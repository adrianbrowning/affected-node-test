import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildStaticGraph } from '../src/static-graph.ts';

test('shared static dependencies are parsed once per run and retain per-test ownership', () => {
  const root = mkdtempSync(join(tmpdir(), 'affected-static-shared-'));
  const original = fs.readFileSync;
  let sharedReads = 0;
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'src', 'shared.mjs'), "export const shared = true;\n");
    for (const name of ['a', 'b']) {
      writeFileSync(join(root, 'test', `${name}.test.mjs`), "import '../src/shared.mjs';\n");
    }
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).includes('shared.mjs')) sharedReads += 1;
      return original(...args);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    const cache = new Map();
    const first = buildStaticGraph(root, 'test/a.test.mjs', ['test/a.test.mjs'], cache);
    const second = buildStaticGraph(root, 'test/b.test.mjs', ['test/b.test.mjs'], cache);
    assert.deepEqual(first.edges, [['test/a.test.mjs', 'src/shared.mjs']]);
    assert.deepEqual(second.edges, [['test/b.test.mjs', 'src/shared.mjs']]);
    assert.equal(sharedReads, 1);
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
