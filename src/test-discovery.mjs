import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { matchesPatterns } from './project-config.mjs';

const excludedDirectories = new Set([
  '.affected-tests',
  '.git',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

export function discoverTestFiles(root, config, directory = root, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) discoverTestFiles(root, config, path, output);
    else if (entry.isFile()) {
      const repositoryPath = relative(root, path).split(sep).join('/');
      const included = config.include.length
        ? matchesPatterns(repositoryPath, config.include)
        : /(?:\.test|\.spec)\.[cm]?js$/.test(entry.name);
      if (included && !matchesPatterns(repositoryPath, config.exclude)) output.push(repositoryPath);
    }
  }
  return output.sort();
}
