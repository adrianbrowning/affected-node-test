import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../src/process-control.ts';

const cli = fileURLToPath(new URL('../bin/affected-node-test.ts', import.meta.url));

function run(cwd: string, ...args: string[]) {
  return runWithEnv(cwd, {}, ...args);
}

function runWithEnv(cwd: string, extraEnv: NodeJS.ProcessEnv, ...args: string[]) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env });
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function waitForProcessOutput(
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

async function stopWatchProcess(
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
  git(cwd, 'branch', '-M', 'main');
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

function makeWorkspace() {
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

function makeTypeScriptRepository() {
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

function makeParallelRepository({ delays = { a: 500, b: 500, c: 500 } }: {
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

async function waitFor(check: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Timed out waiting for condition');
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
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

test('init previews, writes, repeats idempotently, and preserves conflicts', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-init-'));
  const packagePath = join(cwd, 'package.json');
  const initialPackage = '{"name":"init-fixture","scripts":{"test":"node --test"}}\n';
  writeFileSync(packagePath, initialPackage);
  try {
    const preview = run(cwd, 'init');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Would create affected-node-test\.config\.json/);
    assert.match(preview.stdout, /Would update \.gitignore: add \.affected-tests\//);
    assert.match(preview.stdout, /Would update package\.json: add script test:affected/);
    assert.match(preview.stdout, /Would update package\.json: add script test:baseline/);
    assert.match(preview.stdout, /Preview only; rerun with --write to apply changes\./);
    assert.equal(readFileSync(packagePath, 'utf8'), initialPackage);
    assert.equal(existsSync(join(cwd, 'affected-node-test.config.json')), false);
    assert.equal(existsSync(join(cwd, '.gitignore')), false);

    const write = run(cwd, 'init', '--write');
    assert.equal(write.status, 0, write.stderr);
    assert.match(write.stdout, /Created affected-node-test\.config\.json/);
    assert.match(write.stdout, /Updated \.gitignore: added \.affected-tests\//);
    assert.match(write.stdout, /Updated package\.json: added script test:affected/);
    assert.match(write.stdout, /Updated package\.json: added script test:baseline/);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'affected-node-test.config.json'), 'utf8')), {
      $schema: './node_modules/affected-node-test/schema/affected-node-test.schema.json',
    });
    assert.match(readFileSync(join(cwd, '.gitignore'), 'utf8'), /^\.affected-tests\/$/m);
    const writtenPackage = JSON.parse(readFileSync(packagePath, 'utf8'));
    assert.equal(writtenPackage.scripts.test, 'node --test');
    assert.equal(writtenPackage.scripts['test:affected'], 'affected-node-test affected');
    assert.equal(writtenPackage.scripts['test:baseline'], 'affected-node-test baseline');

    const repeat = run(cwd, 'init', '--write');
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(repeat.stdout, 'No changes needed.\n');

    writeFileSync(join(cwd, 'affected-node-test.config.json'), '{"include":["spec/**"]}\n');
    writtenPackage.scripts['test:affected'] = 'custom-runner';
    writeFileSync(packagePath, `${JSON.stringify(writtenPackage, null, 2)}\n`);
    const conflict = run(cwd, 'init', '--write');
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /Conflict: affected-node-test\.config\.json already exists with different content; left unchanged\./);
    assert.match(conflict.stderr, /Conflict: package\.json script test:affected is already "custom-runner"; left unchanged\./);
    assert.equal(JSON.parse(readFileSync(packagePath, 'utf8')).scripts['test:affected'], 'custom-runner');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('help, version, and invalid input are useful before project configuration loads', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-cli-info-'));
  writeFileSync(join(cwd, 'affected-node-test.config.json'), '{ invalid json\n');
  try {
    const topLevel = run(cwd, '--help');
    assert.equal(topLevel.status, 0, topLevel.stderr);
    assert.match(topLevel.stdout, /Affected test selection for Node's native test runner\./);
    assert.match(topLevel.stdout, /Commands:/);
    assert.match(topLevel.stdout, /baseline\s+Build the complete dependency graph/);
    assert.match(topLevel.stdout, /affected \[REF\]\s+Run tests affected by Git changes/);
    assert.match(topLevel.stdout, /Default concurrency is min\(4, available parallelism\), with a minimum of 1\./);

    const commands = ['baseline', 'affected', 'related', 'since-last-run', 'last-failed', 'watch', 'clear-cache', 'doctor', 'init'];
    for (const command of commands) {
      const result = run(cwd, command, '--help');
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Usage: affected-node-test ${command}`));
      assert.match(result.stdout, /Example:/);
      assert.equal(result.stderr, '');
    }

    const helpCommand = run(cwd, 'help', 'affected');
    assert.equal(helpCommand.status, 0, helpCommand.stderr);
    assert.match(helpCommand.stdout, /Usage: affected-node-test affected \[REF\]/);

    const version = run(cwd, '--version');
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout, 'affected-node-test 0.1.0\n');

    const invalidOption = run(cwd, 'baseline', '--wat');
    assert.equal(invalidOption.status, 1);
    assert.match(invalidOption.stderr, /Unknown option: --wat/);
    assert.match(invalidOption.stderr, /Usage: affected-node-test baseline/);
    assert.doesNotMatch(invalidOption.stderr, /SyntaxError|\n\s+at /);

    const invalidCommand = run(cwd, 'wat');
    assert.equal(invalidCommand.status, 1);
    assert.match(invalidCommand.stderr, /Unknown command: wat/);
    assert.match(invalidCommand.stderr, /Usage: affected-node-test/);
    assert.doesNotMatch(invalidCommand.stderr, /SyntaxError|\n\s+at /);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('doctor validates single projects without running tests or mutating cache', () => {
  const cwd = makeNonGitRepository();
  const workerMarker = join(cwd, 'worker-ran');
  writeFileSync(join(cwd, 'test', 'setup.mjs'), 'process.env.DOCTOR_SETUP = "loaded";\n');
  writeFileSync(join(cwd, '.env.test'), 'DOCTOR_ENV=loaded\n');
  writeFileSync(join(cwd, 'test', 'value.test.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(workerMarker)}, 'ran');`,
    "import test from 'node:test';",
    "test('value', () => {});",
    '',
  ].join('\n'));
  writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
    $schema: './node_modules/affected-node-test/schema/affected-node-test.schema.json',
    envFiles: ['.env.test'],
    projectDependencies: ['package.json'],
    setupFiles: ['test/setup.mjs'],
  }));
  try {
    const result = run(cwd, 'doctor');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Node: v?\d+\.\d+\.\d+ \(supported; requires >=26\.0\.0\)/);
    assert.match(result.stdout, new RegExp(`Project root: ${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(result.stdout, /Tests: 1 discovered/);
    assert.match(result.stdout, /Cache: missing \(\.affected-tests\/graph\.json\)/);
    assert.match(result.stdout, /Git: available \(not a repository\)/);
    assert.match(result.stdout, /envFiles: \.env\.test/);
    assert.match(result.stdout, /setupFiles: test\/setup\.mjs/);
    assert.match(result.stdout, /projectDependencies: package\.json/);
    assert.match(result.stdout, /Ready: configuration and test discovery are valid\./);
    assert.equal(existsSync(workerMarker), false);
    assert.equal(existsSync(join(cwd, '.affected-tests')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('doctor reports workspace projects and actionable missing-test remediation', () => {
  const workspace = makeWorkspace();
  const empty = mkdtempSync(join(tmpdir(), 'affected-tests-doctor-empty-'));
  writeFileSync(join(empty, 'package.json'), '{"type":"module"}\n');
  try {
    const workspaceResult = run(workspace, 'doctor');
    assert.equal(workspaceResult.status, 0, workspaceResult.stderr);
    assert.match(workspaceResult.stdout, /Workspace projects: 2/);
    assert.match(workspaceResult.stdout, /Project packages\/a/);
    assert.match(workspaceResult.stdout, /Project packages\/b/);
    assert.equal((workspaceResult.stdout.match(/Tests: 1 discovered/g) ?? []).length, 2);
    assert.equal(existsSync(join(workspace, 'packages', 'a', '.affected-tests')), false);
    assert.equal(existsSync(join(workspace, 'packages', 'b', '.affected-tests')), false);

    const emptyResult = run(empty, 'doctor');
    assert.equal(emptyResult.status, 1);
    assert.match(emptyResult.stdout, /Tests: 0 discovered/);
    assert.match(emptyResult.stderr, /No test files discovered\. Add conventional \.test\/\.spec files or configure include\./);
    assert.equal(existsSync(join(empty, '.affected-tests')), false);

    writeFileSync(join(empty, 'affected-node-test.config.json'), JSON.stringify({ $schema: 42 }));
    const invalidSchema = run(empty, 'doctor');
    assert.equal(invalidSchema.status, 1);
    assert.match(invalidSchema.stderr, /\$schema must be a non-empty string\./);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test('dry-run previews finite selections and fallbacks without workers or cache writes', () => {
  const cwd = makeRepository();
  const marker = join(cwd, 'worker-ran');
  const testPath = join(cwd, 'test', 'value.test.mjs');
  writeFileSync(testPath, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    readFileSync(testPath, 'utf8'),
  ].join('\n'));
  git(cwd, 'add', 'test/value.test.mjs');
  git(cwd, 'commit', '-qm', 'add worker marker');
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    rmSync(marker);
    const cachePath = join(cwd, '.affected-tests', 'graph.json');
    const cacheBefore = readFileSync(cachePath, 'utf8');
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');

    const affected = run(cwd, 'affected', '--dry-run');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Dry run: selected 1\/1 test file\(s\)\./);
    assert.match(affected.stdout, /test\/value\.test\.mjs/);
    assert.match(affected.stdout, /changed dependency: test\/value\.test\.mjs -> src\/value\.mjs/);
    assert.doesNotMatch(affected.stdout, /▶/);

    const related = run(cwd, 'related', 'src/value.mjs', '--dry-run');
    assert.equal(related.status, 0, related.stderr);
    assert.match(related.stdout, /Dry run: selected 1\/1 related test file\(s\)\./);
    assert.match(related.stdout, /changed dependency: test\/value\.test\.mjs -> src\/value\.mjs/);

    const sinceLastRun = run(cwd, 'since-last-run', '--dry-run');
    assert.equal(sinceLastRun.status, 0, sinceLastRun.stderr);
    assert.match(sinceLastRun.stdout, /Dry run: selected 1\/1 test file\(s\) since last run\./);
    assert.match(sinceLastRun.stdout, /recorded dependency state changed/);

    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(cachePath, 'utf8'), cacheBefore);

    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1;\n');
    const noOp = run(cwd, 'affected', '--dry-run');
    assert.equal(noOp.status, 0, noOp.stderr);
    assert.match(noOp.stdout, /No changed files\./);
    assert.equal(existsSync(marker), false);

    writeFileSync(join(cwd, 'test', 'added.test.mjs'), [
      "import test from 'node:test';",
      "test('added', () => {});",
      '',
    ].join('\n'));
    const unrecorded = run(cwd, 'affected', '--dry-run');
    assert.equal(unrecorded.status, 0, unrecorded.stderr);
    assert.match(unrecorded.stdout, /test\/added\.test\.mjs/);
    assert.match(unrecorded.stdout, /unrecorded test/);
    assert.doesNotMatch(unrecorded.stdout, /▶/);
    rmSync(join(cwd, 'test', 'added.test.mjs'));

    writeFileSync(join(cwd, 'src', 'new.mjs'), 'export const added = true;\n');
    const fallback = run(cwd, 'affected', '--dry-run');
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(fallback.stdout, /Dry run: full suite \(1 test file\(s\)\)\./);
    assert.match(fallback.stdout, /unknown code changed: src\/new\.mjs/);
    assert.doesNotMatch(fallback.stdout, /▶/);
    assert.equal(readFileSync(cachePath, 'utf8'), cacheBefore);

    rmSync(join(cwd, '.affected-tests'), { recursive: true, force: true });
    const cacheMiss = run(cwd, 'affected', '--dry-run');
    assert.equal(cacheMiss.status, 0, cacheMiss.stderr);
    assert.match(cacheMiss.stdout, /No graph cache; running full suite\./);
    assert.match(cacheMiss.stdout, /Dry run: full suite \(1 test file\(s\)\)\./);
    assert.equal(existsSync(join(cwd, '.affected-tests')), false);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('JSON dry-run emits one versioned selection document without workers or cache writes', () => {
  const cwd = makeRepository();
  const marker = join(cwd, 'worker-ran');
  const testPath = join(cwd, 'test', 'value.test.mjs');
  writeFileSync(testPath, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    readFileSync(testPath, 'utf8'),
  ].join('\n'));
  git(cwd, 'add', 'test/value.test.mjs');
  git(cwd, 'commit', '-qm', 'add worker marker');
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    rmSync(marker);
    const cachePath = join(cwd, '.affected-tests', 'graph.json');
    const cacheBefore = readFileSync(cachePath, 'utf8');
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');

    const human = run(cwd, 'affected', '--dry-run');
    const affected = run(cwd, 'affected', '--dry-run', '--output=json');
    assert.equal(affected.status, 0, affected.stderr);
    const selected = JSON.parse(affected.stdout);
    assert.deepEqual(selected, {
      schemaVersion: 1,
      mode: 'preview',
      command: 'affected',
      provider: 'git',
      projectRoot: cwd,
      outcome: 'selected',
      tests: ['test/value.test.mjs'],
      totalTests: 1,
      reasons: {
        'test/value.test.mjs': [{
          file: 'src/value.mjs',
          kind: 'dependency',
          path: ['test/value.test.mjs', 'src/value.mjs'],
        }],
      },
      fallback: null,
    });
    assert.ok(selected.tests.every((path) => human.stdout.includes(path)));
    assert.match(affected.stderr, /Changed files: src\/value\.mjs/);
    assert.doesNotMatch(affected.stdout, /Dry run|Changed files|▶/);
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(cachePath, 'utf8'), cacheBefore);

    const related = run(cwd, 'related', 'src/value.mjs', '--dry-run', '--output=json');
    assert.equal(related.status, 0, related.stderr);
    assert.equal(JSON.parse(related.stdout).provider, 'explicit-files');

    const sinceLastRun = run(cwd, 'since-last-run', '--dry-run', '--output=json');
    assert.equal(sinceLastRun.status, 0, sinceLastRun.stderr);
    assert.equal(JSON.parse(sinceLastRun.stdout).provider, 'filesystem');

    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1;\n');
    const noOp = run(cwd, 'affected', '--dry-run', '--output=json');
    assert.equal(noOp.status, 0, noOp.stderr);
    assert.deepEqual(JSON.parse(noOp.stdout).tests, []);
    assert.equal(JSON.parse(noOp.stdout).outcome, 'no-tests');

    writeFileSync(join(cwd, 'src', 'new.mjs'), 'export const added = true;\n');
    const fallback = run(cwd, 'affected', '--dry-run', '--output=json');
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.deepEqual(JSON.parse(fallback.stdout).fallback, {
      files: ['src/new.mjs'],
      kind: 'unknown-code',
    });
    assert.equal(JSON.parse(fallback.stdout).outcome, 'full-suite');

    rmSync(join(cwd, '.affected-tests'), { recursive: true, force: true });
    const cacheMiss = run(cwd, 'affected', '--dry-run', '--output=json');
    assert.equal(cacheMiss.status, 0, cacheMiss.stderr);
    assert.equal(JSON.parse(cacheMiss.stdout).fallback.kind, 'cache-unavailable');
    assert.match(cacheMiss.stderr, /No graph cache; running full suite\./);
    assert.equal(existsSync(join(cwd, '.affected-tests')), false);
    assert.equal(existsSync(marker), false);

    const baseline = run(cwd, 'baseline', '--dry-run', '--output=json');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).provider, 'baseline');
    assert.equal(JSON.parse(baseline.stdout).outcome, 'full-suite');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('JSON finite runs emit one document for passing, failing, no-op, and fallback outcomes', () => {
  const cwd = makeRepository();
  const testPath = join(cwd, 'test', 'value.test.mjs');
  writeFileSync(testPath, [
    "console.log('json-worker-output');",
    readFileSync(testPath, 'utf8'),
  ].join('\n'));
  git(cwd, 'add', 'test/value.test.mjs');
  git(cwd, 'commit', '-qm', 'add worker output');
  try {
    assert.equal(run(cwd, 'baseline').status, 0);

    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // changed\n');
    const passing = run(cwd, 'affected', '--output=json');
    assert.equal(passing.status, 0, passing.stderr);
    assert.deepEqual(JSON.parse(passing.stdout), {
      schemaVersion: 1,
      mode: 'run',
      command: 'affected',
      provider: 'git',
      projectRoot: cwd,
      outcome: 'selected',
      tests: ['test/value.test.mjs'],
      totalTests: 1,
      reasons: {
        'test/value.test.mjs': [{
          file: 'src/value.mjs',
          kind: 'dependency',
          path: ['test/value.test.mjs', 'src/value.mjs'],
        }],
      },
      fallback: null,
      execution: {
        status: 'passed',
        tests: ['test/value.test.mjs'],
        failures: [],
        exitCode: 0,
      },
    });
    assert.match(passing.stderr, /json-worker-output/);
    assert.doesNotMatch(passing.stdout, /json-worker-output|▶|Selected/);

    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1;\n');
    const noOp = run(cwd, 'affected', '--output=json');
    assert.equal(noOp.status, 0, noOp.stderr);
    assert.equal(JSON.parse(noOp.stdout).outcome, 'no-tests');
    assert.deepEqual(JSON.parse(noOp.stdout).execution, {
      status: 'passed',
      tests: [],
      failures: [],
      exitCode: 0,
    });

    writeFileSync(testPath, `${readFileSync(testPath, 'utf8')}\nthrow new Error('json failure');\n`);
    const failing = run(cwd, 'affected', '--output=json');
    assert.equal(failing.status, 1);
    assert.equal(JSON.parse(failing.stdout).execution.status, 'failed');
    assert.deepEqual(JSON.parse(failing.stdout).execution.failures, ['test/value.test.mjs']);
    assert.equal(JSON.parse(failing.stdout).execution.exitCode, 1);
    assert.match(failing.stderr, /json failure/);

    git(cwd, 'checkout', '--', 'test/value.test.mjs');
    writeFileSync(join(cwd, 'src', 'new.mjs'), 'export const added = true;\n');
    const fallback = run(cwd, 'affected', '--output=json');
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.equal(JSON.parse(fallback.stdout).outcome, 'full-suite');
    assert.deepEqual(JSON.parse(fallback.stdout).fallback, {
      files: ['src/new.mjs'],
      kind: 'unknown-code',
    });
    assert.deepEqual(JSON.parse(fallback.stdout).execution.tests, ['test/value.test.mjs']);
    assert.deepEqual(JSON.parse(fallback.stdout).execution.failures, []);

    const baseline = run(cwd, 'baseline', '--output=json');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).command, 'baseline');
    assert.equal(JSON.parse(baseline.stdout).execution.status, 'passed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dry-run explains sticky failures without rerunning them', () => {
  const cwd = makeRepository();
  const testPath = join(cwd, 'test', 'value.test.mjs');
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    const passing = readFileSync(testPath, 'utf8');
    writeFileSync(testPath, `${passing}\nthrow new Error('sticky preview');\n`);
    assert.equal(run(cwd, 'affected').status, 1);
    writeFileSync(testPath, passing);

    const preview = run(cwd, 'affected', '--dry-run');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /test\/value\.test\.mjs/);
    assert.match(preview.stdout, /previously failing test/);
    assert.doesNotMatch(preview.stdout, /▶/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('last-failed previews, reruns, clears, and conservatively handles a missing cache', () => {
  const cwd = makeRepository();
  const testPath = join(cwd, 'test', 'value.test.mjs');
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    const passing = readFileSync(testPath, 'utf8');
    writeFileSync(testPath, `${passing}\nthrow new Error('remember me');\n`);
    assert.equal(run(cwd, 'affected').status, 1);
    const preview = run(cwd, 'last-failed', '--dry-run');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Dry run: selected 1\/1 previously failing test file\(s\)\./);
    assert.match(preview.stdout, /previously failing test/);

    const stillFailing = run(cwd, 'last-failed', '--output=json');
    assert.equal(stillFailing.status, 1);
    assert.deepEqual(JSON.parse(stillFailing.stdout).execution.failures, ['test/value.test.mjs']);

    writeFileSync(testPath, passing);
    const rerun = run(cwd, 'last-failed', '--output=json');
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(JSON.parse(rerun.stdout).command, 'last-failed');
    assert.deepEqual(JSON.parse(rerun.stdout).execution.tests, ['test/value.test.mjs']);
    assert.deepEqual(JSON.parse(rerun.stdout).execution.failures, []);

    const noOp = run(cwd, 'last-failed');
    assert.equal(noOp.status, 0, noOp.stderr);
    assert.equal(noOp.stdout, 'No previously failing tests.\n');

    rmSync(join(cwd, '.affected-tests'), { recursive: true, force: true });
    const cacheMiss = run(cwd, 'last-failed', '--dry-run');
    assert.equal(cacheMiss.status, 0, cacheMiss.stderr);
    assert.match(cacheMiss.stdout, /No graph cache; running full suite\./);
    assert.match(cacheMiss.stdout, /Dry run: full suite \(1 test file\(s\)\)\./);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('--concurrency rejects non-positive values before accessing Git', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-options-'));
  try {
    const result = run(cwd, 'baseline', '--concurrency', '0');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--concurrency must be a positive integer or a percentage greater than 0% and at most 100%\./);
    assert.doesNotMatch(result.stderr, /not a git repository/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('--concurrency accepts percentages and clamps small allocations to one worker', () => {
  const cwd = makeParallelRepository({ delays: { a: 50, b: 50, c: 50 } });
  const tracker = join(cwd, 'processes.log');
  try {
    const result = runWithEnv(cwd, { TEST_TRACKER: tracker }, 'baseline', '--concurrency', '1%');
    assert.equal(result.status, 0, result.stderr);
    const events = readFileSync(tracker, 'utf8').trim().split('\n');
    let active = 0;
    let maximumActive = 0;
    for (const event of events) {
      active += event.startsWith('start:') ? 1 : -1;
      maximumActive = Math.max(maximumActive, active);
    }
    assert.equal(maximumActive, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('clear-cache removes the saved dependency graph', () => {
  const cwd = makeRepository();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    const cache = join(cwd, '.affected-tests', 'graph.json');
    assert.equal(existsSync(cache), true);

    const cleared = run(cwd, 'clear-cache');
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.match(cleared.stdout, /Cleared cache: \.affected-tests\/graph\.json/);
    assert.equal(existsSync(cache), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a configured cache directory is used for writes and clearing', () => {
  const cwd = makeRepository();
  try {
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      cacheDir: 'cache/affected-node-test',
      projectDependencies: ['**/*'],
    }));
    git(cwd, 'add', 'affected-node-test.config.json');
    git(cwd, 'commit', '-qm', 'configure cache');
    const cache = join(cwd, 'cache', 'affected-node-test', 'graph.json');

    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(existsSync(cache), true);
    assert.equal(existsSync(join(cwd, '.affected-tests', 'graph.json')), false);

    const affected = run(cwd, 'affected');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /No changed files\./);

    const cleared = run(cwd, 'clear-cache');
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.match(cleared.stdout, /Cleared cache: cache\/affected-node-test\/graph\.json/);
    assert.equal(existsSync(cache), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a configured cache directory cannot escape the project root', () => {
  const cwd = makeRepository();
  try {
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({ cacheDir: '../shared-cache' }));

    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 1);
    assert.match(baseline.stderr, /cacheDir must stay within the project root/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace baseline runs configured projects with isolated caches', () => {
  const cwd = makeWorkspace();
  try {
    const baseline = run(cwd, 'baseline', '--concurrency', '1');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /Project packages\/a/);
    assert.match(baseline.stdout, /Project packages\/b/);
    assert.ok(baseline.stdout.indexOf('Project packages/a') < baseline.stdout.indexOf('Project packages/b'));
    assert.equal(existsSync(join(cwd, 'packages', 'a', '.affected-tests', 'graph.json')), true);
    assert.equal(existsSync(join(cwd, 'packages', 'b', '.affected-tests', 'graph.json')), true);
    assert.equal(existsSync(join(cwd, '.affected-tests', 'graph.json')), false);

    const cleared = run(cwd, 'clear-cache');
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.equal(existsSync(join(cwd, 'packages', 'a', '.affected-tests', 'graph.json')), false);
    assert.equal(existsSync(join(cwd, 'packages', 'b', '.affected-tests', 'graph.json')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace project filters scope finite and watch commands', { timeout: 60_000 }, async () => {
  const cwd = makeWorkspace();
  try {
    const baseline = run(cwd, 'baseline', '--project', 'packages/a');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /Project packages\/a/);
    assert.doesNotMatch(baseline.stdout, /Project packages\/b/);
    assert.equal(existsSync(join(cwd, 'packages', 'a', '.affected-tests', 'graph.json')), true);
    assert.equal(existsSync(join(cwd, 'packages', 'b', '.affected-tests', 'graph.json')), false);

    const multiple = run(cwd, 'baseline', '--project', 'packages/b', '--project', 'packages/a', '--output=json');
    assert.equal(multiple.status, 0, multiple.stderr);
    assert.deepEqual(JSON.parse(multiple.stdout).projects.map(({ path }: { path: string }) => path), ['packages/a', 'packages/b']);

    const missing = run(cwd, 'baseline', '--project', 'packages/missing');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No workspace projects matched --project packages\/missing\./);

    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [cli, 'watch', '--project', 'packages/a', '--concurrency', '1'], {
      cwd,
      detached: process.platform !== 'win32',
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal })));
    try {
      await waitForProcessOutput(child, () => stdout + stderr,
        (output) => output.includes('Watching in 1 projects.'), 30_000);
      assert.doesNotMatch(stdout, /\[packages\/b\]/);
      await stopWatchProcess(child, closed, stderr);
    } finally {
      if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
      await closed;
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace related routes files only to their owning project', () => {
  const cwd = makeWorkspace();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);

    const related = run(cwd, 'related', 'packages/a/src/value.mjs');
    assert.equal(related.status, 0, related.stderr);
    assert.match(related.stdout, /Project packages\/a/);
    assert.doesNotMatch(related.stdout, /Project packages\/b/);
    assert.match(related.stdout, /Related files: src\/value\.mjs/);
    assert.match(related.stdout, /Selected 1\/1 related test file\(s\)/);

    const excluded = run(cwd, 'related', 'packages/b/src/value.mjs', '--project', 'packages/a');
    assert.equal(excluded.status, 0, excluded.stderr);
    assert.doesNotMatch(excluded.stdout, /Project packages\/a|Project packages\/b|Building graph/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace affected routes Git changes only to their owning project', () => {
  const cwd = makeWorkspace();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    writeFileSync(join(cwd, 'packages', 'a', 'src', 'value.mjs'), 'export const value = 1; // changed\n');

    const affected = run(cwd, 'affected');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Changed files: packages\/a\/src\/value\.mjs/);
    assert.match(affected.stdout, /Project packages\/a/);
    assert.doesNotMatch(affected.stdout, /Project packages\/b/);
    assert.match(affected.stdout, /Selected 1\/1 related test file\(s\)/);

    const excluded = run(cwd, 'affected', '--project', 'packages/b');
    assert.equal(excluded.status, 0, excluded.stderr);
    assert.doesNotMatch(excluded.stdout, /Project packages\/a|Project packages\/b|Building graph/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace affected-first completes affected projects before remaining projects', () => {
  const cwd = makeWorkspace();
  const tracker = join(tmpdir(), `workspace-affected-first-${process.pid}-${Date.now()}.log`);
  try {
    for (const name of ['a', 'b']) {
      const path = join(cwd, 'packages', name, 'test', 'value.test.mjs');
      writeFileSync(path, [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(process.env.PARTITION_TRACKER, '${name}\\n');`,
        readFileSync(path, 'utf8'),
      ].join('\n'));
    }
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'track workspace partitions');
    assert.equal(runWithEnv(cwd, { PARTITION_TRACKER: tracker }, 'baseline').status, 0);
    writeFileSync(tracker, '');
    writeFileSync(join(cwd, 'packages', 'a', 'src', 'value.mjs'), 'export const value = 1; // changed\n');

    const result = runWithEnv(cwd, { PARTITION_TRACKER: tracker }, 'affected-first', 'HEAD');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(tracker, 'utf8').trim().split('\n'), ['a', 'b']);
    assert.match(result.stdout, /Project packages\/a — affected/);
    assert.match(result.stdout, /Project packages\/b — remaining/);
  } finally {
    rmSync(tracker, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace affected-first phases resume from one portable plan', () => {
  const cwd = makeWorkspace();
  const tracker = join(tmpdir(), `workspace-affected-phases-${process.pid}-${Date.now()}.log`);
  const plan = '.affected-tests/workspace-plan.json';
  try {
    for (const name of ['a', 'b']) {
      const path = join(cwd, 'packages', name, 'test', 'value.test.mjs');
      writeFileSync(path, [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(process.env.PARTITION_TRACKER, '${name}\\n');`,
        readFileSync(path, 'utf8'),
      ].join('\n'));
    }
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'track split workspace partitions');
    assert.equal(runWithEnv(cwd, { PARTITION_TRACKER: tracker }, 'baseline').status, 0);
    writeFileSync(tracker, '');
    writeFileSync(join(cwd, 'packages', 'a', 'src', 'value.mjs'), 'export const value = 1; // split\n');

    const first = runWithEnv(cwd, { PARTITION_TRACKER: tracker },
      'affected-first', 'HEAD', '--phase', 'affected', '--plan', plan);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(readFileSync(tracker, 'utf8').trim().split('\n'), ['a']);
    const serialized = readFileSync(join(cwd, plan), 'utf8');
    assert.doesNotMatch(serialized, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const second = runWithEnv(cwd, { PARTITION_TRACKER: tracker },
      'affected-first', '--phase', 'remaining', '--plan', plan);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readFileSync(tracker, 'utf8').trim().split('\n'), ['a', 'b']);
  } finally {
    rmSync(tracker, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace dry-run preserves project routing, fallbacks, and cache state', () => {
  const cwd = makeWorkspace();
  const cache = (project: string) => join(cwd, 'packages', project, '.affected-tests', 'graph.json');
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    const cacheBefore = {
      a: readFileSync(cache('a'), 'utf8'),
      b: readFileSync(cache('b'), 'utf8'),
    };

    const noOp = run(cwd, 'since-last-run', '--dry-run');
    assert.equal(noOp.status, 0, noOp.stderr);
    assert.match(noOp.stdout, /Project packages\/a/);
    assert.match(noOp.stdout, /Project packages\/b/);
    assert.equal((noOp.stdout.match(/No tests changed since last run\./g) ?? []).length, 2);

    writeFileSync(join(cwd, 'packages', 'a', 'src', 'value.mjs'), 'export const value = 1; // changed\n');
    const affected = run(cwd, 'affected', '--dry-run');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Project packages\/a/);
    assert.doesNotMatch(affected.stdout, /Project packages\/b/);
    assert.match(affected.stdout, /Dry run: selected 1\/1 related test file\(s\)\./);
    assert.match(affected.stdout, /changed dependency: test\/value\.test\.mjs -> src\/value\.mjs/);

    const related = run(cwd, 'related', 'packages/b/src/value.mjs', '--dry-run');
    assert.equal(related.status, 0, related.stderr);
    assert.match(related.stdout, /Project packages\/b/);
    assert.doesNotMatch(related.stdout, /Project packages\/a/);
    assert.match(related.stdout, /changed dependency: test\/value\.test\.mjs -> src\/value\.mjs/);

    writeFileSync(join(cwd, 'packages', 'b', 'src', 'value.mjs'), 'export const value = 2; // changed\n');
    const sinceLastRun = run(cwd, 'since-last-run', '--dry-run');
    assert.equal(sinceLastRun.status, 0, sinceLastRun.stderr);
    assert.match(sinceLastRun.stdout, /Project packages\/a/);
    assert.match(sinceLastRun.stdout, /Project packages\/b/);
    assert.equal((sinceLastRun.stdout.match(/recorded dependency state changed/g) ?? []).length, 2);

    writeFileSync(join(cwd, 'README.md'), 'workspace-level change\n');
    const fallback = run(cwd, 'affected', '--dry-run');
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(fallback.stdout, /Workspace-level change README\.md; previewing every project baseline\./);
    assert.equal((fallback.stdout.match(/Dry run: full suite \(1 test file\(s\)\)\./g) ?? []).length, 2);
    assert.doesNotMatch(fallback.stdout, /▶/);

    const relatedFallback = run(cwd, 'related', 'README.md', '--dry-run');
    assert.equal(relatedFallback.status, 0, relatedFallback.stderr);
    assert.match(relatedFallback.stdout, /Workspace-level related file README\.md; previewing every project baseline\./);
    assert.equal((relatedFallback.stdout.match(/Dry run: full suite \(1 test file\(s\)\)\./g) ?? []).length, 2);

    assert.equal(readFileSync(cache('a'), 'utf8'), cacheBefore.a);
    assert.equal(readFileSync(cache('b'), 'utf8'), cacheBefore.b);
    assert.doesNotMatch(`${affected.stdout}${related.stdout}${sinceLastRun.stdout}`, /▶/);

    rmSync(join(cwd, 'README.md'));
    rmSync(join(cwd, 'packages', 'a', '.affected-tests'), { recursive: true, force: true });
    rmSync(join(cwd, 'packages', 'b', '.affected-tests'), { recursive: true, force: true });
    const cacheMiss = run(cwd, 'affected', '--dry-run');
    assert.equal(cacheMiss.status, 0, cacheMiss.stderr);
    assert.equal((cacheMiss.stdout.match(/No graph cache; running full suite\./g) ?? []).length, 2);
    assert.equal(existsSync(cache('a')), false);
    assert.equal(existsSync(cache('b')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace JSON aggregates routing and project results for finite commands', () => {
  const cwd = makeWorkspace();
  try {
    const baseline = run(cwd, 'baseline', '--output=json');
    assert.equal(baseline.status, 0, baseline.stderr);
    const baselineDocument = JSON.parse(baseline.stdout);
    assert.equal(baselineDocument.schemaVersion, 1);
    assert.equal(baselineDocument.mode, 'run');
    assert.equal(baselineDocument.command, 'baseline');
    assert.equal(baselineDocument.workspaceRoot, cwd);
    assert.equal(baselineDocument.outcome, 'passed');
    assert.equal(baselineDocument.exitCode, 0);
    assert.deepEqual(baselineDocument.projects.map(({ path }: { path: string }) => path), ['packages/a', 'packages/b']);

    const noOp = run(cwd, 'affected', '--output=json');
    assert.equal(noOp.status, 0, noOp.stderr);
    assert.equal(JSON.parse(noOp.stdout).routing.kind, 'no-changes');
    assert.equal(JSON.parse(noOp.stdout).outcome, 'passed');

    writeFileSync(join(cwd, 'packages', 'a', 'src', 'value.mjs'), 'export const value = 1; // changed\n');
    const selected = run(cwd, 'affected', '--output=json');
    assert.equal(selected.status, 0, selected.stderr);
    const selectedDocument = JSON.parse(selected.stdout);
    assert.deepEqual(selectedDocument.routing, {
      kind: 'project-files',
      files: ['packages/a/src/value.mjs'],
    });
    const projectA = selectedDocument.projects.find(({ path }: { path: string }) => path === 'packages/a');
    assert.deepEqual(projectA.result.execution.tests, ['test/value.test.mjs']);
    assert.deepEqual(projectA.result.execution.failures, []);

    const failingTest = join(cwd, 'packages', 'b', 'test', 'value.test.mjs');
    writeFileSync(failingTest, `${readFileSync(failingTest, 'utf8')}\nthrow new Error('workspace json failure');\n`);
    const failing = run(cwd, 'affected', '--output=json');
    assert.equal(failing.status, 1);
    assert.equal(JSON.parse(failing.stdout).outcome, 'failed');
    assert.equal(JSON.parse(failing.stdout).exitCode, 1);
    assert.match(failing.stderr, /workspace json failure/);

    git(cwd, 'checkout', '--', 'packages/b/test/value.test.mjs');
    const lastFailed = run(cwd, 'last-failed', '--dry-run', '--output=json');
    assert.equal(lastFailed.status, 0, lastFailed.stderr);
    const failedProject = JSON.parse(lastFailed.stdout).projects
      .find(({ path }: { path: string }) => path === 'packages/b');
    assert.deepEqual(failedProject.result.tests, ['test/value.test.mjs']);

    writeFileSync(join(cwd, 'README.md'), 'workspace change\n');
    const fallback = run(cwd, 'affected', '--dry-run', '--output=json');
    assert.equal(fallback.status, 0, fallback.stderr);
    const fallbackDocument = JSON.parse(fallback.stdout);
    assert.deepEqual(fallbackDocument.routing, {
      kind: 'workspace-fallback',
      file: 'README.md',
      reason: 'workspace-level-change',
    });
    assert.equal(fallbackDocument.mode, 'preview');
    assert.deepEqual(fallbackDocument.projects.map(({ path }: { path: string }) => path), ['packages/a', 'packages/b']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('watch emits structured readiness over IPC', { timeout: 30_000 }, async () => {
  const cwd = makeRepository();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [cli, 'watch', '--concurrency', '1'], {
    cwd,
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages: unknown[] = [];
  let stdout = '';
  let stderr = '';
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('message', (message) => { messages.push(message); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    await waitForProcessOutput(child, () => `${stdout}${stderr}\n${JSON.stringify(messages)}`,
      () => messages.some((message) => Boolean(message && typeof message === 'object' &&
        'type' in message && message.type === 'affected-node-test:watch-ready')), 15_000);
    assert.match(stdout, /Watching for changes\./);

    await stopWatchProcess(child, closed, stderr);
  } finally {
    if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
    await closed;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace watch coordinates project reruns and shutdown', { timeout: 60_000 }, async () => {
  const cwd = makeWorkspace();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [cli, 'watch', '--concurrency', '1'], {
    cwd,
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    await waitForProcessOutput(child, () => stdout + stderr,
      (output) => output.includes('Watching in 2 projects.'), 30_000);
    const rerunStart = stdout.length;
    writeFileSync(join(cwd, 'packages', 'a', 'src', 'value.mjs'), 'export const value = 1; // watched\n');

    await waitForProcessOutput(child, () => stdout + stderr,
      (output) => output.slice(rerunStart).includes('[packages/a] ▶ test/value.test.mjs'), 20_000);
    const rerunOutput = stdout.slice(rerunStart);
    assert.doesNotMatch(rerunOutput, /\[packages\/b\] ▶ test\/value\.test\.mjs/);

    await stopWatchProcess(child, closed, stderr);
  } finally {
    if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
    await closed;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace watch stops sibling watchers when one project fails to start', { timeout: 30_000 }, async () => {
  const cwd = makeWorkspace();
  writeFileSync(join(cwd, 'packages', 'b', 'affected-node-test.config.json'), JSON.stringify({
    setupFiles: ['test/missing-setup.mjs'],
  }));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [cli, 'watch', '--concurrency', '1'], {
    cwd,
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    const result = await closed;
    assert.equal(result.code, 1, `${stdout}\n${stderr}`);
    assert.match(stderr, /packages\/b.*setupFiles pattern matched no files/s);
  } finally {
    if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
    await closed;
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
  writeFileSync(testPath, `${readFileSync(testPath, 'utf8')}\nconsole.log('spill:' + 'x'.repeat(300_000));\n`);
  git(cwd, 'add', 'test/value.test.mjs');
  git(cwd, 'commit', '-qm', 'add large output');
  try {
    const passing = run(cwd, 'baseline', '--concurrency', '1');
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /spill:x{100}/);
    assert.deepEqual(edgeTemporaryDirectories(), temporaryDirectories);

    writeFileSync(testPath, `${readFileSync(testPath, 'utf8')}\nthrow new Error('after spill');\n`);
    const failing = run(cwd, 'affected', '--concurrency', '1');
    assert.equal(failing.status, 1);
    assert.match(failing.stdout, /spill:x{100}/);
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

test('watch reruns only tests related to a changed dependency', { timeout: 45_000 }, async () => {
  const cwd = makeRepository({ withOtherTest: true });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [cli, 'watch', '--concurrency', '1'], {
    cwd,
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    await waitForProcessOutput(child, () => stdout + stderr,
      (output) => output.includes('Watching for changes.'), 20_000);
    const rerunStart = stdout.length;
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // watched\n');

    await waitForProcessOutput(child, () => stdout + stderr, (output) =>
      output.includes('Watch changes: src/value.mjs') &&
      output.slice(rerunStart).includes('▶ test/value.test.mjs'), 20_000);
    const rerunOutput = stdout.slice(rerunStart);
    assert.match(rerunOutput, /Selected 1\/2 test file\(s\)/);
    assert.doesNotMatch(rerunOutput, /▶ test\/other\.test\.mjs/);

    await stopWatchProcess(child, closed, stderr);
  } finally {
    if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
    await closed;
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
test(`${signal} stops active test processes and preserves the cache`, {
  skip: process.platform === 'win32' ? 'Windows does not expose graceful POSIX signal delivery.' : false,
  timeout: 15_000,
}, async () => {
  const cwd = makeInterruptRepository();
  const tracker = join(cwd, 'interrupt.log');
  let cliProcess: ChildProcess | undefined;
  let testPid: number | undefined;
  const previousTemporaryDirectories = edgeTemporaryDirectories();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    const cachePath = join(cwd, '.affected-tests', 'graph.json');
    const previousCache = readFileSync(cachePath, 'utf8');
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // changed\n');

    const env: NodeJS.ProcessEnv = { ...process.env, INTERRUPT_TRACKER: tracker };
    delete env.NODE_TEST_CONTEXT;
    cliProcess = spawn(process.execPath, [cli, 'affected', 'HEAD', '--concurrency', '1'], {
      cwd,
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    assert.ok(cliProcess.stderr);
    cliProcess.stderr.setEncoding('utf8');
    cliProcess.stderr.on('data', (chunk) => { stderr += chunk; });

    await waitFor(() => existsSync(tracker));
    testPid = Number(readFileSync(tracker, 'utf8').match(/start:(\d+)/)?.[1]);
    assert.ok(Number.isSafeInteger(testPid) && testPid > 1);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
      cliProcess?.once('exit', (code, signal) => resolveExit({ code, signal })));
    cliProcess.kill(signal);
    const result = await exited;

    await waitFor(() => testPid !== undefined && !isProcessRunning(testPid));
    await waitFor(() => JSON.stringify(edgeTemporaryDirectories()) === JSON.stringify(previousTemporaryDirectories));
    assert.deepEqual(result, { code: exitCode, signal: null });
    assert.match(stderr, new RegExp(`Test run interrupted by ${signal}; previous graph was left unchanged\\.`));
    assert.equal(readFileSync(cachePath, 'utf8'), previousCache);
  } finally {
    if (cliProcess && cliProcess.exitCode === null && cliProcess.signalCode === null) {
      terminateProcessTree(cliProcess, 'SIGKILL');
    }
    if (testPid !== undefined && Number.isSafeInteger(testPid) && testPid > 1 && isProcessRunning(testPid)) process.kill(testPid, 'SIGKILL');
    rmSync(cwd, { recursive: true, force: true });
  }
});
}

test('forced process-tree termination preserves the previous cache', { timeout: 15_000 }, async () => {
  const cwd = makeInterruptRepository();
  const tracker = join(cwd, 'interrupt.log');
  let cliProcess: ChildProcess | undefined;
  let testPid: number | undefined;
  const previousTemporaryDirectories = edgeTemporaryDirectories();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    const cachePath = join(cwd, '.affected-tests', 'graph.json');
    const previousCache = readFileSync(cachePath, 'utf8');
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // changed\n');

    const env: NodeJS.ProcessEnv = { ...process.env, INTERRUPT_TRACKER: tracker };
    delete env.NODE_TEST_CONTEXT;
    cliProcess = spawn(process.execPath, [cli, 'affected', 'HEAD', '--concurrency', '1'], {
      cwd,
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(() => existsSync(tracker));
    testPid = Number(readFileSync(tracker, 'utf8').match(/start:(\d+)/)?.[1]);
    assert.ok(Number.isSafeInteger(testPid) && testPid > 1);

    const closed = new Promise<void>((resolve) => cliProcess?.once('close', () => resolve()));
    terminateProcessTree(cliProcess, 'SIGKILL');
    await closed;

    await waitFor(() => testPid !== undefined && !isProcessRunning(testPid));
    assert.equal(readFileSync(cachePath, 'utf8'), previousCache);
  } finally {
    if (cliProcess && cliProcess.exitCode === null) terminateProcessTree(cliProcess, 'SIGKILL');
    if (testPid !== undefined && Number.isSafeInteger(testPid) && testPid > 1 && isProcessRunning(testPid)) {
      process.kill(testPid, 'SIGKILL');
    }
    for (const directory of edgeTemporaryDirectories()) {
      if (!previousTemporaryDirectories.includes(directory)) {
        rmSync(join(tmpdir(), directory), { recursive: true, force: true });
      }
    }
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

test('configured node arguments execute discovered TypeScript tests', () => {
  const cwd = makeTypeScriptRepository();
  try {
    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /✔ typed value/);
    assert.match(readFileSync(join(cwd, '.affected-tests', 'graph.json'), 'utf8'), /src\/value\.ts/);

    writeFileSync(join(cwd, 'src', 'value.ts'), 'export const value: number = 1; \/\/ changed\n');
    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Selected 1\/1 test file\(s\)/);
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
