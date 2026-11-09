import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isNodeError } from './errors.ts';

function within(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function isContainedPath(root: string, candidate: string) {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  if (!within(absoluteRoot, absoluteCandidate)) return false;
  const realRoot = realpathSync(absoluteRoot);
  let ancestor = absoluteCandidate;
  for (;;) {
    try {
      return within(realRoot, realpathSync(ancestor));
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
  }
}
