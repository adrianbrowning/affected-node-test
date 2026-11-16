import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { terminateProcessTree } from '../../src/process-control.ts';
import { cli, run, runWithEnv, git, makeRepository, makeTypeScriptRepository, makeInterruptRepository, makeSetupRepository, makeGlobalSetupRepository, makeEnvironmentRepository, waitFor, isProcessRunning, edgeTemporaryDirectories } from '../helpers/cli-fixtures.ts';

test('forced process-tree termination preserves the previous cache', { timeout: 35_000 }, async () => {
  const cwd = makeInterruptRepository();
  const tracker = join(cwd, 'interrupt.log');
  let cliProcess: ChildProcess | undefined;
  let testPid: number | undefined;
  const previousTemporaryDirectories = edgeTemporaryDirectories();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    const cachePath = join(cwd, '.affected-tests', 'graph.json');
    const previousCache = readFileSync(cachePath, 'utf8');
    writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // changed\n');

    const env: NodeJS.ProcessEnv = { ...process.env, INTERRUPT_TRACKER: tracker };
    delete env.NODE_TEST_CONTEXT;
    cliProcess = spawn(process.execPath, [cli, 'affected', 'HEAD', '--concurrency', '1'], {
      cwd,
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const startedProcess = cliProcess;
    await waitFor(() => existsSync(tracker) || startedProcess.exitCode !== null || startedProcess.signalCode !== null, 20_000);
    assert.ok(existsSync(tracker), `Test process exited before writing its tracker (exit code: ${cliProcess.exitCode})`);
    testPid = Number(/start:(\d+)/.exec(readFileSync(tracker, 'utf8'))?.[1]);
    assert.ok(Number.isSafeInteger(testPid) && testPid > 1);

    const closed = new Promise<void>((resolve) => cliProcess?.once('close', () => resolve()));
    terminateProcessTree(cliProcess, 'SIGKILL');
    await closed;

    await waitFor(() => testPid !== undefined && !isProcessRunning(testPid));
    assert.equal(readFileSync(cachePath, 'utf8'), previousCache);
  } finally {
    if (cliProcess && cliProcess.exitCode === null) terminateProcessTree(cliProcess, 'SIGKILL');
    if (testPid !== undefined && Number.isSafeInteger(testPid) && testPid > 1 && isProcessRunning(testPid)) {
      process.kill(testPid, 'SIGKILL');
    }
    for (const directory of edgeTemporaryDirectories()) {
      if (!previousTemporaryDirectories.includes(directory)) {
        rmSync(join(tmpdir(), directory), { recursive: true, force: true });
      }
    }
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('configured force-rerun triggers run the full suite for non-module files', () => {
  const cwd = makeRepository();
  try {
    mkdirSync(join(cwd, 'fixtures'));
    writeFileSync(join(cwd, 'fixtures', 'template.txt'), 'initial\n');
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      forceRerunTriggers: ['fixtures/**'],
    }, null, 2));
    git(cwd, 'add', 'fixtures/template.txt', 'affected-node-test.config.json');
    git(cwd, 'commit', '-qm', 'configure fixture trigger');
    assert.equal(run(cwd, 'baseline').status, 0);

    writeFileSync(join(cwd, 'fixtures', 'template.txt'), 'changed\n');
    const affected = run(cwd, 'affected', 'HEAD');

    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Force-rerun trigger matched: fixtures\/template\.txt; running full suite\./);
    assert.match(affected.stdout, /Building graph from 1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('configured include and exclude patterns control test discovery', () => {
  const cwd = makeRepository();
  try {
    mkdirSync(join(cwd, 'specs'));
    mkdirSync(join(cwd, 'specs', 'ignored'));
    const customTest = "import test from 'node:test'; test('custom', () => {});\n";
    writeFileSync(join(cwd, 'specs', 'custom.check.mjs'), customTest);
    writeFileSync(join(cwd, 'specs', 'ignored', 'skip.check.mjs'), customTest);
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      include: ['specs/**/*.check.mjs'],
      exclude: ['specs/ignored/**'],
    }, null, 2));
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'configure test discovery');

    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /Building graph from 1 test file\(s\)/);
    assert.match(baseline.stdout, /▶ specs\/custom\.check\.mjs/);
    assert.doesNotMatch(baseline.stdout, /skip\.check\.mjs|test\/value\.test\.mjs/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('configured node arguments execute discovered TypeScript tests', () => {
  const cwd = makeTypeScriptRepository();
  try {
    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /✔ typed value/);
    assert.match(readFileSync(join(cwd, '.affected-tests', 'graph.json'), 'utf8'), /src\/value\.ts/);

    writeFileSync(join(cwd, 'src', 'value.ts'), 'export const value: number = 1; // changed\n');
    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Selected 1\/1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('invalid project configuration fails before running tests', () => {
  const cwd = makeRepository();
  try {
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      include: 'test/**/*.mjs',
    }));

    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 1);
    assert.match(baseline.stderr, /affected-node-test\.config\.json: include must be an array of non-empty strings\./);
    assert.doesNotMatch(baseline.stdout, /Building graph|▶/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('watch-trigger mappings select tests for non-module changes', () => {
  const cwd = makeRepository({ withOtherTest: true });
  try {
    mkdirSync(join(cwd, 'fixtures'));
    writeFileSync(join(cwd, 'fixtures', 'value.txt'), 'initial\n');
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      watchTriggerPatterns: [
        { pattern: 'fixtures/**', tests: ['test/value.test.mjs'] },
      ],
    }, null, 2));
    git(cwd, 'add', 'fixtures/value.txt', 'affected-node-test.config.json');
    git(cwd, 'commit', '-qm', 'configure watch trigger');
    assert.equal(run(cwd, 'baseline').status, 0);

    writeFileSync(join(cwd, 'fixtures', 'value.txt'), 'changed\n');
    const affected = run(cwd, 'affected', 'HEAD');

    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Watch trigger matched fixtures\/value\.txt; selected 1 mapped test file\(s\)\./);
    assert.match(affected.stdout, /Selected 1\/2 test file\(s\)/);
    assert.match(affected.stdout, /▶ test\/value\.test\.mjs/);
    assert.doesNotMatch(affected.stdout, /▶ test\/other\.test\.mjs/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a watch-trigger mapping with no discovered tests runs the full suite', () => {
  const cwd = makeRepository({ withOtherTest: true });
  try {
    mkdirSync(join(cwd, 'fixtures'));
    writeFileSync(join(cwd, 'fixtures', 'value.txt'), 'initial\n');
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      watchTriggerPatterns: [
        { pattern: 'fixtures/**', tests: ['test/missing*.test.mjs'] },
      ],
    }, null, 2));
    git(cwd, 'add', 'fixtures/value.txt', 'affected-node-test.config.json');
    git(cwd, 'commit', '-qm', 'configure unmatched watch trigger');
    assert.equal(run(cwd, 'baseline').status, 0);

    writeFileSync(join(cwd, 'fixtures', 'value.txt'), 'changed\n');
    const affected = run(cwd, 'affected', 'HEAD');

    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Watch trigger matched fixtures\/value\.txt but selected no tests; running full suite\./);
    assert.match(affected.stdout, /Building graph from 2 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('committed project dependency changes invalidate the graph cache', () => {
  const cwd = makeRepository();
  try {
    writeFileSync(join(cwd, 'test', 'setup.mjs'), 'export const setupVersion = 1;\n');
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({
      projectDependencies: ['test/setup.mjs'],
    }, null, 2));
    git(cwd, 'add', 'test/setup.mjs', 'affected-node-test.config.json');
    git(cwd, 'commit', '-qm', 'declare project setup dependency');
    assert.equal(run(cwd, 'baseline').status, 0);

    writeFileSync(join(cwd, 'test', 'setup.mjs'), 'export const setupVersion = 2;\n');
    git(cwd, 'add', 'test/setup.mjs');
    git(cwd, 'commit', '-qm', 'change setup dependency');
    const affected = run(cwd, 'affected', 'HEAD');

    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Project dependencies changed since graph was built; running full suite\./);
    assert.match(affected.stdout, /Building graph from 1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('setup files execute for every test and connect their imports to each graph', () => {
  const cwd = makeSetupRepository();
  try {
    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    const cache = readFileSync(join(cwd, '.affected-tests', 'graph.json'), 'utf8');
    assert.match(cache, /test\/setup\.mjs/);
    assert.match(cache, /test\/setup-helper\.mjs/);

    writeFileSync(join(cwd, 'test', 'setup-helper.mjs'), 'globalThis.setupReady = true; // changed\n');
    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Setup dependencies changed since graph was built; running full suite\./);
    assert.match(affected.stdout, /Building graph from 2 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('committed transitive setup changes invalidate the graph cache', () => {
  const cwd = makeSetupRepository();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    writeFileSync(join(cwd, 'test', 'setup-helper.mjs'), 'globalThis.setupReady = true; // committed\n');
    git(cwd, 'add', 'test/setup-helper.mjs');
    git(cwd, 'commit', '-qm', 'change setup helper');

    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Setup dependencies changed since graph was built; running full suite\./);
    assert.match(affected.stdout, /Building graph from 2 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('global setup runs once before tests and teardown runs once afterward', () => {
  const cwd = makeGlobalSetupRepository();
  const lifecycleLog = join(cwd, 'global-setup.log');
  try {
    const baseline = runWithEnv(cwd, { GLOBAL_SETUP_LOG: lifecycleLog }, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(readFileSync(lifecycleLog, 'utf8'), 'setup\nteardown\n');
    assert.match(baseline.stdout, /▶ test\/other\.test\.mjs/);
    assert.match(baseline.stdout, /▶ test\/value\.test\.mjs/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('committed transitive global-setup changes invalidate the graph cache', () => {
  const cwd = makeGlobalSetupRepository();
  const lifecycleLog = join(cwd, 'global-setup.log');
  try {
    assert.equal(runWithEnv(cwd, { GLOBAL_SETUP_LOG: lifecycleLog }, 'baseline').status, 0);
    writeFileSync(join(cwd, 'test', 'global-setup-helper.mjs'), "export const ready = 'yes'; // committed\n");
    git(cwd, 'add', 'test/global-setup-helper.mjs');
    git(cwd, 'commit', '-qm', 'change global setup helper');

    const affected = runWithEnv(cwd, { GLOBAL_SETUP_LOG: lifecycleLog }, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Global setup dependencies changed since graph was built; running full suite\./);
    assert.match(affected.stdout, /Building graph from 2 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('global teardown failures fail the run without creating a graph cache', () => {
  const cwd = makeGlobalSetupRepository();
  const lifecycleLog = join(cwd, 'global-setup.log');
  try {
    const setupPath = join(cwd, 'test', 'global-setup.mjs');
    const source = readFileSync(setupPath, 'utf8');
    writeFileSync(setupPath, source.replace(
      "return async () => appendFileSync(process.env.GLOBAL_SETUP_LOG, 'teardown\\n');",
      "return async () => { throw new Error('teardown boom'); };",
    ));

    const baseline = runWithEnv(cwd, { GLOBAL_SETUP_LOG: lifecycleLog }, 'baseline');
    assert.equal(baseline.status, 1);
    assert.match(baseline.stderr, /Global teardown failed: Error: teardown boom/);
    assert.equal(existsSync(join(cwd, '.affected-tests', 'graph.json')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('environment files load before test workers start', () => {
  const cwd = makeEnvironmentRepository();
  try {
    const baseline = run(cwd, 'baseline');
    assert.equal(baseline.status, 0, baseline.stderr);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('committed environment-file changes invalidate the graph cache', () => {
  const cwd = makeEnvironmentRepository();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    writeFileSync(join(cwd, '.env.test'), 'NODE_AFFECTED_TESTS_ENV_FIXTURE_7F3=from-env-file\n# committed change\n');
    git(cwd, 'add', '.env.test');
    git(cwd, 'commit', '-qm', 'change environment file');

    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Environment files changed since graph was built; running full suite\./);
    assert.match(affected.stdout, /Building graph from 1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('committed mock and snapshot convention changes invalidate the graph cache', () => {
  const cwd = makeRepository();
  try {
    mkdirSync(join(cwd, 'test', '__mocks__'));
    mkdirSync(join(cwd, 'test', '__snapshots__'));
    const mockPath = join(cwd, 'test', '__mocks__', 'service.mjs');
    const snapshotPath = join(cwd, 'test', '__snapshots__', 'value.test.mjs.snap');
    writeFileSync(mockPath, 'export const mocked = 1;\n');
    writeFileSync(snapshotPath, 'initial snapshot\n');
    git(cwd, 'add', 'test/__mocks__/service.mjs', 'test/__snapshots__/value.test.mjs.snap');
    git(cwd, 'commit', '-qm', 'add mock and snapshot');
    assert.equal(run(cwd, 'baseline').status, 0);

    writeFileSync(mockPath, 'export const mocked = 2;\n');
    writeFileSync(snapshotPath, 'changed snapshot\n');
    git(cwd, 'add', 'test/__mocks__/service.mjs', 'test/__snapshots__/value.test.mjs.snap');
    git(cwd, 'commit', '-qm', 'change mock and snapshot');
    const affected = run(cwd, 'affected', 'HEAD');

    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Convention dependencies changed since graph was built; running full suite\./);
    assert.match(affected.stdout, /Building graph from 1 test file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a newly added committed snapshot invalidates the graph cache', () => {
  const cwd = makeRepository();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    mkdirSync(join(cwd, 'test', '__snapshots__'));
    writeFileSync(join(cwd, 'test', '__snapshots__', 'value.test.mjs.snap'), 'new snapshot\n');
    git(cwd, 'add', 'test/__snapshots__/value.test.mjs.snap');
    git(cwd, 'commit', '-qm', 'add snapshot');

    const affected = run(cwd, 'affected', 'HEAD');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Convention dependencies changed since graph was built; running full suite\./);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
