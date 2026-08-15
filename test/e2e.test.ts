/**
 * End-to-end smoke test for the AgenticMemoryEngine with a stub LLM.
 *
 * Run with:
 *   node --import tsx --test test/e2e.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgenticMemoryEngine } from '../src/memory.js';
import { resolveConfig } from '../src/config.js';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

// A programmable LLM stub — returns canned responses in order.
// Sequence:
//   1. analyze_content for note A
//   2. analyze_content for note B
//   3. decide_evolution for note B  (looking at A as neighbor)
//   4. strengthen_details for note B
//   5. analyze_content for note C (no relevant neighbors, so evolution skips)
function makeStubLLM() {
  const responses = [
    // 1. analyze A
    'KEYWORDS: cooking, pasta, italian\nCONTEXT: User mentioned cooking italian pasta.\nTAGS: cooking, italian, food',
    // 2. analyze B
    'KEYWORDS: cooking, pasta, recipe\nCONTEXT: User asked for a pasta recipe.\nTAGS: cooking, food, recipe',
    // 3. decide B
    'DECISION: STRENGTHEN\nREASON: B is closely related to A',
    // 4. strengthen B
    'CONNECTIONS: 0\nTAGS: cooking, recipe, italian',
    // 5. analyze C
    'KEYWORDS: machine-learning, agent, memory\nCONTEXT: User mentioned working on agent memory.\nTAGS: ml, agents, research',
  ];
  let i = 0;
  return async () => {
    const r = responses[i] ?? 'DECISION: NO_EVOLUTION\nREASON: default';
    i++;
    return r;
  };
}

function tmpDir(): string {
  return path.join(os.tmpdir(), `dsh-amem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

async function cleanup(dir: string) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

test('end-to-end: three notes, evolution links B to A', async () => {
  const dir = tmpDir();
  const config = resolveConfig({
    storageDir: dir,
    retrievalK: 5,
    hybridAlpha: 0.5,
    enableEvolution: true,
    enableAutoConsolidation: true,
    maxLinksPerNote: 5,
    embeddingModel: 'tfidf-lite',
    llmModel: 'stub',
  });
  const engine = new AgenticMemoryEngine({
    llm: { generate: makeStubLLM(), available: true },
    config,
  });

  await engine.init();

  try {
    const a = await engine.add('I love cooking italian pasta');
    const b = await engine.add('Could you share a pasta recipe?');
    const c = await engine.add('Working on agent memory research');

    assert.ok(a.id, 'note A has id');
    assert.ok(b.id, 'note B has id');
    assert.ok(c.id, 'note C has id');

    // B should have at least one link (the stub returns CONNECTIONS: 0 = A)
    assert.ok(b.links.length >= 1, `note B should have at least one link, got ${b.links.length}`);
    assert.equal(b.links[0], a.id, 'note B should link to note A');

    // Search should find B and A together
    const pastaResults = engine.search('pasta cooking', 5);
    assert.ok(pastaResults.length >= 1, 'should find at least one pasta-related note');
    const ids = new Set(pastaResults.map((r) => r.note.id));
    assert.ok(ids.has(a.id) || ids.has(b.id), 'either A or B should be retrieved');

    // Stats should reflect all three
    const stats = engine.stats();
    assert.equal(stats.total, 3);
    assert.ok(stats.withLinks >= 1, 'at least one note has links');

    await engine.flush();
    // After flush, the notes dir should contain JSON files
    const files = await fs.readdir(path.join(dir, 'notes'));
    assert.ok(files.length === 3, `should have 3 note files, got ${files.length}`);
  } finally {
    await engine.dispose();
    await cleanup(dir);
  }
});
