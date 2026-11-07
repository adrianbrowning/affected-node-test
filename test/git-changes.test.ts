import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { getGitChanges } from '../src/git-changes.ts';

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('Git change module owns root validation, working changes, and exclusions', () => {
  const root = mkdtempSync(join(tmpdir(), 'affected-git-changes-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'staged.mjs'), 'export const staged = 1;\n');
    writeFileSync(join(root, 'src', 'unstaged.mjs'), 'export const unstaged = 1;\n');
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'tests@example.invalid');
    git(root, 'config', 'user.name', 'Tests');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'initial');

    writeFileSync(join(root, 'src', 'staged.mjs'), 'export const staged = 2;\n');
    git(root, 'add', 'src/staged.mjs');
    writeFileSync(join(root, 'src', 'unstaged.mjs'), 'export const unstaged = 2;\n');
    writeFileSync(join(root, 'src', 'untracked.mjs'), 'export const untracked = true;\n');
    writeFileSync(join(root, 'internal.cache'), 'ignore me\n');

    assert.deepEqual(getGitChanges({
      exclude: (path) => path.endsWith('.cache'),
      root,
    }), {
      files: ['src/staged.mjs', 'src/unstaged.mjs', 'src/untracked.mjs'],
    });
    assert.throws(() => getGitChanges({ root: join(root, 'src') }),
      /Run affected from the Git repository root\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
