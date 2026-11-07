import type { SelectionOutcome } from './selection-run.ts';
import type { DependencyGraph, DependencyRunResult } from './dependency-record.ts';

export type TestPartition = {
  affected: string[];
  fallback: boolean;
  remaining: string[];
};

export type PartitionIdentity = {
  changes: string[];
  changesFingerprint: string;
  comparisonBase: string | null;
  config: string;
  head: string;
  node: string;
  projectPath: string;
  tests: string[];
};
type StoredRunResult = {
  completedTests: string[];
  durations: Record<string, number>;
  failedTests: string[];
  resultGraph: DependencyGraph;
  unresolvedStaticTests: string[];
};
export type PartitionPlan = PartitionIdentity & TestPartition & {
  affectedResult?: StoredRunResult;
  ref: string | null;
  schemaVersion: 1;
  state: 'affected-failed' | 'affected-passed' | 'complete' | 'planned' | 'remaining-failed';
};

export function partitionTests(allTests: string[], selection?: SelectionOutcome): TestPartition {
  const orderedTests = [...new Set(allTests)].sort();
  if (!selection || selection.kind === 'baseline') {
    return { affected: orderedTests, fallback: true, remaining: [] };
  }
  const all = new Set(orderedTests);
  const affected = [...new Set(selection.tests)].filter((test) => all.has(test)).sort();
  const selected = new Set(affected);
  return {
    affected,
    fallback: false,
    remaining: orderedTests.filter((test) => !selected.has(test)),
  };
}

export function createPartitionPlan({ identity, partition, ref }: {
  identity: PartitionIdentity;
  partition: TestPartition;
  ref?: string;
}): PartitionPlan {
  return {
    schemaVersion: 1,
    state: 'planned',
    ref: ref ?? null,
    ...identity,
    ...partition,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isGraph(value: unknown): value is DependencyGraph {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).every((edges) => Array.isArray(edges) && edges.every((edge) =>
      Array.isArray(edge) && edge.length === 2 && edge.every((part) => typeof part === 'string'))));
}

function isStoredResult(value: unknown): value is StoredRunResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return isStringArray(result.completedTests) && isStringArray(result.failedTests) &&
    isStringArray(result.unresolvedStaticTests) && isGraph(result.resultGraph) &&
    Boolean(result.durations && typeof result.durations === 'object' && !Array.isArray(result.durations) &&
      Object.values(result.durations).every((duration) => typeof duration === 'number' && Number.isFinite(duration)));
}

export function parsePartitionPlan(value: unknown): PartitionPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Partition plan must be an object.');
  const plan = value as Record<string, unknown>;
  const states = ['affected-failed', 'affected-passed', 'complete', 'planned', 'remaining-failed'];
  if (plan.schemaVersion !== 1 || !states.includes(String(plan.state)) ||
      !(plan.ref === null || typeof plan.ref === 'string') ||
      !(plan.comparisonBase === null || typeof plan.comparisonBase === 'string') ||
      typeof plan.changesFingerprint !== 'string' || typeof plan.config !== 'string' ||
      typeof plan.head !== 'string' || typeof plan.node !== 'string' || typeof plan.projectPath !== 'string' ||
      typeof plan.fallback !== 'boolean' || !isStringArray(plan.changes) || !isStringArray(plan.tests) ||
      !isStringArray(plan.affected) || !isStringArray(plan.remaining)) {
    throw new Error('Partition plan has an invalid or unsupported structure.');
  }
  const tests = [...new Set(plan.tests)].sort();
  const affected = [...new Set(plan.affected)].sort();
  const remaining = [...new Set(plan.remaining)].sort();
  if (JSON.stringify([...affected, ...remaining].sort()) !== JSON.stringify(tests) ||
      affected.some((test) => remaining.includes(test))) {
    throw new Error('Partition plan test partitions are not a disjoint complete suite.');
  }
  if (plan.affectedResult !== undefined && !isStoredResult(plan.affectedResult)) {
    throw new Error('Partition plan affected result is invalid.');
  }
  if (plan.state !== 'planned' && !isStoredResult(plan.affectedResult)) {
    throw new Error('Partition plan is missing its affected phase result.');
  }
  return plan as PartitionPlan;
}

export function validatePartitionIdentity(plan: PartitionPlan, current: PartitionIdentity) {
  const keys: (keyof PartitionIdentity)[] = [
    'changes', 'changesFingerprint', 'comparisonBase', 'config', 'head', 'node', 'projectPath', 'tests',
  ];
  const stale = keys.find((key) => JSON.stringify(plan[key]) !== JSON.stringify(current[key]));
  if (stale) throw new Error(`Partition plan is stale: ${stale} changed; rerun the affected phase.`);
}

function storedResult(result: DependencyRunResult): StoredRunResult {
  return {
    completedTests: result.completedTests,
    durations: result.durations ?? {},
    failedTests: result.failedTests,
    resultGraph: result.resultGraph,
    unresolvedStaticTests: result.unresolvedStaticTests ?? [],
  };
}

export function recordAffectedResult(plan: PartitionPlan, result: DependencyRunResult): PartitionPlan {
  return {
    ...plan,
    affectedResult: storedResult(result),
    state: result.failedTests.length || result.interrupted ? 'affected-failed' : 'affected-passed',
  };
}

export function recordRemainingResult(plan: PartitionPlan, result: DependencyRunResult): PartitionPlan {
  return {
    ...plan,
    state: result.failedTests.length || result.interrupted ? 'remaining-failed' : 'complete',
  };
}
