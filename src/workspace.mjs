import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const normal = (path) => path.split(sep).join('/');

export function runWorkspace({ root, projects, command, args, cliPath }) {
  const supportedCommands = new Set(['baseline', 'since-last-run', 'clear-cache', 'related']);
  if (!supportedCommands.has(command)) {
    throw new Error(`Workspace command is not implemented yet: ${command}`);
  }

  const resolvedProjects = projects.map((configuredRoot) => {
    if (isAbsolute(configuredRoot)) {
      throw new Error(`Workspace project root must be project-relative: ${configuredRoot}`);
    }
    const projectRoot = resolve(root, configuredRoot);
    const projectPath = relative(root, projectRoot);
    if (!projectPath || projectPath === '..' || projectPath.startsWith(`..${sep}`)) {
      throw new Error(`Workspace project root must stay below the workspace root: ${configuredRoot}`);
    }
    let stats;
    try {
      stats = statSync(projectRoot);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Workspace project root does not exist: ${configuredRoot}`);
      throw error;
    }
    if (!stats.isDirectory()) throw new Error(`Workspace project root is not a directory: ${configuredRoot}`);
    return { path: normal(projectPath), root: projectRoot };
  }).sort((a, b) => a.path.localeCompare(b.path));

  for (let index = 0; index < resolvedProjects.length; index += 1) {
    const project = resolvedProjects[index];
    if (index && project.path === resolvedProjects[index - 1].path) {
      throw new Error(`Workspace project root is duplicated: ${project.path}`);
    }
    const nested = resolvedProjects.find((candidate, candidateIndex) =>
      candidateIndex !== index && candidate.path.startsWith(`${project.path}/`));
    if (nested) throw new Error(`Workspace project roots cannot overlap: ${project.path} and ${nested.path}`);
  }

  let projectRuns = resolvedProjects.map((project) => ({ project, command, args }));
  if (command === 'related') {
    const files = [];
    const forwardedOptions = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--concurrency') {
        forwardedOptions.push(args[index], args[index + 1]);
        index += 1;
      } else {
        files.push(args[index]);
      }
    }
    if (!files.length) throw new Error('Usage: affected-node-test related <file...> [--concurrency N]');

    const groupedFiles = new Map(resolvedProjects.map((project) => [project.path, []]));
    let workspaceLevelFile;
    for (const file of files) {
      const absoluteFile = resolve(root, file);
      const workspacePath = relative(root, absoluteFile);
      if (isAbsolute(workspacePath) || workspacePath === '..' || workspacePath.startsWith(`..${sep}`)) {
        throw new Error(`Related file is outside the workspace root: ${file}`);
      }
      const normalizedWorkspacePath = normal(workspacePath);
      const owner = resolvedProjects.find((project) =>
        normalizedWorkspacePath === project.path || normalizedWorkspacePath.startsWith(`${project.path}/`));
      if (!owner) {
        workspaceLevelFile = normalizedWorkspacePath;
        continue;
      }
      groupedFiles.get(owner.path).push(normal(relative(owner.root, absoluteFile)));
    }

    if (workspaceLevelFile) {
      console.log(`Workspace-level related file ${workspaceLevelFile}; running every project baseline.`);
      projectRuns = resolvedProjects.map((project) => ({
        project,
        command: 'baseline',
        args: forwardedOptions,
      }));
    } else {
      projectRuns = resolvedProjects
        .filter((project) => groupedFiles.get(project.path).length)
        .map((project) => ({
          project,
          command: 'related',
          args: [...new Set(groupedFiles.get(project.path))].sort().concat(forwardedOptions),
        }));
    }
  }

  let exitCode = 0;
  for (const { project, command: projectCommand, args: projectArgs } of projectRuns) {
    console.log(`\nProject ${project.path}`);
    const result = spawnSync(process.execPath, [cliPath, projectCommand, ...projectArgs], {
      cwd: project.root,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) exitCode = 1;
  }
  return exitCode;
}
