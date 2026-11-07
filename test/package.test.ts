import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the published package and checked quickstart use the affected-node-test identity', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'affected-node-test');
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.engines.node, '>=26.0.0');
  assert.equal(packageJson.bin['affected-node-test'], './dist/bin/affected-node-test.js');
  assert.deepEqual(packageJson.files, ['dist', 'schema', 'README.md']);

  const builtVersion = spawnSync(process.execPath, [join(root, 'dist', 'bin', 'affected-node-test.js'), '--version'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(builtVersion.status, 0, builtVersion.stderr);
  assert.equal(builtVersion.stdout, `affected-node-test ${packageJson.version}\n`);

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const packedFiles: { mode: number; path: string }[] = JSON.parse(packed.stdout)[0].files;
  const files = packedFiles.map((file) => file.path);
  assert.ok(files.includes('dist/bin/affected-node-test.js'));
  const packedBin = packedFiles.find((file) => file.path === 'dist/bin/affected-node-test.js');
  assert.ok(packedBin);
  assert.ok(packedBin.mode & 0o111);
  assert.ok(files.includes('dist/src/selection-run.js'));
  assert.ok(!files.some((file) => file.endsWith('.ts')));
  assert.ok(files.includes('schema/affected-node-test.schema.json'));
  assert.ok(files.includes('README.md'));
  assert.ok(!files.some((file) => file.startsWith('test/')));

  const quickstart = readFileSync(join(root, 'docs/examples/quickstart.sh'), 'utf8');
  if (process.platform !== 'win32') {
    const syntax = spawnSync('bash', ['-n'], { encoding: 'utf8', input: quickstart });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
  assert.match(quickstart, /pnpm add --save-dev affected-node-test/);
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
