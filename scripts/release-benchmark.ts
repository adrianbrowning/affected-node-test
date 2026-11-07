import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'bin', 'affected-node-test.js');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'affected-node-test-benchmark-'));

function run(command: string, args: string[], cwd: string) {
  const started = performance.now();
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const durationMs = Math.round(performance.now() - started);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}`);
  return durationMs;
}

function git(cwd: string, ...args: string[]) {
  run('git', args, cwd);
}

function createProject(cwd: string, count: number, noisy = false) {
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'test'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(cwd, 'src', `value-${index}.mjs`), `export const value = ${index};\n`);
    writeFileSync(join(cwd, 'test', `value-${index}.test.mjs`), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      `import { value } from '../src/value-${index}.mjs';`,
      noisy ? `console.log('x'.repeat(${512 * 1024}));` : '',
      `test('value ${index}', () => assert.equal(value, ${index}));`,
      '',
    ].join('\n'));
  }
}

function initialize(cwd: string) {
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'benchmark@example.invalid');
  git(cwd, 'config', 'user.name', 'Benchmark');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'benchmark fixture');
}

try {
  const single = join(fixtureRoot, 'single');
  createProject(single, 20);
  initialize(single);
  const baseline = run(process.execPath, [cli, 'baseline', '--concurrency', '4'], single);
  writeFileSync(join(single, 'src', 'value-0.mjs'), 'export const value = 0; // changed\n');
  const affected = run(process.execPath, [cli, 'affected', 'HEAD', '--concurrency', '4'], single);

  const workspace = join(fixtureRoot, 'workspace');
  createProject(join(workspace, 'packages', 'a'), 10);
  createProject(join(workspace, 'packages', 'b'), 10);
  writeFileSync(join(workspace, 'affected-node-test.config.json'),
    JSON.stringify({ projects: ['packages/a', 'packages/b'] }));
  initialize(workspace);
  const workspaceBaseline = run(process.execPath, [cli, 'baseline', '--concurrency', '4'], workspace);

  const largeOutputFixture = join(fixtureRoot, 'large-output');
  createProject(largeOutputFixture, 2, true);
  initialize(largeOutputFixture);
  const largeOutput = run(process.execPath, [cli, 'baseline', '--concurrency', '2'], largeOutputFixture);

  const measurements = {
    affected: { durationMs: affected, thresholdMs: 10_000, tests: '1/20' },
    baseline: { durationMs: baseline, thresholdMs: 30_000, tests: 20 },
    largeOutput: { bytes: 2 * 512 * 1024, durationMs: largeOutput, thresholdMs: 15_000, tests: 2 },
    workspaceBaseline: { durationMs: workspaceBaseline, thresholdMs: 30_000, projects: 2, tests: 20 },
  };
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, measurements }, null, 2));
  const exceeded = Object.entries(measurements).find(([, measurement]) => measurement.durationMs > measurement.thresholdMs);
  if (exceeded) throw new Error(`${exceeded[0]} exceeded its release-review threshold.`);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
