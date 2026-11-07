import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { createOutputBuffer } from '../src/output-buffer.mjs';

function capture() {
  let value = '';
  return {
    destination: new Writable({ write(chunk, _encoding, callback) { value += chunk; callback(); } }),
    value: () => value,
  };
}

test('small worker output stays in memory and replays exactly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'output-buffer-test-'));
  try {
    const output = createOutputBuffer({ directory, name: 'stdout', threshold: 16 });
    output.append('small output');
    assert.deepEqual(readdirSync(directory), []);
    const captured = capture();
    await output.writeTo(captured.destination);
    assert.equal(captured.value(), 'small output');
    output.cleanup();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('large worker output spills securely, streams exactly, and cleans up', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'output-buffer-test-'));
  try {
    const output = createOutputBuffer({ directory, name: 'stderr', threshold: 8 });
    output.append('1234');
    output.append('56789');
    assert.deepEqual(readdirSync(directory), ['stderr.log']);
    assert.equal(statSync(join(directory, 'stderr.log')).mode & 0o777, 0o600);
    const captured = capture();
    await output.writeTo(captured.destination);
    assert.equal(captured.value(), '123456789');
    output.cleanup();
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
