/**
 * Smoke test for the HybridRetriever. No LLM required.
 *
 * Run with:
 *   node --import tsx --test test/retriever.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HybridRetriever } from '../src/retriever.js';
import type { MemoryNote } from '../src/types.js';

const fakeNote = (id: string, text: string, keywords: string[]): MemoryNote => ({
  id,
  content: text,
  context: text.slice(0, 80),
  keywords,
  tags: [],
  links: [],
  createdAt: 0,
  updatedAt: 0,
  evolutionHistory: [],
});

test('returns the most relevant note for a query', () => {
  const retriever = new HybridRetriever({ alpha: 0.5 });
  const notes = [
    fakeNote('a', 'apple pie recipe', ['apple', 'pie', 'recipe']),
    fakeNote('b', 'banana smoothie recipe', ['banana', 'smoothie', 'recipe']),
    fakeNote('c', 'car engine repair', ['car', 'engine', 'repair']),
  ];
  for (const n of notes) {
    retriever.registerNote(n);
    retriever.addDocument([n.content, n.context, n.keywords.join(' '), n.tags.join(' ')].join(' ').toLowerCase());
  }
  const result = retriever.retrieve('apple dessert', 1);
  assert.equal(result.length, 1);
  assert.equal(notes[result[0]].id, 'a');
});

test('handles empty corpus without throwing', () => {
  const retriever = new HybridRetriever({ alpha: 0.5 });
  assert.deepEqual(retriever.retrieve('anything', 5), []);
});

test('retrieves Chinese notes and drops zero-score matches', () => {
  const retriever = new HybridRetriever({ alpha: 0.5 });
  const notes = [
    fakeNote('db', '用户偏好使用 SQLite 数据库', ['SQLite', '数据库']),
    fakeNote('food', '用户喜欢意大利面食谱', ['意大利面', '食谱']),
  ];
  retriever.rebuild(notes);

  const database = retriever.retrieveScored('数据库偏好', 5);
  assert.equal(database.length, 1);
  assert.equal(notes[database[0].index].id, 'db');
  assert.ok(database[0].score > 0);
  assert.deepEqual(retriever.retrieve('苹果香蕉', 5), []);
});

test('alpha endpoints preserve BM25=0 and semantic=1 semantics', () => {
  const note = fakeNote('one', 'agent memory retrieval', ['agent', 'memory']);
  for (const alpha of [0, 1]) {
    const retriever = new HybridRetriever({ alpha });
    retriever.rebuild([note]);
    assert.deepEqual(retriever.retrieve('agent memory', 1), [0]);
  }
});
