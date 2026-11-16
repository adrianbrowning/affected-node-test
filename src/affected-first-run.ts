import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { writeJsonAtomically } from './cache.ts';
import { isContainedPath } from './contained-path.ts';
import { configurationFingerprint } from './config.ts';
import type { DependencyRecord, DependencyRunResult } from './dependency-record.ts';
import { errorMessage } from './errors.ts';
import { gitMergeBase, gitRevision } from './git-changes.ts';
import {
  createPartitionPlan, parsePartitionPlan, partitionTests, recordAffectedResult,
  recordRemainingResult, validatePartitionIdentity,
} from './partition-plan.ts';
import type { PartitionIdentity, PartitionPlan } from './partition-plan.ts';
import type { ProjectConfig } from './project-config.ts';
import { repositoryFilesFingerprint } from './project-config.ts';
import { selectTestsForFiles } from './selection-run.ts';
import type { SelectionOutcome } from './selection-run.ts';
import type { createTestExecutor } from './test-execution.ts';

type InterruptSignal = 'SIGINT' | 'SIGTERM';
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 } as const;

export function createAffectedFirstRunner({ root, output, phase, plan, projectConfig, discover,
  diffFiles, loadUsableCache, runTests, finishRun, fail, getInterruptedSignal }: {
  root: string;
  output: 'human' | 'json';
  phase?: 'affected' | 'remaining';
  plan?: string;
  projectConfig: ProjectConfig;
  discover: () => string[];
  diffFiles: (ref?: string) => string[] | null;
  loadUsableCache: (tests: string[]) => DependencyRecord | undefined;
  runTests: ReturnType<typeof createTestExecutor>['runTests'];
  finishRun: (tests: string[], result: DependencyRunResult, previous?: DependencyRecord) => unknown;
  fail: (message: string) => never;
  getInterruptedSignal: () => InterruptSignal | undefined;
}) {
  function combineRunResults(first: DependencyRunResult, second: DependencyRunResult): DependencyRunResult {
    return {
      completedTests: [...first.completedTests, ...second.completedTests],
      durations: { ...first.durations, ...second.durations },
      failedTests: [...first.failedTests, ...second.failedTests],
      interrupted: second.interrupted ?? first.interrupted,
      resultGraph: second.resultGraph,
      unresolvedStaticTests: [
        ...(first.unresolvedStaticTests ?? []),
        ...(second.unresolvedStaticTests ?? []),
      ],
    };
  }
  function resolvePlanPath(path: string) {
    const resolved = resolve(root, path);
    if (isAbsolute(path) || !isContainedPath(root, resolved)) {
      fail('--plan must be a project-relative path within the project root.');
    }
    return resolved;
  }
  function partitionIdentity(ref: string | undefined, tests: string[], changes: string[] | null): PartitionIdentity {
    return {
      changes: changes ?? [],
      changesFingerprint: repositoryFilesFingerprint(root, changes ?? []),
      comparisonBase: ref ? gitMergeBase(root, ref) : gitRevision(root),
      config: configurationFingerprint(root),
      head: gitRevision(root),
      node: process.versions.node,
      projectPath: process.env.AFFECTED_NODE_TEST_PROJECT_PATH ?? '.',
      tests,
    };
  }
  function affectedFirstChanges(ref?: string): string[] | null {
    const supplied = process.env.AFFECTED_NODE_TEST_CHANGED_FILES;
    if (supplied === undefined) return diffFiles(ref);
    try {
      const parsed: unknown = JSON.parse(supplied);
      if (parsed === null) return null;
      if (!Array.isArray(parsed) || parsed.some((file) => typeof file !== 'string')) {
        throw new Error('expected a JSON string array or null');
      }
      return [...new Set(parsed)].sort();
    } catch (error: unknown) {
      return fail(`Invalid internal workspace change set: ${errorMessage(error)}`);
    }
  }
  function readPartitionPlan(path: string): PartitionPlan {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return parsePartitionPlan(parsed);
    } catch (error: unknown) {
      return fail(`Partition plan is invalid: ${errorMessage(error)}`);
    }
  }
  function reportPartitionFailure(result: DependencyRunResult) {
    if (result.interrupted) {
      console.error(`Test run interrupted by ${result.interrupted}; dependency graph was left unchanged.`);
      process.exitCode = signalExitCodes[result.interrupted];
    } else if (result.failedTests.length) {
      console.error('Tests failed; dependency graph was left unchanged.');
      process.exitCode = 1;
    }
  }
  function printPartitionDocument({
    completedTests,
    partition,
    phase,
    plan,
  }: {
    completedTests: string[];
    partition: ReturnType<typeof partitionTests>;
    phase: 'affected' | 'all' | 'remaining';
    plan?: PartitionPlan;
  }) {
    if (output !== 'json') return;
    const exitCode = process.exitCode ?? 0;
    let outcome: 'failed' | 'interrupted' | 'passed' = 'passed';
    if (exitCode !== 0) outcome = getInterruptedSignal() ? 'interrupted' : 'failed';
    console.log(JSON.stringify({
      schemaVersion: 1,
      command: 'affected-first',
      mode: 'run',
      phase,
      outcome,
      exitCode,
      partitions: {
        affected: partition.affected,
        remaining: partition.remaining,
      },
      completedTests,
      pendingTests: plan?.state === 'affected-passed' ? partition.remaining : [],
      planState: plan?.state,
    }, null, 2));
  }
  function affectedFirstSelection(
    tests: string[],
    saved: DependencyRecord | undefined,
    changes: string[] | null,
    ref?: string,
  ): SelectionOutcome | undefined {
    if (!saved) return;
    return changes === null
      ? {
          kind: 'baseline',
          message: `No merge base with ${ref}; running full suite in the affected phase.`,
          reason: { kind: 'no-merge-base', ref: ref ?? 'unknown ref' },
        }
      : selectTestsForFiles({ config: projectConfig, files: changes, record: saved, tests });
  }
  async function affectedFirstPhase(ref: string | undefined, phase: 'affected' | 'remaining', planFile: string) {
    const tests = discover();
    const path = resolvePlanPath(planFile);
    if (phase === 'affected') {
      const changes = affectedFirstChanges(ref);
      const saved = loadUsableCache(tests);
      const partition = partitionTests(tests, affectedFirstSelection(tests, saved, changes, ref));
      let plan = createPartitionPlan({ identity: partitionIdentity(ref, tests, changes), partition, ref });
      (output === 'json' ? console.error : console.log)(
        `Affected phase: ${partition.affected.length}/${tests.length} test file(s)`);
      const result = await runTests(partition.affected, {}, saved?.durations);
      plan = recordAffectedResult(plan, result);
      writeJsonAtomically(path, plan);
      reportPartitionFailure(result);
      printPartitionDocument({ completedTests: result.completedTests, partition, phase, plan });
      return;
    }

    let plan: PartitionPlan = readPartitionPlan(path);
    if (plan.state !== 'affected-passed') {
      fail(`Partition plan cannot run the remaining phase from state ${plan.state}; rerun the affected phase.`);
    }
    const changes = affectedFirstChanges(plan.ref ?? undefined);
    try {
      validatePartitionIdentity(plan, partitionIdentity(plan.ref ?? undefined, tests, changes));
    } catch (error: unknown) {
      fail(errorMessage(error));
    }
    const saved = loadUsableCache(tests);
    (output === 'json' ? console.error : console.log)(
      `Remaining phase: ${plan.remaining.length}/${tests.length} test file(s)`);
    const result = await runTests(plan.remaining, plan.affectedResult?.resultGraph ?? {}, {
      ...(saved?.durations ?? {}),
      ...(plan.affectedResult?.durations ?? {}),
    });
    const affectedResult = plan.affectedResult;
    if (!affectedResult) return fail('Partition plan lost its affected phase result.');
    plan = recordRemainingResult(plan, result);
    writeJsonAtomically(path, plan);
    const combined = combineRunResults(affectedResult, result);
    finishRun(tests, combined, saved);
    printPartitionDocument({ completedTests: combined.completedTests, partition: plan, phase, plan });
  }
  async function affectedFirst(ref?: string) {
    if (phase && plan) {
      await affectedFirstPhase(ref, phase, plan);
      return;
    }
    const tests = discover();
    const saved = loadUsableCache(tests);
    const changes = affectedFirstChanges(ref);
    const selection = affectedFirstSelection(tests, saved, changes, ref);
    const partition = partitionTests(tests, selection);
    (output === 'json' ? console.error : console.log)(
      `Affected phase: ${partition.affected.length}/${tests.length} test file(s)`);
    const first = await runTests(partition.affected, saved?.graph ?? {}, saved?.durations);
    if (first.failedTests.length || first.interrupted) {
      finishRun(tests, first, saved);
      printPartitionDocument({ completedTests: first.completedTests, partition, phase: 'all' });
      return;
    }
    (output === 'json' ? console.error : console.log)(
      `Remaining phase: ${partition.remaining.length}/${tests.length} test file(s)`);
    const second = await runTests(partition.remaining, first.resultGraph, {
      ...(saved?.durations ?? {}),
      ...(first.durations ?? {}),
    });
    const combined = combineRunResults(first, second);
    finishRun(tests, combined, saved);
    printPartitionDocument({ completedTests: combined.completedTests, partition, phase: 'all' });
  }
  return affectedFirst;
}
