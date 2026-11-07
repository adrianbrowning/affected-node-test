import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeJsonAtomically } from '../src/cache.ts';

test('cache writes atomically replace the destination file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'affected-tests-cache-'));
  const path = join(directory, 'graph.json');
  try {
    writeFileSync(path, '{"old":true}\n');
    const previousInode = statSync(path).ino;

    writeJsonAtomically(path, { current: true });

    assert.notEqual(statSync(path).ino, previousInode);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { current: true });
    assert.deepEqual(readdirSync(directory), ['graph.json']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
