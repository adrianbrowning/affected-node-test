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
  assert.equal(packageJson.bin['affected-node-test'], './bin/affected-node-test.mjs');
  assert.deepEqual(packageJson.files, ['bin', 'schema', 'src', 'README.md']);

  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const packedFiles = JSON.parse(packed.stdout)[0].files;
  const files = packedFiles.map((file) => file.path);
  assert.ok(files.includes('bin/affected-node-test.mjs'));
  assert.ok(packedFiles.find((file) => file.path === 'bin/affected-node-test.mjs').mode & 0o111);
  assert.ok(files.includes('src/selection-run.mjs'));
  assert.ok(files.includes('schema/affected-node-test.schema.json'));
  assert.ok(files.includes('README.md'));
  assert.ok(!files.some((file) => file.startsWith('test/')));

  const quickstart = readFileSync(join(root, 'docs/examples/quickstart.sh'), 'utf8');
  const syntax = spawnSync('bash', ['-n'], { encoding: 'utf8', input: quickstart });
  assert.equal(syntax.status, 0, syntax.stderr);
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
