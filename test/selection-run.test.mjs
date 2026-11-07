import assert from 'node:assert/strict';
import test from 'node:test';

import { selectTestsForFiles, selectTestsSinceLastRun } from '../src/selection-run.mjs';

const tests = ['test/a.test.mjs', 'test/b.test.mjs'];
const record = {
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
  });

  assert.deepEqual(selectTestsForFiles({
    config,
    files: ['src/new.ts'],
    record,
    tests,
  }), {
    kind: 'baseline',
    message: 'Unknown code file changed (src/new.ts); running full suite.',
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
    tests: ['test/a.test.mjs'],
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
    tests: ['test/b.test.mjs'],
  });
});
