#!/usr/bin/env node
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, watch as watchFiles } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve, relative, join, sep, isAbsolute } from 'node:path';
import { availableParallelism, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { commandHelp, isCommandName, topLevelHelp } from '../src/cli-help.ts';
import type { CommandName } from '../src/cli-help.ts';
import { configurationFingerprint } from '../src/config.ts';
import { parseConcurrency } from '../src/concurrency.ts';
import { applyDependencyRun, loadDependencyRecord } from '../src/dependency-record.ts';
import type {
  DependencyGraph,
  DependencyRecord,
  DependencyRunResult,
  DependencyState,
  FileState,
  RecordMetadata,
} from '../src/dependency-record.ts';
import { dependenciesForTest } from '../src/dependency-graph.ts';
import type { DependencyEdge } from '../src/dependency-graph.ts';
import { diagnose } from '../src/doctor.ts';
import { createOutputBuffer } from '../src/output-buffer.ts';
import { buildStaticGraph } from '../src/static-graph.ts';
import { getGitChanges } from '../src/git-changes.ts';
import {
  executeSelectionRun,
  selectLastFailed,
  selectTestsForFiles,
  selectTestsSinceLastRun,
} from '../src/selection-run.ts';
import type { BaselineOutcome, SelectedOutcome, SelectionOutcome } from '../src/selection-run.ts';
import type { PreparedSelection } from '../src/selection-run.ts';
import { renderSelectionPreview } from '../src/selection-preview.ts';
import {
  createSelectionPreviewDocument,
  createSelectionRunDocument,
  isSelectionCommand,
} from '../src/selection-document.ts';
import type { SelectionCommand } from '../src/selection-document.ts';
import { runWorkspace } from '../src/workspace.ts';
import { sendWatchReady } from '../src/watch-protocol.ts';
import { discoverTestFiles } from '../src/test-discovery.ts';
import {
  conventionDependencyPatterns,
  loadProjectConfig,
  matchingRepositoryFiles,
  repositoryFilesFingerprint,
} from '../src/project-config.ts';
import type { ProjectConfig } from '../src/project-config.ts';
import { errorMessage, isNodeError } from '../src/errors.ts';
import { initializeProject } from '../src/init.ts';

const root = process.cwd();
const sourceExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const hook = fileURLToPath(new URL(`../src/hook.${sourceExtension}`, import.meta.url));
const [requestedCommand = 'help', ...args] = process.argv.slice(2);
const fail = (message: string): never => { console.error(message); process.exit(1); };
const failUsage = (message: string, help: string): never => fail(`${message}\n\n${help}`);
const packageRoot = import.meta.url.endsWith('.ts') ? '..' : '../..';
const parsedPackage: unknown = JSON.parse(readFileSync(fileURLToPath(new URL(`${packageRoot}/package.json`, import.meta.url)), 'utf8'));
if (!parsedPackage || typeof parsedPackage !== 'object' || !('version' in parsedPackage) ||
    typeof parsedPackage.version !== 'string') {
  fail('package.json: version must be a string.');
}
const packageVersion = (parsedPackage as { version: string }).version;
if (requestedCommand === '--version' || requestedCommand === '-v') {
  if (args.length) failUsage(`Unexpected argument: ${args[0]}`, topLevelHelp());
  console.log(`affected-node-test ${packageVersion}`);
  process.exit(0);
}
if (requestedCommand === 'help' || requestedCommand === '--help' || requestedCommand === '-h') {
  if (args.length > 1) failUsage(`Unexpected argument: ${args[1]}`, topLevelHelp());
  if (args[0] && !isCommandName(args[0])) {
    failUsage(`Unknown command: ${args[0]}`, topLevelHelp());
  }
  const helpCommand = args[0];
  console.log(helpCommand && isCommandName(helpCommand) ? commandHelp(helpCommand) : topLevelHelp());
  process.exit(0);
}
const command: CommandName = isCommandName(requestedCommand)
  ? requestedCommand
  : failUsage(`Unknown command: ${requestedCommand}`, topLevelHelp());
if (args.includes('--help') || args.includes('-h')) {
  console.log(commandHelp(command));
  process.exit(0);
}
if (command === 'init') {
  const invalid = args.find((argument) => argument !== '--write');
  if (invalid) failUsage(`Unknown option: ${invalid}`, commandHelp(command));
  if (args.filter((argument) => argument === '--write').length > 1) {
    failUsage('--write may only be specified once.', commandHelp(command));
  }
  try {
    const result = initializeProject(root, { write: args.includes('--write') });
    for (const line of result.output) console.log(line);
    for (const conflict of result.conflicts) console.error(conflict);
    process.exit(result.conflicts.length ? 1 : 0);
  } catch (error: unknown) {
    fail(errorMessage(error));
  }
}
function parseArguments(values: string[]) {
  const positionals: string[] = [];
  let dryRun = false;
  let output: 'human' | 'json' = 'human';
  const projectFilters: string[] = [];
  let concurrency = Math.max(1, Math.min(4, availableParallelism()));
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--concurrency') {
      const value = values[index + 1];
      try {
        concurrency = parseConcurrency(value, availableParallelism());
      } catch (error: unknown) {
        failUsage(errorMessage(error), commandHelp(command));
      }
      index += 1;
    } else if (values[index] === '--dry-run') {
      if (!['baseline', 'affected', 'related', 'since-last-run', 'last-failed'].includes(command)) {
        failUsage(`Unknown option: ${values[index]}`, commandHelp(command));
      }
      dryRun = true;
    } else if (values[index] === '--output=json') {
      if (!['baseline', 'affected', 'related', 'since-last-run', 'last-failed'].includes(command)) {
        failUsage(`Unknown option: ${values[index]}`, commandHelp(command));
      }
      output = 'json';
    } else if (values[index] === '--project') {
      if (!['baseline', 'affected', 'related', 'since-last-run', 'last-failed', 'watch', 'clear-cache'].includes(command)) {
        failUsage(`Unknown option: ${values[index]}`, commandHelp(command));
      }
      const value = values[index + 1];
      if (!value || value.startsWith('-')) {
        failUsage('--project requires a non-empty glob.', commandHelp(command));
      }
      projectFilters.push(value);
      index += 1;
    } else if (values[index].startsWith('-')) {
      failUsage(`Unknown option: ${values[index]}`, commandHelp(command));
    } else {
      positionals.push(values[index]);
    }
  }
  return { concurrency, dryRun, output, positionals, projectFilters };
}
const options = parseArguments(args);
if (command === 'related' && !options.positionals.length) {
  failUsage('related requires at least one FILE.', commandHelp(command));
}
if (command === 'affected' && options.positionals.length > 1) {
  failUsage(`Unexpected argument: ${options.positionals[1]}`, commandHelp(command));
}
if (!['affected', 'related'].includes(command) && options.positionals.length) {
  failUsage(`Unexpected argument: ${options.positionals[0]}`, commandHelp(command));
}
const activeChildren = new Set<ChildProcess>();
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 } as const;
type InterruptSignal = keyof typeof signalExitCodes;
let interruptedSignal: InterruptSignal | undefined;
let stopWatching: ((signal?: InterruptSignal) => void) | undefined;
function killChildTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== 'ESRCH') throw error;
  }
}
function interrupt(signal: InterruptSignal) {
  if (interruptedSignal) {
    for (const child of activeChildren) killChildTree(child, 'SIGKILL');
    return;
  }
  interruptedSignal = signal;
  for (const child of activeChildren) killChildTree(child, signal);
  const forceKill = setTimeout(() => {
    for (const child of activeChildren) killChildTree(child, 'SIGKILL');
  }, 2_000);
  forceKill.unref();
  stopWatching?.(signal);
}
const normal = (p: string) => p.split(sep).join('/').replace(/^\.\//, '');
function configuredProject(): ProjectConfig {
  try {
    return loadProjectConfig(root);
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
const projectConfig = configuredProject();
if (command === 'doctor') {
  try {
    const report = diagnose(root, projectConfig);
    console.log(report.lines.join('\n'));
    for (const problem of report.problems) console.error(`Problem: ${problem}`);
    process.exit(report.problems.length ? 1 : 0);
  } catch (error: unknown) {
    fail(errorMessage(error));
  }
}
if (projectConfig.projects.length) {
  try {
    const status = await runWorkspace({
      root,
      projects: projectConfig.projects,
      command,
      args,
      cliPath: fileURLToPath(import.meta.url),
    });
    process.exit(status);
  } catch (error: unknown) {
    fail(errorMessage(error));
  }
}
if (options.projectFilters.length) {
  failUsage('--project requires a workspace configuration.', commandHelp(command));
}
process.once('SIGINT', () => interrupt('SIGINT'));
process.once('SIGTERM', () => interrupt('SIGTERM'));
const cacheDirectory = resolve(root, projectConfig.cacheDir);
const cacheDirectoryFromRoot = relative(root, cacheDirectory);
if (isAbsolute(projectConfig.cacheDir) || cacheDirectoryFromRoot === '..' || cacheDirectoryFromRoot.startsWith(`..${sep}`)) {
  fail('affected-node-test.config.json: cacheDir must stay within the project root.');
}
const cachePath = join(cacheDirectory, 'graph.json');
const cacheDirectoryRepositoryPath = normal(cacheDirectoryFromRoot);
const cacheRepositoryPath = normal(relative(root, cachePath));
function isCacheRepositoryPath(path: string) {
  return path === cacheRepositoryPath || (
    Boolean(cacheDirectoryRepositoryPath) && path.startsWith(`${cacheDirectoryRepositoryPath}/`)
  );
}
function matchingProjectFiles(patterns: string[]) {
  return matchingRepositoryFiles(root, patterns).filter((path) => !isCacheRepositoryPath(path));
}
function configuredProjectDependencyFingerprint() {
  return repositoryFilesFingerprint(root, matchingProjectFiles(projectConfig.projectDependencies));
}
function resolveConfiguredFiles(key: string, patterns: string[]) {
  const files = new Set<string>();
  for (const pattern of patterns) {
    const matches = matchingProjectFiles([pattern]);
    if (!matches.length) fail(`affected-node-test.config.json: ${key} pattern matched no files: ${pattern}`);
    for (const match of matches) files.add(match);
  }
  return files;
}
const setupFiles = resolveConfiguredFiles('setupFiles', projectConfig.setupFiles);
const globalSetupFiles = resolveConfiguredFiles('globalSetupFiles', projectConfig.globalSetupFiles);
const envFiles = resolveConfiguredFiles('envFiles', projectConfig.envFiles);
const conventionDependencyFiles = matchingProjectFiles(conventionDependencyPatterns);
const globalSetupEdges: DependencyEdge[] = [];
let recordGlobalSetupEdges = false;
if (globalSetupFiles.size) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (recordGlobalSetupEdges && context.parentURL?.startsWith('file:') && resolved.url?.startsWith('file:')) {
        const parent = fileURLToPath(context.parentURL);
        const child = fileURLToPath(resolved.url);
        const parentPath = relative(root, parent);
        const childPath = relative(root, child);
        const inside = (path: string) => path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
        if (inside(parentPath) && inside(childPath)) {
          globalSetupEdges.push([normal(parentPath), normal(childPath)]);
        }
      }
      return resolved;
    },
  });
}

function discover() {
  return discoverTestFiles(root, projectConfig);
}
type OutputBuffer = ReturnType<typeof createOutputBuffer>;
type GraphTestResult = {
  cleanup: () => void;
  durationMs: number;
  edges: DependencyEdge[];
  status: 0 | 1;
  stderr: OutputBuffer;
  stdout: OutputBuffer;
  unresolvedStatic: boolean;
};
function parseEdge(line: string): DependencyEdge {
  const parsed: unknown = JSON.parse(line);
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((part) => typeof part !== 'string')) {
    throw new Error('Worker emitted an invalid dependency edge.');
  }
  return [parsed[0], parsed[1]];
}
function graphForTest(test: string) {
  const folder = mkdtempSync(join(tmpdir(), 'affected-test-'));
  const log = join(folder, 'edges.jsonl');
  return new Promise<GraphTestResult>((resolveResult) => {
    const startedAt = performance.now();
    const imports = [hook, ...[...setupFiles].map((file) => join(root, file))]
      .flatMap((file) => ['--import', file]);
    const child = spawn(process.execPath,
      [...projectConfig.nodeArgs, ...imports, '--test', join(root, test)],
      { cwd: root, detached: process.platform !== 'win32', stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env,
        AFFECTED_TESTS_EDGES_FILE: log, AFFECTED_TESTS_ROOT: root } });
    activeChildren.add(child);
    if (!child.stdout || !child.stderr) throw new Error(`Failed to capture test output for ${test}.`);
    const stdout = createOutputBuffer({ directory: folder, name: 'stdout' });
    const stderr = createOutputBuffer({ directory: folder, name: 'stderr' });
    child.stdout.on('data', (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk));
    child.on('error', (error) => stderr.append(`${error.stack ?? error}\n`));
    child.on('close', (code) => {
      activeChildren.delete(child);
      try {
        const edges = existsSync(log)
          ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(parseEdge)
          : [];
        for (const setupFile of setupFiles) edges.push([test, setupFile]);
        const staticGraph = buildStaticGraph(root, test, [
          test,
          ...setupFiles,
          ...globalSetupFiles,
        ]);
        edges.push(...staticGraph.edges);
        const uniqueEdges = [...new Map(edges.map((edge) => [JSON.stringify(edge), edge])).values()];
        resolveResult({
          durationMs: performance.now() - startedAt,
          edges: uniqueEdges,
          status: code === 0 ? 0 : 1,
          stdout,
          stderr,
          unresolvedStatic: staticGraph.unresolved,
          cleanup: () => rmSync(folder, { recursive: true, force: true }),
        });
      } catch (error) {
        stdout.cleanup();
        stderr.cleanup();
        rmSync(folder, { recursive: true, force: true });
        throw error;
      }
    });
  });
}
function lifecycleFailure(tests: string[], resultGraph: DependencyGraph): DependencyRunResult {
  return {
    completedTests: tests,
    failedTests: tests,
    resultGraph,
    interrupted: interruptedSignal,
  };
}
async function runTests(
  tests: string[],
  oldGraph: DependencyGraph = {},
  historicalDurations: Record<string, number> = {},
): Promise<DependencyRunResult> {
  const resultGraph: DependencyGraph = { ...oldGraph };
  const teardowns: (() => unknown | Promise<unknown>)[] = [];
  if (tests.length) {
    try {
      for (const file of envFiles) process.loadEnvFile(join(root, file));
    } catch (error: unknown) {
      console.error(`Environment file loading failed: ${error instanceof Error ? error.stack : error}`);
      return lifecycleFailure(tests, resultGraph);
    }
    try {
      for (const file of globalSetupFiles) {
        recordGlobalSetupEdges = true;
        const loaded: unknown = await import(pathToFileURL(join(root, file)).href);
        if (!loaded || typeof loaded !== 'object') throw new Error(`${file} did not export a module object.`);
        const module = loaded as { default?: unknown; setup?: unknown; teardown?: unknown };
        const setup = module.setup ?? module.default;
        if (typeof setup !== 'function') {
          throw new Error(`${file} must export setup() or a default setup function.`);
        }
        const returnedTeardown = await setup();
        const teardown = typeof returnedTeardown === 'function' ? returnedTeardown : module.teardown;
        if (teardown !== undefined && typeof teardown !== 'function') {
          throw new Error(`${file} teardown must be a function.`);
        }
        if (teardown) teardowns.unshift(teardown);
      }
    } catch (error: unknown) {
      console.error(`Global setup failed: ${error instanceof Error ? error.stack : error}`);
      for (const teardown of teardowns) {
        try { await teardown(); } catch (teardownError: unknown) {
          console.error(`Global teardown failed: ${teardownError instanceof Error ? teardownError.stack : teardownError}`);
        }
      }
      return lifecycleFailure(tests, resultGraph);
    } finally {
      recordGlobalSetupEdges = false;
    }
  }
  const scheduledTests = [...tests].sort((left, right) =>
    (historicalDurations[right] ?? -1) - (historicalDurations[left] ?? -1) || left.localeCompare(right));
  const results = new Map<string, GraphTestResult>();
  let nextIndex = 0;
  async function worker() {
    while (!interruptedSignal && nextIndex < scheduledTests.length) {
      const index = nextIndex;
      nextIndex += 1;
      const test = scheduledTests[index];
      results.set(test, await graphForTest(test));
    }
  }
  const workerCount = Math.min(options.concurrency, tests.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const completedTests: string[] = [];
  const durations: Record<string, number> = {};
  const failedTests: string[] = [];
  const unresolvedStaticTests: string[] = [];
  for (const test of tests) {
    const result = results.get(test);
    if (!result) continue;
    (options.output === 'json' ? console.error : console.log)(`\n▶ ${test}`);
    try {
      await result.stdout.writeTo(options.output === 'json' ? process.stderr : process.stdout);
      await result.stderr.writeTo(process.stderr);
    } finally {
      result.stdout.cleanup();
      result.stderr.cleanup();
      result.cleanup();
    }
    resultGraph[test] = result.edges;
    completedTests.push(test);
    durations[test] = result.durationMs;
    if (result.status !== 0) failedTests.push(test);
    if (result.unresolvedStatic) unresolvedStaticTests.push(test);
  }
  for (const teardown of teardowns) {
    try {
      recordGlobalSetupEdges = true;
      await teardown();
    } catch (error: unknown) {
      console.error(`Global teardown failed: ${error instanceof Error ? error.stack : error}`);
      for (const test of completedTests) {
        if (!failedTests.includes(test)) failedTests.push(test);
      }
    } finally {
      recordGlobalSetupEdges = false;
    }
  }
  for (const test of completedTests) {
    for (const globalSetupFile of globalSetupFiles) resultGraph[test].push([test, globalSetupFile]);
    resultGraph[test].push(...globalSetupEdges);
  }
  return { completedTests, durations, failedTests, resultGraph, interrupted: interruptedSignal, unresolvedStaticTests };
}
function dependencyClosure(graph: DependencyGraph, roots: Set<string>) {
  const adjacency = new Map<string, Set<string>>();
  for (const edges of Object.values(graph)) {
    for (const [parent, child] of edges) {
      if (!adjacency.has(parent)) adjacency.set(parent, new Set());
      adjacency.get(parent)?.add(child);
    }
  }
  const visited = new Set<string>(roots);
  const stack = [...roots];
  while (stack.length) {
    const parent = stack.pop();
    if (parent === undefined) break;
    for (const dependency of adjacency.get(parent) ?? []) {
      if (!visited.has(dependency)) {
        visited.add(dependency);
        stack.push(dependency);
      }
    }
  }
  return [...visited].sort();
}
function dependencyState(graph: DependencyGraph, test: string): DependencyState {
  const state: DependencyState = {};
  for (const path of [...dependenciesForTest(graph[test] ?? [], test)].sort()) {
    try {
      const stats = statSync(join(root, path));
      state[path] = { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      state[path] = null;
    }
  }
  return state;
}
function recordMetadata(graph: DependencyGraph): RecordMetadata {
  const setupDependencies = dependencyClosure(graph, setupFiles);
  const globalSetupDependencies = dependencyClosure(graph, globalSetupFiles);
  const environmentFiles = [...envFiles].sort();
  const resolvedSetupFiles = [...setupFiles].sort();
  const resolvedGlobalSetupFiles = [...globalSetupFiles].sort();
  return {
    node: process.versions.node,
    config: configurationFingerprint(root),
    projectDependencies: configuredProjectDependencyFingerprint(),
    setupDependencyFiles: setupDependencies,
    setupDependencies: repositoryFilesFingerprint(root, setupDependencies),
    setupFiles: resolvedSetupFiles,
    globalSetupDependencyFiles: globalSetupDependencies,
    globalSetupDependencies: repositoryFilesFingerprint(root, globalSetupDependencies),
    globalSetupFiles: resolvedGlobalSetupFiles,
    environmentFiles,
    environment: repositoryFilesFingerprint(root, environmentFiles),
    conventionDependencyFiles,
    conventionDependencies: repositoryFilesFingerprint(root, conventionDependencyFiles),
  };
}
type RunStatus =
  | { exitCode: 0; status: 'passed' }
  | { exitCode: 1; status: 'failed' }
  | { exitCode: 130 | 143; signal: InterruptSignal; status: 'interrupted' };
function finishRun(tests: string[], result: DependencyRunResult, previous?: DependencyRecord): RunStatus {
  const outcome = applyDependencyRun(cachePath, {
    dependencyStateForTest: dependencyState,
    metadataForGraph: recordMetadata,
    previous,
    result,
    tests,
  });
  if (outcome.status === 'interrupted') {
    console.error(`Test run interrupted by ${outcome.signal}; previous graph was left unchanged.`);
    const exitCode = signalExitCodes[outcome.signal];
    process.exitCode = exitCode;
    return { ...outcome, exitCode };
  }
  if (outcome.status === 'passed') {
    process.exitCode = 0;
    return { ...outcome, exitCode: 0 };
  }
  console.error('Tests failed; previous dependency graph was left unchanged and failure status was recorded.');
  process.exitCode = 1;
  return { ...outcome, exitCode: 1 };
}
async function baseline(previous?: DependencyRecord, selection?: BaselineOutcome) {
  const tests = discover();
  if (options.dryRun) {
    if (options.output === 'json') {
      printSelectionDocument(tests, selection);
      return;
    }
    for (const line of renderSelectionPreview({ allTests: tests, selection })) console.log(line);
    return;
  }
  (options.output === 'json' ? console.error : console.log)(`Building graph from ${tests.length} test file(s)`);
  const result = await runTests(tests, {}, previous?.durations);
  const runStatus = finishRun(tests, result, previous);
  if (options.output === 'json') printRunDocument(tests, selection, result, runStatus);
}
async function executeSelectionOutcome(
  tests: string[],
  prepare: (record: DependencyRecord) => PreparedSelection,
) {
  await executeSelectionRun({
    baseline,
    empty: options.output === 'json'
      ? (_saved, selection) => {
        if (options.dryRun) {
          printSelectionDocument(tests, selection);
          return;
        }
        printRunDocument(tests, selection, {
          completedTests: [],
          failedTests: [],
        }, { exitCode: 0, status: 'passed' });
      }
      : undefined,
    execute: async (selectedTests, saved, selection, details) => {
      if (options.dryRun) {
        if (options.output === 'json') {
          printSelectionDocument(tests, selection);
          return;
        }
        for (const line of renderSelectionPreview({
          allTests: tests,
          selectedLabel: details.selectedLabel,
          selection,
        })) console.log(line);
        return;
      }
      const result = await runTests(selectedTests, saved.graph, saved.durations);
      const runStatus = finishRun(tests, result, saved);
      if (options.output === 'json') printRunDocument(tests, selection, result, runStatus);
    },
    loadRecord: () => loadUsableCache(tests),
    log: options.output === 'json' ? console.error : console.log,
    prepare: (saved) => ({ ...prepare(saved), announceSelected: !options.dryRun }),
    totalTests: tests.length,
  });
}
let cacheFallback: { kind: 'cache-unavailable'; message: string } | undefined;
function currentSelectionCommand(): SelectionCommand {
  if (!isSelectionCommand(command)) throw new Error(`Command ${command} has no selection provider.`);
  return command;
}
function printSelectionDocument(tests: string[], selection?: SelectionOutcome) {
  console.log(JSON.stringify(createSelectionPreviewDocument({
    allTests: tests,
    cacheFallback,
    command: currentSelectionCommand(),
    projectRoot: root,
    selection,
  }), null, 2));
}
function printRunDocument(
  tests: string[],
  selection: SelectionOutcome | undefined,
  result: Pick<DependencyRunResult, 'completedTests' | 'failedTests'>,
  runStatus: RunStatus,
) {
  console.log(JSON.stringify(createSelectionRunDocument({
    allTests: tests,
    cacheFallback,
    command: currentSelectionCommand(),
    projectRoot: root,
    result,
    runStatus,
    selection,
  }), null, 2));
}
function clearCache() {
  rmSync(cachePath, { force: true });
  console.log(`Cleared cache: ${normal(relative(root, cachePath))}`);
}
function diffFiles(ref?: string): string[] | null {
  try {
    const changes = getGitChanges({ exclude: isCacheRepositoryPath, ref, root });
    return changes.noMergeBase ? null : changes.files;
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}
function loadUsableCache(tests: string[]) {
  const loaded = loadDependencyRecord(cachePath, {
    config: configurationFingerprint(root),
    conventionDependencyFiles,
    environmentFiles: [...envFiles].sort(),
    globalSetupFiles: [...globalSetupFiles].sort(),
    node: process.versions.node,
    projectDependencies: configuredProjectDependencyFingerprint(),
    root,
    setupFiles: [...setupFiles].sort(),
    tests,
  });
  if (loaded.reason) {
    cacheFallback = { kind: 'cache-unavailable', message: loaded.reason };
    (options.output === 'json' ? console.error : console.log)(loaded.reason);
    return;
  }
  return loaded.record;
}
function dependencyStateChanged(state: DependencyState) {
  for (const [path, previous] of Object.entries(state)) {
    try {
      const current = statSync(join(root, path));
      if (!previous || current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) return true;
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      if (previous !== null) return true;
    }
  }
  return false;
}
async function sinceLastRun() {
  const tests = discover();
  await executeSelectionOutcome(tests, (saved) => ({
    emptyMessage: 'No tests changed since last run.',
    selection: selectTestsSinceLastRun({ dependencyStateChanged, record: saved, tests }),
    selectedLabel: 'test file(s) since last run',
  }));
}
async function lastFailed() {
  const tests = discover();
  await executeSelectionOutcome(tests, (saved) => ({
    emptyMessage: 'No previously failing tests.',
    selection: selectLastFailed({ record: saved }),
    selectedLabel: 'previously failing test file(s)',
  }));
}
async function related(files: string[]) {
  const repositoryFiles = [...new Set(files.map((file) => {
    const path = relative(root, resolve(root, file));
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      fail(`Related file is outside the project root: ${file}`);
    }
    return normal(path);
  }))].sort();
  const tests = discover();
  await executeSelectionOutcome(tests, (saved) => ({
    contextMessages: [`Related files: ${repositoryFiles.join(', ')}`],
    emptyMessage: 'No related tests found.',
    selection: selectTestsForFiles({ config: projectConfig, files: repositoryFiles, record: saved, tests }),
    selectedLabel: 'related test file(s)',
  }));
}
async function affected(ref?: string) {
  const changes = diffFiles(ref);
  const tests = discover();
  if (changes === null) {
    await executeSelectionOutcome(tests, () => ({
      selection: {
        kind: 'baseline',
        message: `No merge base with ${ref}; running full suite.`,
        reason: { kind: 'no-merge-base', ref: ref ?? 'unknown ref' },
      },
    }));
    return;
  }
  await executeSelectionOutcome(tests, (saved) => {
    const selection = selectTestsForFiles({ config: projectConfig, files: changes, record: saved, tests });
    return {
      contextMessages: changes.length
        ? [`Changed files: ${changes.join(', ')}`]
        : selection.kind === 'selected' && selection.tests.length
          ? [`No changed files; rerunning ${saved.failedTests.length} previously failing test file(s).`]
          : [],
      emptyMessage: changes.length ? 'No affected tests found.' : 'No changed files.',
      selection,
    };
  });
}
async function watchMode() {
  await baseline();
  if (interruptedSignal) return;

  const ignoredDirectories = new Set<string>(['.git', 'node_modules', 'coverage', 'dist', 'build']);
  const pending = new Set<string>();
  let debounce: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;

  const shouldIgnore = (path: string) => isCacheRepositoryPath(path) ||
    ignoredDirectories.has(path.split('/')[0]);

  const runChanges = async () => {
    if (running || stopped || !pending.size) return;
    running = true;
    const files = [...pending].sort();
    pending.clear();
    try {
      const tests = discover();
      console.log(`Watch changes: ${files.join(', ')}`);
      await executeSelectionOutcome(tests, (saved) => ({
        emptyMessage: 'No related tests found.',
        selection: selectTestsForFiles({ config: projectConfig, files, record: saved, tests }),
      }));
    } catch (error: unknown) {
      console.error(`Watch rerun failed: ${error instanceof Error ? error.stack : error}`);
      process.exitCode = 1;
    } finally {
      running = false;
      if (pending.size && !stopped) {
        clearTimeout(debounce);
        debounce = setTimeout(() => void runChanges(), 100);
      }
    }
  };

  const watcher = watchFiles(root, { recursive: true }, (_event, filename) => {
    if (!filename || stopped) return;
    const path = normal(String(filename));
    if (shouldIgnore(path)) return;
    pending.add(path);
    clearTimeout(debounce);
    debounce = setTimeout(() => void runChanges(), 100);
  });
  watcher.on('error', (error) => {
    console.error(`File watcher failed: ${error.stack ?? error}`);
    process.exitCode = 1;
    stopWatching?.();
  });
  console.log('Watching for changes.');
  sendWatchReady();
  await new Promise<void>((resolveStop) => {
    stopWatching = (signal?: InterruptSignal) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(debounce);
      watcher.close();
      if (signal) process.exitCode = signalExitCodes[signal];
      resolveStop();
    };
  });
  stopWatching = undefined;
}
if (command === 'baseline') {
  await baseline();
} else if (command === 'affected') {
  await affected(options.positionals[0]);
} else if (command === 'related') {
  await related(options.positionals);
} else if (command === 'since-last-run') {
  await sinceLastRun();
} else if (command === 'last-failed') {
  await lastFailed();
} else if (command === 'watch') {
  await watchMode();
} else if (command === 'clear-cache') {
  clearCache();
}
