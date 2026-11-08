import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { run, runWithEnv, git, makeRepository } from '../helpers/cli-fixtures.ts';

test('affected-first runs the selected partition before the complement without duplicates', () => {
  const cwd = makeRepository({ withOtherTest: true });
  const tracker = join(tmpdir(), `affected-first-${process.pid}-${Date.now()}.log`);
  try {
    for (const [file, label] of [['value.test.mjs', 'value'], ['other.test.mjs', 'other']] as const) {
      const path = join(cwd, 'test', file);
      writeFileSync(path, [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(process.env.PARTITION_TRACKER, '${label}\\n');`,
        readFileSync(path, 'utf8'),
      ].join('\n'));
    }
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'track partition execution');
    assert.equal(runWithEnv(cwd, { PARTITION_TRACKER: tracker }, 'baseline').status, 0);
    writeFileSync(tracker, '');

    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // affected-first\n');
    const result = runWithEnv(cwd, { PARTITION_TRACKER: tracker },
      'affected-first', 'HEAD', '--concurrency', '1');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Affected phase: 1\/2 test file\(s\)/);
    assert.match(result.stdout, /Remaining phase: 1\/2 test file\(s\)/);
    assert.deepEqual(readFileSync(tracker, 'utf8').trim().split('\n'), ['value', 'other']);
    const record = JSON.parse(readFileSync(join(cwd, '.affected-tests', 'graph.json'), 'utf8'));
    assert.deepEqual(Object.keys(record.graph).sort(), ['test/other.test.mjs', 'test/value.test.mjs']);
  } finally {
    rmSync(tracker, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('affected-first phases hand off a portable plan and run only the complement', () => {
  const cwd = makeRepository({ withOtherTest: true });
  const tracker = join(tmpdir(), `affected-first-phases-${process.pid}-${Date.now()}.log`);
  const planPath = join(cwd, '.affected-tests', 'ci-plan.json');
  try {
    for (const [file, label] of [['value.test.mjs', 'value'], ['other.test.mjs', 'other']] as const) {
      const path = join(cwd, 'test', file);
      writeFileSync(path, [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(process.env.PARTITION_TRACKER, '${label}\\n');`,
        readFileSync(path, 'utf8'),
      ].join('\n'));
    }
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'track phased execution');
    assert.equal(runWithEnv(cwd, { PARTITION_TRACKER: tracker }, 'baseline').status, 0);
    const previousCache = readFileSync(join(cwd, '.affected-tests', 'graph.json'), 'utf8');
    writeFileSync(tracker, '');
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // phased\n');

    const first = runWithEnv(cwd, { PARTITION_TRACKER: tracker },
      'affected-first', 'HEAD', '--phase', 'affected', '--plan', '.affected-tests/ci-plan.json');
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(readFileSync(tracker, 'utf8').trim().split('\n'), ['value']);
    assert.equal(readFileSync(join(cwd, '.affected-tests', 'graph.json'), 'utf8'), previousCache);
    const serializedPlan = readFileSync(planPath, 'utf8');
    assert.doesNotMatch(serializedPlan, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(JSON.parse(serializedPlan).state, 'affected-passed');

    const second = runWithEnv(cwd, { PARTITION_TRACKER: tracker },
      'affected-first', '--phase', 'remaining', '--plan', '.affected-tests/ci-plan.json');
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readFileSync(tracker, 'utf8').trim().split('\n'), ['value', 'other']);
    assert.deepEqual(JSON.parse(readFileSync(planPath, 'utf8')).state, 'complete');
  } finally {
    rmSync(tracker, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('affected-first remaining phase rejects stale and malformed plans before running tests', () => {
  const cwd = makeRepository({ withOtherTest: true });
  const plan = '.affected-tests/ci-plan.json';
  const planPath = join(cwd, plan);
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // plan identity\n');
    const first = run(cwd, 'affected-first', 'HEAD', '--phase', 'affected', '--plan', plan);
    assert.equal(first.status, 0, first.stderr);

    const document = JSON.parse(readFileSync(planPath, 'utf8'));
    document.node = '0.0.0';
    writeFileSync(planPath, JSON.stringify(document));
    const stale = run(cwd, 'affected-first', '--phase', 'remaining', '--plan', plan);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /Partition plan is stale: node changed; rerun the affected phase/);

    document.node = process.versions.node;
    document.affectedResult.resultGraph['test/value.test.mjs'] = [
      ['test/value.test.mjs', '../../outside.mjs'],
    ];
    writeFileSync(planPath, JSON.stringify(document));
    const unsafe = run(cwd, 'affected-first', '--phase', 'remaining', '--plan', plan);
    assert.equal(unsafe.status, 1);
    assert.match(unsafe.stderr, /Partition plan affected result is invalid/);

    writeFileSync(planPath, '{not json');
    const malformed = run(cwd, 'affected-first', '--phase', 'remaining', '--plan', plan);
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /Partition plan is invalid/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a failed affected-first phase leaves the complement and graph cache untouched', () => {
  const cwd = makeRepository({ withOtherTest: true });
  const tracker = join(tmpdir(), `affected-first-failure-${process.pid}-${Date.now()}.log`);
  try {
    for (const [file, label] of [['value.test.mjs', 'value'], ['other.test.mjs', 'other']] as const) {
      const path = join(cwd, 'test', file);
      writeFileSync(path, [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(process.env.PARTITION_TRACKER, '${label}\\n');`,
        readFileSync(path, 'utf8'),
      ].join('\n'));
    }
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'track failed partition');
    assert.equal(runWithEnv(cwd, { PARTITION_TRACKER: tracker }, 'baseline').status, 0);
    const cache = readFileSync(join(cwd, '.affected-tests', 'graph.json'), 'utf8');
    writeFileSync(tracker, '');
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');

    const result = runWithEnv(cwd, { PARTITION_TRACKER: tracker },
      'affected-first', 'HEAD', '--phase', 'affected', '--plan', '.affected-tests/ci-plan.json');
    assert.equal(result.status, 1);
    assert.deepEqual(readFileSync(tracker, 'utf8').trim().split('\n'), ['value']);
    assert.equal(readFileSync(join(cwd, '.affected-tests', 'graph.json'), 'utf8'), cache);
    assert.equal(JSON.parse(readFileSync(join(cwd, '.affected-tests', 'ci-plan.json'), 'utf8')).state,
      'affected-failed');
  } finally {
    rmSync(tracker, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('affected-first JSON reports both partitions and the completed inventory', () => {
  const cwd = makeRepository({ withOtherTest: true });
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // json partition\n');
    const result = run(cwd, 'affected-first', 'HEAD', '--output=json');
    assert.equal(result.status, 0, result.stderr);
    const document = JSON.parse(result.stdout);
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.command, 'affected-first');
    assert.equal(document.phase, 'all');
    assert.deepEqual(document.partitions.affected, ['test/value.test.mjs']);
    assert.deepEqual(document.partitions.remaining, ['test/other.test.mjs']);
    assert.deepEqual(document.completedTests.sort(), ['test/other.test.mjs', 'test/value.test.mjs']);
    assert.equal(document.exitCode, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
