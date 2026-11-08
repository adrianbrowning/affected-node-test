import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { configFileName, loadProjectConfig, matchingRepositoryFiles, repositoryFileInventory } from './project-config.ts';
import { discoverTestFiles } from './test-discovery.ts';
import { resolveWorkspaceProjects } from './workspace.ts';
import type { ProjectConfig } from './project-config.ts';
import { isNodeError } from './errors.ts';

const requiredNode = [26, 0, 0];
const resolvedFileKeys = ['envFiles', 'setupFiles', 'globalSetupFiles', 'projectDependencies'] as const;
type ResolvedFileKey = typeof resolvedFileKeys[number];
const requiredPatternKeys = new Set<ResolvedFileKey>(['envFiles', 'setupFiles', 'globalSetupFiles']);
const normal = (path: string) => path.split(sep).join('/');

function nodeSupported(version: string) {
  const parts = version.split('.').map(Number);
  for (let index = 0; index < requiredNode.length; index += 1) {
    if (parts[index] > requiredNode[index]) return true;
    if (parts[index] < requiredNode[index]) return false;
  }
  return true;
}

function gitStatus(root: string) {
  const version = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (isNodeError(version.error) && version.error.code === 'ENOENT') return 'unavailable (install Git to use affected)';
  if (version.status !== 0) return 'unavailable (git --version failed)';
  const repository = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
  });
  return repository.status === 0 && repository.stdout.trim() === 'true'
    ? 'available (repository detected)'
    : 'available (not a repository)';
}

function cacheDetails(root: string, config: ProjectConfig, problems: string[]) {
  const cacheDirectory = resolve(root, config.cacheDir);
  const fromRoot = relative(root, cacheDirectory);
  if (isAbsolute(config.cacheDir) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    problems.push(`${configFileName}: cacheDir must stay within the project root.`);
  }
  const cachePath = join(cacheDirectory, 'graph.json');
  return {
    cacheDirectoryLabel: normal(fromRoot),
    cachePath,
    label: normal(relative(root, cachePath)),
  };
}

function resolveConfiguredFiles(
  root: string,
  config: ProjectConfig,
  cache: ReturnType<typeof cacheDetails>,
  problems: string[],
  inventory: string[],
) {
  const output = {} as Record<ResolvedFileKey, string[]>;
  for (const key of resolvedFileKeys) {
    const files = new Set<string>();
    for (const pattern of config[key]) {
      const matches = matchingRepositoryFiles(root, [pattern], inventory)
        .filter((path) => path !== cache.label &&
          (!cache.cacheDirectoryLabel || !path.startsWith(`${cache.cacheDirectoryLabel}/`)));
      if (!matches.length && requiredPatternKeys.has(key)) {
        problems.push(`${configFileName}: ${key} pattern matched no files: ${pattern}`);
      }
      for (const match of matches) files.add(match);
    }
    output[key] = [...files].sort();
  }
  return output;
}

function inspectProject(root: string, config: ProjectConfig) {
  const problems: string[] = [];
  const inventory = repositoryFileInventory(root);
  const tests = discoverTestFiles(root, config, inventory);
  if (!tests.length) {
    problems.push('No test files discovered. Add conventional .test/.spec files or configure include.');
  }
  const cache = cacheDetails(root, config, problems);
  const configuredFiles = resolveConfiguredFiles(root, config, cache, problems, inventory);
  const lines = [
    `Project root: ${root}`,
    `Configuration: ${existsSync(join(root, configFileName)) ? configFileName : 'defaults'}`,
    `Tests: ${tests.length} discovered`,
    `Cache: ${existsSync(cache.cachePath) ? 'present' : 'missing'} (${cache.label})`,
    'Resolved configured files:',
  ];
  for (const key of resolvedFileKeys) {
    lines.push(`  ${key}: ${configuredFiles[key].length ? configuredFiles[key].join(', ') : '(none)'}`);
  }
  return { lines, problems };
}

export function diagnose(root: string, config: ProjectConfig) {
  const supported = nodeSupported(process.versions.node);
  const lines = [
    'affected-node-test doctor',
    `Node: ${process.version} (${supported ? 'supported' : 'unsupported'}; requires >=26.0.0)`,
    `Git: ${gitStatus(root)}`,
  ];
  const problems: string[] = [];
  if (!supported) problems.push(`Node ${process.version} is unsupported. Install Node 26.0.0 or newer.`);

  if (config.projects.length) {
    const projects = resolveWorkspaceProjects({ root, projects: config.projects });
    lines.push(`Workspace root: ${root}`, `Workspace projects: ${projects.length}`);
    for (const project of projects) {
      const projectConfig = loadProjectConfig(project.root);
      const inspected = inspectProject(project.root, projectConfig);
      lines.push('', `Project ${project.path}`, ...inspected.lines.map((line) => `  ${line}`));
      for (const problem of inspected.problems) problems.push(`${project.path}: ${problem}`);
    }
  } else {
    const inspected = inspectProject(root, config);
    lines.push(...inspected.lines);
    problems.push(...inspected.problems);
  }

  if (!problems.length) lines.push('Ready: configuration and test discovery are valid.');
  return { lines, problems };
}
