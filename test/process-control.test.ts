import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { terminateProcessTree } from '../src/process-control.ts';

async function waitFor(check: () => boolean, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Timed out waiting for process state.');
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

test('process-tree termination removes a child and its descendant', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'affected-process-tree-'));
  const marker = join(directory, 'descendant.pid');
  const parentSource = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const parent = spawn(process.execPath, ['-e', parentSource], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  let descendantPid: number | undefined;
  try {
    await waitFor(() => existsSync(marker));
    descendantPid = Number(readFileSync(marker, 'utf8'));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);

    terminateProcessTree(parent, 'SIGKILL');
    await new Promise<void>((resolve) => parent.once('close', () => resolve()));
    await waitFor(() => descendantPid !== undefined && !isRunning(descendantPid));
  } finally {
    if (parent.exitCode === null) terminateProcessTree(parent, 'SIGKILL');
    if (descendantPid !== undefined && isRunning(descendantPid)) process.kill(descendantPid, 'SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});
