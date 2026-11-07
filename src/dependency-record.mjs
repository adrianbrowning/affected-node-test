import { readFileSync } from 'node:fs';
import { writeJsonAtomically } from './cache.mjs';
import { repositoryFilesFingerprint } from './project-config.mjs';

const recordVersion = 10;

function isValidRecord(record) {
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
      !Array.isArray(record.failedTests) ||
      !Array.isArray(record.unresolvedStaticTests) ||
      !record.graph || typeof record.graph !== 'object' || Array.isArray(record.graph)) {
    return false;
  }
  const testSet = new Set(record.tests);
  return record.setupDependencyFiles.every((path) => typeof path === 'string') &&
    record.setupFiles.every((path) => typeof path === 'string') &&
    record.globalSetupDependencyFiles.every((path) => typeof path === 'string') &&
    record.globalSetupFiles.every((path) => typeof path === 'string') &&
    record.environmentFiles.every((path) => typeof path === 'string') &&
    record.conventionDependencyFiles.every((path) => typeof path === 'string') &&
    Object.values(record.dependencyStates).every((state) => state && typeof state === 'object' && !Array.isArray(state)) &&
    record.failedTests.every((test) => typeof test === 'string' && testSet.has(test)) &&
    record.unresolvedStaticTests.every((test) => typeof test === 'string' && testSet.has(test)) &&
    record.tests.every((test) => typeof test === 'string' &&
      Array.isArray(record.graph[test]) && record.graph[test].every((edge) =>
        Array.isArray(edge) && edge.length === 2 && edge.every((part) => typeof part === 'string')));
}

export function writeDependencyRecord(path, record) {
  writeJsonAtomically(path, { ...record, version: recordVersion });
}

export function loadDependencyRecord(path, expected) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { reason: 'No graph cache; running full suite.' };
    throw error;
  }
  let record;
  try {
    record = JSON.parse(source);
  } catch {
    return { reason: 'Invalid graph cache; running full suite.' };
  }
  if (!isValidRecord(record)) return { reason: 'Invalid graph cache; running full suite.' };
  if (record.version !== recordVersion || record.node !== expected.node ||
      JSON.stringify(record.tests) !== JSON.stringify(expected.tests)) {
    return { reason: 'Test files or runtime changed; running full suite.' };
  }
  if (record.config !== expected.config) {
    return { reason: 'Project configuration changed since graph was built; running full suite.' };
  }
  if (record.projectDependencies !== expected.projectDependencies) {
    return { reason: 'Project dependencies changed since graph was built; running full suite.' };
  }
  const fingerprintFiles = (paths) => repositoryFilesFingerprint(expected.root, paths);
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
