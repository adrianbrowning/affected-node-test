#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, watch as watchFiles } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve, relative, join, sep, isAbsolute } from 'node:path';
import { availableParallelism, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { commandHelp, commandNames, topLevelHelp } from '../src/cli-help.mjs';
import { configurationFingerprint } from '../src/config.mjs';
import { applyDependencyRun, loadDependencyRecord } from '../src/dependency-record.mjs';
import { dependenciesForTest } from '../src/dependency-graph.mjs';
import { diagnose } from '../src/doctor.mjs';
import { buildStaticGraph } from '../src/static-graph.mjs';
import { getGitChanges } from '../src/git-changes.mjs';
import {
  executeSelectionRun,
  selectTestsForFiles,
  selectTestsSinceLastRun,
} from '../src/selection-run.mjs';
import { runWorkspace } from '../src/workspace.mjs';
import { sendWatchReady } from '../src/watch-protocol.mjs';
import { discoverTestFiles } from '../src/test-discovery.mjs';
import {
  conventionDependencyPatterns,
  loadProjectConfig,
  matchingRepositoryFiles,
  repositoryFilesFingerprint,
} from '../src/project-config.mjs';

const root = process.cwd();
const hook = fileURLToPath(new URL('../src/hook.mjs', import.meta.url));
const [command = 'help', ...args] = process.argv.slice(2);
const fail = (message) => { console.error(message); process.exit(1); };
const failUsage = (message, help) => fail(`${message}\n\n${help}`);
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
if (command === '--version' || command === '-v') {
  if (args.length) failUsage(`Unexpected argument: ${args[0]}`, topLevelHelp());
  console.log(`affected-node-test ${packageJson.version}`);
  process.exit(0);
}
if (command === 'help' || command === '--help' || command === '-h') {
  if (args.length > 1) failUsage(`Unexpected argument: ${args[1]}`, topLevelHelp());
  if (args[0] && !commandNames.includes(args[0])) {
    failUsage(`Unknown command: ${args[0]}`, topLevelHelp());
  }
  console.log(args[0] ? commandHelp(args[0]) : topLevelHelp());
  process.exit(0);
}
if (!commandNames.includes(command)) failUsage(`Unknown command: ${command}`, topLevelHelp());
if (args.includes('--help') || args.includes('-h')) {
  console.log(commandHelp(command));
  process.exit(0);
}
function parseArguments(values) {
  const positionals = [];
  let concurrency = Math.max(1, Math.min(4, availableParallelism()));
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--concurrency') {
      const value = values[index + 1];
      if (!/^\d+$/.test(value ?? '') || Number(value) < 1) {
        failUsage('--concurrency must be a positive integer.', commandHelp(command));
      }
      concurrency = Number(value);
      index += 1;
    } else if (values[index].startsWith('-')) {
      failUsage(`Unknown option: ${values[index]}`, commandHelp(command));
    } else {
      positionals.push(values[index]);
    }
  }
  return { concurrency, positionals };
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
const activeChildren = new Set();
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };
let interruptedSignal;
let stopWatching;
function killChildTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
function interrupt(signal) {
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
const normal = (p) => p.split(sep).join('/').replace(/^\.\//, '');
let projectConfig;
try {
  projectConfig = loadProjectConfig(root);
} catch (error) {
  fail(error.message);
}
if (command === 'doctor') {
  try {
    const report = diagnose(root, projectConfig);
    console.log(report.lines.join('\n'));
    for (const problem of report.problems) console.error(`Problem: ${problem}`);
    process.exit(report.problems.length ? 1 : 0);
  } catch (error) {
    fail(error.message);
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
  } catch (error) {
    fail(error.message);
  }
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
function isCacheRepositoryPath(path) {
  return path === cacheRepositoryPath || (
    cacheDirectoryRepositoryPath && path.startsWith(`${cacheDirectoryRepositoryPath}/`)
  );
}
function matchingProjectFiles(patterns) {
  return matchingRepositoryFiles(root, patterns).filter((path) => !isCacheRepositoryPath(path));
}
function configuredProjectDependencyFingerprint() {
  return repositoryFilesFingerprint(root, matchingProjectFiles(projectConfig.projectDependencies));
}
function resolveConfiguredFiles(key, patterns) {
  const files = new Set();
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
const globalSetupEdges = [];
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
        const inside = (path) => path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
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
function graphForTest(test) {
  const folder = mkdtempSync(join(tmpdir(), 'affected-test-'));
  const log = join(folder, 'edges.jsonl');
  return new Promise((resolveResult) => {
    const startedAt = performance.now();
    const imports = [hook, ...[...setupFiles].map((file) => join(root, file))]
      .flatMap((file) => ['--import', file]);
    const child = spawn(process.execPath,
      [...projectConfig.nodeArgs, ...imports, '--test', join(root, test)],
      { cwd: root, detached: process.platform !== 'win32', stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env,
        AFFECTED_TESTS_EDGES_FILE: log, AFFECTED_TESTS_ROOT: root } });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { stderr += `${error.stack ?? error}\n`; });
    child.on('close', (code) => {
      activeChildren.delete(child);
      try {
        const edges = existsSync(log)
          ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
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
        });
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });
  });
}
function lifecycleFailure(tests, resultGraph) {
  return {
    completedTests: tests,
    failedTests: tests,
    resultGraph,
    interrupted: interruptedSignal,
  };
}
async function runTests(tests, oldGraph = {}, historicalDurations = {}) {
  const resultGraph = { ...oldGraph };
  const teardowns = [];
  if (tests.length) {
    try {
      for (const file of envFiles) process.loadEnvFile(join(root, file));
    } catch (error) {
      console.error(`Environment file loading failed: ${error.stack ?? error}`);
      return lifecycleFailure(tests, resultGraph);
    }
    try {
      for (const file of globalSetupFiles) {
        recordGlobalSetupEdges = true;
        const module = await import(pathToFileURL(join(root, file)).href);
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
    } catch (error) {
      console.error(`Global setup failed: ${error.stack ?? error}`);
      for (const teardown of teardowns) {
        try { await teardown(); } catch (teardownError) {
          console.error(`Global teardown failed: ${teardownError.stack ?? teardownError}`);
        }
      }
      return lifecycleFailure(tests, resultGraph);
    } finally {
      recordGlobalSetupEdges = false;
    }
  }
  const scheduledTests = [...tests].sort((left, right) =>
    (historicalDurations[right] ?? -1) - (historicalDurations[left] ?? -1) || left.localeCompare(right));
  const results = new Map();
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
  const completedTests = [];
  const durations = {};
  const failedTests = [];
  const unresolvedStaticTests = [];
  for (const test of tests) {
    const result = results.get(test);
    if (!result) continue;
    console.log(`\n▶ ${test}`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
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
    } catch (error) {
      console.error(`Global teardown failed: ${error.stack ?? error}`);
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
function dependencyClosure(graph, roots) {
  const adjacency = new Map();
  for (const edges of Object.values(graph)) {
    for (const [parent, child] of edges) {
      if (!adjacency.has(parent)) adjacency.set(parent, new Set());
      adjacency.get(parent).add(child);
    }
  }
  const visited = new Set(roots);
  const stack = [...roots];
  while (stack.length) {
    for (const dependency of adjacency.get(stack.pop()) ?? []) {
      if (!visited.has(dependency)) {
        visited.add(dependency);
        stack.push(dependency);
      }
    }
  }
  return [...visited].sort();
}
function dependencyState(graph, test) {
  const state = {};
  for (const path of [...dependenciesForTest(graph[test] ?? [], test)].sort()) {
    try {
      const stats = statSync(join(root, path));
      state[path] = { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state[path] = null;
    }
  }
  return state;
}
function recordMetadata(graph) {
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
function finishRun(tests, result, previous) {
  const outcome = applyDependencyRun(cachePath, {
    dependencyStateForTest: dependencyState,
    metadataForGraph: recordMetadata,
    previous,
    result,
    tests,
  });
  if (outcome.status === 'interrupted') {
    console.error(`Test run interrupted by ${outcome.signal}; previous graph was left unchanged.`);
    process.exitCode = signalExitCodes[outcome.signal];
    return;
  }
  if (outcome.status === 'passed') {
    process.exitCode = 0;
    return;
  }
  console.error('Tests failed; previous dependency graph was left unchanged and failure status was recorded.');
  process.exitCode = 1;
}
async function baseline(previous) {
  const tests = discover();
  console.log(`Building graph from ${tests.length} test file(s)`);
  finishRun(tests, await runTests(tests, {}, previous?.durations));
}
async function executeSelectionOutcome(tests, prepare) {
  await executeSelectionRun({
    baseline,
    execute: async (selectedTests, saved) =>
      finishRun(tests, await runTests(selectedTests, saved.graph, saved.durations), saved),
    loadRecord: () => loadUsableCache(tests),
    log: console.log,
    prepare,
    totalTests: tests.length,
  });
}
function clearCache() {
  rmSync(cachePath, { force: true });
  console.log(`Cleared cache: ${normal(relative(root, cachePath))}`);
}
function diffFiles(ref) {
  let changes;
  try {
    changes = getGitChanges({ exclude: isCacheRepositoryPath, ref, root });
  } catch (error) {
    fail(error.message);
  }
  return changes.noMergeBase ? null : changes.files;
}
function loadUsableCache(tests) {
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
    console.log(loaded.reason);
    return;
  }
  return loaded.record;
}
function dependencyStateChanged(state) {
  for (const [path, previous] of Object.entries(state)) {
    try {
      const current = statSync(join(root, path));
      if (!previous || current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
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
async function related(files) {
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
async function affected(ref) {
  const changes = diffFiles(ref);
  const tests = discover();
  await executeSelectionOutcome(tests, (saved) => {
    if (changes === null) {
      return {
        selection: { kind: 'baseline', message: `No merge base with ${ref}; running full suite.` },
      };
    }
    const selection = selectTestsForFiles({ config: projectConfig, files: changes, record: saved, tests });
    return {
      contextMessages: changes.length
        ? [`Changed files: ${changes.join(', ')}`]
        : selection.tests.length
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

  const ignoredDirectories = new Set(['.git', 'node_modules', 'coverage', 'dist', 'build']);
  const pending = new Set();
  let debounce;
  let running = false;
  let stopped = false;

  const shouldIgnore = (path) => isCacheRepositoryPath(path) ||
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
    } catch (error) {
      console.error(`Watch rerun failed: ${error.stack ?? error}`);
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
  await new Promise((resolveStop) => {
    stopWatching = (signal) => {
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
} else if (command === 'watch') {
  await watchMode();
} else if (command === 'clear-cache') {
  clearCache();
}
