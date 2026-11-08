import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { run, git, makeRepository, makeNonGitRepository } from '../helpers/cli-fixtures.ts';

test('since-last-run selects changed dependencies without Git', () => {
  const cwd = makeNonGitRepository();
  try {
    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // changed\n');

    const selected = run(cwd, 'since-last-run');
    assert.equal(selected.status, 0, selected.stderr);
    assert.match(selected.stdout, /Selected 1\/1 test file\(s\) since last run/);
    assert.match(selected.stdout, /▶ test\/value\.test\.mjs/);

    const unchanged = run(cwd, 'since-last-run');
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.match(unchanged.stdout, /No tests changed since last run\./);
    assert.doesNotMatch(unchanged.stdout, /▶/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('new tests run incrementally in Git and mtime modes', () => {
  const cwd = makeRepository();
  const writeTest = (name: string) => writeFileSync(join(cwd, 'test', `${name}.test.mjs`), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';",
    `test('${name}', () => assert.equal(value, 1));`,
    '',
  ].join('\n'));
  try {
    assert.equal(run(cwd, 'baseline').status, 0);

    writeTest('added');
    const affected = run(cwd, 'affected');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Selected 1\/2 test file\(s\)/);
    assert.match(affected.stdout, /▶ test\/added\.test\.mjs/);
    assert.doesNotMatch(affected.stdout, /▶ test\/value\.test\.mjs/);

    writeTest('later');
    const sinceLastRun = run(cwd, 'since-last-run');
    assert.equal(sinceLastRun.status, 0, sinceLastRun.stderr);
    assert.match(sinceLastRun.stdout, /Selected 1\/3 test file\(s\) since last run/);
    assert.match(sinceLastRun.stdout, /▶ test\/later\.test\.mjs/);
    assert.doesNotMatch(sinceLastRun.stdout, /▶ test\/(?:added|value)\.test\.mjs/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a failing new test remains an incremental sticky failure', () => {
  const cwd = makeRepository();
  const addedTest = join(cwd, 'test', 'added.test.mjs');
  const source = (expected: number) => [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';",
    `test('added', () => assert.equal(value, ${expected}));`,
    '',
  ].join('\n');
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    writeFileSync(addedTest, source(2));

    const failed = run(cwd, 'affected');
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /▶ test\/added\.test\.mjs/);
    assert.doesNotMatch(failed.stdout, /▶ test\/value\.test\.mjs/);

    writeFileSync(addedTest, source(1));
    const recovered = run(cwd, 'affected');
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /Selected 1\/2 test file\(s\)/);
    assert.match(recovered.stdout, /▶ test\/added\.test\.mjs/);
    assert.doesNotMatch(recovered.stdout, /▶ test\/value\.test\.mjs/);
    assert.doesNotMatch(recovered.stdout, /Invalid graph cache/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an untaken literal dynamic import selects only its owning test', () => {
  const cwd = makeRepository({ withOtherTest: true });
  try {
    writeFileSync(join(cwd, 'src', 'lazy.mjs'), 'export const lazy = true;\n');
    const testPath = join(cwd, 'test', 'value.test.mjs');
    writeFileSync(testPath, `if (false) await import('../src/lazy.mjs');\n${readFileSync(testPath, 'utf8')}`);
    git(cwd, 'add', 'src/lazy.mjs', 'test/value.test.mjs');
    git(cwd, 'commit', '-qm', 'add untaken literal import');
    assert.equal(run(cwd, 'baseline').status, 0);

    writeFileSync(join(cwd, 'src', 'lazy.mjs'), 'export const lazy = false;\n');
    const affected = run(cwd, 'affected', 'HEAD');

    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Selected 1\/2 test file\(s\)/);
    assert.match(affected.stdout, /▶ test\/value\.test\.mjs/);
    assert.doesNotMatch(affected.stdout, /▶ test\/other\.test\.mjs|Building graph from 2 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an unresolved computed import conservatively selects its owning test', () => {
  const cwd = makeRepository({ withOtherTest: true });
  try {
    const testPath = join(cwd, 'test', 'value.test.mjs');
    writeFileSync(testPath, [
      "const lazyTarget = '../src/other.mjs';",
      'if (false) await import(lazyTarget);',
      readFileSync(testPath, 'utf8'),
    ].join('\n'));
    git(cwd, 'add', 'test/value.test.mjs');
    git(cwd, 'commit', '-qm', 'add computed import');
    assert.equal(run(cwd, 'baseline').status, 0);

    writeFileSync(join(cwd, 'src', 'other.mjs'), 'export const other = 2; // changed\n');
    const affected = run(cwd, 'affected', 'HEAD');

    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Selected 2\/2 test file\(s\)/);
    assert.match(affected.stdout, /▶ test\/other\.test\.mjs/);
    assert.match(affected.stdout, /▶ test\/value\.test\.mjs/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('related selects tests for explicit files without Git', () => {
  const cwd = makeNonGitRepository({ withOtherTest: true });
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    const related = run(cwd, 'related', 'src/value.mjs');

    assert.equal(related.status, 0, related.stderr);
    assert.match(related.stdout, /Related files: src\/value\.mjs/);
    assert.match(related.stdout, /Selected 1\/2 related test file\(s\)/);
    assert.match(related.stdout, /▶ test\/value\.test\.mjs/);
    assert.doesNotMatch(related.stdout, /▶ test\/other\.test\.mjs/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
