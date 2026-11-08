import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { writeJsonAtomically } from '../src/cache.ts';

test('cache writes atomically replace the destination file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'affected-tests-cache-'));
  const path = join(directory, 'graph.json');
  const originalWrite = fs.writeFileSync;
  const originalRename = fs.renameSync;
  let exclusiveTemporaryPath: string | undefined;
  let renamedTemporaryPath: string | undefined;
  try {
    writeFileSync(path, '{"old":true}\n');
    const previousInode = statSync(path).ino;

    fs.writeFileSync = ((target: Parameters<typeof fs.writeFileSync>[0], data: Parameters<typeof fs.writeFileSync>[1], options?: Parameters<typeof fs.writeFileSync>[2]) => {
      if (String(target) !== path) {
        assert.equal(dirname(String(target)), directory);
        assert.equal(typeof options === 'object' && options !== null && 'flag' in options ? options.flag : undefined, 'wx');
        exclusiveTemporaryPath = String(target);
      }
      return originalWrite(target, data, options);
    }) as typeof fs.writeFileSync;
    fs.renameSync = ((source: string, destination: string) => {
      assert.equal(destination, path);
      assert.equal(source, exclusiveTemporaryPath);
      assert.equal(readFileSync(path, 'utf8'), '{"old":true}\n');
      assert.deepEqual(JSON.parse(readFileSync(source, 'utf8')), { current: true });
      renamedTemporaryPath = source;
      return originalRename(source, destination);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();

    writeJsonAtomically(path, { current: true });

    assert.equal(renamedTemporaryPath, exclusiveTemporaryPath);
    assert.ok(renamedTemporaryPath);
    assert.notEqual(statSync(path).ino, previousInode);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { current: true });
    assert.deepEqual(readdirSync(directory), ['graph.json']);
  } finally {
    fs.writeFileSync = originalWrite;
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  }
});
