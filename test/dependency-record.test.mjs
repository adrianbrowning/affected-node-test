import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadDependencyRecord, writeDependencyRecord } from '../src/dependency-record.mjs';
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

    writeDependencyRecord(path, record);
    const loaded = loadDependencyRecord(path, current);
    assert.equal(loaded.record.version, 10);
    assert.deepEqual(loaded.record.graph, record.graph);

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
