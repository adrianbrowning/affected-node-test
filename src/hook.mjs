// Loaded in each test process, before the test module runs.
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, isAbsolute, sep } from 'node:path';

const log = process.env.AFFECTED_TESTS_EDGES_FILE;
const root = process.env.AFFECTED_TESTS_ROOT;
const inside = (p) => {
  if (!isAbsolute(p)) return false;
  const rel = relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
};
if (log && root) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (context.parentURL?.startsWith('file:') && resolved.url?.startsWith('file:')) {
        const parent = fileURLToPath(context.parentURL);
        const child = fileURLToPath(resolved.url);
        if (inside(parent) && inside(child)) {
          appendFileSync(log, JSON.stringify([relative(root, parent), relative(root, child)]) + '\n');
        }
      }
      return resolved;
    },
  });
}
