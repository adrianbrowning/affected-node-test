import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import type { DependencyEdge } from './dependency-graph.ts';
import { createOutputBuffer } from './output-buffer.ts';
import { buildStaticGraph } from './static-graph.ts';
import type { StaticGraphCache } from './static-graph.ts';

type OutputBuffer = ReturnType<typeof createOutputBuffer>;
export type GraphTestResult = {
  cleanup: () => void;
  durationMs: number;
  edges: DependencyEdge[];
  status: 0 | 1;
  stderr: OutputBuffer;
  stdout: OutputBuffer;
  unresolvedStatic: boolean;
};

export function createTestWorker({ root, hook, nodeArgs, setupFiles, globalSetupFiles, activeChildren }: {
  root: string;
  hook: string;
  nodeArgs: string[];
  setupFiles: Set<string>;
  globalSetupFiles: Set<string>;
  activeChildren: Set<ChildProcess>;
}) {
  let staticGraphCache: StaticGraphCache = new Map();
  function parseEdge(line: string): DependencyEdge {
    const parsed: unknown = JSON.parse(line);
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((part) => typeof part !== 'string')) {
      throw new Error('Worker emitted an invalid dependency edge.');
    }
    return [parsed[0], parsed[1]];
  }
  function graphForTest(test: string) {
    const folder = mkdtempSync(join(tmpdir(), 'affected-test-'));
    const log = join(folder, 'edges.jsonl');
    return new Promise<GraphTestResult>((resolveResult, rejectResult) => {
      const startedAt = performance.now();
      const imports = [hook, ...[...setupFiles].map((file) => join(root, file))]
        .flatMap((file) => ['--import', pathToFileURL(file).href]);
      const child = spawn(process.execPath,
        [...nodeArgs, ...imports, '--test', join(root, test)],
        { cwd: root, detached: process.platform !== 'win32', stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env,
          AFFECTED_TESTS_EDGES_FILE: log, AFFECTED_TESTS_ROOT: root } });
      activeChildren.add(child);
      // A failed spawn can leave piped streams absent.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!child.stdout || !child.stderr) throw new Error(`Failed to capture test output for ${test}.`);
      const stdout = createOutputBuffer({ directory: folder, name: 'stdout' });
      const stderr = createOutputBuffer({ directory: folder, name: 'stderr' });
      child.stdout.on('data', (chunk: Buffer) => stdout.append(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk));
      child.on('error', (error) => stderr.append(`${error.stack ?? error}\n`));
      child.on('close', (code) => {
        activeChildren.delete(child);
        try {
          const edges = existsSync(log)
            ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(parseEdge)
            : [];
          for (const setupFile of setupFiles) edges.push([test, setupFile]);
          const staticGraph = buildStaticGraph(root, test, [
            test,
            ...setupFiles,
            ...globalSetupFiles,
          ], staticGraphCache);
          edges.push(...staticGraph.edges);
          const uniqueEdges = [...new Map(edges.map((edge) => [JSON.stringify(edge), edge])).values()];
          resolveResult({
            durationMs: performance.now() - startedAt,
            edges: uniqueEdges,
            status: code === 0 ? 0 : 1,
            stdout,
            stderr,
            unresolvedStatic: staticGraph.unresolved,
            cleanup: () => rmSync(folder, { recursive: true, force: true }),
          });
        } catch (error: unknown) {
          stdout.cleanup();
          stderr.cleanup();
          rmSync(folder, { recursive: true, force: true });
          rejectResult(error);
        }
      });
    });
  }

  return {
    run: graphForTest,
    reset: () => { staticGraphCache = new Map(); },
  };
}
