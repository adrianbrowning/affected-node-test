#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, watch as watchFiles } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve, relative, join, sep, isAbsolute } from 'node:path';
import { availableParallelism, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configurationFingerprint } from '../src/config.mjs';
import { applyDependencyRun, loadDependencyRecord } from '../src/dependency-record.mjs';
import { buildStaticGraph } from '../src/static-graph.mjs';
import { getGitChanges } from '../src/git-changes.mjs';
import { runWorkspace } from '../src/workspace.mjs';
import { sendWatchReady } from '../src/watch-protocol.mjs';
import {
  conventionDependencyPatterns,
  loadProjectConfig,
  matchesPatterns,
  matchingRepositoryFiles,
  repositoryFilesFingerprint,
} from '../src/project-config.mjs';

const root = process.cwd();
const hook = fileURLToPath(new URL('../src/hook.mjs', import.meta.url));
const [command = 'help', ...args] = process.argv.slice(2);
const usage = 'Usage:\n  affected-node-test baseline [--concurrency N]\n  affected-node-test affected [git-ref] [--concurrency N]\n  affected-node-test related <file...> [--concurrency N]\n  affected-node-test since-last-run [--concurrency N]\n  affected-node-test watch [--concurrency N]\n  affected-node-test clear-cache';
const fail = (message) => { console.error(message); process.exit(1); };
if (command === 'help' || command === '--help' || command === '-h') {
  console.log(usage);
  process.exit(0);
}
function parseArguments(values) {
  const positionals = [];
  let concurrency = Math.max(1, Math.min(4, availableParallelism()));
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--concurrency') {
      const value = values[index + 1];
      if (!/^\d+$/.test(value ?? '') || Number(value) < 1) {
        fail('--concurrency must be a positive integer.');
      }
      concurrency = Number(value);
      index += 1;
    } else if (values[index].startsWith('-')) {
      fail(`Unknown option: ${values[index]}`);
    } else {
      positionals.push(values[index]);
    }
  }
  return { concurrency, positionals };
}
const options = parseArguments(args);
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

function discover(dir = root, output = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.affected-tests', 'coverage', 'dist', 'build'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) discover(p, output);
    else if (e.isFile()) {
      const repositoryPath = normal(relative(root, p));
      const included = projectConfig.include.length
        ? matchesPatterns(repositoryPath, projectConfig.include)
        : /(?:\.test|\.spec)\.[cm]?js$/.test(e.name);
      if (included && !matchesPatterns(repositoryPath, projectConfig.exclude)) output.push(repositoryPath);
    }
  }
  return output.sort();
}
function graphForTest(test) {
  const folder = mkdtempSync(join(tmpdir(), 'affected-test-'));
  const log = join(folder, 'edges.jsonl');
  return new Promise((resolveResult) => {
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
async function runTests(tests, oldGraph = {}) {
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
  const results = new Array(tests.length);
  let nextIndex = 0;
  async function worker() {
    while (!interruptedSignal && nextIndex < tests.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await graphForTest(tests[index]);
    }
  }
  const workerCount = Math.min(options.concurrency, tests.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const completedTests = [];
  const failedTests = [];
  const unresolvedStaticTests = [];
  for (let index = 0; index < tests.length; index += 1) {
    const test = tests[index];
    const result = results[index];
    if (!result) continue;
    console.log(`\n▶ ${test}`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    resultGraph[test] = result.edges;
    completedTests.push(test);
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
  return { completedTests, failedTests, resultGraph, interrupted: interruptedSignal, unresolvedStaticTests };
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
  for (const path of [...dependencies(graph[test] ?? [], test)].sort()) {
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
async function baseline() {
  const tests = discover();
  console.log(`Building graph from ${tests.length} test file(s)`);
  finishRun(tests, await runTests(tests));
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
function dependencies(edges, test) {
  const adjacency = new Map();
  for (const [parent, child] of edges) {
    if (!adjacency.has(parent)) adjacency.set(parent, new Set());
    adjacency.get(parent).add(child);
  }
  const visited = new Set([test]);
  const stack = [test];
  while (stack.length) {
    for (const dep of adjacency.get(stack.pop()) ?? []) {
      if (!visited.has(dep)) { visited.add(dep); stack.push(dep); }
    }
  }
  return visited;
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
  const saved = loadUsableCache(tests);
  if (!saved) return baseline();
  const selected = new Set(saved.failedTests);
  for (const test of tests) {
    const state = saved.dependencyStates[test];
    if (!state || dependencyStateChanged(state)) selected.add(test);
  }
  if (!selected.size) { console.log('No tests changed since last run.'); return; }
  const selectedTests = [...selected].sort();
  console.log(`Selected ${selectedTests.length}/${tests.length} test file(s) since last run`);
  finishRun(tests, await runTests(selectedTests, saved.graph), saved);
}
function selectForFiles(tests, saved, files) {
  const forcedChange = files.find((path) => matchesPatterns(path, projectConfig.forceRerunTriggers));
  if (forcedChange) return { fullRunMessage: `Force-rerun trigger matched: ${forcedChange}; running full suite.` };
  if (files.some((path) => /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|node_modules\/|tsconfig[^/]*\.json|\.npmrc|\.node-version|\.nvmrc)$/.test(path))) {
    return { fullRunMessage: 'Project configuration changed; running full suite.' };
  }
  const selected = new Set(saved.failedTests);
  const known = new Set(tests);
  for (const test of tests) for (const [parent, child] of saved.graph[test] ?? []) {
    known.add(parent);
    known.add(child);
  }
  const codeChange = (path) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path);
  const unknownCode = files.filter((path) => codeChange(path) && !known.has(path));
  if (unknownCode.length) {
    return { fullRunMessage: `Unknown code file changed (${unknownCode.join(', ')}); running full suite.` };
  }
  if (files.some(codeChange)) {
    for (const test of saved.unresolvedStaticTests) selected.add(test);
  }
  const messages = [];
  const watchTriggeredChanges = new Set();
  const watchTriggeredTests = new Set();
  for (const mapping of projectConfig.watchTriggerPatterns) {
    for (const file of files) {
      if (!matchesPatterns(file, [mapping.pattern])) continue;
      watchTriggeredChanges.add(file);
      const mappedTests = tests.filter((test) => matchesPatterns(test, mapping.tests));
      if (!mappedTests.length) {
        return { fullRunMessage: `Watch trigger matched ${file} but selected no tests; running full suite.` };
      }
      for (const test of mappedTests) {
        selected.add(test);
        watchTriggeredTests.add(test);
      }
    }
  }
  if (watchTriggeredChanges.size) {
    messages.push(`Watch trigger matched ${[...watchTriggeredChanges].join(', ')}; selected ${watchTriggeredTests.size} mapped test file(s).`);
  }
  for (const test of tests) {
    if (files.some((file) => dependencies(saved.graph[test] ?? [], test).has(file))) selected.add(test);
  }
  return { messages, selected };
}
async function related(files) {
  if (!files.length) fail('Usage: affected-node-test related <file...> [--concurrency N]');
  const repositoryFiles = [...new Set(files.map((file) => {
    const path = relative(root, resolve(root, file));
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      fail(`Related file is outside the project root: ${file}`);
    }
    return normal(path);
  }))].sort();
  const tests = discover();
  const saved = loadUsableCache(tests);
  if (!saved) return baseline();
  const selection = selectForFiles(tests, saved, repositoryFiles);
  if (selection.fullRunMessage) {
    console.log(selection.fullRunMessage); return baseline();
  }
  for (const message of selection.messages) console.log(message);
  console.log(`Related files: ${repositoryFiles.join(', ')}`);
  if (!selection.selected.size) { console.log('No related tests found.'); return; }
  const selectedTests = [...selection.selected].sort();
  console.log(`Selected ${selectedTests.length}/${tests.length} related test file(s)`);
  finishRun(tests, await runTests(selectedTests, saved.graph), saved);
}
async function affected(ref) {
  const changes = diffFiles(ref);
  const tests = discover();
  const saved = loadUsableCache(tests);
  if (!saved) return baseline();
  if (changes === null) {
    console.log(`No merge base with ${ref}; running full suite.`); return baseline();
  }
  if (!changes.length && !saved.failedTests.length) { console.log('No changed files.'); return; }
  const selection = selectForFiles(tests, saved, changes);
  if (selection.fullRunMessage) {
    console.log(selection.fullRunMessage); return baseline();
  }
  for (const message of selection.messages) console.log(message);
  if (changes.length) console.log(`Changed files: ${changes.join(', ')}`);
  else console.log(`No changed files; rerunning ${saved.failedTests.length} previously failing test file(s).`);
  if (!selection.selected.size) { console.log('No affected tests found.'); return; }
  const selectedTests = [...selection.selected].sort();
  console.log(`Selected ${selectedTests.length}/${tests.length} test file(s)`);
  finishRun(tests, await runTests(selectedTests, saved.graph), saved);
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
      const saved = loadUsableCache(tests);
      console.log(`Watch changes: ${files.join(', ')}`);
      if (!saved) {
        await baseline();
      } else {
        const selection = selectForFiles(tests, saved, files);
        if (selection.fullRunMessage) {
          console.log(selection.fullRunMessage);
          await baseline();
        } else {
          for (const message of selection.messages) console.log(message);
          if (!selection.selected.size) {
            console.log('No related tests found.');
          } else {
            const selectedTests = [...selection.selected].sort();
            console.log(`Selected ${selectedTests.length}/${tests.length} test file(s)`);
            finishRun(tests, await runTests(selectedTests, saved.graph), saved);
          }
        }
      }
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
  if (options.positionals.length) fail(`Unexpected argument: ${options.positionals[0]}`);
  await baseline();
} else if (command === 'affected') {
  if (options.positionals.length > 1) fail('Usage: affected-node-test affected [git-ref] [--concurrency N]');
  await affected(options.positionals[0]);
} else if (command === 'related') {
  await related(options.positionals);
} else if (command === 'since-last-run') {
  if (options.positionals.length) fail(`Unexpected argument: ${options.positionals[0]}`);
  await sinceLastRun();
} else if (command === 'watch') {
  if (options.positionals.length) fail(`Unexpected argument: ${options.positionals[0]}`);
  await watchMode();
} else if (command === 'clear-cache') {
  if (options.positionals.length) fail(`Unexpected argument: ${options.positionals[0]}`);
  clearCache();
}
else fail(`Unknown command: ${command}\n\n${usage}`);
