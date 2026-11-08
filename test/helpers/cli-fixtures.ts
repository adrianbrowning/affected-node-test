import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../../src/process-control.ts';

export const cli = fileURLToPath(new URL('../../bin/affected-node-test.ts', import.meta.url));

export function run(cwd: string, ...args: string[]) {
  return runWithEnv(cwd, {}, ...args);
}

export function runWithEnv(cwd: string, extraEnv: NodeJS.ProcessEnv, ...args: string[]) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env });
}

export function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

export async function waitForProcessOutput(
  child: ChildProcess,
  output: () => string,
  predicate: (output: string) => boolean,
  timeout = 8_000,
) {
  const deadline = Date.now() + timeout;
  while (!predicate(output())) {
    if (child.exitCode !== null) throw new Error(`Process exited with ${child.exitCode}:\n${output()}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for process output:\n${output()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function stopWatchProcess(
  child: ChildProcess,
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  stderr: string,
) {
  if (process.platform === 'win32') terminateProcessTree(child, 'SIGKILL');
  else child.kill('SIGTERM');
  const result = await closed;
  if (process.platform !== 'win32') assert.equal(result.code, 143, stderr);
  return result;
}

export function makeRepository({ withOtherTest = false } = {}) {
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
  git(cwd, 'branch', '-M', 'main');
  return cwd;
}

export function makeNonGitRepository({ withOtherTest = false } = {}) {
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

export function makeWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-workspace-'));
  for (const [name, value] of [['a', 1], ['b', 2]] as const) {
    const project = join(cwd, 'packages', name);
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(join(project, 'test'));
    writeFileSync(join(project, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(project, 'src', 'value.mjs'), `export const value = ${value};\n`);
    writeFileSync(join(project, 'test', 'value.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { value } from '../src/value.mjs';",
      `test('${name}', () => assert.equal(value, ${value}));`,
      '',
    ].join('\n'));
  }
  writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
    projects: ['packages/a', 'packages/b'],
  }));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'tests@example.invalid');
  git(cwd, 'config', 'user.name', 'Tests');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'initial');
  return cwd;
}

export function makeCommonJsRepository() {
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

export function makeTypeScriptRepository() {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-typescript-'));
  mkdirSync(join(cwd, 'src'));
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(cwd, 'src', 'value.ts'), 'export const value: number = 1;\n');
  writeFileSync(join(cwd, 'test', 'preload.mjs'), "process.env.AFFECTED_PRELOAD = 'ready';\n");
  writeFileSync(join(cwd, 'test', 'value.test.ts'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.ts';",
    "test('typed value', () => {",
    "  assert.equal(process.env.AFFECTED_PRELOAD, 'ready');",
    "  assert.equal(value, 1);",
    "});",
    '',
  ].join('\n'));
  writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
    include: ['test/**/*.test.ts'],
    nodeArgs: ['--import', './test/preload.mjs'],
    projectDependencies: ['test/preload.mjs'],
  }));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'tests@example.invalid');
  git(cwd, 'config', 'user.name', 'Tests');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'initial');
  return cwd;
}

export function makeParallelRepository({ delays = { a: 500, b: 500, c: 500 } }: {
  delays?: Record<'a' | 'b' | 'c', number>;
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-parallel-'));
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
  for (const name of ['a', 'b', 'c'] as const) {
    writeFileSync(join(cwd, 'test', `${name}.test.mjs`), [
      "import { appendFileSync } from 'node:fs';",
      "import test from 'node:test';",
      `appendFileSync(process.env.TEST_TRACKER, 'start:${name}\\n');`,
      `await new Promise((resolve) => setTimeout(resolve, ${delays[name]}));`,
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

export function makeInterruptRepository() {
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

export function makeSetupRepository() {
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

export function makeGlobalSetupRepository() {
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

export function makeEnvironmentRepository() {
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

export async function waitFor(check: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Timed out waiting for condition');
}

export function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

export function edgeTemporaryDirectories() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('affected-test-')).sort();
}
