#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve, relative, join, sep, isAbsolute } from 'node:path';
import { availableParallelism, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomically } from '../src/cache.mjs';
import { configurationFingerprint } from '../src/config.mjs';
import { buildStaticGraph } from '../src/static-graph.mjs';
import {
  conventionDependencyPatterns,
  loadProjectConfig,
  matchesPatterns,
  matchingRepositoryFiles,
  projectDependencyFingerprint,
  repositoryFilesFingerprint,
} from '../src/project-config.mjs';

const root = process.cwd();
const hook = fileURLToPath(new URL('../src/hook.mjs', import.meta.url));
const cachePath = join(root, '.affected-tests', 'graph.json');
const [command = 'help', ...args] = process.argv.slice(2);
const usage = 'Usage:\n  affected-node-test baseline [--concurrency N]\n  affected-node-test affected [git-ref] [--concurrency N]\n  affected-node-test related <file...> [--concurrency N]\n  affected-node-test since-last-run [--concurrency N]';
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
}
process.once('SIGINT', () => interrupt('SIGINT'));
process.once('SIGTERM', () => interrupt('SIGTERM'));
const normal = (p) => p.split(sep).join('/').replace(/^\.\//, '');
const runGit = (...argv) => {
  const result = spawnSync('git', argv, { cwd: root, encoding: 'buffer' });
  if (result.status !== 0) fail(`Git failed: git ${argv.join(' ')}\n${result.stderr}`);
  return result.stdout;
};
if (command === 'affected') {
  const gitRoot = resolve(String(runGit('rev-parse', '--show-toplevel')).trim());
  if (gitRoot !== root) fail('Run affected from the Git repository root.');
}
let projectConfig;
try {
  projectConfig = loadProjectConfig(root);
} catch (error) {
  fail(error.message);
}
function resolveConfiguredFiles(key, patterns) {
  const files = new Set();
  for (const pattern of patterns) {
    const matches = matchingRepositoryFiles(root, [pattern]);
    if (!matches.length) fail(`affected-node-test.config.json: ${key} pattern matched no files: ${pattern}`);
    for (const match of matches) files.add(match);
  }
  return files;
}
const setupFiles = resolveConfiguredFiles('setupFiles', projectConfig.setupFiles);
const globalSetupFiles = resolveConfiguredFiles('globalSetupFiles', projectConfig.globalSetupFiles);
const envFiles = resolveConfiguredFiles('envFiles', projectConfig.envFiles);
const conventionDependencyFiles = matchingRepositoryFiles(root, conventionDependencyPatterns);
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
      [...imports, '--test', join(root, test)],
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
function save(tests, graph, failedTests = [], dependencyStates = {}, unresolvedStaticTests = []) {
  const setupDependencies = dependencyClosure(graph, setupFiles);
  const globalSetupDependencies = dependencyClosure(graph, globalSetupFiles);
  const environmentFiles = [...envFiles].sort();
  const resolvedSetupFiles = [...setupFiles].sort();
  const resolvedGlobalSetupFiles = [...globalSetupFiles].sort();
  // Dependency graphs are complete snapshots; failed runs only update status metadata.
  writeJsonAtomically(cachePath, {
    version: 10,
    node: process.versions.node,
    config: configurationFingerprint(root),
    projectDependencies: projectDependencyFingerprint(root, projectConfig.projectDependencies),
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
    tests,
    graph,
    failedTests: [...failedTests].sort(),
    dependencyStates,
    unresolvedStaticTests: [...unresolvedStaticTests].sort(),
  });
}
function isValidCache(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) ||
      typeof saved.config !== 'string' || !Array.isArray(saved.tests) ||
      typeof saved.projectDependencies !== 'string' ||
      !Array.isArray(saved.setupDependencyFiles) || typeof saved.setupDependencies !== 'string' ||
      !Array.isArray(saved.setupFiles) ||
      !Array.isArray(saved.globalSetupDependencyFiles) || typeof saved.globalSetupDependencies !== 'string' ||
      !Array.isArray(saved.globalSetupFiles) ||
      !Array.isArray(saved.environmentFiles) || typeof saved.environment !== 'string' ||
      !Array.isArray(saved.conventionDependencyFiles) || typeof saved.conventionDependencies !== 'string' ||
      !saved.dependencyStates || typeof saved.dependencyStates !== 'object' || Array.isArray(saved.dependencyStates) ||
      !Array.isArray(saved.failedTests) ||
      !Array.isArray(saved.unresolvedStaticTests) ||
      !saved.graph || typeof saved.graph !== 'object' || Array.isArray(saved.graph)) {
    return false;
  }
  const testSet = new Set(saved.tests);
  return saved.setupDependencyFiles.every((path) => typeof path === 'string') &&
    saved.setupFiles.every((path) => typeof path === 'string') &&
    saved.globalSetupDependencyFiles.every((path) => typeof path === 'string') &&
    saved.globalSetupFiles.every((path) => typeof path === 'string') &&
    saved.environmentFiles.every((path) => typeof path === 'string') &&
    saved.conventionDependencyFiles.every((path) => typeof path === 'string') &&
    Object.values(saved.dependencyStates).every((state) => state && typeof state === 'object' && !Array.isArray(state)) &&
    saved.failedTests.every((test) => typeof test === 'string' && testSet.has(test)) &&
    saved.unresolvedStaticTests.every((test) => typeof test === 'string' && testSet.has(test)) &&
    saved.tests.every((test) => typeof test === 'string' &&
    Array.isArray(saved.graph[test]) && saved.graph[test].every((edge) =>
      Array.isArray(edge) && edge.length === 2 && edge.every((part) => typeof part === 'string')));
}
function finishRun(tests, result, previous) {
  const { completedTests, failedTests, resultGraph, interrupted, unresolvedStaticTests = [] } = result;
  if (interrupted) {
    console.error(`Test run interrupted by ${interrupted}; previous graph was left unchanged.`);
    process.exitCode = signalExitCodes[interrupted];
    return;
  }
  if (!failedTests.length) {
    const dependencyStates = { ...(previous?.dependencyStates ?? {}) };
    const unresolved = new Set(previous?.unresolvedStaticTests ?? []);
    for (const test of completedTests) dependencyStates[test] = dependencyState(resultGraph, test);
    for (const test of completedTests) unresolved.delete(test);
    for (const test of unresolvedStaticTests) unresolved.add(test);
    save(tests, resultGraph, [], dependencyStates, unresolved);
    process.exitCode = 0;
    return;
  }
  if (previous) {
    const stickyFailures = new Set(previous.failedTests);
    for (const test of completedTests) stickyFailures.delete(test);
    for (const test of failedTests) stickyFailures.add(test);
    save(tests, previous.graph, stickyFailures, previous.dependencyStates, previous.unresolvedStaticTests);
  }
  console.error('Tests failed; previous dependency graph was left unchanged and failure status was recorded.');
  process.exitCode = 1;
}
async function baseline() {
  const tests = discover();
  console.log(`Building graph from ${tests.length} test file(s)`);
  finishRun(tests, await runTests(tests));
}
function diffFiles(ref) {
  let base = 'HEAD';
  if (ref) {
    const mergeBase = spawnSync('git', ['merge-base', ref, 'HEAD'], { cwd: root, encoding: 'buffer' });
    if (mergeBase.status === 1) return null;
    if (mergeBase.status !== 0) fail(`Git failed: git merge-base ${ref} HEAD\n${mergeBase.stderr}`);
    base = mergeBase.stdout.toString('utf8').trim();
  }
  const changed = runGit('diff', '--name-only', '-z', base, '--').toString('utf8').split('\0').filter(Boolean);
  // `git diff` does not show untracked additions.
  const untracked = runGit('ls-files', '--others', '--exclude-standard', '-z').toString('utf8').split('\0').filter(Boolean);
  return [...new Set([...changed, ...untracked].map(normal))].filter((p) => !p.startsWith('.affected-tests/')); 
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
  let saved;
  try { saved = JSON.parse(readFileSync(cachePath, 'utf8')); } catch {
    console.log('No graph cache; running full suite.'); return;
  }
  if (!isValidCache(saved)) {
    console.log('Invalid graph cache; running full suite.'); return;
  }
  if (saved.version !== 10 || saved.node !== process.versions.node ||
      JSON.stringify(saved.tests) !== JSON.stringify(tests)) {
    console.log('Test files or runtime changed; running full suite.'); return;
  }
  if (saved.config !== configurationFingerprint(root)) {
    console.log('Project configuration changed since graph was built; running full suite.'); return;
  }
  if (saved.projectDependencies !== projectDependencyFingerprint(root, projectConfig.projectDependencies)) {
    console.log('Project dependencies changed since graph was built; running full suite.'); return;
  }
  if (JSON.stringify(saved.environmentFiles) !== JSON.stringify([...envFiles].sort()) ||
      saved.environment !== repositoryFilesFingerprint(root, saved.environmentFiles)) {
    console.log('Environment files changed since graph was built; running full suite.'); return;
  }
  if (JSON.stringify(saved.conventionDependencyFiles) !== JSON.stringify(conventionDependencyFiles) ||
      saved.conventionDependencies !== repositoryFilesFingerprint(root, saved.conventionDependencyFiles)) {
    console.log('Convention dependencies changed since graph was built; running full suite.'); return;
  }
  if (JSON.stringify(saved.setupFiles) !== JSON.stringify([...setupFiles].sort()) ||
      saved.setupDependencies !== repositoryFilesFingerprint(root, saved.setupDependencyFiles)) {
    console.log('Setup dependencies changed since graph was built; running full suite.'); return;
  }
  if (JSON.stringify(saved.globalSetupFiles) !== JSON.stringify([...globalSetupFiles].sort()) ||
      saved.globalSetupDependencies !== repositoryFilesFingerprint(root, saved.globalSetupDependencyFiles)) {
    console.log('Global setup dependencies changed since graph was built; running full suite.'); return;
  }
  return saved;
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
  const jsChange = (path) => /\.[cm]?js$/.test(path);
  const unknownCode = files.filter((path) => jsChange(path) && !known.has(path));
  if (unknownCode.length) {
    return { fullRunMessage: `Unknown JS file changed (${unknownCode.join(', ')}); running full suite.` };
  }
  if (files.some(jsChange)) {
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
  const tests = discover();
  const saved = loadUsableCache(tests);
  if (!saved) return baseline();
  const changes = diffFiles(ref);
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
}
else fail(`Unknown command: ${command}\n\n${usage}`);
