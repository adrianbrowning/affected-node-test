import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, matchesGlob, relative, sep } from 'node:path';

export const configFileName = 'affected-node-test.config.json';
export const conventionDependencyPatterns = [
  '**/__mocks__/**',
  '**/__snapshots__/**',
  '**/*.snap',
];
const excludedDirectories = new Set([
  '.affected-tests',
  '.git',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

function stringArray(config, key) {
  const value = config[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    throw new Error(`${configFileName}: ${key} must be an array of non-empty strings.`);
  }
  return value;
}

function nonEmptyString(config, key, fallback) {
  const value = config[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${configFileName}: ${key} must be a non-empty string.`);
  }
  return value;
}

function watchTriggerPatterns(config) {
  const value = config.watchTriggerPatterns;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${configFileName}: watchTriggerPatterns must be an array.`);
  }
  return value.map((mapping, index) => {
    const label = `watchTriggerPatterns[${index}]`;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      throw new Error(`${configFileName}: ${label} must be an object.`);
    }
    const unknownKey = Object.keys(mapping).find((key) => !['pattern', 'tests'].includes(key));
    if (unknownKey) throw new Error(`${configFileName}: unknown option ${label}.${unknownKey}.`);
    if (typeof mapping.pattern !== 'string' || mapping.pattern === '') {
      throw new Error(`${configFileName}: ${label}.pattern must be a non-empty string.`);
    }
    if (!Array.isArray(mapping.tests) ||
        !mapping.tests.length || mapping.tests.some((test) => typeof test !== 'string' || test === '')) {
      throw new Error(`${configFileName}: ${label}.tests must be a non-empty array of non-empty strings.`);
    }
    return { pattern: mapping.pattern, tests: mapping.tests };
  });
}

export function loadProjectConfig(root) {
  let source;
  try {
    source = readFileSync(join(root, configFileName), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        cacheDir: '.affected-tests',
        include: [],
        exclude: [],
        envFiles: [],
        forceRerunTriggers: [],
        globalSetupFiles: [],
        projectDependencies: [],
        projects: [],
        setupFiles: [],
        watchTriggerPatterns: [],
      };
    }
    throw error;
  }
  let config;
  try {
    config = JSON.parse(source);
  } catch (error) {
    throw new Error(`${configFileName}: invalid JSON: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${configFileName}: configuration must be a JSON object.`);
  }
  const knownKeys = new Set([
    'cacheDir',
    'include',
    'exclude',
    'envFiles',
    'forceRerunTriggers',
    'globalSetupFiles',
    'projectDependencies',
    'projects',
    'setupFiles',
    'watchTriggerPatterns',
  ]);
  const unknownKey = Object.keys(config).find((key) => !knownKeys.has(key));
  if (unknownKey) throw new Error(`${configFileName}: unknown option ${unknownKey}.`);
  const projects = stringArray(config, 'projects');
  const projectOptions = [...knownKeys].filter((key) => key !== 'projects');
  if (projects.length) {
    const mixedOption = projectOptions.find((key) => Object.hasOwn(config, key));
    if (mixedOption) {
      throw new Error(`${configFileName}: workspace option projects cannot be combined with ${mixedOption}.`);
    }
  }
  return {
    cacheDir: nonEmptyString(config, 'cacheDir', '.affected-tests'),
    include: stringArray(config, 'include'),
    exclude: stringArray(config, 'exclude'),
    envFiles: stringArray(config, 'envFiles'),
    forceRerunTriggers: stringArray(config, 'forceRerunTriggers'),
    globalSetupFiles: stringArray(config, 'globalSetupFiles'),
    projectDependencies: stringArray(config, 'projectDependencies'),
    projects,
    setupFiles: stringArray(config, 'setupFiles'),
    watchTriggerPatterns: watchTriggerPatterns(config),
  };
}

export function matchesPatterns(path, patterns) {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

function matchingFiles(root, patterns, directory = root, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) matchingFiles(root, patterns, path, output);
    else if (entry.isFile()) {
      const repositoryPath = relative(root, path).split(sep).join('/');
      if (matchesPatterns(repositoryPath, patterns)) output.push([repositoryPath, path]);
    }
  }
  return output;
}

export function matchingRepositoryFiles(root, patterns) {
  if (!patterns.length) return [];
  return matchingFiles(root, patterns)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repositoryPath]) => repositoryPath);
}

export function projectDependencyFingerprint(root, patterns) {
  return repositoryFilesFingerprint(root, matchingRepositoryFiles(root, patterns));
}

export function repositoryFilesFingerprint(root, repositoryPaths) {
  const hash = createHash('sha256');
  for (const repositoryPath of [...new Set(repositoryPaths)].sort()) {
    hash.update(repositoryPath);
    hash.update('\0');
    try {
      hash.update(readFileSync(join(root, repositoryPath)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('<missing>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}
