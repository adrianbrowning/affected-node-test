import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { terminateProcessTree } from '../../src/process-control.ts';
import { cli, run, waitForProcessOutput, stopWatchProcess, makeRepository, makeInterruptRepository, waitFor, isProcessRunning, edgeTemporaryDirectories } from '../helpers/cli-fixtures.ts';

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
    assert.match(rerunOutput, /Selected 1\/2 related test file\(s\)/);
    assert.doesNotMatch(rerunOutput, /▶ test\/other\.test\.mjs/);

    await stopWatchProcess(child, closed, stderr);
  } finally {
    if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
    await closed;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('watch reruns load fresh configuration, environment, and global setup modules', { timeout: 90_000 }, async () => {
  const cwd = makeRepository();
  const tracker = join(tmpdir(), `affected-watch-fresh-${process.pid}-${Date.now()}.log`);
  writeFileSync(join(cwd, '.env.watch'), 'WATCH_VALUE=one\n');
  writeFileSync(join(cwd, 'test', 'global-setup.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    "export function setup() { appendFileSync(process.env.WATCH_FRESH_TRACKER, 'setup:v1\\n'); }",
    '',
  ].join('\n'));
  writeFileSync(join(cwd, 'test', 'value.test.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    "import test from 'node:test';",
    "appendFileSync(process.env.WATCH_FRESH_TRACKER, `value:${process.env.WATCH_VALUE}\\n`);",
    "test('value', () => {});",
    '',
  ].join('\n'));
  writeFileSync(join(cwd, 'test', 'other.test.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    "import test from 'node:test';",
    "appendFileSync(process.env.WATCH_FRESH_TRACKER, 'other\\n');",
    "test('other', () => {});",
    '',
  ].join('\n'));
  const configuration = (include: string) => JSON.stringify({
    envFiles: ['.env.watch'],
    globalSetupFiles: ['test/global-setup.mjs'],
    include: [include],
  });
  writeFileSync(join(cwd, 'affected-node-test.config.json'), configuration('test/value.test.mjs'));
  const env: NodeJS.ProcessEnv = { ...process.env, WATCH_FRESH_TRACKER: tracker };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [cli, 'watch', '--concurrency', '1'], {
    cwd,
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    await waitForProcessOutput(child, () => output, (value) => value.includes('Watching for changes.'), 20_000);
    await waitFor(() => existsSync(tracker) && readFileSync(tracker, 'utf8').includes('value:one'), 20_000);

    writeFileSync(join(cwd, '.env.watch'), 'WATCH_VALUE=two\n');
    await waitFor(() => readFileSync(tracker, 'utf8').includes('value:two'), 20_000);

    writeFileSync(join(cwd, 'test', 'global-setup.mjs'), [
      "import { appendFileSync } from 'node:fs';",
      "export function setup() { appendFileSync(process.env.WATCH_FRESH_TRACKER, 'setup:v2\\n'); }",
      '',
    ].join('\n'));
    await waitFor(() => readFileSync(tracker, 'utf8').includes('setup:v2'), 20_000);

    writeFileSync(join(cwd, 'affected-node-test.config.json'), configuration('test/other.test.mjs'));
    await waitFor(() => readFileSync(tracker, 'utf8').includes('other'), 20_000);
    await waitForProcessOutput(child, () => output, (value) => value.includes('✔ other'), 20_000);
    await stopWatchProcess(child, closed, output);
  } finally {
    if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
    await closed;
    rmSync(tracker, { force: true });
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
    testPid = Number(/start:(\d+)/.exec(readFileSync(tracker, 'utf8'))?.[1]);
    assert.ok(Number.isSafeInteger(testPid) && testPid > 1);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      cliProcess?.once('exit', (code, signal) => resolve({ code, signal })));
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
