import { spawnSync } from 'node:child_process';
import { resolve, sep } from 'node:path';

const normal = (path) => path.split(sep).join('/');

function git(root, args, encoding = 'buffer') {
  const result = spawnSync('git', args, { cwd: root, encoding });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
    throw new Error(`Git failed: git ${args.join(' ')}\n${stderr}`);
  }
  return result.stdout;
}

function validateGitRoot(root) {
  const gitRoot = git(root, ['rev-parse', '--show-toplevel'], 'utf8').trim();
  if (resolve(gitRoot) !== resolve(root)) {
    throw new Error('Run affected from the Git repository root.');
  }
}

export function getGitChanges({ root, ref, exclude = () => false }) {
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
  const changed = git(root, ['diff', '--name-only', '-z', base, '--'])
    .toString('utf8').split('\0').filter(Boolean);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  const files = [...new Set([...changed, ...untracked].map(normal))]
    .filter((path) => !exclude(path))
    .sort();
  return { files };
}
