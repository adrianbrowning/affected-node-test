import { readFileSync } from 'node:fs';
import { writeJsonAtomically } from './cache.ts';
import { repositoryFilesFingerprint } from './project-config.ts';
import type { DependencyEdge } from './dependency-graph.ts';
import { isNodeError } from './errors.ts';
import { isRepositoryPath } from './repository-path.ts';

export type DependencyGraph = Record<string, DependencyEdge[]>;
export type FileState = { mtimeMs: number; size: number } | null;
export type DependencyState = Record<string, FileState>;
export type RecordMetadata = {
  config: string;
  conventionDependencies: string;
  conventionDependencyFiles: string[];
  environment: string;
  environmentFiles: string[];
  globalSetupDependencies: string;
  globalSetupDependencyFiles: string[];
  globalSetupFiles: string[];
  node: string;
  projectDependencies: string;
  setupDependencies: string;
  setupDependencyFiles: string[];
  setupFiles: string[];
};
export type DependencyRecord = RecordMetadata & {
  dependencyStates: Record<string, DependencyState>;
  durations: Record<string, number>;
  failedTests: string[];
  graph: DependencyGraph;
  tests: string[];
  unresolvedStaticTests: string[];
  version: number;
};
export type DependencyRunResult = {
  completedTests: string[];
  durations?: Record<string, number>;
  failedTests: string[];
  interrupted?: 'SIGINT' | 'SIGTERM';
  resultGraph: DependencyGraph;
  unresolvedStaticTests?: string[];
};
export type DependencyRunOutcome =
  | { signal: 'SIGINT' | 'SIGTERM'; status: 'interrupted' }
  | { status: 'failed' }
  | { status: 'passed' };

const recordVersion = 11;

function isValidRecord(value: unknown): value is DependencyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.config !== 'string' || !Array.isArray(record.tests) ||
      typeof record.projectDependencies !== 'string' ||
      !Array.isArray(record.setupDependencyFiles) || typeof record.setupDependencies !== 'string' ||
      !Array.isArray(record.setupFiles) ||
      !Array.isArray(record.globalSetupDependencyFiles) || typeof record.globalSetupDependencies !== 'string' ||
      !Array.isArray(record.globalSetupFiles) ||
      !Array.isArray(record.environmentFiles) || typeof record.environment !== 'string' ||
      !Array.isArray(record.conventionDependencyFiles) || typeof record.conventionDependencies !== 'string' ||
      !record.dependencyStates || typeof record.dependencyStates !== 'object' || Array.isArray(record.dependencyStates) ||
      !record.durations || typeof record.durations !== 'object' || Array.isArray(record.durations) ||
      !Array.isArray(record.failedTests) ||
      !Array.isArray(record.unresolvedStaticTests) ||
      !record.graph || typeof record.graph !== 'object' || Array.isArray(record.graph)) {
    return false;
  }
  const tests = record.tests as unknown[];
  const testSet = new Set(tests);
  return (record.setupDependencyFiles as unknown[]).every(isRepositoryPath) &&
    (record.setupFiles as unknown[]).every(isRepositoryPath) &&
    (record.globalSetupDependencyFiles as unknown[]).every(isRepositoryPath) &&
    (record.globalSetupFiles as unknown[]).every(isRepositoryPath) &&
    (record.environmentFiles as unknown[]).every(isRepositoryPath) &&
    (record.conventionDependencyFiles as unknown[]).every(isRepositoryPath) &&
    Object.entries(record.dependencyStates).every(([test, state]) => testSet.has(test) && state &&
      typeof state === 'object' && !Array.isArray(state) && Object.keys(state).every(isRepositoryPath)) &&
    Object.values(record.durations).every((duration) => typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) &&
    Object.keys(record.durations).every((test) => testSet.has(test)) &&
    Object.keys(record.graph).every((test) => testSet.has(test)) &&
    (record.failedTests as unknown[]).every(isRepositoryPath) &&
    (record.unresolvedStaticTests as unknown[]).every((test) => typeof test === 'string' && testSet.has(test)) &&
    tests.every((test) => isRepositoryPath(test) &&
      Array.isArray((record.graph as Record<string, unknown>)[test]) && ((record.graph as Record<string, unknown[]>)[test]).every((edge) =>
        Array.isArray(edge) && edge.length === 2 && edge.every((path) => path === '' || isRepositoryPath(path))));
}

function writeDependencyRecord(path: string, record: Omit<DependencyRecord, 'version'> | DependencyRecord) {
  writeJsonAtomically(path, { ...record, version: recordVersion });
}

export function applyDependencyRun(path: string, {
  dependencyStateForTest,
  metadataForGraph,
  previous,
  result,
  tests,
}: {
  dependencyStateForTest: (graph: DependencyGraph, test: string) => DependencyState;
  metadataForGraph: (graph: DependencyGraph) => RecordMetadata;
  previous?: DependencyRecord;
  result: DependencyRunResult;
  tests: string[];
}): DependencyRunOutcome {
  const {
    completedTests,
    failedTests,
    interrupted,
    resultGraph,
    durations: resultDurations = {},
    unresolvedStaticTests = [],
  } = result;
  if (interrupted) return { signal: interrupted, status: 'interrupted' };

  if (!failedTests.length) {
    const dependencyStates = { ...(previous?.dependencyStates ?? {}) };
    const durations = { ...(previous?.durations ?? {}) };
    const unresolved = new Set(previous?.unresolvedStaticTests ?? []);
    for (const test of completedTests) {
      dependencyStates[test] = dependencyStateForTest(resultGraph, test);
      const duration = resultDurations[test];
      if (Number.isFinite(duration) && duration >= 0) durations[test] = duration;
    }
    for (const test of completedTests) unresolved.delete(test);
    for (const test of unresolvedStaticTests) unresolved.add(test);
    writeDependencyRecord(path, {
      ...metadataForGraph(resultGraph),
      dependencyStates,
      durations,
      failedTests: [],
      graph: resultGraph,
      tests,
      unresolvedStaticTests: [...unresolved].sort(),
    });
    return { status: 'passed' };
  }

  if (previous) {
    const stickyFailures = new Set(previous.failedTests);
    for (const test of completedTests) stickyFailures.delete(test);
    for (const test of failedTests) stickyFailures.add(test);
    writeDependencyRecord(path, {
      ...previous,
      failedTests: [...stickyFailures].sort(),
    });
  }
  return { status: 'failed' };
}

export function loadDependencyRecord(path: string, expected: {
  config: string;
  conventionDependencyFiles: string[];
  environmentFiles: string[];
  globalSetupFiles: string[];
  node: string;
  projectDependencies: string;
  root: string;
  setupFiles: string[];
  tests: string[];
}) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return { reason: 'No graph cache; running full suite.' };
    throw error;
  }
  let record: unknown;
  try {
    record = JSON.parse(source);
  } catch {
    return { reason: 'Invalid graph cache; running full suite.' };
  }
  if (!isValidRecord(record)) return { reason: 'Invalid graph cache; running full suite.' };
  const expectedTests = new Set(expected.tests);
  const recordedTestWasRemoved = [...record.tests, ...record.failedTests]
    .some((test) => !expectedTests.has(test));
  if (record.version !== recordVersion || record.node !== expected.node || recordedTestWasRemoved) {
    return { reason: 'Test files or runtime changed; running full suite.' };
  }
  if (record.config !== expected.config) {
    return { reason: 'Project configuration changed since graph was built; running full suite.' };
  }
  if (record.projectDependencies !== expected.projectDependencies) {
    return { reason: 'Project dependencies changed since graph was built; running full suite.' };
  }
  const fingerprintFiles = (paths: string[]) => repositoryFilesFingerprint(expected.root, paths);
  if (JSON.stringify(record.environmentFiles) !== JSON.stringify(expected.environmentFiles) ||
      record.environment !== fingerprintFiles(record.environmentFiles)) {
    return { reason: 'Environment files changed since graph was built; running full suite.' };
  }
  if (JSON.stringify(record.conventionDependencyFiles) !== JSON.stringify(expected.conventionDependencyFiles) ||
      record.conventionDependencies !== fingerprintFiles(record.conventionDependencyFiles)) {
    return { reason: 'Convention dependencies changed since graph was built; running full suite.' };
  }
  if (JSON.stringify(record.setupFiles) !== JSON.stringify(expected.setupFiles) ||
      record.setupDependencies !== fingerprintFiles(record.setupDependencyFiles)) {
    return { reason: 'Setup dependencies changed since graph was built; running full suite.' };
  }
  if (JSON.stringify(record.globalSetupFiles) !== JSON.stringify(expected.globalSetupFiles) ||
      record.globalSetupDependencies !== fingerprintFiles(record.globalSetupDependencyFiles)) {
    return { reason: 'Global setup dependencies changed since graph was built; running full suite.' };
  }
  return { record };
}
