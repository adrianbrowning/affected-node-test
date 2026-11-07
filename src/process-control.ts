import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { isNodeError } from './errors.ts';

function descendantPids(rootPid: number) {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' });
  if (listed.error || listed.status !== 0) return [];
  const children = new Map<number, number[]>();
  for (const line of listed.stdout.split('\n')) {
    const [pidText, parentText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(pid);
    children.set(parent, siblings);
  }
  const descendants: number[] = [];
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length) {
    const pid = pending.shift();
    if (pid === undefined) continue;
    descendants.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return descendants;
}

function kill(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== 'ESRCH') throw error;
  }
}

export function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (result.error && child.exitCode === null) child.kill(signal);
    return;
  }
  for (const pid of descendantPids(child.pid).reverse()) kill(pid, signal);
  try {
    process.kill(-child.pid, signal);
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== 'ESRCH') throw error;
  }
}
