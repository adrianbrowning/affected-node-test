import { rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CommandName } from './command-catalog.ts';
import { configurationFingerprint } from './config.ts';
import { dependenciesForTest } from './dependency-graph.ts';
import { applyDependencyRun, loadDependencyRecord } from './dependency-record.ts';
import type { DependencyGraph, DependencyRecord, DependencyRunResult, DependencyState, RecordMetadata } from './dependency-record.ts';
import { errorMessage, isNodeError } from './errors.ts';
import { getGitChanges } from './git-changes.ts';
import type { ProjectConfig } from './project-config.ts';
import { matchingRepositoryFiles, repositoryFilesFingerprint } from './project-config.ts';
import { createSelectionPreviewDocument, createSelectionRunDocument, isSelectionCommand } from './selection-document.ts';
import type { SelectionCommand } from './selection-document.ts';
import { renderSelectionPreview } from './selection-preview.ts';
import { selectLastFailed, selectTestsForFiles, selectTestsSinceLastRun } from './selection-run.ts';
import type { BaselineOutcome, PreparedSelection, SelectionOutcome } from './selection-run.ts';
import type { createTestExecutor } from './test-execution.ts';

type InterruptSignal = 'SIGINT' | 'SIGTERM';
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 } as const;

export function createSelectionExecution({ root, cachePath, command, projectConfig, setupFiles,
  globalSetupFiles, envFiles, conventionDependencyFiles, repositoryInventory, discover, runTests,
  isCacheRepositoryPath, dryRun, output, fail }: {
  root: string;
  cachePath: string;
  command: CommandName;
  projectConfig: ProjectConfig;
  setupFiles: Set<string>;
  globalSetupFiles: Set<string>;
  envFiles: Set<string>;
  conventionDependencyFiles: string[];
  repositoryInventory: string[];
  discover: () => string[];
  runTests: ReturnType<typeof createTestExecutor>['runTests'];
  isCacheRepositoryPath: (path: string) => boolean;
  dryRun: boolean;
  output: 'human' | 'json';
  fail: (message: string) => never;
}) {
  const normal = (path: string) => path.split(sep).join('/').replace(/^\.\//, '');
  function configuredProjectDependencyFingerprint() {
    return repositoryFilesFingerprint(root, matchingRepositoryFiles(root, projectConfig.projectDependencies, repositoryInventory));
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
    if (dryRun) {
      if (output === 'json') {
        printSelectionDocument(tests, selection);
        return;
      }
      for (const line of renderSelectionPreview({ allTests: tests, selection })) console.log(line);
      return;
    }
    (output === 'json' ? console.error : console.log)(`Building graph from ${tests.length} test file(s)`);
    const result = await runTests(tests, {}, previous?.durations);
    const runStatus = finishRun(tests, result, previous);
    if (output === 'json') printRunDocument(tests, selection, result, runStatus);
  }
  async function executeSelectionOutcome(
    tests: string[],
    prepare: (record: DependencyRecord) => PreparedSelection,
  ) {
    const saved = loadUsableCache(tests);
    if (!saved) {
      await baseline();
      return;
    }
    const { selection, contextMessages = [], emptyMessage = 'No tests selected.',
      selectedLabel = 'test file(s)' } = prepare(saved);
    const log = output === 'json' ? console.error : console.log;
    if (selection.kind === 'baseline') {
      log(selection.message);
      await baseline(saved, selection);
      return;
    }
    for (const message of selection.messages) log(message);
    for (const message of contextMessages) log(message);
    if (!selection.tests.length) {
      log(emptyMessage);
      if (output === 'json') {
        if (dryRun) printSelectionDocument(tests, selection);
        else printRunDocument(tests, selection, { completedTests: [], failedTests: [] },
          { exitCode: 0, status: 'passed' });
      }
      return;
    }
    if (!dryRun) log(`Selected ${selection.tests.length}/${tests.length} ${selectedLabel}`);
    if (dryRun) {
      if (output === 'json') printSelectionDocument(tests, selection);
      else for (const line of renderSelectionPreview({
        allTests: tests, selectedLabel, selection,
      })) console.log(line);
      return;
    }
    const result = await runTests(selection.tests, saved.graph, saved.durations);
    const runStatus = finishRun(tests, result, saved);
    if (output === 'json') printRunDocument(tests, selection, result, runStatus);
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
      (output === 'json' ? console.error : console.log)(loaded.reason);
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

  async function run(positionals: string[]) {
    if (command === 'baseline') await baseline();
    else if (command === 'affected') await affected(positionals[0]);
    else if (command === 'related') await related(positionals);
    else if (command === 'since-last-run') await sinceLastRun();
    else if (command === 'last-failed') await lastFailed();
    else throw new Error(`Command ${command} does not select tests.`);
  }
  return { run, clearCache, diffFiles, loadUsableCache, finishRun };
}
