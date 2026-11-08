import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { terminateProcessTree } from '../../src/process-control.ts';
import { cli, run, runWithEnv, git, waitForProcessOutput, stopWatchProcess, makeRepository, makeWorkspace } from '../helpers/cli-fixtures.ts';

test('workspace baseline runs configured projects with isolated caches', () => {
  const cwd = makeWorkspace();
  try {
    const baseline = run(cwd, 'baseline', '--concurrency', '1');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /Project packages\/a/);
    assert.match(baseline.stdout, /Project packages\/b/);
    assert.ok(baseline.stdout.indexOf('Project packages/a') < baseline.stdout.indexOf('Project packages/b'));
    assert.equal(existsSync(join(cwd, 'packages', 'a', '.affected-tests', 'graph.json')), true);
    assert.equal(existsSync(join(cwd, 'packages', 'b', '.affected-tests', 'graph.json')), true);
    assert.equal(existsSync(join(cwd, '.affected-tests', 'graph.json')), false);

    const cleared = run(cwd, 'clear-cache');
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.equal(existsSync(join(cwd, 'packages', 'a', '.affected-tests', 'graph.json')), false);
    assert.equal(existsSync(join(cwd, 'packages', 'b', '.affected-tests', 'graph.json')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace runs independent projects concurrently and reports lexical order', () => {
  const cwd = makeWorkspace();
  const tracker = join(cwd, 'project-events.log');
  try {
    for (const name of ['a', 'b']) {
      const path = join(cwd, 'packages', name, 'test', 'value.test.mjs');
      writeFileSync(path, [
        "import { appendFileSync } from 'node:fs';",
        "import test from 'node:test';",
        `test('parallel ${name}', async () => {`,
        `  appendFileSync(process.env.PROJECT_EVENTS, 'start:${name}\\n');`,
        '  await new Promise((resolve) => setTimeout(resolve, 500));',
        `  appendFileSync(process.env.PROJECT_EVENTS, 'end:${name}\\n');`,
        '});',
        '',
      ].join('\n'));
    }
    const result = runWithEnv(cwd, { PROJECT_EVENTS: tracker }, 'baseline');
    assert.equal(result.status, 0, result.stderr);
    const events = readFileSync(tracker, 'utf8').trim().split('\n');
    assert.equal(events.slice(0, 2).every((event) => event.startsWith('start:')), true);
    assert.ok(result.stdout.indexOf('Project packages/a') < result.stdout.indexOf('Project packages/b'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace rejects symlinked project, cache, and plan escapes', {
  skip: process.platform === 'win32' ? 'Symlink creation requires Windows developer privileges.' : false,
}, () => {
  const cwd = makeWorkspace();
  const outside = mkdtempSync(join(tmpdir(), 'affected-workspace-external-'));
  try {
    symlinkSync(outside, join(cwd, 'external'), 'dir');
    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({ projects: ['external'] }));
    const project = run(cwd, 'baseline');
    assert.equal(project.status, 1);
    assert.match(project.stderr, /Workspace project root must stay below the workspace root/);

    writeFileSync(join(cwd, 'affected-node-test.config.json'), JSON.stringify({ projects: ['packages/a', 'packages/b'] }));
    symlinkSync(outside, join(cwd, 'packages', 'a', 'external'), 'dir');
    writeFileSync(join(cwd, 'packages', 'a', 'affected-node-test.config.json'), JSON.stringify({ cacheDir: 'external' }));
    const cache = run(cwd, 'baseline');
    assert.equal(cache.status, 1);
    assert.match(cache.stderr, /cacheDir must stay within the project root/);

    writeFileSync(join(cwd, 'packages', 'a', 'affected-node-test.config.json'), '{}');
    const plan = run(cwd, 'affected-first', 'HEAD', '--phase', 'affected', '--plan', 'external/plan.json');
    assert.equal(plan.status, 1);
    assert.match(plan.stderr, /--plan must be a workspace-relative path within the workspace root/);
    assert.equal(existsSync(join(outside, 'plan.json')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('workspace project filters scope finite and watch commands', { timeout: 60_000 }, async () => {
  const cwd = makeWorkspace();
  try {
    const baseline = run(cwd, 'baseline', '--project', 'packages/a');
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /Project packages\/a/);
    assert.doesNotMatch(baseline.stdout, /Project packages\/b/);
    assert.equal(existsSync(join(cwd, 'packages', 'a', '.affected-tests', 'graph.json')), true);
    assert.equal(existsSync(join(cwd, 'packages', 'b', '.affected-tests', 'graph.json')), false);

    const multiple = run(cwd, 'baseline', '--project', 'packages/b', '--project', 'packages/a', '--output=json');
    assert.equal(multiple.status, 0, multiple.stderr);
    assert.deepEqual(JSON.parse(multiple.stdout).projects.map(({ path }: { path: string }) => path), ['packages/a', 'packages/b']);

    const missing = run(cwd, 'baseline', '--project', 'packages/missing');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No workspace projects matched --project packages\/missing\./);

    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [cli, 'watch', '--project', 'packages/a', '--concurrency', '1'], {
      cwd,
      detached: process.platform !== 'win32',
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal })));
    try {
      await waitForProcessOutput(child, () => stdout + stderr,
        (output) => output.includes('Watching in 1 projects.'), 30_000);
      assert.doesNotMatch(stdout, /\[packages\/b\]/);
      await stopWatchProcess(child, closed, stderr);
    } finally {
      if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
      await closed;
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace related routes files only to their owning project', () => {
  const cwd = makeWorkspace();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);

    const related = run(cwd, 'related', 'packages/a/src/value.mjs');
    assert.equal(related.status, 0, related.stderr);
    assert.match(related.stdout, /Project packages\/a/);
    assert.doesNotMatch(related.stdout, /Project packages\/b/);
    assert.match(related.stdout, /Related files: src\/value\.mjs/);
    assert.match(related.stdout, /Selected 1\/1 related test file\(s\)/);

    const excluded = run(cwd, 'related', 'packages/b/src/value.mjs', '--project', 'packages/a');
    assert.equal(excluded.status, 0, excluded.stderr);
    assert.doesNotMatch(excluded.stdout, /Project packages\/a|Project packages\/b|Building graph/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace affected routes Git changes only to their owning project', () => {
  const cwd = makeWorkspace();
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    writeFileSync(join(cwd, 'packages', 'a', 'src', 'value.mjs'), 'export const value = 1; // changed\n');

    const affected = run(cwd, 'affected');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Changed files: packages\/a\/src\/value\.mjs/);
    assert.match(affected.stdout, /Project packages\/a/);
    assert.doesNotMatch(affected.stdout, /Project packages\/b/);
    assert.match(affected.stdout, /Selected 1\/1 related test file\(s\)/);

    const excluded = run(cwd, 'affected', '--project', 'packages/b');
    assert.equal(excluded.status, 0, excluded.stderr);
    assert.doesNotMatch(excluded.stdout, /Project packages\/a|Project packages\/b|Building graph/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace affected-first completes affected projects before remaining projects', () => {
  const cwd = makeWorkspace();
  const tracker = join(tmpdir(), `workspace-affected-first-${process.pid}-${Date.now()}.log`);
  try {
    for (const name of ['a', 'b']) {
      const path = join(cwd, 'packages', name, 'test', 'value.test.mjs');
      writeFileSync(path, [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(process.env.PARTITION_TRACKER, '${name}\\n');`,
        readFileSync(path, 'utf8'),
      ].join('\n'));
    }
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'track workspace partitions');
    assert.equal(runWithEnv(cwd, { PARTITION_TRACKER: tracker }, 'baseline').status, 0);
    writeFileSync(tracker, '');
    writeFileSync(join(cwd, 'packages', 'a', 'src', 'value.mjs'), 'export const value = 1; // changed\n');

    const result = runWithEnv(cwd, { PARTITION_TRACKER: tracker }, 'affected-first', 'HEAD');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(tracker, 'utf8').trim().split('\n'), ['a', 'b']);
    assert.match(result.stdout, /Project packages\/a — affected/);
    assert.match(result.stdout, /Project packages\/b — remaining/);

    writeFileSync(tracker, '');
    const filtered = runWithEnv(cwd, { PARTITION_TRACKER: tracker },
      'affected-first', 'HEAD', '--project', 'packages/a');
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.deepEqual(readFileSync(tracker, 'utf8').trim().split('\n'), ['a']);
    assert.match(filtered.stdout, /Project packages\/a — affected/);
    assert.doesNotMatch(filtered.stdout, /Project packages\/b/);
  } finally {
    rmSync(tracker, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace affected-first phases resume from one portable plan', () => {
  const cwd = makeWorkspace();
  const tracker = join(tmpdir(), `workspace-affected-phases-${process.pid}-${Date.now()}.log`);
  const plan = '.affected-tests/workspace-plan.json';
  try {
    for (const name of ['a', 'b']) {
      const path = join(cwd, 'packages', name, 'test', 'value.test.mjs');
      writeFileSync(path, [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(process.env.PARTITION_TRACKER, '${name}\\n');`,
        readFileSync(path, 'utf8'),
      ].join('\n'));
    }
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'track split workspace partitions');
    assert.equal(runWithEnv(cwd, { PARTITION_TRACKER: tracker }, 'baseline').status, 0);
    writeFileSync(tracker, '');
    writeFileSync(join(cwd, 'packages', 'a', 'src', 'value.mjs'), 'export const value = 1; // split\n');

    const first = runWithEnv(cwd, { PARTITION_TRACKER: tracker },
      'affected-first', 'HEAD', '--project', 'packages/a', '--phase', 'affected', '--plan', plan);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(readFileSync(tracker, 'utf8').trim().split('\n'), ['a']);
    const serialized = readFileSync(join(cwd, plan), 'utf8');
    assert.doesNotMatch(serialized, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const second = runWithEnv(cwd, { PARTITION_TRACKER: tracker },
      'affected-first', '--project', 'packages/a', '--phase', 'remaining', '--plan', plan);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readFileSync(tracker, 'utf8').trim().split('\n'), ['a']);
  } finally {
    rmSync(tracker, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace dry-run preserves project routing, fallbacks, and cache state', () => {
  const cwd = makeWorkspace();
  const cache = (project: string) => join(cwd, 'packages', project, '.affected-tests', 'graph.json');
  try {
    assert.equal(run(cwd, 'baseline').status, 0);
    const cacheBefore = {
      a: readFileSync(cache('a'), 'utf8'),
      b: readFileSync(cache('b'), 'utf8'),
    };

    const noOp = run(cwd, 'since-last-run', '--dry-run');
    assert.equal(noOp.status, 0, noOp.stderr);
    assert.match(noOp.stdout, /Project packages\/a/);
    assert.match(noOp.stdout, /Project packages\/b/);
    assert.equal((noOp.stdout.match(/No tests changed since last run\./g) ?? []).length, 2);

    writeFileSync(join(cwd, 'packages', 'a', 'src', 'value.mjs'), 'export const value = 1; // changed\n');
    const affected = run(cwd, 'affected', '--dry-run');
    assert.equal(affected.status, 0, affected.stderr);
    assert.match(affected.stdout, /Project packages\/a/);
    assert.doesNotMatch(affected.stdout, /Project packages\/b/);
    assert.match(affected.stdout, /Dry run: selected 1\/1 related test file\(s\)\./);
    assert.match(affected.stdout, /changed dependency: test\/value\.test\.mjs -> src\/value\.mjs/);

    const related = run(cwd, 'related', 'packages/b/src/value.mjs', '--dry-run');
    assert.equal(related.status, 0, related.stderr);
    assert.match(related.stdout, /Project packages\/b/);
    assert.doesNotMatch(related.stdout, /Project packages\/a/);
    assert.match(related.stdout, /changed dependency: test\/value\.test\.mjs -> src\/value\.mjs/);

    writeFileSync(join(cwd, 'packages', 'b', 'src', 'value.mjs'), 'export const value = 2; // changed\n');
    const sinceLastRun = run(cwd, 'since-last-run', '--dry-run');
    assert.equal(sinceLastRun.status, 0, sinceLastRun.stderr);
    assert.match(sinceLastRun.stdout, /Project packages\/a/);
    assert.match(sinceLastRun.stdout, /Project packages\/b/);
    assert.equal((sinceLastRun.stdout.match(/recorded dependency state changed/g) ?? []).length, 2);

    writeFileSync(join(cwd, 'README.md'), 'workspace-level change\n');
    const fallback = run(cwd, 'affected', '--dry-run');
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(fallback.stdout, /Workspace-level change README\.md; previewing every project baseline\./);
    assert.equal((fallback.stdout.match(/Dry run: full suite \(1 test file\(s\)\)\./g) ?? []).length, 2);
    assert.doesNotMatch(fallback.stdout, /▶/);

    const relatedFallback = run(cwd, 'related', 'README.md', '--dry-run');
    assert.equal(relatedFallback.status, 0, relatedFallback.stderr);
    assert.match(relatedFallback.stdout, /Workspace-level related file README\.md; previewing every project baseline\./);
    assert.equal((relatedFallback.stdout.match(/Dry run: full suite \(1 test file\(s\)\)\./g) ?? []).length, 2);

    assert.equal(readFileSync(cache('a'), 'utf8'), cacheBefore.a);
    assert.equal(readFileSync(cache('b'), 'utf8'), cacheBefore.b);
    assert.doesNotMatch(`${affected.stdout}${related.stdout}${sinceLastRun.stdout}`, /▶/);

    rmSync(join(cwd, 'README.md'));
    rmSync(join(cwd, 'packages', 'a', '.affected-tests'), { recursive: true, force: true });
    rmSync(join(cwd, 'packages', 'b', '.affected-tests'), { recursive: true, force: true });
    const cacheMiss = run(cwd, 'affected', '--dry-run');
    assert.equal(cacheMiss.status, 0, cacheMiss.stderr);
    assert.equal((cacheMiss.stdout.match(/No graph cache; running full suite\./g) ?? []).length, 2);
    assert.equal(existsSync(cache('a')), false);
    assert.equal(existsSync(cache('b')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace JSON aggregates routing and project results for finite commands', () => {
  const cwd = makeWorkspace();
  try {
    const baseline = run(cwd, 'baseline', '--output=json');
    assert.equal(baseline.status, 0, baseline.stderr);
    const baselineDocument = JSON.parse(baseline.stdout);
    assert.equal(baselineDocument.schemaVersion, 1);
    assert.equal(baselineDocument.mode, 'run');
    assert.equal(baselineDocument.command, 'baseline');
    assert.equal(baselineDocument.workspaceRoot, cwd);
    assert.equal(baselineDocument.outcome, 'passed');
    assert.equal(baselineDocument.exitCode, 0);
    assert.deepEqual(baselineDocument.projects.map(({ path }: { path: string }) => path), ['packages/a', 'packages/b']);

    const noOp = run(cwd, 'affected', '--output=json');
    assert.equal(noOp.status, 0, noOp.stderr);
    assert.equal(JSON.parse(noOp.stdout).routing.kind, 'no-changes');
    assert.equal(JSON.parse(noOp.stdout).outcome, 'passed');

    writeFileSync(join(cwd, 'packages', 'a', 'src', 'value.mjs'), 'export const value = 1; // changed\n');
    const selected = run(cwd, 'affected', '--output=json');
    assert.equal(selected.status, 0, selected.stderr);
    const selectedDocument = JSON.parse(selected.stdout);
    assert.deepEqual(selectedDocument.routing, {
      kind: 'project-files',
      files: ['packages/a/src/value.mjs'],
    });
    const projectA = selectedDocument.projects.find(({ path }: { path: string }) => path === 'packages/a');
    assert.deepEqual(projectA.result.execution.tests, ['test/value.test.mjs']);
    assert.deepEqual(projectA.result.execution.failures, []);

    const failingTest = join(cwd, 'packages', 'b', 'test', 'value.test.mjs');
    writeFileSync(failingTest, `${readFileSync(failingTest, 'utf8')}\nthrow new Error('workspace json failure');\n`);
    const failing = run(cwd, 'affected', '--output=json');
    assert.equal(failing.status, 1);
    assert.equal(JSON.parse(failing.stdout).outcome, 'failed');
    assert.equal(JSON.parse(failing.stdout).exitCode, 1);
    assert.match(failing.stderr, /workspace json failure/);

    git(cwd, 'checkout', '--', 'packages/b/test/value.test.mjs');
    const lastFailed = run(cwd, 'last-failed', '--dry-run', '--output=json');
    assert.equal(lastFailed.status, 0, lastFailed.stderr);
    const failedProject = JSON.parse(lastFailed.stdout).projects
      .find(({ path }: { path: string }) => path === 'packages/b');
    assert.deepEqual(failedProject.result.tests, ['test/value.test.mjs']);

    writeFileSync(join(cwd, 'README.md'), 'workspace change\n');
    const fallback = run(cwd, 'affected', '--dry-run', '--output=json');
    assert.equal(fallback.status, 0, fallback.stderr);
    const fallbackDocument = JSON.parse(fallback.stdout);
    assert.deepEqual(fallbackDocument.routing, {
      kind: 'workspace-fallback',
      file: 'README.md',
      reason: 'workspace-level-change',
    });
    assert.equal(fallbackDocument.mode, 'preview');
    assert.deepEqual(fallbackDocument.projects.map(({ path }: { path: string }) => path), ['packages/a', 'packages/b']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('watch emits structured readiness over IPC', { timeout: 30_000 }, async () => {
  const cwd = makeRepository();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [cli, 'watch', '--concurrency', '1'], {
    cwd,
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages: unknown[] = [];
  let stdout = '';
  let stderr = '';
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('message', (message) => { messages.push(message); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    await waitForProcessOutput(child, () => `${stdout}${stderr}\n${JSON.stringify(messages)}`,
      () => messages.some((message) => Boolean(message && typeof message === 'object' &&
        'type' in message && message.type === 'affected-node-test:watch-ready')), 15_000);
    assert.match(stdout, /Watching for changes\./);

    await stopWatchProcess(child, closed, stderr);
  } finally {
    if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
    await closed;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace watch coordinates project reruns and shutdown', { timeout: 60_000 }, async () => {
  const cwd = makeWorkspace();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [cli, 'watch', '--concurrency', '1'], {
    cwd,
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    await waitForProcessOutput(child, () => stdout + stderr,
      (output) => output.includes('Watching in 2 projects.'), 30_000);
    const rerunStart = stdout.length;
    writeFileSync(join(cwd, 'packages', 'a', 'src', 'value.mjs'), 'export const value = 1; // watched\n');

    await waitForProcessOutput(child, () => stdout + stderr,
      (output) => output.slice(rerunStart).includes('[packages/a] ▶ test/value.test.mjs'), 20_000);
    const rerunOutput = stdout.slice(rerunStart);
    assert.doesNotMatch(rerunOutput, /\[packages\/b\] ▶ test\/value\.test\.mjs/);

    await stopWatchProcess(child, closed, stderr);
  } finally {
    if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
    await closed;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workspace watch stops sibling watchers when one project fails to start', { timeout: 30_000 }, async () => {
  const cwd = makeWorkspace();
  writeFileSync(join(cwd, 'packages', 'b', 'affected-node-test.config.json'), JSON.stringify({
    setupFiles: ['test/missing-setup.mjs'],
  }));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [cli, 'watch', '--concurrency', '1'], {
    cwd,
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    const result = await closed;
    assert.equal(result.code, 1, `${stdout}\n${stderr}`);
    assert.match(stderr, /packages\/b.*setupFiles pattern matched no files/s);
  } finally {
    if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
    await closed;
    rmSync(cwd, { recursive: true, force: true });
  }
});
