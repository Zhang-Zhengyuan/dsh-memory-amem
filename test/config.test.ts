import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.js';

test('config applies safe defaults and rejects out-of-range values', () => {
  const config = resolveConfig();
  assert.equal(config.retrievalK, 10);
  assert.equal(config.memoryScope, 'global');
  assert.throws(() => resolveConfig({ hybridAlpha: 2 }), /hybridAlpha/);
  assert.throws(() => resolveConfig({ retrievalK: -1 }), /retrievalK/);
  assert.throws(() => resolveConfig({ flushIntervalMs: 0 }), /flushIntervalMs/);
  assert.throws(() => resolveConfig({ memoryScope: 'workspace' as never }), /memoryScope/);
  assert.throws(() => resolveConfig({ embeddingModel: 'not-implemented' }), /embeddingModel/);
});
