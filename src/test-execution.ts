import type { ChildProcess } from 'node:child_process';
import { registerHooks } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DependencyEdge } from './dependency-graph.ts';
import type { DependencyGraph, DependencyRunResult } from './dependency-record.ts';
import { createTestWorker } from './test-worker.ts';
import type { GraphTestResult } from './test-worker.ts';

type InterruptSignal = 'SIGINT' | 'SIGTERM';

export function createTestExecutor({ root, hook, nodeArgs, setupFiles, globalSetupFiles, envFiles,
  concurrency, output, activeChildren, getInterruptedSignal }: {
  root: string;
  hook: string;
  nodeArgs: string[];
  setupFiles: Set<string>;
  globalSetupFiles: Set<string>;
  envFiles: Set<string>;
  concurrency: number;
  output: 'human' | 'json';
  activeChildren: Set<ChildProcess>;
  getInterruptedSignal: () => InterruptSignal | undefined;
}) {
  const normal = (path: string) => path.split(sep).join('/').replace(/^\.\//, '');
  const globalSetupEdges: DependencyEdge[] = [];
  let recordGlobalSetupEdges = false;
  if (globalSetupFiles.size) {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        // Node passes no parent URL for an entry point.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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

  const testWorker = createTestWorker({ root, hook, nodeArgs, setupFiles, globalSetupFiles, activeChildren });
  function lifecycleFailure(tests: string[], resultGraph: DependencyGraph): DependencyRunResult {
    return {
      completedTests: tests,
      failedTests: tests,
      resultGraph,
      interrupted: getInterruptedSignal(),
    };
  }
  async function runTests(
    tests: string[],
    oldGraph: DependencyGraph = {},
    historicalDurations: Record<string, number> = {},
  ): Promise<DependencyRunResult> {
    testWorker.reset();
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
      while (!getInterruptedSignal() && nextIndex < scheduledTests.length) {
        const index = nextIndex;
        nextIndex += 1;
        const test = scheduledTests[index];
        results.set(test, await testWorker.run(test));
      }
    }
    const workerCount = Math.min(concurrency, tests.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    const completedTests: string[] = [];
    const durations: Record<string, number> = {};
    const failedTests: string[] = [];
    const unresolvedStaticTests: string[] = [];
    for (const test of tests) {
      const result = results.get(test);
      if (!result) continue;
      (output === 'json' ? console.error : console.log)(`\n▶ ${test}`);
      try {
        await result.stdout.writeTo(output === 'json' ? process.stderr : process.stdout);
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
    return { completedTests, durations, failedTests, resultGraph, interrupted: getInterruptedSignal(), unresolvedStaticTests };
  }
  return { runTests };
}
