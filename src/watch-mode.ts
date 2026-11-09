import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { watch as watchFiles } from 'node:fs';
import { sep } from 'node:path';
import { sendWatchReady } from './watch-protocol.ts';

type InterruptSignal = 'SIGINT' | 'SIGTERM';
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 } as const;

export function createWatchMode({ root, cliPath, concurrency, activeChildren, isCacheRepositoryPath,
  getInterruptedSignal }: {
  root: string;
  cliPath: string;
  concurrency: number;
  activeChildren: Set<ChildProcess>;
  isCacheRepositoryPath: (path: string) => boolean;
  getInterruptedSignal: () => InterruptSignal | undefined;
}) {
    let stopWatching: ((signal?: InterruptSignal) => void) | undefined;
    const normal = (path: string) => path.split(sep).join('/').replace(/^\.\//, '');
  async function watchMode() {
    const runFreshCommand = async (childCommand: 'baseline' | 'related', childArgs: string[]) =>
      new Promise<number>((resolveStatus, rejectStatus) => {
        const child = spawn(process.execPath, [
          cliPath,
          childCommand,
          ...childArgs,
          '--concurrency',
          String(concurrency),
        ], {
          cwd: root,
          detached: process.platform !== 'win32',
          env: process.env,
          stdio: 'inherit',
        });
        activeChildren.add(child);
        child.once('error', (error) => {
          activeChildren.delete(child);
          rejectStatus(error);
        });
        child.once('close', (code) => {
          activeChildren.delete(child);
          resolveStatus(code ?? 1);
        });
      });

    const baselineStatus = await runFreshCommand('baseline', []);
    if (baselineStatus !== 0) process.exitCode = 1;
    if (getInterruptedSignal()) return;

    const ignoredDirectories = new Set<string>(['.git', 'node_modules', 'coverage', 'dist', 'build']);
    const pending = new Set<string>();
    let debounce: NodeJS.Timeout | undefined;
    let running = false;
    let stopped = false;

    const shouldIgnore = (path: string) => isCacheRepositoryPath(path) ||
      ignoredDirectories.has(path.split('/')[0]);

    const runChanges = async () => {
      if (running || stopped || !pending.size) return;
      running = true;
      const files = [...pending].sort();
      pending.clear();
      try {
        console.log(`Watch changes: ${files.join(', ')}`);
        const status = await runFreshCommand('related', files);
        // Interrupt and stop state may change while the child command runs.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (status !== 0 && !getInterruptedSignal() && !stopped) {
          throw new Error(`Watch rerun exited with status ${status}.`);
        }
      } catch (error: unknown) {
        console.error(`Watch rerun failed: ${error instanceof Error ? error.stack : error}`);
        process.exitCode = 1;
      } finally {
        running = false;
        // A new event may have arrived while the previous command ran.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (pending.size && !stopped) {
          clearTimeout(debounce);
          debounce = setTimeout(() => void runChanges(), 100);
        }
      }
    };

    const watcher = watchFiles(root, { recursive: true }, (_event, filename) => {
      if (!filename || stopped) return;
      const path = normal(String(filename));
      if (shouldIgnore(path)) return;
      pending.add(path);
      clearTimeout(debounce);
      debounce = setTimeout(() => void runChanges(), 100);
    });
    watcher.on('error', (error) => {
      console.error(`File watcher failed: ${error.stack ?? error}`);
      process.exitCode = 1;
      stopWatching?.();
    });
    console.log('Watching for changes.');
    sendWatchReady();
    await new Promise<void>((resolveStop) => {
      stopWatching = (signal?: InterruptSignal) => {
        if (stopped) return;
        stopped = true;
        clearTimeout(debounce);
        watcher.close();
        if (signal) process.exitCode = signalExitCodes[signal];
        resolveStop();
      };
    });
    stopWatching = undefined;
  }
  return { run: watchMode, stop: (signal: InterruptSignal) => stopWatching?.(signal) };
}
