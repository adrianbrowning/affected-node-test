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

export function gitRevision(root: string, ref = 'HEAD') {
  return gitText(root, ['rev-parse', ref]).trim();
}

export function gitMergeBase(root: string, ref: string) {
  const result = spawnSync('git', ['merge-base', ref, 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (result.status === 1) return null;
  if (result.status !== 0) throw new Error(`Git failed: git merge-base ${ref} HEAD\n${result.stderr}`);
  return result.stdout.trim();
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
    const mergeBase = gitMergeBase(root, ref);
    if (mergeBase === null) return { noMergeBase: true };
    base = mergeBase;
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
