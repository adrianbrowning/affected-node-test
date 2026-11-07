import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { configFileName, loadProjectConfig, matchingRepositoryFiles } from './project-config.mjs';
import { discoverTestFiles } from './test-discovery.mjs';
import { resolveWorkspaceProjects } from './workspace.mjs';

const requiredNode = [22, 15, 0];
const resolvedFileKeys = ['envFiles', 'setupFiles', 'globalSetupFiles', 'projectDependencies'];
const requiredPatternKeys = new Set(['envFiles', 'setupFiles', 'globalSetupFiles']);
const normal = (path) => path.split(sep).join('/');

function nodeSupported(version) {
  const parts = version.split('.').map(Number);
  for (let index = 0; index < requiredNode.length; index += 1) {
    if (parts[index] > requiredNode[index]) return true;
    if (parts[index] < requiredNode[index]) return false;
  }
  return true;
}

function gitStatus(root) {
  const version = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (version.error?.code === 'ENOENT') return 'unavailable (install Git to use affected)';
  if (version.status !== 0) return 'unavailable (git --version failed)';
  const repository = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
  });
  return repository.status === 0 && repository.stdout.trim() === 'true'
    ? 'available (repository detected)'
    : 'available (not a repository)';
}

function cacheDetails(root, config, problems) {
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

function resolveConfiguredFiles(root, config, cache, problems) {
  const output = {};
  for (const key of resolvedFileKeys) {
    const files = new Set();
    for (const pattern of config[key]) {
      const matches = matchingRepositoryFiles(root, [pattern])
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

function inspectProject(root, config) {
  const problems = [];
  const tests = discoverTestFiles(root, config);
  if (!tests.length) {
    problems.push('No test files discovered. Add conventional .test/.spec files or configure include.');
  }
  const cache = cacheDetails(root, config, problems);
  const configuredFiles = resolveConfiguredFiles(root, config, cache, problems);
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

export function diagnose(root, config) {
  const supported = nodeSupported(process.versions.node);
  const lines = [
    'affected-node-test doctor',
    `Node: ${process.version} (${supported ? 'supported' : 'unsupported'}; requires >=22.15.0)`,
    `Git: ${gitStatus(root)}`,
  ];
  const problems = [];
  if (!supported) problems.push(`Node ${process.version} is unsupported. Install Node 22.15.0 or newer.`);

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
