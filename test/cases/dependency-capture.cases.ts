import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runWithEnv, git, makeRepository } from '../helpers/cli-fixtures.ts';

test('runtime dependency capture preserves ordered edges across batch boundaries', () => {
  const cwd = makeRepository();
  const writeCount = join(tmpdir(), `affected-edge-writes-${process.pid}-${Date.now()}.txt`);
  const moduleCount = 800;
  const moduleName = (index: number) => `module-${index}-${'x'.repeat(90)}.mjs`;
  try {
    mkdirSync(join(cwd, 'src', 'dense'));
    for (let index = 0; index < moduleCount; index += 1) {
      writeFileSync(join(cwd, 'src', 'dense', moduleName(index)), `export const value = ${index};\n`);
    }
    writeFileSync(join(cwd, 'test', 'count-edge-writes.mjs'), [
      "import fs, { writeFileSync } from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const originalAppend = fs.appendFileSync;',
      'const batchBytes = [];',
      "writeFileSync(process.env.EDGE_WRITE_COUNT, '[]');",
      'fs.appendFileSync = (path, ...args) => {',
      "  if (String(path).endsWith('edges.jsonl')) {",
      '    batchBytes.push(Buffer.byteLength(args[0]));',
      '    writeFileSync(process.env.EDGE_WRITE_COUNT, JSON.stringify(batchBytes));',
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
      "    const loaded = await import(`../src/dense/module-${index}-${'x'.repeat(90)}.mjs`);",
      '    total += loaded.value;',
      '  }',
      `  assert.equal(total, ${(moduleCount - 1) * moduleCount / 2});`,
      '});',
      '',
    ].join('\n'));
    rmSync(join(cwd, 'test', 'value.test.mjs'));
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      include: ['test/dense.test.mjs'],
      nodeArgs: ['--import', './test/count-edge-writes.mjs'],
    }));
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'add module-dense fixture');

    const baseline = runWithEnv(cwd, { EDGE_WRITE_COUNT: writeCount }, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    const batchBytes: number[] = JSON.parse(readFileSync(writeCount, 'utf8'));
    assert.ok(batchBytes.length >= 2 && batchBytes.length <= 4, `expected multiple bounded writes: ${batchBytes}`);
    assert.ok(batchBytes.every((bytes) => bytes > 0 && bytes <= 64 * 1024), `oversized write: ${batchBytes}`);
    const graph = JSON.parse(readFileSync(join(cwd, '.affected-tests', 'graph.json'), 'utf8')).graph;
    const directEdges = graph['test/dense.test.mjs']
      .filter((edge: [string, string]) => edge[0] === 'test/dense.test.mjs' && edge[1].startsWith('src/dense/module-'))
      .map((edge: [string, string]) => edge[1]);
    assert.deepEqual(directEdges, Array.from({ length: moduleCount }, (_, index) => `src/dense/${moduleName(index)}`));

    writeFileSync(join(cwd, 'src', 'dense', moduleName(0)), 'export const value = 0; // changed\n');
    const affected = runWithEnv(cwd, { EDGE_WRITE_COUNT: writeCount }, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Selected 1\/1 test file\(s\)/);
  } finally {
    rmSync(writeCount, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
