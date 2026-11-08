import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'bin', 'affected-node-test.js');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'affected-node-test-benchmark-'));

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
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

function createSharedGraphProject(cwd: string, testCount: number, depth: number) {
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'test'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
  for (let index = 0; index < depth; index += 1) {
    writeFileSync(join(cwd, 'src', `shared-${index}.mjs`),
      index + 1 === depth ? 'export const value = 1;\n' :
        `export { value } from './shared-${index + 1}.mjs';\n`);
  }
  for (let index = 0; index < testCount; index += 1) {
    writeFileSync(join(cwd, 'test', `shared-${index}.test.mjs`), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { value } from '../src/shared-0.mjs';",
      `test('shared ${index}', () => assert.equal(value, 1));`,
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

function createModuleDenseProject(cwd: string, moduleCount: number) {
  mkdirSync(join(cwd, 'src', 'dense'), { recursive: true });
  mkdirSync(join(cwd, 'test'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}\n');
  for (let index = 0; index < moduleCount; index += 1) {
    writeFileSync(join(cwd, 'src', 'dense', `module-${index}.mjs`), `export const value = ${index};\n`);
  }
  writeFileSync(join(cwd, 'test', 'count-edge-writes.mjs'), [
    "import fs, { writeFileSync } from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const originalAppend = fs.appendFileSync;',
    'let edgeWrites = 0;',
    "writeFileSync(process.env.EDGE_WRITE_COUNT, '0');",
    'fs.appendFileSync = (path, ...args) => {',
    "  if (String(path).endsWith('edges.jsonl')) {",
    '    edgeWrites += 1;',
    '    writeFileSync(process.env.EDGE_WRITE_COUNT, String(edgeWrites));',
    '  }',
    '  return originalAppend(path, ...args);',
    '};',
    'syncBuiltinESMExports();',
    '',
  ].join('\n'));
  writeFileSync(join(cwd, 'test', 'dense.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    `test('loads ${moduleCount} computed modules', async () => {`,
    '  let total = 0;',
    `  for (let index = 0; index < ${moduleCount}; index += 1) {`,
    '    const loaded = await import(`../src/dense/module-${index}.mjs`);',
    '    total += loaded.value;',
    '  }',
    `  assert.equal(total, ${(moduleCount - 1) * moduleCount / 2});`,
    '});',
    '',
  ].join('\n'));
  writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
    include: ['test/dense.test.mjs'],
    nodeArgs: ['--import', './test/count-edge-writes.mjs'],
  }));
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

  const widerWorkspace = join(fixtureRoot, 'wider-workspace');
  for (const name of ['a', 'b', 'c', 'd']) createProject(join(widerWorkspace, 'packages', name), 5);
  writeFileSync(join(widerWorkspace, 'affected-node-test.config.json'),
    JSON.stringify({ projects: ['packages/a', 'packages/b', 'packages/c', 'packages/d'] }));
  initialize(widerWorkspace);
  const widerWorkspaceBaseline = run(process.execPath, [cli, 'baseline', '--concurrency', '4'], widerWorkspace);

  const largeOutputFixture = join(fixtureRoot, 'large-output');
  createProject(largeOutputFixture, 2, true);
  initialize(largeOutputFixture);
  const largeOutput = run(process.execPath, [cli, 'baseline', '--concurrency', '2'], largeOutputFixture);

  const moduleDenseFixture = join(fixtureRoot, 'module-dense');
  const moduleCount = 256;
  const edgeWriteCount = join(fixtureRoot, 'module-dense-edge-writes.txt');
  createModuleDenseProject(moduleDenseFixture, moduleCount);
  initialize(moduleDenseFixture);
  const moduleDense = run(process.execPath, [cli, 'baseline'], moduleDenseFixture, {
    EDGE_WRITE_COUNT: edgeWriteCount,
  });
  const edgeWrites = Number(readFileSync(edgeWriteCount, 'utf8'));

  const sharedFixture = join(fixtureRoot, 'shared-graph');
  createSharedGraphProject(sharedFixture, 20, 128);
  initialize(sharedFixture);
  const sharedGraph = run(process.execPath, [cli, 'baseline', '--concurrency', '4'], sharedFixture);

  const measurements = {
    affected: { durationMs: affected, thresholdMs: 10_000, tests: '1/20' },
    baseline: { durationMs: baseline, thresholdMs: 30_000, tests: 20 },
    largeOutput: { bytes: 2 * 512 * 1024, durationMs: largeOutput, thresholdMs: 15_000, tests: 2 },
    moduleDense: { durationMs: moduleDense, edgeWrites, modules: moduleCount, thresholdMs: 15_000, writeThreshold: 4 },
    sharedGraph: { durationMs: sharedGraph, tests: 20, sharedModules: 128, thresholdMs: 30_000 },
    workspaceBaseline: { durationMs: workspaceBaseline, thresholdMs: 30_000, projects: 2, tests: 20 },
    widerWorkspaceBaseline: { durationMs: widerWorkspaceBaseline, thresholdMs: 30_000, projects: 4, tests: 20 },
  };
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, measurements }, null, 2));
  const exceeded = Object.entries(measurements).find(([, measurement]) => measurement.durationMs > measurement.thresholdMs);
  if (exceeded) throw new Error(`${exceeded[0]} exceeded its release-review threshold.`);
  if (edgeWrites > measurements.moduleDense.writeThreshold) {
    throw new Error(`moduleDense performed ${edgeWrites} edge-log writes; expected at most ${measurements.moduleDense.writeThreshold}.`);
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
