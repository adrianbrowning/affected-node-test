import test from 'node:test';
import assert from 'node:assert/strict';
import { totalLabel } from '../src/format.mjs';
test('indirect math dependency', () => assert.equal(totalLabel(1, 2), 'Total: 3'));
