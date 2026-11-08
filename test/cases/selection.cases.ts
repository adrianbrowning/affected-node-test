import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { run, git, makeRepository, makeCommonJsRepository } from '../helpers/cli-fixtures.ts';

test('a structurally invalid cache falls back to the full suite', () => {
  const cwd = makeRepository();
  try {
    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(readFileSync(join(cwd, '.affected-tests', 'graph.json'), 'utf8'), /src\/value\.mjs/);

    writeFileSync(join(cwd, '.affected-tests', 'graph.json'), 'null\n');
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // changed\n');

    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Invalid graph cache; running full suite\./);
    assert.match(affected.stdout, /Building graph from 1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the cache is pinned to the exact Node runtime version', () => {
  const cwd = makeRepository();
  try {
    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    const saved = JSON.parse(readFileSync(join(cwd, '.affected-tests', 'graph.json'), 'utf8'));
    assert.equal(saved.node, process.versions.node);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('affected compares against the merge base of a diverged target branch', () => {
  const cwd = makeRepository({ withOtherTest: true });
  try {
    git(cwd, 'switch', '-qc', 'feature');
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // feature\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'feature change');

    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(readFileSync(join(cwd, '.affected-tests', 'graph.json'), 'utf8'), /src\/value\.mjs/);

    git(cwd, 'switch', '-q', 'main');
    writeFileSync(join(cwd, 'src', 'other.mjs'), 'export const other = 2; // main\n');
    git(cwd, 'add', 'src/other.mjs');
    git(cwd, 'commit', '-qm', 'main change');
    git(cwd, 'switch', '-q', 'feature');

    const affected = run(cwd, 'affected', 'main');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Changed files: src\/value\.mjs/);
    assert.doesNotMatch(affected.stdout, /src\/other\.mjs/);
    assert.match(affected.stdout, /Selected 1\/2 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a ref without a merge base falls back to the full suite', () => {
  const cwd = makeRepository();
  try {
    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);

    const tree = git(cwd, 'rev-parse', 'HEAD^{tree}').trim();
    const unrelated = git(cwd, 'commit-tree', tree, '-m', 'unrelated root').trim();
    git(cwd, 'update-ref', 'refs/heads/unrelated', unrelated);
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // changed\n');

    const affected = run(cwd, 'affected', 'unrelated');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /No merge base with unrelated; running full suite\./);
    assert.match(affected.stdout, /Building graph from 1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a failing affected run preserves the previous graph and records the failure', () => {
  const cwd = makeRepository();
  try {
    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    const cachePath = join(cwd, '.affected-tests', 'graph.json');
    const previousCache = JSON.parse(readFileSync(cachePath, 'utf8'));

    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = ;\n');
    const affected = run(cwd, 'affected', 'HEAD');

    assert.equal(affected.status, 1);
    assert.match(affected.stderr, /Tests failed; previous dependency graph was left unchanged and failure status was recorded\./);
    const updatedCache = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.deepEqual(updatedCache.graph, previousCache.graph);
    assert.deepEqual(updatedCache.failedTests, ['test/value.test.mjs']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a previously failing test is rerun even when the Git diff is empty', () => {
  const cwd = makeRepository();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = ;\n');

    const firstFailure = run(cwd, 'affected', 'HEAD');
    assert.equal(firstFailure.status, 1);
    git(cwd, 'add', 'src/value.mjs');
    git(cwd, 'commit', '-qm', 'commit failing change');

    const retry = run(cwd, 'affected', 'HEAD');
    assert.equal(retry.status, 1);
    assert.match(retry.stdout, /No changed files; rerunning 1 previously failing test file\(s\)\./);
    assert.match(retry.stdout, /▶ test\/value\.test\.mjs/);

    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // fixed\n');
    const recovery = run(cwd, 'affected', 'HEAD');
    assert.equal(recovery.status, 0, recovery.stderr);
    git(cwd, 'add', 'src/value.mjs');
    git(cwd, 'commit', '-qm', 'fix test dependency');

    const afterRecovery = run(cwd, 'affected', 'HEAD');
    assert.equal(afterRecovery.status, 0, afterRecovery.stderr);
    assert.match(afterRecovery.stdout, /No changed files\./);
    assert.doesNotMatch(afterRecovery.stdout, /▶ test\/value\.test\.mjs/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a cache is invalidated by committed project configuration changes', () => {
  const cwd = makeRepository();
  try {
    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);

    writeFileSync(join(cwd, 'package.json'), '{"type":"module","description":"changed"}\n');
    git(cwd, 'add', 'package.json');
    git(cwd, 'commit', '-qm', 'change project configuration');

    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Project configuration changed since graph was built; running full suite\./);
    assert.match(affected.stdout, /Building graph from 1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('CommonJS require dependencies select affected tests', () => {
  const cwd = makeCommonJsRepository();
  try {
    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(readFileSync(join(cwd, '.affected-tests', 'graph.json'), 'utf8'), /src\/value\.cjs/);

    writeFileSync(join(cwd, 'src', 'value.cjs'), 'exports.value = 1; // changed\n');
    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Selected 1\/1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('staged changes to known dependencies select affected tests', () => {
  const cwd = makeRepository();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // staged\n');
    git(cwd, 'add', 'src/value.mjs');

    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Selected 1\/1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('ref-less affected selects tests for uncommitted changes', () => {
  const cwd = makeRepository({ withOtherTest: true });
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // unstaged\n');

    const affected = run(cwd, 'affected');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Changed files: src\/value\.mjs/);
    assert.match(affected.stdout, /Selected 1\/2 test file\(s\)/);
    assert.match(affected.stdout, /▶ test\/value\.test\.mjs/);
    assert.doesNotMatch(affected.stdout, /▶ test\/other\.test\.mjs/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an untracked JavaScript file triggers a conservative full run', () => {
  const cwd = makeRepository();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    writeFileSync(join(cwd, 'src', 'new.mjs'), 'export const added = true;\n');

    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Unknown code file changed \(src\/new\.mjs\); running full suite\./);
    assert.match(affected.stdout, /Building graph from 1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a renamed dependency triggers a conservative full run', () => {
  const cwd = makeRepository();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    git(cwd, 'mv', 'src/value.mjs', 'src/renamed.mjs');
    writeFileSync(join(cwd, 'test', 'value.test.mjs'),
      readFileSync(join(cwd, 'test', 'value.test.mjs'), 'utf8').replace('../src/value.mjs', '../src/renamed.mjs'));
    git(cwd, 'add', 'test/value.test.mjs');

    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Unknown code file changed \(src\/renamed\.mjs\); running full suite\./);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a deleted dependency still selects its affected test', () => {
  const cwd = makeRepository();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    git(cwd, 'rm', 'src/value.mjs');

    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 1);
    assert.match(affected.stdout, /Selected 1\/1 test file\(s\)/);
    assert.match(affected.stderr, /Tests failed; previous dependency graph was left unchanged and failure status was recorded\./);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
