import assert from 'node:assert/strict';
import test from 'node:test';

import { isRepositoryPath, normalizeRepositoryPath } from '../src/repository-path.ts';

test('repository paths normalize Windows separators before portable validation', () => {
  assert.equal(normalizeRepositoryPath('test\\nested\\value.test.mjs'), 'test/nested/value.test.mjs');
  assert.equal(isRepositoryPath(normalizeRepositoryPath('test\\nested\\value.test.mjs')), true);
  assert.equal(isRepositoryPath('test\\nested\\value.test.mjs'), false);
  assert.equal(isRepositoryPath('../outside.mjs'), false);
  assert.equal(isRepositoryPath('C:\\outside.mjs'), false);
});
