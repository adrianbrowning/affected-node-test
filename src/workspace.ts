import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { loadProjectConfig, matchesPatterns, repositoryFilesFingerprint } from './project-config.ts';
import { getGitChanges } from './git-changes.ts';
import { selectionProvider } from './selection-document.ts';
import type { SelectionCommand } from './selection-document.ts';
import { watchReadyMessageType } from './watch-protocol.ts';
import type { CommandName } from './cli-help.ts';
import { isNodeError } from './errors.ts';
import { terminateProcessTree } from './process-control.ts';
import { writeJsonAtomically } from './cache.ts';
import { isContainedPath } from './contained-path.ts';

export type WorkspaceProject = {
  cacheDirectoryPath: string;
  path: string;
  root: string;
};
type WorkspaceCommand = SelectionCommand | 'affected-first' | 'clear-cache' | 'watch';
type ProjectRun = {
  args: string[];
  command: WorkspaceCommand;
  project: WorkspaceProject;
  suppressNoop?: boolean;
};
const supportedCommands: WorkspaceCommand[] = [
  'baseline', 'since-last-run', 'last-failed', 'clear-cache', 'related', 'affected', 'affected-first', 'watch',
];

const normal = (path: string) => path.split(sep).join('/');

function splitCommandArgs(args: string[]) {
  const positionals: string[] = [];
  const forwardedOptions: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--concurrency') {
      forwardedOptions.push(args[index], args[index + 1]);
      index += 1;
    } else if (args[index] === '--dry-run' || args[index] === '--output=json') {
      forwardedOptions.push(args[index]);
    } else {
      positionals.push(args[index]);
    }
  }
  return { forwardedOptions, positionals };
}

function extractProjectFilters(args: string[]) {
  const commandArgs: string[] = [];
  const projectFilters: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--project') {
      commandArgs.push(args[index]);
      continue;
    }
    const filter = args[index + 1];
    if (!filter || filter.startsWith('-')) throw new Error('--project requires a non-empty glob.');
    projectFilters.push(filter);
    index += 1;
  }
  return { commandArgs, projectFilters };
}

function baselineVerb(options: string[]) {
  return options.includes('--dry-run') ? 'previewing' : 'running';
}

function ownerOf(projects: WorkspaceProject[], workspacePath: string) {
  return projects.find((project) =>
    workspacePath === project.path || workspacePath.startsWith(`${project.path}/`));
}

function isProjectCachePath(project: WorkspaceProject, projectPath: string) {
  if (!project.cacheDirectoryPath) return projectPath === 'graph.json';
  return projectPath === `${project.cacheDirectoryPath}/graph.json` ||
    projectPath.startsWith(`${project.cacheDirectoryPath}/`);
}

function prefixLines(stream: Readable, destination: Writable, projectPath: string) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
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

function runWorkspaceWatch({ projects, args, cliPath }: {
  args: string[];
  cliPath: string;
  projects: WorkspaceProject[];
}) {
  return new Promise<number>((resolveResult) => {
    const children: ReturnType<typeof spawn>[] = [];
    const readyProjects = new Set<string>();
    let closedChildren = 0;
    let exitCode = 0;
    let forceKill: NodeJS.Timeout | undefined;
    let stopping = false;

    const stop = (code: number, childSignal: NodeJS.Signals = 'SIGTERM') => {
      if (stopping) return;
      stopping = true;
      exitCode = code;
      for (const child of children) {
        if (child.exitCode === null) terminateProcessTree(child, childSignal);
      }
      forceKill = setTimeout(() => {
        for (const child of children) {
          if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
        }
      }, 2_000);
      forceKill.unref();
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
        detached: process.platform !== 'win32',
        env: process.env,
        stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      if (!child.stdout || !child.stderr) throw new Error(`Failed to capture watcher output for ${project.path}.`);
      const flushStdout = prefixLines(child.stdout, process.stdout, project.path);
      const flushStderr = prefixLines(child.stderr, process.stderr, project.path);
      child.on('message', (message) => {
        if (!message || typeof message !== 'object' || !('type' in message) ||
            message.type !== watchReadyMessageType || readyProjects.has(project.path)) return;
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
          clearTimeout(forceKill);
          cleanupSignals();
          resolveResult(exitCode);
        }
      });
    }
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
}

export function resolveWorkspaceProjects({ root, projects }: { projects: string[]; root: string }) {
  const resolvedProjects = projects.map((configuredRoot) => {
    if (isAbsolute(configuredRoot)) {
      throw new Error(`Workspace project root must be project-relative: ${configuredRoot}`);
    }
    const projectRoot = resolve(root, configuredRoot);
    const projectPath = relative(root, projectRoot);
    if (!projectPath || !isContainedPath(root, projectRoot)) {
      throw new Error(`Workspace project root must stay below the workspace root: ${configuredRoot}`);
    }
    let stats;
    try {
      stats = statSync(projectRoot);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') throw new Error(`Workspace project root does not exist: ${configuredRoot}`);
      throw error;
    }
    if (!stats.isDirectory()) throw new Error(`Workspace project root is not a directory: ${configuredRoot}`);
    const projectConfig = loadProjectConfig(projectRoot);
    if (isAbsolute(projectConfig.cacheDir) || !isContainedPath(projectRoot, resolve(projectRoot, projectConfig.cacheDir))) {
      throw new Error(`Workspace project cacheDir must stay within the project root: ${configuredRoot}`);
    }
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

function workspaceAffectedChanges({ root, projects, ref, excludePath }: {
  excludePath?: string;
  projects: WorkspaceProject[];
  ref?: string;
  root: string;
}) {
  const changed = getGitChanges({
    exclude: (workspacePath) => {
      if (workspacePath === excludePath) return true;
      const owner = ownerOf(projects, workspacePath);
      if (!owner) return false;
      return isProjectCachePath(owner, workspacePath.slice(owner.path.length + 1));
    },
    ref,
    root,
  });
  if (changed.noMergeBase) return { fallback: true, files: [] as string[] };
  return {
    fallback: changed.files.some((workspacePath) => !ownerOf(projects, workspacePath)),
    files: changed.files,
  };
}

type WorkspacePartitionPlan = {
  changes: string[];
  changesFingerprint: string;
  fallback: boolean;
  projects: { path: string; plan: unknown }[];
  ref: string | null;
  schemaVersion: 1;
};

function readWorkspacePartitionPlan(path: string): WorkspacePartitionPlan {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error: unknown) {
    throw new Error(`Workspace partition plan is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workspace partition plan is invalid: expected an object.');
  }
  const plan = value as Record<string, unknown>;
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.changes) ||
      plan.changes.some((file) => typeof file !== 'string') || typeof plan.changesFingerprint !== 'string' ||
      typeof plan.fallback !== 'boolean' || !(plan.ref === null || typeof plan.ref === 'string') ||
      !Array.isArray(plan.projects) || plan.projects.some((project) => !project || typeof project !== 'object' ||
        Array.isArray(project) || typeof (project as Record<string, unknown>).path !== 'string' ||
        !('plan' in project))) {
    throw new Error('Workspace partition plan is invalid or unsupported.');
  }
  return plan as WorkspacePartitionPlan;
}

function splitAffectedFirstArgs(args: string[]) {
  const commandArgs: string[] = [];
  let phase: 'affected' | 'remaining' | undefined;
  let plan: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--phase') {
      const value = args[index + 1];
      if (value !== 'affected' && value !== 'remaining') throw new Error('--phase must be affected or remaining.');
      phase = value;
      index += 1;
    } else if (args[index] === '--plan') {
      plan = args[index + 1];
      if (!plan || plan.startsWith('-')) throw new Error('--plan requires a workspace-relative path.');
      index += 1;
    } else {
      commandArgs.push(args[index]);
    }
  }
  if (Boolean(phase) !== Boolean(plan)) throw new Error('--phase and --plan must be used together.');
  return { commandArgs, phase, plan };
}

function runWorkspaceAffectedFirst({ root, projects, args, cliPath }: {
  args: string[];
  cliPath: string;
  projects: WorkspaceProject[];
  root: string;
}) {
  const split = splitAffectedFirstArgs(args);
  const { forwardedOptions, positionals } = splitCommandArgs(split.commandArgs);
  if (positionals.length > 1) throw new Error('Usage: affected-node-test affected-first [git-ref] [--concurrency N]');
  if (split.phase === 'remaining' && positionals.length) {
    throw new Error('The remaining phase reads REF from the plan; do not pass REF again.');
  }
  const workspacePlanPath = split.plan ? resolve(root, split.plan) : undefined;
  if (workspacePlanPath) {
    if (isAbsolute(split.plan ?? '') || !isContainedPath(root, workspacePlanPath)) {
      throw new Error('--plan must be a workspace-relative path within the workspace root.');
    }
  }
  const stored = split.phase === 'remaining' && workspacePlanPath
    ? readWorkspacePartitionPlan(workspacePlanPath)
    : undefined;
  const ref = stored?.ref ?? positionals[0];
  const excludePath = workspacePlanPath ? normal(relative(root, workspacePlanPath)) : undefined;
  const changes = workspaceAffectedChanges({ root, projects, ref: ref ?? undefined, excludePath });
  if (stored && (stored.fallback !== changes.fallback ||
      JSON.stringify(stored.changes) !== JSON.stringify(changes.files) ||
      stored.changesFingerprint !== repositoryFilesFingerprint(root, changes.files))) {
    throw new Error('Workspace partition plan is stale: changed files differ; rerun the affected phase.');
  }
  const jsonOutput = forwardedOptions.includes('--output=json');
  const plans = projects.map((project) => ({
    project,
    path: `.affected-tests/workspace-partition-${process.pid}.json`,
    changes: changes.fallback
      ? null
      : changes.files
        .filter((file) => ownerOf(projects, file)?.path === project.path)
        .map((file) => file.slice(project.path.length + 1)),
  }));
  const documents: { affected?: unknown; path: string; remaining?: unknown }[] =
    projects.map((project) => ({ path: project.path }));
  const embedded = new Map(stored?.projects.map((item) => [item.path, item.plan]) ?? []);
  if (stored && (stored.projects.length !== projects.length || projects.some((project) => !embedded.has(project.path)))) {
    throw new Error('Workspace partition plan affected phase did not complete successfully; rerun the affected phase.');
  }
  if (stored && stored.projects.some(({ plan }) => !plan || typeof plan !== 'object' || Array.isArray(plan) ||
      (plan as Record<string, unknown>).state !== 'affected-passed')) {
    throw new Error('Workspace partition plan affected phase did not complete successfully; rerun the affected phase.');
  }
  const runPhase = (phase: 'affected' | 'remaining') => {
    for (let index = 0; index < plans.length; index += 1) {
      const item = plans[index];
      if (phase === 'remaining') writeJsonAtomically(resolve(item.project.root, item.path), embedded.get(item.project.path));
      const childArgs = [
        cliPath,
        'affected-first',
        ...(phase === 'affected' && ref ? [ref] : []),
        '--phase', phase,
        '--plan', item.path,
        ...forwardedOptions,
      ];
      const result = spawnSync(process.execPath, childArgs, {
        cwd: item.project.root,
        encoding: 'utf8',
        env: {
          ...process.env,
          AFFECTED_NODE_TEST_CHANGED_FILES: JSON.stringify(item.changes),
          AFFECTED_NODE_TEST_PROJECT_PATH: item.project.path,
        },
      });
      if (result.error) throw result.error;
      if (jsonOutput) {
        try {
          documents[index][phase] = JSON.parse(result.stdout);
        } catch {
          throw new Error(`Project ${item.project.path} did not produce valid JSON output.`);
        }
      } else {
        console.log(`\nProject ${item.project.path} — ${phase}`);
        if (result.stdout) process.stdout.write(result.stdout);
      }
      if (result.stderr) process.stderr.write(result.stderr);
      if (phase === 'affected' || result.status === 0) {
        embedded.set(item.project.path, JSON.parse(readFileSync(resolve(item.project.root, item.path), 'utf8')));
      }
      if (result.status !== 0) return result.status ?? 1;
    }
    return 0;
  };
  try {
    let exitCode = 0;
    if (split.phase !== 'remaining') exitCode = runPhase('affected');
    if (workspacePlanPath && split.phase === 'affected') {
      writeJsonAtomically(workspacePlanPath, {
        schemaVersion: 1,
        ref: ref ?? null,
        fallback: changes.fallback,
        changes: changes.files,
        changesFingerprint: repositoryFilesFingerprint(root, changes.files),
        projects: projects.filter((project) => embedded.has(project.path))
          .map((project) => ({ path: project.path, plan: embedded.get(project.path) })),
      });
    }
    if (exitCode === 0 && split.phase !== 'affected') exitCode = runPhase('remaining');
    if (workspacePlanPath && split.phase === 'remaining') {
      writeJsonAtomically(workspacePlanPath, {
        ...stored,
        projects: projects.map((project) => ({ path: project.path, plan: embedded.get(project.path) })),
      });
    }
    if (jsonOutput) {
      console.log(JSON.stringify({
        schemaVersion: 1,
        command: 'affected-first',
        mode: 'run',
        outcome: exitCode === 0 ? 'passed' : 'failed',
        exitCode,
        workspaceRoot: root,
        projects: documents,
      }, null, 2));
    }
    return exitCode;
  } finally {
    for (const item of plans) rmSync(resolve(item.project.root, item.path), { force: true });
  }
}

export async function runWorkspace({ root, projects, command: requestedCommand, args: rawArgs, cliPath }: {
  args: string[];
  cliPath: string;
  command: CommandName;
  projects: string[];
  root: string;
}) {
  if (!supportedCommands.includes(requestedCommand as WorkspaceCommand)) {
    const command: CommandName = requestedCommand;
    throw new Error(`Workspace command is not implemented yet: ${command}`);
  }
  const command = requestedCommand as WorkspaceCommand;

  const allProjects = resolveWorkspaceProjects({ root, projects });
  const { commandArgs: args, projectFilters } = extractProjectFilters(rawArgs);
  const resolvedProjects = projectFilters.length
    ? allProjects.filter((project) => projectFilters.some((filter) => matchesPatterns(project.path, [filter])))
    : allProjects;
  if (!resolvedProjects.length) {
    throw new Error(`No workspace projects matched ${projectFilters.map((filter) => `--project ${filter}`).join(', ')}.`);
  }
  if (command === 'affected-first') {
    return runWorkspaceAffectedFirst({ root, projects: resolvedProjects, args, cliPath });
  }
  const jsonOutput = args.includes('--output=json');
  const log = jsonOutput ? console.error : console.log;
  let routing: Record<string, unknown> = { kind: 'all-projects' };

  if (command === 'watch') {
    const { forwardedOptions, positionals } = splitCommandArgs(args);
    if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
    return runWorkspaceWatch({ projects: resolvedProjects, args: forwardedOptions, cliPath });
  }

  let projectRuns: ProjectRun[] = resolvedProjects.map((project) => ({ project, command, args }));
  if (command === 'related') {
    const { forwardedOptions, positionals: files } = splitCommandArgs(args);
    if (!files.length) throw new Error('Usage: affected-node-test related <file...> [--concurrency N]');

    const groupedFiles = new Map<string, string[]>(resolvedProjects.map((project) => [project.path, []]));
    let workspaceLevelFile: string | undefined;
    for (const file of files) {
      const absoluteFile = resolve(root, file);
      const workspacePath = relative(root, absoluteFile);
      if (isAbsolute(workspacePath) || workspacePath === '..' || workspacePath.startsWith(`..${sep}`)) {
        throw new Error(`Related file is outside the workspace root: ${file}`);
      }
      const normalizedWorkspacePath = normal(workspacePath);
      const owner = ownerOf(allProjects, normalizedWorkspacePath);
      if (!owner) {
        workspaceLevelFile = normalizedWorkspacePath;
        continue;
      }
      if (!groupedFiles.has(owner.path)) continue;
      groupedFiles.get(owner.path)?.push(normal(relative(owner.root, absoluteFile)));
    }

    if (workspaceLevelFile) {
      log(`Workspace-level related file ${workspaceLevelFile}; ${baselineVerb(forwardedOptions)} every project baseline.`);
      routing = { file: workspaceLevelFile, kind: 'workspace-fallback', reason: 'workspace-level-file' };
      projectRuns = resolvedProjects.map((project) => ({
        project,
        command: 'baseline',
        args: forwardedOptions,
      }));
    } else {
      routing = { files: files.map(normal).sort(), kind: 'project-files' };
      projectRuns = resolvedProjects
        .filter((project) => Boolean(groupedFiles.get(project.path)?.length))
        .map((project) => ({
          project,
          command: 'related',
          args: [...new Set(groupedFiles.get(project.path) ?? [])].sort().concat(forwardedOptions),
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
        const owner = ownerOf(allProjects, workspacePath);
        if (!owner) return false;
        const projectPath = workspacePath.slice(owner.path.length + 1);
        return isProjectCachePath(owner, projectPath);
      },
      ref,
      root,
    });
    if (changed.noMergeBase) {
      log(`No merge base with ${ref}; ${baselineVerb(forwardedOptions)} every project baseline.`);
      routing = { kind: 'workspace-fallback', reason: 'no-merge-base', ref };
      projectRuns = resolvedProjects.map((project) => ({ project, command: 'baseline', args: forwardedOptions }));
    } else {
      const changes = changed.files;
      routing = changes.length
        ? { files: changes, kind: 'project-files' }
        : { kind: 'no-changes' };
      if (changes.length) log(`Changed files: ${changes.join(', ')}`);
      const groupedFiles = new Map<string, string[]>(resolvedProjects.map((project) => [project.path, []]));
      const workspaceLevelChange = changes.find((workspacePath) => {
        const owner = ownerOf(allProjects, workspacePath);
        if (!owner) return true;
        if (!groupedFiles.has(owner.path)) return false;
        groupedFiles.get(owner.path)?.push(workspacePath.slice(owner.path.length + 1));
        return false;
      });
      if (workspaceLevelChange) {
        log(`Workspace-level change ${workspaceLevelChange}; ${baselineVerb(forwardedOptions)} every project baseline.`);
        routing = { file: workspaceLevelChange, kind: 'workspace-fallback', reason: 'workspace-level-change' };
        projectRuns = resolvedProjects.map((project) => ({ project, command: 'baseline', args: forwardedOptions }));
      } else {
        projectRuns = resolvedProjects.map((project) => groupedFiles.get(project.path)?.length
          ? {
              project,
              command: 'related',
              args: [...new Set(groupedFiles.get(project.path) ?? [])].sort().concat(forwardedOptions),
            }
          : { project, command: 'since-last-run', args: forwardedOptions, suppressNoop: true });
        printNoChangedFiles = !changes.length;
      }
    }
  }

  let exitCode = 0;
  let displayedProjects = 0;
  const projectDocuments: { path: string; result: unknown }[] = [];
  for (const { project, command: projectCommand, args: projectArgs, suppressNoop = false } of projectRuns) {
    const result = spawnSync(process.execPath, [cliPath, projectCommand, ...projectArgs], {
      cwd: project.root,
      encoding: 'utf8',
      env: process.env,
    });
    if (result.error) throw result.error;
    const noOp = !jsonOutput && suppressNoop && result.status === 0 && !result.stderr &&
      result.stdout.trim() === 'No tests changed since last run.';
    if (noOp) continue;
    displayedProjects += 1;
    if (jsonOutput) {
      let projectDocument: unknown;
      try {
        projectDocument = JSON.parse(result.stdout);
      } catch {
        throw new Error(`Project ${project.path} did not produce valid JSON output.`);
      }
      projectDocuments.push({ path: project.path, result: projectDocument });
    } else {
      console.log(`\nProject ${project.path}`);
      if (result.stdout) process.stdout.write(result.stdout);
    }
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) exitCode = 1;
  }
  if (jsonOutput) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      mode: args.includes('--dry-run') ? 'preview' : 'run',
      command,
      provider: command === 'clear-cache' ? 'cache' : selectionProvider(command),
      workspaceRoot: root,
      outcome: exitCode ? 'failed' : 'passed',
      exitCode,
      routing,
      projectFilters,
      projects: projectDocuments,
    }, null, 2));
  } else if (printNoChangedFiles && !displayedProjects) {
    console.log('No changed files.');
  }
  return exitCode;
}
