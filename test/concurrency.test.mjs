import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConcurrency } from '../src/concurrency.mjs';

test('percentage concurrency floors deterministically with a minimum of one', () => {
  assert.equal(parseConcurrency('50%', 8), 4);
  assert.equal(parseConcurrency('33%', 8), 2);
  assert.equal(parseConcurrency('12.5%', 8), 1);
  assert.equal(parseConcurrency('1%', 2), 1);
  assert.equal(parseConcurrency('100%', 8), 8);
  assert.equal(parseConcurrency('3', 8), 3);
});

test('percentage concurrency rejects zero, over-100, and malformed values', () => {
  const message = '--concurrency must be a positive integer or a percentage greater than 0% and at most 100%.';
  for (const value of ['0', '-1', '0%', '100.1%', '50.0.0%', '%', 'half']) {
    assert.throws(() => parseConcurrency(value, 8), { message });
  }
});
