import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeSelectionRun,
  selectLastFailed,
  selectTestsForFiles,
  selectTestsSinceLastRun,
} from '../src/selection-run.mjs';

const tests = ['test/a.test.mjs', 'test/b.test.mjs'];
const record = {
  dependencyStates: {
    'test/a.test.mjs': {},
    'test/b.test.mjs': {},
  },
  failedTests: ['test/b.test.mjs'],
  graph: {
    'test/a.test.mjs': [
      ['test/a.test.mjs', 'src/a.mjs'],
      ['src/a.mjs', 'src/shared.mjs'],
    ],
    'test/b.test.mjs': [['test/b.test.mjs', 'src/b.mjs']],
  },
  unresolvedStaticTests: [],
};
const config = {
  forceRerunTriggers: [],
  watchTriggerPatterns: [],
};

test('file selection returns normalized targeted and conservative outcomes', () => {
  assert.deepEqual(selectTestsForFiles({
    config,
    files: ['src/shared.mjs'],
    record,
    tests,
  }), {
    kind: 'selected',
    messages: [],
    reasons: {
      'test/a.test.mjs': [{
        file: 'src/shared.mjs',
        kind: 'dependency',
        path: ['test/a.test.mjs', 'src/a.mjs', 'src/shared.mjs'],
      }],
      'test/b.test.mjs': [{ kind: 'previous-failure' }],
    },
    tests,
  });

  assert.deepEqual(selectTestsForFiles({
    config: { ...config, forceRerunTriggers: ['fixtures/**'] },
    files: ['fixtures/template.html'],
    record,
    tests,
  }), {
    kind: 'baseline',
    message: 'Force-rerun trigger matched: fixtures/template.html; running full suite.',
    reason: {
      file: 'fixtures/template.html',
      kind: 'force-rerun-trigger',
      pattern: 'fixtures/**',
    },
  });

  assert.deepEqual(selectTestsForFiles({
    config,
    files: ['src/new.ts'],
    record,
    tests,
  }), {
    kind: 'baseline',
    message: 'Unknown code file changed (src/new.ts); running full suite.',
    reason: { files: ['src/new.ts'], kind: 'unknown-code' },
  });

  assert.deepEqual(selectTestsForFiles({
    config,
    files: ['package.json'],
    record,
    tests,
  }), {
    kind: 'baseline',
    message: 'Project configuration changed; running full suite.',
    reason: { files: ['package.json'], kind: 'project-configuration' },
  });

  assert.deepEqual(selectTestsForFiles({
    config: {
      ...config,
      watchTriggerPatterns: [{ pattern: 'fixtures/**', tests: ['test/missing*'] }],
    },
    files: ['fixtures/value.txt'],
    record,
    tests,
  }), {
    kind: 'baseline',
    message: 'Watch trigger matched fixtures/value.txt but selected no tests; running full suite.',
    reason: {
      file: 'fixtures/value.txt',
      kind: 'watch-trigger-empty',
      pattern: 'fixtures/**',
      testPatterns: ['test/missing*'],
    },
  });

  assert.deepEqual(selectTestsForFiles({
    config: {
      ...config,
      watchTriggerPatterns: [{ pattern: 'fixtures/**', tests: ['test/a*'] }],
    },
    files: ['fixtures/value.txt'],
    record: { ...record, failedTests: [] },
    tests,
  }), {
    kind: 'selected',
    messages: ['Watch trigger matched fixtures/value.txt; selected 1 mapped test file(s).'],
    reasons: {
      'test/a.test.mjs': [{
        file: 'fixtures/value.txt',
        kind: 'watch-trigger',
        pattern: 'fixtures/**',
      }],
    },
    tests: ['test/a.test.mjs'],
  });

  assert.deepEqual(selectTestsForFiles({
    config,
    files: [],
    record: {
      ...record,
      dependencyStates: { 'test/a.test.mjs': {} },
      failedTests: [],
    },
    tests,
  }), {
    kind: 'selected',
    messages: [],
    reasons: {
      'test/b.test.mjs': [{ kind: 'unrecorded-test' }],
    },
    tests: ['test/b.test.mjs'],
  });
});

test('mtime selection returns the same normalized targeted outcome', () => {
  const changedStates = new Set(['changed']);

  assert.deepEqual(selectTestsSinceLastRun({
    dependencyStateChanged: (state) => changedStates.has(state),
    record: {
      ...record,
      dependencyStates: {
        'test/a.test.mjs': 'unchanged',
        'test/b.test.mjs': 'changed',
      },
    },
    tests,
  }), {
    kind: 'selected',
    messages: [],
    reasons: {
      'test/b.test.mjs': [
        { kind: 'previous-failure' },
        { kind: 'dependency-state-change' },
      ],
    },
    tests: ['test/b.test.mjs'],
  });

  assert.deepEqual(selectTestsSinceLastRun({
    dependencyStateChanged: () => false,
    record: {
      ...record,
      failedTests: [],
      dependencyStates: { 'test/a.test.mjs': {}, 'test/b.test.mjs': {} },
    },
    tests,
  }), {
    kind: 'selected',
    messages: [],
    reasons: {},
    tests: [],
  });

  assert.deepEqual(selectTestsSinceLastRun({
    dependencyStateChanged: () => false,
    record: {
      ...record,
      failedTests: [],
      dependencyStates: { 'test/a.test.mjs': {} },
    },
    tests,
  }), {
    kind: 'selected',
    messages: [],
    reasons: {
      'test/b.test.mjs': [{ kind: 'unrecorded-test' }],
    },
    tests: ['test/b.test.mjs'],
  });
});

test('last-failed selection returns only sticky failures with structured reasons', () => {
  assert.deepEqual(selectLastFailed({ record }), {
    kind: 'selected',
    messages: [],
    reasons: {
      'test/b.test.mjs': [{ kind: 'previous-failure' }],
    },
    tests: ['test/b.test.mjs'],
  });
});

test('selection run owns cache fallback and targeted safety sequencing', async () => {
  const events = [];
  const record = { graph: {} };
  const runtime = {
    baseline: async () => events.push('baseline'),
    execute: async (selectedTests, loadedRecord) => {
      assert.equal(loadedRecord, record);
      events.push(`execute:${selectedTests.join(',')}`);
    },
    log: (message) => events.push(`log:${message}`),
    totalTests: 2,
  };

  await executeSelectionRun({
    ...runtime,
    loadRecord: () => undefined,
    prepare: () => {
      events.push('prepare');
      return {};
    },
  });
  assert.deepEqual(events, ['baseline']);

  events.length = 0;
  await executeSelectionRun({
    ...runtime,
    loadRecord: () => record,
    prepare: (loadedRecord) => {
      assert.equal(loadedRecord, record);
      return {
        emptyMessage: 'No affected tests found.',
        selectedLabel: 'related test file(s)',
        selection: {
          kind: 'selected',
          messages: ['Mapped fixture change.'],
          tests: ['test/a.test.mjs'],
        },
      };
    },
  });
  assert.deepEqual(events, [
    'log:Mapped fixture change.',
    'log:Selected 1/2 related test file(s)',
    'execute:test/a.test.mjs',
  ]);

  events.length = 0;
  await executeSelectionRun({
    ...runtime,
    loadRecord: () => record,
    prepare: () => ({
      emptyMessage: 'No affected tests found.',
      selection: { kind: 'selected', messages: [], tests: [] },
    }),
  });
  assert.deepEqual(events, ['log:No affected tests found.']);
});
