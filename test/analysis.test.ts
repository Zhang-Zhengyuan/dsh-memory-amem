/**
 * Basic sanity tests for the parsing helpers. Run with:
 *   node --import tsx --test test/analysis.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisService } from '../src/analysis.js';

const stubLLM = (response: string) => async () => response;

test('parses JSON response', async () => {
  const llm = stubLLM('```json\n{"keywords": ["k1", "k2"], "context": "ctx", "tags": ["t1"]}\n```');
  const svc = new AnalysisService(llm as any);
  const result = await svc.analyze('hello world');
  assert.deepEqual(result.keywords, ['k1', 'k2']);
  assert.equal(result.context, 'ctx');
  assert.deepEqual(result.tags, ['t1']);
});

test('falls back to section-marker parsing', async () => {
  const llm = stubLLM('KEYWORDS: alpha, beta, gamma\nCONTEXT: A short summary.\nTAGS: tag1, tag2');
  const svc = new AnalysisService(llm as any);
  const result = await svc.analyze('hello world');
  assert.deepEqual(result.keywords, ['alpha', 'beta', 'gamma']);
  assert.equal(result.context, 'A short summary.');
  assert.deepEqual(result.tags, ['tag1', 'tag2']);
});

test('recovers from empty keywords via heuristic', async () => {
  const llm = stubLLM('CONTEXT: only context\nTAGS:');
  const svc = new AnalysisService(llm as any);
  const result = await svc.analyze('The quick brown fox jumps over the lazy dog. Alpha Beta.');
  assert.ok(result.keywords.length > 0, 'heuristic keywords should kick in');
  assert.equal(result.context, 'only context');
});

test('fallback analysis retains useful Chinese keywords', async () => {
  const svc = new AnalysisService(stubLLM(''));
  const result = await svc.analyze('用户偏好使用 SQLite 数据库，并希望保留长期记忆。');
  assert.ok(result.keywords.some((keyword) => keyword.includes('数据库') || keyword.includes('长期记忆')));
  assert.ok(result.context.includes('SQLite'));
});
