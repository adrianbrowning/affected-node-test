import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function runNpm(args: string[], cwd: string) {
  if (process.platform !== 'win32') return spawnSync('npm', args, { cwd, encoding: 'utf8' });
  const command = `npm ${args.map((argument) => `"${argument.replaceAll('"', '""')}"`).join(' ')}`;
  return spawnSync('cmd.exe', ['/d', '/s', '/c', command], { cwd, encoding: 'utf8' });
}

test('the published package and checked quickstart use the affected-node-test identity', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, '@gcmdev/affected-node-test');
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.engines.node, '>=26.0.0');
  assert.equal(packageJson.bin['affected-node-test'], './dist/bin/affected-node-test.js');
  assert.equal(packageJson.author, 'Adrian Browning');
  assert.equal(packageJson.license, 'MIT');
  assert.deepEqual(packageJson.files, ['CHANGELOG.md', 'LICENSE', 'dist', 'schema', 'README.md']);
  assert.deepEqual(packageJson.publishConfig, {
    access: 'public',
    provenance: true,
    registry: 'https://registry.npmjs.org/',
  });

  const builtVersion = spawnSync(process.execPath, [join(root, 'dist', 'bin', 'affected-node-test.js'), '--version'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(builtVersion.status, 0, builtVersion.stderr);
  assert.equal(builtVersion.stdout, `affected-node-test ${packageJson.version}\n`);

  const packed = runNpm(['pack', '--dry-run', '--json', '--ignore-scripts'], root);
  assert.equal(packed.status, 0, packed.stderr);
  const packedFiles: { mode: number; path: string }[] = JSON.parse(packed.stdout)[0].files;
  const files = packedFiles.map((file) => file.path);
  assert.ok(files.includes('dist/bin/affected-node-test.js'));
  const packedBin = packedFiles.find((file) => file.path === 'dist/bin/affected-node-test.js');
  assert.ok(packedBin);
  if (process.platform !== 'win32') assert.ok(packedBin.mode & 0o111);
  assert.ok(files.includes('dist/src/selection-run.js'));
  assert.ok(!files.some((file) => file.endsWith('.ts')));
  assert.ok(files.includes('schema/affected-node-test.schema.json'));
  assert.ok(files.includes('README.md'));
  assert.ok(files.includes('LICENSE'));
  assert.ok(files.includes('CHANGELOG.md'));
  assert.ok(files.every((file) => ['CHANGELOG.md', 'LICENSE', 'README.md', 'package.json'].includes(file) ||
    file.startsWith('dist/') || file.startsWith('schema/')));
  assert.ok(!files.some((file) => file.startsWith('test/')));

  const quickstart = readFileSync(join(root, 'docs/examples/quickstart.sh'), 'utf8');
  if (process.platform !== 'win32') {
    const syntax = spawnSync('bash', ['-n'], { encoding: 'utf8', input: quickstart });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
  assert.match(quickstart, /pnpm add --save-dev @gcmdev\/affected-node-test/);
  assert.match(quickstart, /pnpm exec affected-node-test baseline/);
  assert.match(quickstart, /pnpm exec affected-node-test affected/);
  assert.match(quickstart, /node --test/);

  const schema = JSON.parse(readFileSync(join(root, 'schema', 'affected-node-test.schema.json'), 'utf8'));
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.$schema.type, 'string');
  assert.ok(schema.properties.projects);
  assert.ok(schema.properties.watchTriggerPatterns);
});

test('the packed artifact installs offline and runs the documented release smoke flow', { timeout: 60_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'affected-node-test-package-'));
  const packageDirectory = join(directory, 'package');
  const fixture = join(directory, 'fixture');
  mkdirSync(packageDirectory);
  mkdirSync(join(fixture, 'src'), { recursive: true });
  mkdirSync(join(fixture, 'test'));
  try {
    const packed = runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', packageDirectory], root);
    assert.equal(packed.status, 0, packed.stderr);
    const packResult: unknown = JSON.parse(packed.stdout);
    assert.ok(Array.isArray(packResult));
    const first = packResult[0];
    assert.ok(first && typeof first === 'object' && 'filename' in first && typeof first.filename === 'string');
    const tarball = join(packageDirectory, first.filename);

    writeFileSync(join(fixture, 'package.json'), '{"name":"release-smoke","private":true,"type":"module"}\n');
    writeFileSync(join(fixture, 'src', 'value.mjs'), 'export const value = 1;\n');
    writeFileSync(join(fixture, 'test', 'value.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { value } from '../src/value.mjs';",
      "test('value', () => assert.equal(value, 1));",
      '',
    ].join('\n'));
    const install = runNpm([
      'install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock',
      tarball, join(root, 'node_modules', 'acorn'),
    ], fixture);
    assert.equal(install.status, 0, install.stderr);

    const installedRoot = join(fixture, 'node_modules', '@gcmdev', 'affected-node-test');
    assert.ok(readFileSync(join(installedRoot, 'LICENSE'), 'utf8').includes('MIT License'));
    assert.match(readFileSync(join(installedRoot, 'CHANGELOG.md'), 'utf8'), /0\.1\.0/);
    const cli = join(fixture, 'node_modules', '.bin', 'affected-node-test');
    const run = (...args: string[]) => spawnSync(cli, args, { cwd: fixture, encoding: 'utf8' });
    assert.equal(run('--help').status, 0);
    assert.equal(run('doctor').status, 0);

    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'release@example.invalid'],
      ['config', 'user.name', 'Release Smoke'],
      ['add', '.'],
      ['commit', '-qm', 'initial'],
    ]) {
      const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(run('baseline').status, 0);
    writeFileSync(join(fixture, 'src', 'value.mjs'), 'export const value = 1; // changed\n');
    const affected = run('affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Selected 1\/1 test file\(s\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the release workflow and policy require a versioned provenance publish', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /release:\s*\n\s*types: \[published\]/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /npm publish --provenance --access public/);
  assert.match(workflow, /pnpm run check:full/);

  const policy = readFileSync(join(root, 'docs', 'releasing.md'), 'utf8');
  assert.match(policy, /Semantic Versioning/);
  assert.match(policy, /@gcmdev\/affected-node-test/);
  assert.match(policy, /rollback/i);
  assert.match(policy, /deprecat/i);
  assert.match(policy, /trusted publish/i);
});
