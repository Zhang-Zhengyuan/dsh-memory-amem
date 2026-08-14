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
