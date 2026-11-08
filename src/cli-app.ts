import type { ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { resolve, relative, join, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAffectedFirstRunner } from './affected-first-run.ts';
import { isContainedPath } from './contained-path.ts';
import { commandHelp, isCommandName, topLevelHelp } from './cli-help.ts';
import type { CommandName } from './cli-help.ts';
import { configurationFingerprint } from './config.ts';
import { parseCliOptions } from './cli-command.ts';
import { applyDependencyRun, loadDependencyRecord } from './dependency-record.ts';
import type {
  DependencyGraph,
  DependencyRecord,
  DependencyRunResult,
  DependencyState,
  RecordMetadata,
} from './dependency-record.ts';
import { dependenciesForTest } from './dependency-graph.ts';
import { diagnose } from './doctor.ts';
import { createTestExecutor } from './test-execution.ts';
import { getGitChanges } from './git-changes.ts';
import {
  executeSelectionRun,
  selectLastFailed,
  selectTestsForFiles,
  selectTestsSinceLastRun,
} from './selection-run.ts';
import type { BaselineOutcome, SelectionOutcome } from './selection-run.ts';
import type { PreparedSelection } from './selection-run.ts';
import { renderSelectionPreview } from './selection-preview.ts';
import {
  createSelectionPreviewDocument,
  createSelectionRunDocument,
  isSelectionCommand,
} from './selection-document.ts';
import type { SelectionCommand } from './selection-document.ts';
import { runWorkspace } from './workspace.ts';
import { createWatchMode } from './watch-mode.ts';
import { discoverTestFiles } from './test-discovery.ts';
import {
  conventionDependencyPatterns,
  loadProjectConfig,
  matchingRepositoryFiles,
  repositoryFileInventory,
  repositoryFilesFingerprint,
} from './project-config.ts';
import type { ProjectConfig } from './project-config.ts';
import { errorMessage, isNodeError } from './errors.ts';
import { initializeProject } from './init.ts';
import { terminateProcessTree } from './process-control.ts';


export async function runCli(cliPath: string) {
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
  const options = (() => {
    try {
      return parseCliOptions(command, args);
    } catch (error: unknown) {
      return failUsage(errorMessage(error), commandHelp(command));
    }
  })();
  const activeChildren = new Set<ChildProcess>();
  const signalExitCodes = { SIGINT: 130, SIGTERM: 143 } as const;
  type InterruptSignal = keyof typeof signalExitCodes;
  let interruptedSignal: InterruptSignal | undefined;
  let watchController: ReturnType<typeof createWatchMode> | undefined;
  function interrupt(signal: InterruptSignal) {
    if (interruptedSignal) {
      for (const child of activeChildren) terminateProcessTree(child, 'SIGKILL');
      return;
    }
    interruptedSignal = signal;
    for (const child of activeChildren) terminateProcessTree(child, signal);
    const forceKill = setTimeout(() => {
      for (const child of activeChildren) terminateProcessTree(child, 'SIGKILL');
    }, 2_000);
    forceKill.unref();
    watchController?.stop(signal);
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
        options,
        cliPath: cliPath,
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
  if (isAbsolute(projectConfig.cacheDir) || !isContainedPath(root, cacheDirectory)) {
    fail('affected-node-test.config.json: cacheDir must stay within the project root.');
  }
  const cachePath = join(cacheDirectory, 'graph.json');
  const cacheDirectoryRepositoryPath = normal(cacheDirectoryFromRoot);
  const cacheRepositoryPath = normal(relative(root, cachePath));
  watchController = createWatchMode({
    root, cliPath: cliPath, concurrency: options.concurrency,
    activeChildren, isCacheRepositoryPath, getInterruptedSignal: () => interruptedSignal,
  });
  const repositoryInventory = repositoryFileInventory(root).filter((path) => !isCacheRepositoryPath(path));
  function isCacheRepositoryPath(path: string) {
    return path === cacheRepositoryPath || (
      Boolean(cacheDirectoryRepositoryPath) && path.startsWith(`${cacheDirectoryRepositoryPath}/`)
    );
  }
  function matchingProjectFiles(patterns: string[]) {
    return matchingRepositoryFiles(root, patterns, repositoryInventory);
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
  const { runTests } = createTestExecutor({
    root, hook, nodeArgs: projectConfig.nodeArgs, setupFiles, globalSetupFiles, envFiles,
    concurrency: options.concurrency, output: options.output, activeChildren,
    getInterruptedSignal: () => interruptedSignal,
  });

  function discover() {
    return discoverTestFiles(root, projectConfig, repositoryInventory);
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
  const affectedFirst = createAffectedFirstRunner({
    root, output: options.output, phase: options.phase, plan: options.plan, projectConfig,
    discover, diffFiles, loadUsableCache, runTests, finishRun, fail,
    getInterruptedSignal: () => interruptedSignal,
  });
  if (command === 'baseline') {
    await baseline();
  } else if (command === 'affected') {
    await affected(options.positionals[0]);
  } else if (command === 'affected-first') {
    await affectedFirst(options.positionals[0]);
  } else if (command === 'related') {
    await related(options.positionals);
  } else if (command === 'since-last-run') {
    await sinceLastRun();
  } else if (command === 'last-failed') {
    await lastFailed();
  } else if (command === 'watch') {
    await watchController.run();
  } else if (command === 'clear-cache') {
    clearCache();
  }
}
