import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

const excludedDirectories = new Set([
  '.affected-tests',
  '.git',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

function isConfigurationFile(path: string) {
  const name = basename(path);
  return name === 'package.json' ||
    name === 'package-lock.json' ||
    name === 'npm-shrinkwrap.json' ||
    name === 'pnpm-lock.yaml' ||
    name === 'yarn.lock' ||
    name === '.npmrc' ||
    name === '.node-version' ||
    name === '.nvmrc' ||
    name === 'affected-node-test.config.json' ||
    /^tsconfig[^/]*\.json$/.test(name);
}

function configurationFiles(root: string, directory = root, output: string[] = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) configurationFiles(root, path, output);
    else if (entry.isFile() && isConfigurationFile(path)) output.push(path);
  }
  return output;
}

export function configurationFingerprint(root: string, env: NodeJS.ProcessEnv = process.env) {
  const hash = createHash('sha256');
  hash.update(`NODE_OPTIONS\0${env.NODE_OPTIONS ?? ''}\0`);
  for (const path of configurationFiles(root).sort()) {
    hash.update(relative(root, path).split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}
