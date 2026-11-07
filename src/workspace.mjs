import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { loadProjectConfig } from './project-config.mjs';
import { getGitChanges } from './git-changes.mjs';
import { watchReadyMessageType } from './watch-protocol.mjs';

const normal = (path) => path.split(sep).join('/');

function splitCommandArgs(args) {
  const positionals = [];
  const forwardedOptions = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--concurrency') {
      forwardedOptions.push(args[index], args[index + 1]);
      index += 1;
    } else if (args[index] === '--dry-run') {
      forwardedOptions.push(args[index]);
    } else {
      positionals.push(args[index]);
    }
  }
  return { forwardedOptions, positionals };
}

function baselineVerb(options) {
  return options.includes('--dry-run') ? 'previewing' : 'running';
}

function ownerOf(projects, workspacePath) {
  return projects.find((project) =>
    workspacePath === project.path || workspacePath.startsWith(`${project.path}/`));
}

function isProjectCachePath(project, projectPath) {
  if (!project.cacheDirectoryPath) return projectPath === 'graph.json';
  return projectPath === `${project.cacheDirectoryPath}/graph.json` ||
    projectPath.startsWith(`${project.cacheDirectoryPath}/`);
}

function prefixLines(stream, destination, projectPath) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      destination.write(`[${projectPath}] ${line}\n`);
    }
  });
  return () => {
    if (!buffer) return;
    destination.write(`[${projectPath}] ${buffer}\n`);
    buffer = '';
  };
}

function runWorkspaceWatch({ projects, args, cliPath }) {
  return new Promise((resolveResult) => {
    const children = [];
    const readyProjects = new Set();
    let closedChildren = 0;
    let exitCode = 0;
    let stopping = false;

    const stop = (code, childSignal = 'SIGTERM') => {
      if (stopping) return;
      stopping = true;
      exitCode = code;
      for (const child of children) {
        if (child.exitCode === null) child.kill(childSignal);
      }
    };
    const onSigint = () => stop(130, 'SIGINT');
    const onSigterm = () => stop(143, 'SIGTERM');
    const cleanupSignals = () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    };

    for (const project of projects) {
      const child = spawn(process.execPath, [cliPath, 'watch', ...args], {
        cwd: project.root,
        env: process.env,
        stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      const flushStdout = prefixLines(child.stdout, process.stdout, project.path);
      const flushStderr = prefixLines(child.stderr, process.stderr, project.path);
      child.on('message', (message) => {
        if (message?.type !== watchReadyMessageType || readyProjects.has(project.path)) return;
        readyProjects.add(project.path);
        if (readyProjects.size === projects.length) console.log(`Watching in ${projects.length} projects.`);
      });
      child.on('error', (error) => {
        console.error(`[${project.path}] ${error.stack ?? error}`);
        stop(1);
      });
      child.on('close', (code) => {
        flushStdout();
        flushStderr();
        closedChildren += 1;
        if (!stopping) stop(code ?? 1);
        if (closedChildren === children.length) {
          cleanupSignals();
          resolveResult(exitCode);
        }
      });
    }
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
}

export function resolveWorkspaceProjects({ root, projects }) {
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
    const projectConfig = loadProjectConfig(projectRoot);
    const cacheDirectoryPath = normal(relative(projectRoot, resolve(projectRoot, projectConfig.cacheDir)));
    return { cacheDirectoryPath, path: normal(projectPath), root: projectRoot };
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
  return resolvedProjects;
}

export async function runWorkspace({ root, projects, command, args, cliPath }) {
  const supportedCommands = new Set(['baseline', 'since-last-run', 'clear-cache', 'related', 'affected', 'watch']);
  if (!supportedCommands.has(command)) {
    throw new Error(`Workspace command is not implemented yet: ${command}`);
  }

  const resolvedProjects = resolveWorkspaceProjects({ root, projects });

  if (command === 'watch') {
    const { forwardedOptions, positionals } = splitCommandArgs(args);
    if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
    return runWorkspaceWatch({ projects: resolvedProjects, args: forwardedOptions, cliPath });
  }

  let projectRuns = resolvedProjects.map((project) => ({ project, command, args }));
  if (command === 'related') {
    const { forwardedOptions, positionals: files } = splitCommandArgs(args);
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
      const owner = ownerOf(resolvedProjects, normalizedWorkspacePath);
      if (!owner) {
        workspaceLevelFile = normalizedWorkspacePath;
        continue;
      }
      groupedFiles.get(owner.path).push(normal(relative(owner.root, absoluteFile)));
    }

    if (workspaceLevelFile) {
      console.log(`Workspace-level related file ${workspaceLevelFile}; ${baselineVerb(forwardedOptions)} every project baseline.`);
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

  let printNoChangedFiles = false;
  if (command === 'affected') {
    const { forwardedOptions, positionals } = splitCommandArgs(args);
    if (positionals.length > 1) {
      throw new Error('Usage: affected-node-test affected [git-ref] [--concurrency N]');
    }
    const ref = positionals[0];
    const changed = getGitChanges({
      exclude: (workspacePath) => {
        const owner = ownerOf(resolvedProjects, workspacePath);
        if (!owner) return false;
        const projectPath = workspacePath.slice(owner.path.length + 1);
        return isProjectCachePath(owner, projectPath);
      },
      ref,
      root,
    });
    if (changed.noMergeBase) {
      console.log(`No merge base with ${ref}; ${baselineVerb(forwardedOptions)} every project baseline.`);
      projectRuns = resolvedProjects.map((project) => ({ project, command: 'baseline', args: forwardedOptions }));
    } else {
      const changes = changed.files;
      if (changes.length) console.log(`Changed files: ${changes.join(', ')}`);
      const groupedFiles = new Map(resolvedProjects.map((project) => [project.path, []]));
      const workspaceLevelChange = changes.find((workspacePath) => {
        const owner = ownerOf(resolvedProjects, workspacePath);
        if (!owner) return true;
        groupedFiles.get(owner.path).push(workspacePath.slice(owner.path.length + 1));
        return false;
      });
      if (workspaceLevelChange) {
        console.log(`Workspace-level change ${workspaceLevelChange}; ${baselineVerb(forwardedOptions)} every project baseline.`);
        projectRuns = resolvedProjects.map((project) => ({ project, command: 'baseline', args: forwardedOptions }));
      } else {
        projectRuns = resolvedProjects.map((project) => groupedFiles.get(project.path).length
          ? {
              project,
              command: 'related',
              args: [...new Set(groupedFiles.get(project.path))].sort().concat(forwardedOptions),
            }
          : { project, command: 'since-last-run', args: forwardedOptions, suppressNoop: true });
        printNoChangedFiles = !changes.length;
      }
    }
  }

  let exitCode = 0;
  let displayedProjects = 0;
  for (const { project, command: projectCommand, args: projectArgs, suppressNoop = false } of projectRuns) {
    const result = spawnSync(process.execPath, [cliPath, projectCommand, ...projectArgs], {
      cwd: project.root,
      encoding: 'utf8',
      env: process.env,
    });
    if (result.error) throw result.error;
    const noOp = suppressNoop && result.status === 0 && !result.stderr &&
      result.stdout.trim() === 'No tests changed since last run.';
    if (noOp) continue;
    displayedProjects += 1;
    console.log(`\nProject ${project.path}`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) exitCode = 1;
  }
  if (printNoChangedFiles && !displayedProjects) console.log('No changed files.');
  return exitCode;
}
