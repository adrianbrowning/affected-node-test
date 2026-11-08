import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, matchesGlob, relative, sep } from 'node:path';
import { errorMessage, isNodeError } from './errors.ts';

export type WatchTriggerPattern = {
  pattern: string;
  tests: string[];
};

export type ProjectConfig = {
  cacheDir: string;
  envFiles: string[];
  exclude: string[];
  forceRerunTriggers: string[];
  globalSetupFiles: string[];
  include: string[];
  nodeArgs: string[];
  projectDependencies: string[];
  projects: string[];
  setupFiles: string[];
  watchTriggerPatterns: WatchTriggerPattern[];
};

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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string' && item !== '');
}

function stringArray(config: Record<string, unknown>, key: string) {
  const value = config[key];
  if (value === undefined) return [];
  if (!isStringArray(value)) {
    throw new Error(`${configFileName}: ${key} must be an array of non-empty strings.`);
  }
  return value;
}

function nonEmptyString(config: Record<string, unknown>, key: string, fallback: string) {
  const value = config[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${configFileName}: ${key} must be a non-empty string.`);
  }
  return value;
}

function watchTriggerPatterns(config: Record<string, unknown>): WatchTriggerPattern[] {
  const value = config.watchTriggerPatterns;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${configFileName}: watchTriggerPatterns must be an array.`);
  }
  return value.map((mapping: unknown, index: number) => {
    const label = `watchTriggerPatterns[${index}]`;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      throw new Error(`${configFileName}: ${label} must be an object.`);
    }
    const objectMapping = mapping as Record<string, unknown>;
    const unknownKey = Object.keys(objectMapping).find((key) => !['pattern', 'tests'].includes(key));
    if (unknownKey) throw new Error(`${configFileName}: unknown option ${label}.${unknownKey}.`);
    if (typeof objectMapping.pattern !== 'string' || objectMapping.pattern === '') {
      throw new Error(`${configFileName}: ${label}.pattern must be a non-empty string.`);
    }
    if (!isStringArray(objectMapping.tests) || !objectMapping.tests.length) {
      throw new Error(`${configFileName}: ${label}.tests must be a non-empty array of non-empty strings.`);
    }
    return { pattern: objectMapping.pattern, tests: objectMapping.tests };
  });
}

export function loadProjectConfig(root: string): ProjectConfig {
  let source;
  try {
    source = readFileSync(join(root, configFileName), 'utf8');
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        cacheDir: '.affected-tests',
        include: [],
        exclude: [],
        envFiles: [],
        forceRerunTriggers: [],
        globalSetupFiles: [],
        nodeArgs: [],
        projectDependencies: [],
        projects: [],
        setupFiles: [],
        watchTriggerPatterns: [],
      };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: unknown) {
    throw new Error(`${configFileName}: invalid JSON: ${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${configFileName}: configuration must be a JSON object.`);
  }
  const config = parsed as Record<string, unknown>;
  const knownKeys = new Set([
    '$schema',
    'cacheDir',
    'include',
    'exclude',
    'envFiles',
    'forceRerunTriggers',
    'globalSetupFiles',
    'nodeArgs',
    'projectDependencies',
    'projects',
    'setupFiles',
    'watchTriggerPatterns',
  ]);
  const unknownKey = Object.keys(config).find((key) => !knownKeys.has(key));
  if (unknownKey) throw new Error(`${configFileName}: unknown option ${unknownKey}.`);
  if (config.$schema !== undefined && (typeof config.$schema !== 'string' || config.$schema === '')) {
    throw new Error(`${configFileName}: $schema must be a non-empty string.`);
  }
  const projects = stringArray(config, 'projects');
  const projectOptions = [...knownKeys].filter((key) => !['$schema', 'projects'].includes(key));
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
    nodeArgs: stringArray(config, 'nodeArgs'),
    projectDependencies: stringArray(config, 'projectDependencies'),
    projects,
    setupFiles: stringArray(config, 'setupFiles'),
    watchTriggerPatterns: watchTriggerPatterns(config),
  };
}

export function matchesPatterns(path: string, patterns: string[]) {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

function inventoryFiles(root: string, directory = root, output: string[] = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inventoryFiles(root, path, output);
    else if (entry.isFile()) {
      const repositoryPath = relative(root, path).split(sep).join('/');
      output.push(repositoryPath);
    }
  }
  return output;
}

export function repositoryFileInventory(root: string) {
  return inventoryFiles(root).sort((a, b) => a.localeCompare(b));
}

export function matchingRepositoryFiles(root: string, patterns: string[], inventory?: string[]) {
  if (!patterns.length) return [];
  return (inventory ?? repositoryFileInventory(root)).filter((path) => matchesPatterns(path, patterns));
}

export function projectDependencyFingerprint(root: string, patterns: string[]) {
  return repositoryFilesFingerprint(root, matchingRepositoryFiles(root, patterns));
}

export function repositoryFilesFingerprint(root: string, repositoryPaths: string[]) {
  const hash = createHash('sha256');
  for (const repositoryPath of [...new Set(repositoryPaths)].sort()) {
    hash.update(repositoryPath);
    hash.update('\0');
    try {
      hash.update(readFileSync(join(root, repositoryPath)));
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      hash.update('<missing>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}
