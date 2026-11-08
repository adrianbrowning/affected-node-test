import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { run, runWithEnv, git, makeRepository, makeParallelRepository, edgeTemporaryDirectories } from '../helpers/cli-fixtures.ts';

test('--concurrency bounds parallel execution and preserves output order', () => {
  const cwd = makeParallelRepository();
  const tracker = join(cwd, 'processes.log');
  try {
    const baseline = runWithEnv(cwd, { TEST_TRACKER: tracker }, 'baseline', '--concurrency', '2');
    assert.equal(baseline.status, 0, baseline.stderr);

    let active = 0;
    let maximumActive = 0;
    for (const event of readFileSync(tracker, 'utf8').trim().split('\n')) {
      if (event.startsWith('start:')) active += 1;
      else if (event.startsWith('end:')) active -= 1;
      maximumActive = Math.max(maximumActive, active);
      assert.ok(active >= 0 && active <= 2, `invalid active process count after ${event}: ${active}`);
    }
    assert.equal(active, 0);
    assert.equal(maximumActive, 2);

    const a = baseline.stdout.indexOf('▶ test/a.test.mjs');
    const b = baseline.stdout.indexOf('▶ test/b.test.mjs');
    const c = baseline.stdout.indexOf('▶ test/c.test.mjs');
    assert.ok(a !== -1 && a < b && b < c, baseline.stdout);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('large worker output preserves reporting and temporary-file cleanup on pass and failure', () => {
  const cwd = makeRepository();
  const testPath = join(cwd, 'test', 'value.test.mjs');
  const temporaryDirectories = edgeTemporaryDirectories();
  writeFileSync(testPath, `${readFileSync(testPath, 'utf8')}\nawait new Promise((resolve) => process.stdout.write('spill:' + 'x'.repeat(300_000) + ':spill-end\\n', resolve));\n`);
  git(cwd, 'add', 'test/value.test.mjs');
  git(cwd, 'commit', '-qm', 'add large output');
  try {
    const passing = run(cwd, 'baseline', '--concurrency', '1');
    assert.equal(passing.status, 0, passing.stderr);
    assert.equal(passing.stdout.match(/spill:(x+):spill-end/)?.[1].length, 300_000);
    assert.deepEqual(edgeTemporaryDirectories(), temporaryDirectories);

    writeFileSync(testPath, `${readFileSync(testPath, 'utf8')}\nthrow new Error('after spill');\n`);
    const failing = run(cwd, 'affected', '--concurrency', '1');
    assert.equal(failing.status, 1);
    assert.equal(failing.stdout.match(/spill:(x+):spill-end/)?.[1].length, 300_000);
    assert.match(failing.stdout, /after spill/);
    assert.deepEqual(edgeTemporaryDirectories(), temporaryDirectories);

    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      nodeArgs: ['--definitely-not-a-node-option'],
    }));
    const startupFailure = run(cwd, 'baseline', '--concurrency', '1');
    assert.equal(startupFailure.status, 1);
    assert.match(`${startupFailure.stdout}${startupFailure.stderr}`, /bad option|not allowed|unknown option/i);
    assert.deepEqual(edgeTemporaryDirectories(), temporaryDirectories);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('historically slow tests start first while reporting remains deterministic', () => {
  const cwd = makeParallelRepository({ delays: { a: 50, b: 50, c: 50 } });
  const tracker = join(cwd, 'processes.log');
  try {
    const baseline = runWithEnv(cwd, { TEST_TRACKER: tracker }, 'baseline', '--concurrency', '1');
    assert.equal(baseline.status, 0, baseline.stderr);
    const cachePath = join(cwd, '.affected-tests', 'graph.json');
    const record = JSON.parse(readFileSync(cachePath, 'utf8'));
    record.durations = {
      'test/a.test.mjs': 100,
      'test/b.test.mjs': 300,
      'test/c.test.mjs': 200,
    };
    writeFileSync(cachePath, JSON.stringify(record));

    writeFileSync(tracker, '');
    for (const name of ['a', 'b', 'c']) {
      const path = join(cwd, 'test', `${name}.test.mjs`);
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n// changed\n`);
    }
    const affected = runWithEnv(cwd, { TEST_TRACKER: tracker }, 'affected', '--concurrency', '1');
    assert.equal(affected.status, 0, affected.stderr);
    const starts = readFileSync(tracker, 'utf8').trim().split('\n')
      .filter((event) => event.startsWith('start:'));
    assert.deepEqual(starts, ['start:b', 'start:c', 'start:a']);

    const a = affected.stdout.indexOf('▶ test/a.test.mjs');
    const b = affected.stdout.indexOf('▶ test/b.test.mjs');
    const c = affected.stdout.indexOf('▶ test/c.test.mjs');
    assert.ok(a !== -1 && a < b && b < c, affected.stdout);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
