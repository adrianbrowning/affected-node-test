import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const normal = (path: string) => path.split(sep).join('/');

function gitBuffer(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root });
  if (result.status !== 0) {
    const stderr = result.stderr.toString('utf8');
    throw new Error(`Git failed: git ${args.join(' ')}\n${stderr}`);
  }
  return result.stdout;
}

function gitText(root: string, args: string[]) {
  return gitBuffer(root, args).toString('utf8');
}

function validateGitRoot(root: string) {
  const gitRoot = gitText(root, ['rev-parse', '--show-toplevel']).trim();
  const canonical = (path: string) => {
    const resolved = realpathSync.native(resolve(path));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  if (canonical(gitRoot) !== canonical(root)) {
    throw new Error('Run affected from the Git repository root.');
  }
}

export function getGitChanges({ root, ref, exclude = () => false }: {
  exclude?: (path: string) => boolean;
  ref?: string;
  root: string;
}): { files: string[]; noMergeBase?: false } | { noMergeBase: true } {
  validateGitRoot(root);
  let base = 'HEAD';
  if (ref) {
    const mergeBase = spawnSync('git', ['merge-base', ref, 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (mergeBase.status === 1) return { noMergeBase: true };
    if (mergeBase.status !== 0) {
      throw new Error(`Git failed: git merge-base ${ref} HEAD\n${mergeBase.stderr}`);
    }
    base = mergeBase.stdout.trim();
  }
  const changed = gitBuffer(root, ['diff', '--name-only', '-z', base, '--'])
    .toString('utf8').split('\0').filter(Boolean);
  const untracked = gitBuffer(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  const files = [...new Set([...changed, ...untracked].map(normal))]
    .filter((path) => !exclude(path))
    .sort();
  return { files };
}
