import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, relative, join, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAffectedFirstRunner } from './affected-first-run.ts';
import { isContainedPath } from './contained-path.ts';
import { commandHelp, isCommandName, topLevelHelp } from './command-catalog.ts';
import type { CommandName } from './command-catalog.ts';
import { parseCliOptions } from './cli-command.ts';
import { createSelectionExecution } from './selection-execution.ts';
import { diagnose } from './doctor.ts';
import { createTestExecutor } from './test-execution.ts';
import { isSelectionCommand } from './selection-document.ts';
import { runWorkspace } from './workspace.ts';
import { createWatchMode } from './watch-mode.ts';
import { discoverTestFiles } from './test-discovery.ts';
import {
  conventionDependencyPatterns,
  loadProjectConfig,
  matchingRepositoryFiles,
  repositoryFileInventory,
} from './project-config.ts';
import type { ProjectConfig } from './project-config.ts';
import { errorMessage } from './errors.ts';
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
  const options = (() => {
    try {
      return parseCliOptions(command, args);
    } catch (error: unknown) {
      return failUsage(errorMessage(error), commandHelp(command));
    }
  })();
  if (command === 'init') {
    try {
      const result = initializeProject(root, { write: options.write });
      for (const line of result.output) console.log(line);
      for (const conflict of result.conflicts) console.error(conflict);
      process.exit(result.conflicts.length ? 1 : 0);
    } catch (error: unknown) {
      fail(errorMessage(error));
    }
  }
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
  const selectionExecution = createSelectionExecution({
    root, cachePath, command, projectConfig, setupFiles, globalSetupFiles, envFiles,
    conventionDependencyFiles, repositoryInventory, discover, runTests,
    isCacheRepositoryPath, dryRun: options.dryRun, output: options.output, fail,
  });
  const { diffFiles, loadUsableCache, finishRun } = selectionExecution;
  const affectedFirst = createAffectedFirstRunner({
    root, output: options.output, phase: options.phase, plan: options.plan, projectConfig,
    discover, diffFiles, loadUsableCache, runTests, finishRun, fail,
    getInterruptedSignal: () => interruptedSignal,
  });
  if (isSelectionCommand(command)) {
    await selectionExecution.run(options.positionals);
  } else if (command === 'affected-first') {
    await affectedFirst(options.positionals[0]);
  } else if (command === 'watch') {
    await watchController.run();
  } else if (command === 'clear-cache') {
    selectionExecution.clearCache();
  }
}
