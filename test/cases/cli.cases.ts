import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { cli, run, runWithEnv, git, makeRepository, makeNonGitRepository, makeWorkspace, makeParallelRepository } from '../helpers/cli-fixtures.ts';

test('--help succeeds outside a Git repository', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-help-'));
  try {
    const result = spawnSync(process.execPath, [cli, '--help'], {
      cwd,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('init previews, writes, repeats idempotently, and preserves conflicts', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-init-'));
  const packagePath = join(cwd, 'package.json');
  const initialPackage = '{"name":"init-fixture","scripts":{"test":"node --test"}}\n';
  writeFileSync(packagePath, initialPackage);
  try {
    const preview = run(cwd, 'init');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Would create affected-node-test\.config\.json/);
    assert.match(preview.stdout, /Would update \.gitignore: add \.affected-tests\//);
    assert.match(preview.stdout, /Would update package\.json: add script test:affected/);
    assert.match(preview.stdout, /Would update package\.json: add script test:baseline/);
    assert.match(preview.stdout, /Preview only; rerun with --write to apply changes\./);
    assert.equal(readFileSync(packagePath, 'utf8'), initialPackage);
    assert.equal(existsSync(join(cwd, 'affected-node-test.config.json')), false);
    assert.equal(existsSync(join(cwd, '.gitignore')), false);

    const write = run(cwd, 'init', '--write');
    assert.equal(write.status, 0, write.stderr);
    assert.match(write.stdout, /Created affected-node-test\.config\.json/);
    assert.match(write.stdout, /Updated \.gitignore: added \.affected-tests\//);
    assert.match(write.stdout, /Updated package\.json: added script test:affected/);
    assert.match(write.stdout, /Updated package\.json: added script test:baseline/);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'affected-node-test.config.json'), 'utf8')), {
      $schema: './node_modules/@gcmdev/affected-node-test/schema/affected-node-test.schema.json',
    });
    assert.match(readFileSync(join(cwd, '.gitignore'), 'utf8'), /^\.affected-tests\/$/m);
    const writtenPackage = JSON.parse(readFileSync(packagePath, 'utf8'));
    assert.equal(writtenPackage.scripts.test, 'node --test');
    assert.equal(writtenPackage.scripts['test:affected'], 'affected-node-test affected');
    assert.equal(writtenPackage.scripts['test:baseline'], 'affected-node-test baseline');

    const repeat = run(cwd, 'init', '--write');
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(repeat.stdout, 'No changes needed.\n');

    writeFileSync(join(cwd, 'affected-node-test.config.json'), '{"include":["spec/**"]}\n');
    writtenPackage.scripts['test:affected'] = 'custom-runner';
    writeFileSync(packagePath, `${JSON.stringify(writtenPackage, null, 2)}\n`);
    const conflict = run(cwd, 'init', '--write');
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /Conflict: affected-node-test\.config\.json already exists with different content; left unchanged\./);
    assert.match(conflict.stderr, /Conflict: package\.json script test:affected is already "custom-runner"; left unchanged\./);
    assert.equal(JSON.parse(readFileSync(packagePath, 'utf8')).scripts['test:affected'], 'custom-runner');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('help, version, and invalid input are useful before project configuration loads', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-cli-info-'));
  writeFileSync(join(cwd, 'affected-node-test.config.json'), '{ invalid json\n');
  try {
    const topLevel = run(cwd, '--help');
    assert.equal(topLevel.status, 0, topLevel.stderr);
    assert.match(topLevel.stdout, /Affected test selection for Node's native test runner\./);
    assert.match(topLevel.stdout, /Commands:/);
    assert.match(topLevel.stdout, /baseline\s+Build the complete dependency graph/);
    assert.match(topLevel.stdout, /affected \[REF\]\s+Run tests affected by Git changes/);
    assert.match(topLevel.stdout, /Default concurrency is min\(4, available parallelism\), with a minimum of 1\./);

    const commands = ['baseline', 'affected', 'related', 'since-last-run', 'last-failed', 'watch', 'clear-cache', 'doctor', 'init'];
    for (const command of commands) {
      const result = run(cwd, command, '--help');
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`Usage: affected-node-test ${command}`));
      assert.match(result.stdout, /Example:/);
      assert.equal(result.stderr, '');
    }

    const helpCommand = run(cwd, 'help', 'affected');
    assert.equal(helpCommand.status, 0, helpCommand.stderr);
    assert.match(helpCommand.stdout, /Usage: affected-node-test affected \[REF\]/);

    const version = run(cwd, '--version');
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout, 'affected-node-test 0.1.0\n');

    const invalidOption = run(cwd, 'baseline', '--wat');
    assert.equal(invalidOption.status, 1);
    assert.match(invalidOption.stderr, /Unknown option: --wat/);
    assert.match(invalidOption.stderr, /Usage: affected-node-test baseline/);
    assert.doesNotMatch(invalidOption.stderr, /SyntaxError|\n[ \t]+at /);

    const invalidCommand = run(cwd, 'wat');
    assert.equal(invalidCommand.status, 1);
    assert.match(invalidCommand.stderr, /Unknown command: wat/);
    assert.match(invalidCommand.stderr, /Usage: affected-node-test/);
    assert.doesNotMatch(invalidCommand.stderr, /SyntaxError|\n[ \t]+at /);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('non-running commands reject concurrency while help reflects accepted options', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-command-options-'));
  writeFileSync(join(cwd, 'affected-node-test.config.json'), '{ invalid json\n');
  try {
    for (const command of ['doctor', 'clear-cache', 'init']) {
      const invalid = run(cwd, command, '--concurrency', '1');
      assert.equal(invalid.status, 1, `${command}: ${invalid.stderr}`);
      assert.match(invalid.stderr, /Unknown option: --concurrency/);
      const help = run(cwd, command, '--help');
      assert.equal(help.status, 0, help.stderr);
      assert.doesNotMatch(help.stdout, /--concurrency/);
    }
    const clearCacheHelp = run(cwd, 'clear-cache', '--help');
    assert.match(clearCacheHelp.stdout, /--project GLOB/);
    const initHelp = run(cwd, 'init', '--help');
    assert.match(initHelp.stdout, /--write/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('doctor validates single projects without running tests or mutating cache', () => {
  const cwd = makeNonGitRepository();
  const workerMarker = join(cwd, 'worker-ran');
  writeFileSync(join(cwd, 'test', 'setup.mjs'), 'process.env.DOCTOR_SETUP = "loaded";\n');
  writeFileSync(join(cwd, '.env.test'), 'DOCTOR_ENV=loaded\n');
  writeFileSync(join(cwd, 'test', 'value.test.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(workerMarker)}, 'ran');`,
    "import test from 'node:test';",
    "test('value', () => {});",
    '',
  ].join('\n'));
  writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
    $schema: './node_modules/@gcmdev/affected-node-test/schema/affected-node-test.schema.json',
    envFiles: ['.env.test'],
    projectDependencies: ['package.json'],
    setupFiles: ['test/setup.mjs'],
  }));
  try {
    const result = run(cwd, 'doctor');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Node: v?\d+\.\d+\.\d+ \(supported; requires >=26\.0\.0\)/);
    assert.match(result.stdout, new RegExp(`Project root: ${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(result.stdout, /Tests: 1 discovered/);
    assert.match(result.stdout, /Cache: missing \(\.affected-tests\/graph\.json\)/);
    assert.match(result.stdout, /Git: available \(not a repository\)/);
    assert.match(result.stdout, /envFiles: \.env\.test/);
    assert.match(result.stdout, /setupFiles: test\/setup\.mjs/);
    assert.match(result.stdout, /projectDependencies: package\.json/);
    assert.match(result.stdout, /Ready: configuration and test discovery are valid\./);
    assert.equal(existsSync(workerMarker), false);
    assert.equal(existsSync(join(cwd, '.affected-tests')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('doctor reports workspace projects and actionable missing-test remediation', () => {
  const workspace = makeWorkspace();
  const empty = mkdtempSync(join(tmpdir(), 'affected-tests-doctor-empty-'));
  writeFileSync(join(empty, 'package.json'), '{"type":"module"}\n');
  try {
    const workspaceResult = run(workspace, 'doctor');
    assert.equal(workspaceResult.status, 0, workspaceResult.stderr);
    assert.match(workspaceResult.stdout, /Workspace projects: 2/);
    assert.match(workspaceResult.stdout, /Project packages\/a/);
    assert.match(workspaceResult.stdout, /Project packages\/b/);
    assert.equal((workspaceResult.stdout.match(/Tests: 1 discovered/g) ?? []).length, 2);
    assert.equal(existsSync(join(workspace, 'packages', 'a', '.affected-tests')), false);
    assert.equal(existsSync(join(workspace, 'packages', 'b', '.affected-tests')), false);

    const emptyResult = run(empty, 'doctor');
    assert.equal(emptyResult.status, 1);
    assert.match(emptyResult.stdout, /Tests: 0 discovered/);
    assert.match(emptyResult.stderr, /No test files discovered\. Add conventional \.test\/\.spec files or configure include\./);
    assert.equal(existsSync(join(empty, '.affected-tests')), false);

    writeFileSync(join(empty, 'affected-node-test.config.json'), JSON.stringify({ $schema: 42 }));
    const invalidSchema = run(empty, 'doctor');
    assert.equal(invalidSchema.status, 1);
    assert.match(invalidSchema.stderr, /\$schema must be a non-empty string\./);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test('dry-run previews finite selections and fallbacks without workers or cache writes', () => {
  const cwd = makeRepository();
  const marker = join(cwd, 'worker-ran');
  const testPath = join(cwd, 'test', 'value.test.mjs');
  writeFileSync(testPath, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    readFileSync(testPath, 'utf8'),
  ].join('\n'));
  git(cwd, 'add', 'test/value.test.mjs');
  git(cwd, 'commit', '-qm', 'add worker marker');
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    rmSync(marker);
    const cachePath = join(cwd, '.affected-tests', 'graph.json');
    const cacheBefore = readFileSync(cachePath, 'utf8');
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');

    const affected = run(cwd, 'affected', '--dry-run');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Dry run: selected 1\/1 test file\(s\)\./);
    assert.match(affected.stdout, /test\/value\.test\.mjs/);
    assert.match(affected.stdout, /changed dependency: test\/value\.test\.mjs -> src\/value\.mjs/);
    assert.doesNotMatch(affected.stdout, /▶/);

    const related = run(cwd, 'related', 'src/value.mjs', '--dry-run');
    assert.equal(related.status, 0, related.stderr);
    assert.match(related.stdout, /Dry run: selected 1\/1 related test file\(s\)\./);
    assert.match(related.stdout, /changed dependency: test\/value\.test\.mjs -> src\/value\.mjs/);

    const sinceLastRun = run(cwd, 'since-last-run', '--dry-run');
    assert.equal(sinceLastRun.status, 0, sinceLastRun.stderr);
    assert.match(sinceLastRun.stdout, /Dry run: selected 1\/1 test file\(s\) since last run\./);
    assert.match(sinceLastRun.stdout, /recorded dependency state changed/);

    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(cachePath, 'utf8'), cacheBefore);

    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1;\n');
    const noOp = run(cwd, 'affected', '--dry-run');
    assert.equal(noOp.status, 0, noOp.stderr);
    assert.match(noOp.stdout, /No changed files\./);
    assert.equal(existsSync(marker), false);

    writeFileSync(join(cwd, 'test', 'added.test.mjs'), [
      "import test from 'node:test';",
      "test('added', () => {});",
      '',
    ].join('\n'));
    const unrecorded = run(cwd, 'affected', '--dry-run');
    assert.equal(unrecorded.status, 0, unrecorded.stderr);
    assert.match(unrecorded.stdout, /test\/added\.test\.mjs/);
    assert.match(unrecorded.stdout, /unrecorded test/);
    assert.doesNotMatch(unrecorded.stdout, /▶/);
    rmSync(join(cwd, 'test', 'added.test.mjs'));

    writeFileSync(join(cwd, 'src', 'new.mjs'), 'export const added = true;\n');
    const fallback = run(cwd, 'affected', '--dry-run');
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(fallback.stdout, /Dry run: full suite \(1 test file\(s\)\)\./);
    assert.match(fallback.stdout, /unknown code changed: src\/new\.mjs/);
    assert.doesNotMatch(fallback.stdout, /▶/);
    assert.equal(readFileSync(cachePath, 'utf8'), cacheBefore);

    rmSync(join(cwd, '.affected-tests'), { recursive: true, force: true });
    const cacheMiss = run(cwd, 'affected', '--dry-run');
    assert.equal(cacheMiss.status, 0, cacheMiss.stderr);
    assert.match(cacheMiss.stdout, /No graph cache; running full suite\./);
    assert.match(cacheMiss.stdout, /Dry run: full suite \(1 test file\(s\)\)\./);
    assert.equal(existsSync(join(cwd, '.affected-tests')), false);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('JSON dry-run emits one versioned selection document without workers or cache writes', () => {
  const cwd = makeRepository();
  const marker = join(cwd, 'worker-ran');
  const testPath = join(cwd, 'test', 'value.test.mjs');
  writeFileSync(testPath, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    readFileSync(testPath, 'utf8'),
  ].join('\n'));
  git(cwd, 'add', 'test/value.test.mjs');
  git(cwd, 'commit', '-qm', 'add worker marker');
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    rmSync(marker);
    const cachePath = join(cwd, '.affected-tests', 'graph.json');
    const cacheBefore = readFileSync(cachePath, 'utf8');
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');

    const human = run(cwd, 'affected', '--dry-run');
    const affected = run(cwd, 'affected', '--dry-run', '--output=json');
    assert.equal(affected.status, 0, affected.stderr);
    const selected = JSON.parse(affected.stdout);
    assert.deepEqual(selected, {
      schemaVersion: 1,
      mode: 'preview',
      command: 'affected',
      provider: 'git',
      projectRoot: cwd,
      outcome: 'selected',
      tests: ['test/value.test.mjs'],
      totalTests: 1,
      reasons: {
        'test/value.test.mjs': [{
          file: 'src/value.mjs',
          kind: 'dependency',
          path: ['test/value.test.mjs', 'src/value.mjs'],
        }],
      },
      fallback: null,
    });
    assert.ok(selected.tests.every((path) => human.stdout.includes(path)));
    assert.match(affected.stderr, /Changed files: src\/value\.mjs/);
    assert.doesNotMatch(affected.stdout, /Dry run|Changed files|▶/);
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(cachePath, 'utf8'), cacheBefore);

    const related = run(cwd, 'related', 'src/value.mjs', '--dry-run', '--output=json');
    assert.equal(related.status, 0, related.stderr);
    assert.equal(JSON.parse(related.stdout).provider, 'explicit-files');

    const sinceLastRun = run(cwd, 'since-last-run', '--dry-run', '--output=json');
    assert.equal(sinceLastRun.status, 0, sinceLastRun.stderr);
    assert.equal(JSON.parse(sinceLastRun.stdout).provider, 'filesystem');

    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1;\n');
    const noOp = run(cwd, 'affected', '--dry-run', '--output=json');
    assert.equal(noOp.status, 0, noOp.stderr);
    assert.deepEqual(JSON.parse(noOp.stdout).tests, []);
    assert.equal(JSON.parse(noOp.stdout).outcome, 'no-tests');

    writeFileSync(join(cwd, 'src', 'new.mjs'), 'export const added = true;\n');
    const fallback = run(cwd, 'affected', '--dry-run', '--output=json');
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.deepEqual(JSON.parse(fallback.stdout).fallback, {
      files: ['src/new.mjs'],
      kind: 'unknown-code',
    });
    assert.equal(JSON.parse(fallback.stdout).outcome, 'full-suite');

    rmSync(join(cwd, '.affected-tests'), { recursive: true, force: true });
    const cacheMiss = run(cwd, 'affected', '--dry-run', '--output=json');
    assert.equal(cacheMiss.status, 0, cacheMiss.stderr);
    assert.equal(JSON.parse(cacheMiss.stdout).fallback.kind, 'cache-unavailable');
    assert.match(cacheMiss.stderr, /No graph cache; running full suite\./);
    assert.equal(existsSync(join(cwd, '.affected-tests')), false);
    assert.equal(existsSync(marker), false);

    const baseline = run(cwd, 'baseline', '--dry-run', '--output=json');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).provider, 'baseline');
    assert.equal(JSON.parse(baseline.stdout).outcome, 'full-suite');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('JSON finite runs emit one document for passing, failing, no-op, and fallback outcomes', () => {
  const cwd = makeRepository();
  const testPath = join(cwd, 'test', 'value.test.mjs');
  writeFileSync(testPath, [
    "console.log('json-worker-output');",
    readFileSync(testPath, 'utf8'),
  ].join('\n'));
  git(cwd, 'add', 'test/value.test.mjs');
  git(cwd, 'commit', '-qm', 'add worker output');
  try {
    assert.equal(run(cwd, 'baseline').status, 0);

    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // changed\n');
    const passing = run(cwd, 'affected', '--output=json');
    assert.equal(passing.status, 0, passing.stderr);
    assert.deepEqual(JSON.parse(passing.stdout), {
      schemaVersion: 1,
      mode: 'run',
      command: 'affected',
      provider: 'git',
      projectRoot: cwd,
      outcome: 'selected',
      tests: ['test/value.test.mjs'],
      totalTests: 1,
      reasons: {
        'test/value.test.mjs': [{
          file: 'src/value.mjs',
          kind: 'dependency',
          path: ['test/value.test.mjs', 'src/value.mjs'],
        }],
      },
      fallback: null,
      execution: {
        status: 'passed',
        tests: ['test/value.test.mjs'],
        failures: [],
        exitCode: 0,
      },
    });
    assert.match(passing.stderr, /json-worker-output/);
    assert.doesNotMatch(passing.stdout, /json-worker-output|▶|Selected/);

    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1;\n');
    const noOp = run(cwd, 'affected', '--output=json');
    assert.equal(noOp.status, 0, noOp.stderr);
    assert.equal(JSON.parse(noOp.stdout).outcome, 'no-tests');
    assert.deepEqual(JSON.parse(noOp.stdout).execution, {
      status: 'passed',
      tests: [],
      failures: [],
      exitCode: 0,
    });

    writeFileSync(testPath, `${readFileSync(testPath, 'utf8')}\nthrow new Error('json failure');\n`);
    const failing = run(cwd, 'affected', '--output=json');
    assert.equal(failing.status, 1);
    assert.equal(JSON.parse(failing.stdout).execution.status, 'failed');
    assert.deepEqual(JSON.parse(failing.stdout).execution.failures, ['test/value.test.mjs']);
    assert.equal(JSON.parse(failing.stdout).execution.exitCode, 1);
    assert.match(failing.stderr, /json failure/);

    git(cwd, 'checkout', '--', 'test/value.test.mjs');
    writeFileSync(join(cwd, 'src', 'new.mjs'), 'export const added = true;\n');
    const fallback = run(cwd, 'affected', '--output=json');
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.equal(JSON.parse(fallback.stdout).outcome, 'full-suite');
    assert.deepEqual(JSON.parse(fallback.stdout).fallback, {
      files: ['src/new.mjs'],
      kind: 'unknown-code',
    });
    assert.deepEqual(JSON.parse(fallback.stdout).execution.tests, ['test/value.test.mjs']);
    assert.deepEqual(JSON.parse(fallback.stdout).execution.failures, []);

    const baseline = run(cwd, 'baseline', '--output=json');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).command, 'baseline');
    assert.equal(JSON.parse(baseline.stdout).execution.status, 'passed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('dry-run explains sticky failures without rerunning them', () => {
  const cwd = makeRepository();
  const testPath = join(cwd, 'test', 'value.test.mjs');
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    const passing = readFileSync(testPath, 'utf8');
    writeFileSync(testPath, `${passing}\nthrow new Error('sticky preview');\n`);
    assert.equal(run(cwd, 'affected').status, 1);
    writeFileSync(testPath, passing);

    const preview = run(cwd, 'affected', '--dry-run');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /test\/value\.test\.mjs/);
    assert.match(preview.stdout, /previously failing test/);
    assert.doesNotMatch(preview.stdout, /▶/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('last-failed previews, reruns, clears, and conservatively handles a missing cache', () => {
  const cwd = makeRepository();
  const testPath = join(cwd, 'test', 'value.test.mjs');
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    const passing = readFileSync(testPath, 'utf8');
    writeFileSync(testPath, `${passing}\nthrow new Error('remember me');\n`);
    assert.equal(run(cwd, 'affected').status, 1);
    const preview = run(cwd, 'last-failed', '--dry-run');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Dry run: selected 1\/1 previously failing test file\(s\)\./);
    assert.match(preview.stdout, /previously failing test/);

    const stillFailing = run(cwd, 'last-failed', '--output=json');
    assert.equal(stillFailing.status, 1);
    assert.deepEqual(JSON.parse(stillFailing.stdout).execution.failures, ['test/value.test.mjs']);

    writeFileSync(testPath, passing);
    const rerun = run(cwd, 'last-failed', '--output=json');
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(JSON.parse(rerun.stdout).command, 'last-failed');
    assert.deepEqual(JSON.parse(rerun.stdout).execution.tests, ['test/value.test.mjs']);
    assert.deepEqual(JSON.parse(rerun.stdout).execution.failures, []);

    const noOp = run(cwd, 'last-failed');
    assert.equal(noOp.status, 0, noOp.stderr);
    assert.equal(noOp.stdout, 'No previously failing tests.\n');

    rmSync(join(cwd, '.affected-tests'), { recursive: true, force: true });
    const cacheMiss = run(cwd, 'last-failed', '--dry-run');
    assert.equal(cacheMiss.status, 0, cacheMiss.stderr);
    assert.match(cacheMiss.stdout, /No graph cache; running full suite\./);
    assert.match(cacheMiss.stdout, /Dry run: full suite \(1 test file\(s\)\)\./);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('--concurrency rejects non-positive values before accessing Git', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'affected-tests-options-'));
  try {
    const result = run(cwd, 'baseline', '--concurrency', '0');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--concurrency must be a positive integer or a percentage greater than 0% and at most 100%\./);
    assert.doesNotMatch(result.stderr, /not a git repository/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('--concurrency accepts percentages and clamps small allocations to one worker', () => {
  const cwd = makeParallelRepository({ delays: { a: 50, b: 50, c: 50 } });
  const tracker = join(cwd, 'processes.log');
  try {
    const result = runWithEnv(cwd, { TEST_TRACKER: tracker }, 'baseline', '--concurrency', '1%');
    assert.equal(result.status, 0, result.stderr);
    const events = readFileSync(tracker, 'utf8').trim().split('\n');
    let active = 0;
    let maximumActive = 0;
    for (const event of events) {
      active += event.startsWith('start:') ? 1 : -1;
      maximumActive = Math.max(maximumActive, active);
    }
    assert.equal(maximumActive, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('clear-cache removes the saved dependency graph', () => {
  const cwd = makeRepository();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    const cache = join(cwd, '.affected-tests', 'graph.json');
    assert.equal(existsSync(cache), true);

    const cleared = run(cwd, 'clear-cache');
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.match(cleared.stdout, /Cleared cache: \.affected-tests\/graph\.json/);
    assert.equal(existsSync(cache), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a configured cache directory is used for writes and clearing', () => {
  const cwd = makeRepository();
  try {
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      cacheDir: 'cache/affected-node-test',
      projectDependencies: ['**/*'],
    }));
    git(cwd, 'add', 'affected-node-test.config.json');
    git(cwd, 'commit', '-qm', 'configure cache');
    const cache = join(cwd, 'cache', 'affected-node-test', 'graph.json');

    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(existsSync(cache), true);
    assert.equal(existsSync(join(cwd, '.affected-tests', 'graph.json')), false);

    const affected = run(cwd, 'affected');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /No changed files\./);

    const cleared = run(cwd, 'clear-cache');
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.match(cleared.stdout, /Cleared cache: cache\/affected-node-test\/graph\.json/);
    assert.equal(existsSync(cache), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a configured cache directory cannot escape the project root', () => {
  const cwd = makeRepository();
  try {
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({ cacheDir: '../shared-cache' }));

    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 1);
    assert.match(baseline.stderr, /cacheDir must stay within the project root/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('configured patterns reuse one repository walk for a command', () => {
  const cwd = makeRepository();
  const count = join(cwd, 'walk-count.txt');
  try {
    const preload = join(cwd, 'count-walks.mjs');
    writeFileSync(preload, [
      "import fs, { writeFileSync } from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      "const original = fs.readdirSync;",
      "let rootWalks = 0;",
      `fs.readdirSync = (path, ...args) => { if (String(path) === ${JSON.stringify(cwd)} && String(process.argv[1]).includes('affected-node-test')) rootWalks += 1; return original(path, ...args); };`,
      'syncBuiltinESMExports();',
      `process.on('exit', () => { if (String(process.argv[1]).includes('affected-node-test')) writeFileSync(${JSON.stringify(count)}, String(rootWalks)); });`,
      '',
    ].join('\n'));
    writeFileSync(join(cwd, '.env'), 'WALK_COUNT_TEST=1\n');
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      envFiles: ['.env'],
      globalSetupFiles: [],
      projectDependencies: ['src/*.mjs', 'package.json'],
      setupFiles: ['count-walks.mjs'],
    }));
    const result = runWithEnv(cwd, { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, 'baseline');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Number(readFileSync(count, 'utf8')) <= 2,
      `expected one repository walk, received ${readFileSync(count, 'utf8')}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('symlinked cache and plan paths cannot escape the project root', {
  skip: process.platform === 'win32' ? 'Symlink creation requires Windows developer privileges.' : false,
}, () => {
  const cwd = makeRepository();
  const outside = mkdtempSync(join(tmpdir(), 'affected-external-'));
  try {
    symlinkSync(outside, join(cwd, 'external'), 'dir');
    writeFileSync(join(outside, 'graph.json'), 'sentinel');
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({ cacheDir: 'external' }));
    for (const command of ['baseline', 'clear-cache']) {
      const result = run(cwd, command);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /cacheDir must stay within the project root/);
      assert.equal(readFileSync(join(outside, 'graph.json'), 'utf8'), 'sentinel');
    }
    writeFileSync(join(cwd, 'affected-node-test.config.json'), '{}');
    const plan = run(cwd, 'affected-first', 'HEAD', '--phase', 'affected', '--plan', 'external/plan.json');
    assert.equal(plan.status, 1);
    assert.match(plan.stderr, /--plan must be a project-relative path within the project root/);
    assert.equal(existsSync(join(outside, 'plan.json')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
