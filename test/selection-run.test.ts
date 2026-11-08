import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectLastFailed,
  selectTestsForFiles,
  selectTestsSinceLastRun,
} from '../src/selection-run.ts';
import type { DependencyRecord, DependencyState } from '../src/dependency-record.ts';

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
} satisfies Pick<DependencyRecord, 'dependencyStates' | 'failedTests' | 'graph' | 'unresolvedStaticTests'>;
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
    config,
    files: ['pnpm-workspace.yaml'],
    record,
    tests,
  }), {
    kind: 'baseline',
    message: 'Project configuration changed; running full suite.',
    reason: { files: ['pnpm-workspace.yaml'], kind: 'project-configuration' },
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

test('multiple changed files retain one dependency reason and path per match', () => {
  assert.deepEqual(selectTestsForFiles({
    config,
    files: ['src/a.mjs', 'src/shared.mjs'],
    record: { ...record, failedTests: [] },
    tests,
  }), {
    kind: 'selected',
    messages: [],
    reasons: {
      'test/a.test.mjs': [
        { file: 'src/a.mjs', kind: 'dependency', path: ['test/a.test.mjs', 'src/a.mjs'] },
        { file: 'src/shared.mjs', kind: 'dependency', path: ['test/a.test.mjs', 'src/a.mjs', 'src/shared.mjs'] },
      ],
    },
    tests: ['test/a.test.mjs'],
  });
});

test('mtime selection returns the same normalized targeted outcome', () => {
  const unchangedState: DependencyState = {};
  const changedState: DependencyState = { 'src/changed.mjs': { mtimeMs: 1, size: 1 } };
  const changedStates = new Set([changedState]);

  assert.deepEqual(selectTestsSinceLastRun({
    dependencyStateChanged: (state) => changedStates.has(state),
    record: {
      ...record,
      dependencyStates: {
        'test/a.test.mjs': unchangedState,
        'test/b.test.mjs': changedState,
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
