import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyDependencyRun, loadDependencyRecord } from '../src/dependency-record.mjs';
import { repositoryFilesFingerprint } from '../src/project-config.mjs';

const expected = {
  config: 'config-fingerprint',
  conventionDependencyFiles: [],
  environmentFiles: [],
  globalSetupFiles: [],
  node: 'test-node',
  projectDependencies: 'project-fingerprint',
  setupFiles: [],
  tests: ['test/a.test.mjs'],
};

test('dependency record module owns persistence and compatibility decisions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'affected-record-'));
  const path = join(directory, 'graph.json');
  const current = { ...expected, root: directory };
  const filesFingerprint = repositoryFilesFingerprint(directory, []);
  const record = {
    config: current.config,
    conventionDependencies: filesFingerprint,
    conventionDependencyFiles: [],
    dependencyStates: {},
    environment: filesFingerprint,
    environmentFiles: [],
    failedTests: [],
    globalSetupDependencies: filesFingerprint,
    globalSetupDependencyFiles: [],
    globalSetupFiles: [],
    graph: { 'test/a.test.mjs': [] },
    node: current.node,
    projectDependencies: current.projectDependencies,
    setupDependencies: filesFingerprint,
    setupDependencyFiles: [],
    setupFiles: [],
    tests: current.tests,
    unresolvedStaticTests: [],
  };
  try {
    assert.deepEqual(loadDependencyRecord(path, current), {
      reason: 'No graph cache; running full suite.',
    });

    writeFileSync(path, JSON.stringify({ ...record, version: 10 }));
    const loaded = loadDependencyRecord(path, current);
    assert.equal(loaded.record.version, 10);
    assert.deepEqual(loaded.record.graph, record.graph);

    assert.deepEqual(loadDependencyRecord(path, {
      ...current,
      tests: [...current.tests, 'test/new.test.mjs'],
    }).record, loaded.record);

    assert.deepEqual(loadDependencyRecord(path, { ...current, tests: [] }), {
      reason: 'Test files or runtime changed; running full suite.',
    });

    assert.deepEqual(loadDependencyRecord(path, { ...current, node: 'other-node' }), {
      reason: 'Test files or runtime changed; running full suite.',
    });

    writeFileSync(path, 'null\n');
    assert.deepEqual(loadDependencyRecord(path, current), {
      reason: 'Invalid graph cache; running full suite.',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('dependency record module owns successful, failed, and interrupted run updates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'affected-record-run-'));
  const path = join(directory, 'graph.json');
  const current = { ...expected, root: directory };
  const filesFingerprint = repositoryFilesFingerprint(directory, []);
  const metadataForGraph = () => ({
    config: current.config,
    conventionDependencies: filesFingerprint,
    conventionDependencyFiles: [],
    environment: filesFingerprint,
    environmentFiles: [],
    globalSetupDependencies: filesFingerprint,
    globalSetupDependencyFiles: [],
    globalSetupFiles: [],
    node: current.node,
    projectDependencies: current.projectDependencies,
    setupDependencies: filesFingerprint,
    setupDependencyFiles: [],
    setupFiles: [],
  });
  const passingResult = {
    completedTests: current.tests,
    failedTests: [],
    resultGraph: { 'test/a.test.mjs': [['test/a.test.mjs', 'src/a.mjs']] },
    unresolvedStaticTests: ['test/a.test.mjs'],
  };
  try {
    assert.deepEqual(applyDependencyRun(path, {
      dependencyStateForTest: () => ({ 'src/a.mjs': { mtimeMs: 1, size: 2 } }),
      metadataForGraph,
      result: passingResult,
      tests: current.tests,
    }), { status: 'passed' });
    const initial = loadDependencyRecord(path, current).record;
    assert.deepEqual(initial.failedTests, []);
    assert.deepEqual(initial.unresolvedStaticTests, current.tests);

    assert.deepEqual(applyDependencyRun(path, {
      dependencyStateForTest: () => assert.fail('failed runs must not calculate dependency state'),
      metadataForGraph: () => assert.fail('failed runs must not replace graph metadata'),
      previous: initial,
      result: { ...passingResult, failedTests: current.tests },
      tests: current.tests,
    }), { status: 'failed' });
    const failed = loadDependencyRecord(path, current).record;
    assert.deepEqual(failed.graph, initial.graph);
    assert.deepEqual(failed.dependencyStates, initial.dependencyStates);
    assert.deepEqual(failed.failedTests, current.tests);

    assert.deepEqual(applyDependencyRun(path, {
      dependencyStateForTest: () => assert.fail('interrupted runs must not calculate dependency state'),
      metadataForGraph: () => assert.fail('interrupted runs must not replace graph metadata'),
      previous: failed,
      result: { ...passingResult, interrupted: 'SIGTERM' },
      tests: current.tests,
    }), { signal: 'SIGTERM', status: 'interrupted' });
    assert.deepEqual(loadDependencyRecord(path, current).record, failed);

    assert.deepEqual(applyDependencyRun(path, {
      dependencyStateForTest: () => ({ 'src/a.mjs': { mtimeMs: 3, size: 4 } }),
      metadataForGraph,
      previous: failed,
      result: { ...passingResult, unresolvedStaticTests: [] },
      tests: current.tests,
    }), { status: 'passed' });
    const recovered = loadDependencyRecord(path, current).record;
    assert.deepEqual(recovered.failedTests, []);
    assert.deepEqual(recovered.unresolvedStaticTests, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
