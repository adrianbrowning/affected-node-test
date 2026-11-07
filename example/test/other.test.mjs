import test from 'node:test';
import assert from 'node:assert/strict';
import { shout } from '../src/other.mjs';
test('unrelated module', () => assert.equal(shout('hi'), 'HI'));
