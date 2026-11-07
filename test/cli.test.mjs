import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/affected-node-test.mjs', import.meta.url));

function run(cwd, ...args) {
  return runWithEnv(cwd, {}, ...args);
}

function runWithEnv(cwd, extraEnv, ...args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env });
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function makeRepository({ withOtherTest = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-repo-'));
  mkdirSync(join(cwd, 'src'));
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(cwd, 'test', 'value.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';",
    "test('value', () => assert.equal(value, 1));",
    '',
  ].join('\n'));
  if (withOtherTest) {
    writeFileSync(join(cwd, 'src', 'other.mjs'), 'export const other = 2;\n');
    writeFileSync(join(cwd, 'test', 'other.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { other } from '../src/other.mjs';",
      "test('other', () => assert.equal(other, 2));",
      '',
    ].join('\n'));
  }
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'tests@example.invalid');
  git(cwd, 'config', 'user.name', 'Tests');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'initial');
  return cwd;
}

function makeNonGitRepository({ withOtherTest = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-nongit-'));
  mkdirSync(join(cwd, 'src'));
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(cwd, 'test', 'value.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';",
    "test('value', () => assert.equal(value, 1));",
    '',
  ].join('\n'));
  if (withOtherTest) {
    writeFileSync(join(cwd, 'src', 'other.mjs'), 'export const other = 2;\n');
    writeFileSync(join(cwd, 'test', 'other.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { other } from '../src/other.mjs';",
      "test('other', () => assert.equal(other, 2));",
      '',
    ].join('\n'));
  }
  return cwd;
}

function makeCommonJsRepository() {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-cjs-'));
  mkdirSync(join(cwd, 'src'));
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'package.json'), '{"type":"commonjs"}\n');
  writeFileSync(join(cwd, 'src', 'value.cjs'), 'exports.value = 1;\n');
  writeFileSync(join(cwd, 'test', 'value.test.cjs'), [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { value } = require('../src/value.cjs');",
    "test('value', () => assert.equal(value, 1));",
    '',
  ].join('\n'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'tests@example.invalid');
  git(cwd, 'config', 'user.name', 'Tests');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'initial');
  return cwd;
}

function makeParallelRepository() {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-parallel-'));
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
  for (const name of ['a', 'b', 'c']) {
    writeFileSync(join(cwd, 'test', `${name}.test.mjs`), [
      "import { appendFileSync } from 'node:fs';",
      "import test from 'node:test';",
      `appendFileSync(process.env.TEST_TRACKER, 'start:${name}\\n');`,
      'await new Promise((resolve) => setTimeout(resolve, 500));',
      `appendFileSync(process.env.TEST_TRACKER, 'end:${name}\\n');`,
      `test('${name}', () => {});`,
      '',
    ].join('\n'));
  }
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'tests@example.invalid');
  git(cwd, 'config', 'user.name', 'Tests');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'initial');
  return cwd;
}

function makeInterruptRepository() {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-interrupt-'));
  mkdirSync(join(cwd, 'src'));
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(cwd, 'test', 'value.test.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';",
    'if (process.env.INTERRUPT_TRACKER) {',
    "  appendFileSync(process.env.INTERRUPT_TRACKER, `start:${process.pid}\\n`);",
    '  await new Promise((resolve) => setTimeout(resolve, 10_000));',
    "  appendFileSync(process.env.INTERRUPT_TRACKER, 'end\\n');",
    '}',
    "test('value', () => assert.equal(value, 1));",
    '',
  ].join('\n'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'tests@example.invalid');
  git(cwd, 'config', 'user.name', 'Tests');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'initial');
  return cwd;
}

function makeSetupRepository() {
  const cwd = makeRepository({ withOtherTest: true });
  writeFileSync(join(cwd, 'test', 'setup-helper.mjs'), 'globalThis.setupReady = true;\n');
  writeFileSync(join(cwd, 'test', 'setup.mjs'), "import './setup-helper.mjs';\n");
  for (const [file, name] of [['value.test.mjs', 'value'], ['other.test.mjs', 'other']]) {
    const path = join(cwd, 'test', file);
    const source = readFileSync(path, 'utf8');
    writeFileSync(path, source.replace(
      `test('${name}', () => assert.equal(${name}, ${name === 'value' ? 1 : 2}));`,
      `test('${name}', () => { assert.equal(globalThis.setupReady, true); assert.equal(${name}, ${name === 'value' ? 1 : 2}); });`,
    ));
  }
  writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
    setupFiles: ['test/setup.mjs'],
  }, null, 2));
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'configure setup file');
  return cwd;
}

function makeGlobalSetupRepository() {
  const cwd = makeRepository({ withOtherTest: true });
  writeFileSync(join(cwd, 'test', 'global-setup-helper.mjs'), "export const ready = 'yes';\n");
  writeFileSync(join(cwd, 'test', 'global-setup.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    "import { ready } from './global-setup-helper.mjs';",
    'export async function setup() {',
    "  appendFileSync(process.env.GLOBAL_SETUP_LOG, 'setup\\n');",
    '  process.env.GLOBAL_SETUP_READY = ready;',
    "  return async () => appendFileSync(process.env.GLOBAL_SETUP_LOG, 'teardown\\n');",
    '}',
    '',
  ].join('\n'));
  for (const file of ['value.test.mjs', 'other.test.mjs']) {
    const path = join(cwd, 'test', file);
    const source = readFileSync(path, 'utf8');
    writeFileSync(path, source.replace('test(', "test('global setup', () => assert.equal(process.env.GLOBAL_SETUP_READY, 'yes'));\ntest("));
  }
  writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
    globalSetupFiles: ['test/global-setup.mjs'],
  }, null, 2));
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'configure global setup');
  return cwd;
}

function makeEnvironmentRepository() {
  const cwd = makeRepository();
  writeFileSync(join(cwd, '.env.test'), 'NODE_AFFECTED_TESTS_ENV_FIXTURE_7F3=from-env-file\n');
  const testPath = join(cwd, 'test', 'value.test.mjs');
  writeFileSync(testPath, `${readFileSync(testPath, 'utf8')}\ntest('environment', () => assert.equal(process.env.NODE_AFFECTED_TESTS_ENV_FIXTURE_7F3, 'from-env-file'));\n`);
  writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
    envFiles: ['.env.test'],
  }, null, 2));
  git(cwd, 'add', '.env.test', 'test/value.test.mjs', 'affected-node-test.config.json');
  git(cwd, 'commit', '-qm', 'configure environment file');
  return cwd;
}

async function waitFor(check, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Timed out waiting for condition');
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function edgeTemporaryDirectories() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('affected-test-')).sort();
}

test('--help succeeds outside a Git repository', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-help-'));
  try {
    const result = spawnSync(process.execPath, [cli, '--help'], {
      cwd,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('--concurrency rejects non-positive values before accessing Git', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-options-'));
  try {
    const result = run(cwd, 'baseline', '--concurrency', '0');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--concurrency must be a positive integer\./);
    assert.doesNotMatch(result.stderr, /not a git repository/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

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
    assert.match(affected.stdout, /Unknown JS file changed \(src\/new\.mjs\); running full suite\./);
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
    assert.match(affected.stdout, /Unknown JS file changed \(src\/renamed\.mjs\); running full suite\./);
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

test('SIGTERM stops active test processes and preserves the cache', { timeout: 15_000 }, async () => {
  const cwd = makeInterruptRepository();
  const tracker = join(cwd, 'interrupt.log');
  let cliProcess;
  let testPid;
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    const cachePath = join(cwd, '.affected-tests', 'graph.json');
    const previousCache = readFileSync(cachePath, 'utf8');
    const previousTemporaryDirectories = edgeTemporaryDirectories();
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // changed\n');

    const env = { ...process.env, INTERRUPT_TRACKER: tracker };
    delete env.NODE_TEST_CONTEXT;
    cliProcess = spawn(process.execPath, [cli, 'affected', 'HEAD', '--concurrency', '1'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    cliProcess.stderr.setEncoding('utf8');
    cliProcess.stderr.on('data', (chunk) => { stderr += chunk; });

    await waitFor(() => existsSync(tracker));
    testPid = Number(readFileSync(tracker, 'utf8').match(/start:(\d+)/)?.[1]);
    assert.ok(Number.isSafeInteger(testPid) && testPid > 1);

    const exited = new Promise((resolveExit) => cliProcess.once('exit', (code, signal) => resolveExit({ code, signal })));
    cliProcess.kill('SIGTERM');
    const result = await exited;

    await waitFor(() => !isProcessRunning(testPid));
    await waitFor(() => JSON.stringify(edgeTemporaryDirectories()) === JSON.stringify(previousTemporaryDirectories));
    assert.deepEqual(result, { code: 143, signal: null });
    assert.match(stderr, /Test run interrupted by SIGTERM; previous graph was left unchanged\./);
    assert.equal(readFileSync(cachePath, 'utf8'), previousCache);
  } finally {
    if (cliProcess && cliProcess.exitCode === null && cliProcess.signalCode === null) cliProcess.kill('SIGKILL');
    if (Number.isSafeInteger(testPid) && testPid > 1 && isProcessRunning(testPid)) process.kill(testPid, 'SIGKILL');
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('configured force-rerun triggers run the full suite for non-module files', () => {
  const cwd = makeRepository();
  try {
    mkdirSync(join(cwd, 'fixtures'));
    writeFileSync(join(cwd, 'fixtures', 'template.txt'), 'initial\n');
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      forceRerunTriggers: ['fixtures/**'],
    }, null, 2));
    git(cwd, 'add', 'fixtures/template.txt', 'affected-node-test.config.json');
    git(cwd, 'commit', '-qm', 'configure fixture trigger');
    assert.equal(run(cwd, 'baseline').status, 0);

    writeFileSync(join(cwd, 'fixtures', 'template.txt'), 'changed\n');
    const affected = run(cwd, 'affected', 'HEAD');

    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Force-rerun trigger matched: fixtures\/template\.txt; running full suite\./);
    assert.match(affected.stdout, /Building graph from 1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('configured include and exclude patterns control test discovery', () => {
  const cwd = makeRepository();
  try {
    mkdirSync(join(cwd, 'specs'));
    mkdirSync(join(cwd, 'specs', 'ignored'));
    const customTest = "import test from 'node:test'; test('custom', () => {});\n";
    writeFileSync(join(cwd, 'specs', 'custom.check.mjs'), customTest);
    writeFileSync(join(cwd, 'specs', 'ignored', 'skip.check.mjs'), customTest);
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      include: ['specs/**/*.check.mjs'],
      exclude: ['specs/ignored/**'],
    }, null, 2));
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'configure test discovery');

    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /Building graph from 1 test file\(s\)/);
    assert.match(baseline.stdout, /▶ specs\/custom\.check\.mjs/);
    assert.doesNotMatch(baseline.stdout, /skip\.check\.mjs|test\/value\.test\.mjs/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('invalid project configuration fails before running tests', () => {
  const cwd = makeRepository();
  try {
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      include: 'test/**/*.mjs',
    }));

    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 1);
    assert.match(baseline.stderr, /affected-node-test\.config\.json: include must be an array of non-empty strings\./);
    assert.doesNotMatch(baseline.stdout, /Building graph|▶/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('watch-trigger mappings select tests for non-module changes', () => {
  const cwd = makeRepository({ withOtherTest: true });
  try {
    mkdirSync(join(cwd, 'fixtures'));
    writeFileSync(join(cwd, 'fixtures', 'value.txt'), 'initial\n');
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      watchTriggerPatterns: [
        { pattern: 'fixtures/**', tests: ['test/value.test.mjs'] },
      ],
    }, null, 2));
    git(cwd, 'add', 'fixtures/value.txt', 'affected-node-test.config.json');
    git(cwd, 'commit', '-qm', 'configure watch trigger');
    assert.equal(run(cwd, 'baseline').status, 0);

    writeFileSync(join(cwd, 'fixtures', 'value.txt'), 'changed\n');
    const affected = run(cwd, 'affected', 'HEAD');

    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Watch trigger matched fixtures\/value\.txt; selected 1 mapped test file\(s\)\./);
    assert.match(affected.stdout, /Selected 1\/2 test file\(s\)/);
    assert.match(affected.stdout, /▶ test\/value\.test\.mjs/);
    assert.doesNotMatch(affected.stdout, /▶ test\/other\.test\.mjs/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a watch-trigger mapping with no discovered tests runs the full suite', () => {
  const cwd = makeRepository({ withOtherTest: true });
  try {
    mkdirSync(join(cwd, 'fixtures'));
    writeFileSync(join(cwd, 'fixtures', 'value.txt'), 'initial\n');
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      watchTriggerPatterns: [
        { pattern: 'fixtures/**', tests: ['test/missing*.test.mjs'] },
      ],
    }, null, 2));
    git(cwd, 'add', 'fixtures/value.txt', 'affected-node-test.config.json');
    git(cwd, 'commit', '-qm', 'configure unmatched watch trigger');
    assert.equal(run(cwd, 'baseline').status, 0);

    writeFileSync(join(cwd, 'fixtures', 'value.txt'), 'changed\n');
    const affected = run(cwd, 'affected', 'HEAD');

    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Watch trigger matched fixtures\/value\.txt but selected no tests; running full suite\./);
    assert.match(affected.stdout, /Building graph from 2 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('committed project dependency changes invalidate the graph cache', () => {
  const cwd = makeRepository();
  try {
    writeFileSync(join(cwd, 'test', 'setup.mjs'), 'export const setupVersion = 1;\n');
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      projectDependencies: ['test/setup.mjs'],
    }, null, 2));
    git(cwd, 'add', 'test/setup.mjs', 'affected-node-test.config.json');
    git(cwd, 'commit', '-qm', 'declare project setup dependency');
    assert.equal(run(cwd, 'baseline').status, 0);

    writeFileSync(join(cwd, 'test', 'setup.mjs'), 'export const setupVersion = 2;\n');
    git(cwd, 'add', 'test/setup.mjs');
    git(cwd, 'commit', '-qm', 'change setup dependency');
    const affected = run(cwd, 'affected', 'HEAD');

    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Project dependencies changed since graph was built; running full suite\./);
    assert.match(affected.stdout, /Building graph from 1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('setup files execute for every test and connect their imports to each graph', () => {
  const cwd = makeSetupRepository();
  try {
    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    const cache = readFileSync(join(cwd, '.affected-tests', 'graph.json'), 'utf8');
    assert.match(cache, /test\/setup\.mjs/);
    assert.match(cache, /test\/setup-helper\.mjs/);

    writeFileSync(join(cwd, 'test', 'setup-helper.mjs'), 'globalThis.setupReady = true; // changed\n');
    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Setup dependencies changed since graph was built; running full suite\./);
    assert.match(affected.stdout, /Building graph from 2 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('committed transitive setup changes invalidate the graph cache', () => {
  const cwd = makeSetupRepository();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    writeFileSync(join(cwd, 'test', 'setup-helper.mjs'), 'globalThis.setupReady = true; // committed\n');
    git(cwd, 'add', 'test/setup-helper.mjs');
    git(cwd, 'commit', '-qm', 'change setup helper');

    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Setup dependencies changed since graph was built; running full suite\./);
    assert.match(affected.stdout, /Building graph from 2 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('global setup runs once before tests and teardown runs once afterward', () => {
  const cwd = makeGlobalSetupRepository();
  const lifecycleLog = join(cwd, 'global-setup.log');
  try {
    const baseline = runWithEnv(cwd, { GLOBAL_SETUP_LOG: lifecycleLog }, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(readFileSync(lifecycleLog, 'utf8'), 'setup\nteardown\n');
    assert.match(baseline.stdout, /▶ test\/other\.test\.mjs/);
    assert.match(baseline.stdout, /▶ test\/value\.test\.mjs/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('committed transitive global-setup changes invalidate the graph cache', () => {
  const cwd = makeGlobalSetupRepository();
  const lifecycleLog = join(cwd, 'global-setup.log');
  try {
    assert.equal(runWithEnv(cwd, { GLOBAL_SETUP_LOG: lifecycleLog }, 'baseline').status, 0);
    writeFileSync(join(cwd, 'test', 'global-setup-helper.mjs'), "export const ready = 'yes'; // committed\n");
    git(cwd, 'add', 'test/global-setup-helper.mjs');
    git(cwd, 'commit', '-qm', 'change global setup helper');

    const affected = runWithEnv(cwd, { GLOBAL_SETUP_LOG: lifecycleLog }, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Global setup dependencies changed since graph was built; running full suite\./);
    assert.match(affected.stdout, /Building graph from 2 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('global teardown failures fail the run without creating a graph cache', () => {
  const cwd = makeGlobalSetupRepository();
  const lifecycleLog = join(cwd, 'global-setup.log');
  try {
    const setupPath = join(cwd, 'test', 'global-setup.mjs');
    const source = readFileSync(setupPath, 'utf8');
    writeFileSync(setupPath, source.replace(
      "return async () => appendFileSync(process.env.GLOBAL_SETUP_LOG, 'teardown\\n');",
      "return async () => { throw new Error('teardown boom'); };",
    ));

    const baseline = runWithEnv(cwd, { GLOBAL_SETUP_LOG: lifecycleLog }, 'baseline');
    assert.equal(baseline.status, 1);
    assert.match(baseline.stderr, /Global teardown failed: Error: teardown boom/);
    assert.equal(existsSync(join(cwd, '.affected-tests', 'graph.json')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('environment files load before test workers start', () => {
  const cwd = makeEnvironmentRepository();
  try {
    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('committed environment-file changes invalidate the graph cache', () => {
  const cwd = makeEnvironmentRepository();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    writeFileSync(join(cwd, '.env.test'), 'NODE_AFFECTED_TESTS_ENV_FIXTURE_7F3=from-env-file\n# committed change\n');
    git(cwd, 'add', '.env.test');
    git(cwd, 'commit', '-qm', 'change environment file');

    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Environment files changed since graph was built; running full suite\./);
    assert.match(affected.stdout, /Building graph from 1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('committed mock and snapshot convention changes invalidate the graph cache', () => {
  const cwd = makeRepository();
  try {
    mkdirSync(join(cwd, 'test', '__mocks__'));
    mkdirSync(join(cwd, 'test', '__snapshots__'));
    const mockPath = join(cwd, 'test', '__mocks__', 'service.mjs');
    const snapshotPath = join(cwd, 'test', '__snapshots__', 'value.test.mjs.snap');
    writeFileSync(mockPath, 'export const mocked = 1;\n');
    writeFileSync(snapshotPath, 'initial snapshot\n');
    git(cwd, 'add', 'test/__mocks__/service.mjs', 'test/__snapshots__/value.test.mjs.snap');
    git(cwd, 'commit', '-qm', 'add mock and snapshot');
    assert.equal(run(cwd, 'baseline').status, 0);

    writeFileSync(mockPath, 'export const mocked = 2;\n');
    writeFileSync(snapshotPath, 'changed snapshot\n');
    git(cwd, 'add', 'test/__mocks__/service.mjs', 'test/__snapshots__/value.test.mjs.snap');
    git(cwd, 'commit', '-qm', 'change mock and snapshot');
    const affected = run(cwd, 'affected', 'HEAD');

    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Convention dependencies changed since graph was built; running full suite\./);
    assert.match(affected.stdout, /Building graph from 1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a newly added committed snapshot invalidates the graph cache', () => {
  const cwd = makeRepository();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    mkdirSync(join(cwd, 'test', '__snapshots__'));
    writeFileSync(join(cwd, 'test', '__snapshots__', 'value.test.mjs.snap'), 'new snapshot\n');
    git(cwd, 'add', 'test/__snapshots__/value.test.mjs.snap');
    git(cwd, 'commit', '-qm', 'add snapshot');

    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Convention dependencies changed since graph was built; running full suite\./);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

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
