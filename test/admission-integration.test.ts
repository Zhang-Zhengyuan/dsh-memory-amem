import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgenticMemoryEngine } from '../src/memory.js';
import { resolveConfig } from '../src/config.js';
import { AdmissionRejectedError } from '../src/admission.js';

const fallbackLlm = { available: false, generate: async () => '' };

async function makeEngine(overrides: Parameters<typeof resolveConfig>[0] = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-amem-admit-'));
  const config = resolveConfig({ storageDir: dir, flushIntervalMs: 60_000, ...overrides });
  const engine = new AgenticMemoryEngine({ llm: fallbackLlm, config });
  await engine.init();
  return { engine, dir };
}

test('engine: ephemeral greeting is blocked by admission and never reaches analysis', async () => {
  const { engine, dir } = await makeEngine({ admission: { enabled: true, minLength: 8, maxLength: 2_000, sensitivePatterns: [], ephemeralPatterns: [], keepPatterns: [], poisonPatterns: [], semanticDedupThreshold: 0.85, semanticDedupMinOverlap: 0.4, enableLlmReview: false } });
  try {
    await assert.rejects(
      engine.add('hi', { source: 'auto_capture' }),
      (err: unknown) => err instanceof AdmissionRejectedError,
    );
    assert.equal(engine.stats().total, 0);
    // diagnostics are recorded even on rejection
    const log = engine.dumpAdmissions();
    assert.equal(log.length, 1);
    assert.equal(log[0].decision.kind, 'soft_skip');
    assert.equal(log[0].context.source, 'auto_capture');
  } finally {
    await engine.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('engine: bearer token never becomes a note and admission history records the block', async () => {
  const { engine, dir } = await makeEngine();
  try {
    const token = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
    await assert.rejects(engine.add(`paste this: ${token}`, { source: 'tool_call' }), AdmissionRejectedError);
    assert.equal(engine.stats().total, 0);
    const log = engine.dumpAdmissions();
    const last = log.at(-1);
    assert.ok(last, 'decision must be recorded');
    assert.equal(last!.decision.kind, 'hard_block');
    assert.equal(last!.decision.matchedRule, 'sensitive.bearer');
    assert.equal(last!.context.source, 'tool_call');
  } finally {
    await engine.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('engine: explicit decision passes admission and lands as a real note', async () => {
  const { engine, dir } = await makeEngine();
  try {
    const text = "we've decided to use vitest for unit tests across the repository";
    const note = await engine.add(text, { sessionId: 's1', source: 'auto_capture' });
    assert.ok(note.id);
    assert.equal(engine.stats().total, 1);
    const log = engine.dumpAdmissions();
    const last = log.at(-1);
    assert.ok(last, 'decision must be recorded');
    assert.equal(last!.decision.kind, 'hard_keep');
  } finally {
    await engine.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('engine: admission history is bounded to the last 200 decisions', async () => {
  const { engine, dir } = await makeEngine();
  try {
    // 250 rejection attempts so the ring buffer must evict.
    for (let i = 0; i < 250; i++) {
      await engine.add('hi', { source: 'auto_capture' }).catch(() => undefined);
    }
    const log = engine.dumpAdmissions();
    assert.equal(log.length, 200, 'history must cap at 200');
  } finally {
    await engine.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('engine: admission disabled falls back to "store everything" semantics', async () => {
  const { engine, dir } = await makeEngine({
    admission: { enabled: false, minLength: 8, maxLength: 2_000, sensitivePatterns: [], ephemeralPatterns: [], keepPatterns: [], poisonPatterns: [], semanticDedupThreshold: 0.85, semanticDedupMinOverlap: 0.4, enableLlmReview: false },
  });
  try {
    // even "hi" should now be stored because policy is disabled.
    await engine.add('hi', { source: 'auto_capture' });
    assert.equal(engine.stats().total, 1);
    const log = engine.dumpAdmissions();
    const last = log.at(-1);
    assert.ok(last, 'decision must be recorded');
    assert.equal(last!.decision.matchedRule, 'system.disabled');
  } finally {
    await engine.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('engine: oversized user-style message is blocked without paying LLM analysis cost', async () => {
  // Track LLM call count to verify admission short-circuits before analysis.
  let llmCalls = 0;
  const llm = { available: true, generate: async () => { llmCalls++; return ''; } };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-amem-admit-ovr-'));
  try {
    const config = resolveConfig({
      storageDir: dir,
      admission: { enabled: true, minLength: 8, maxLength: 64, sensitivePatterns: [], ephemeralPatterns: [], keepPatterns: [], poisonPatterns: [], semanticDedupThreshold: 0.85, semanticDedupMinOverlap: 0.4, enableLlmReview: false },
    });
    const engine = new AgenticMemoryEngine({ llm, config });
    await engine.init();
    const longText = 'x'.repeat(200);
    await assert.rejects(engine.add(longText, { source: 'auto_capture' }), AdmissionRejectedError);
    assert.equal(llmCalls, 0, 'rejected admission must not invoke analysis');
    assert.equal(engine.stats().total, 0);
    await engine.dispose();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('engine: user-supplied ephemeral pattern takes precedence over default uncertain', async () => {
  const { engine, dir } = await makeEngine({
    admission: { enabled: true, minLength: 8, maxLength: 2_000, sensitivePatterns: [], ephemeralPatterns: ['\\[scratch\\]'], keepPatterns: [], poisonPatterns: [], semanticDedupThreshold: 0.85, semanticDedupMinOverlap: 0.4, enableLlmReview: false },
  });
  try {
    const text = '[scratch] this is just me typing out my train of thought about the new shape of the dashboard';
    await assert.rejects(engine.add(text, { source: 'auto_capture' }), AdmissionRejectedError);
    const log = engine.dumpAdmissions().at(-1);
    assert.ok(log, 'decision must be recorded');
    assert.equal(log!.decision.matchedRule, 'user.ephemeral');
  } finally {
    await engine.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('engine: rule snapshot exposes built-ins and user patterns by id', async () => {
  const { engine, dir } = await makeEngine({
    admission: { enabled: true, minLength: 8, maxLength: 2_000, sensitivePatterns: ['foo'], ephemeralPatterns: [], keepPatterns: [], poisonPatterns: [], semanticDedupThreshold: 0.85, semanticDedupMinOverlap: 0.4, enableLlmReview: false },
  });
  try {
    const rules = engine.admissionRuleSnapshot();
    assert.ok(rules.some((r) => r.id === 'sensitive.bearer'));
    assert.ok(rules.some((r) => r.id === 'keep.explicit-decision'));
    assert.ok(rules.some((r) => r.id === 'user.sensitive.0'));
  } finally {
    await engine.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('config: invalid admission regex is rejected at config time', () => {
  assert.throws(() => resolveConfig({
    admission: {
      enabled: true,
      minLength: 8,
      maxLength: 2_000,
      sensitivePatterns: ['('],  // unbalanced group
      ephemeralPatterns: [],
      keepPatterns: [],
      poisonPatterns: [],
      semanticDedupThreshold: 0.85,
      semanticDedupMinOverlap: 0.4,
      enableLlmReview: false,
    },
  } as never), /admission pattern is not a valid regex/);
});

test('config: minLength >= maxLength is rejected', () => {
  assert.throws(() => resolveConfig({
    admission: {
      enabled: true,
      minLength: 10,
      maxLength: 10,
      sensitivePatterns: [],
      ephemeralPatterns: [],
      keepPatterns: [],
      poisonPatterns: [],
      semanticDedupThreshold: 0.85,
      semanticDedupMinOverlap: 0.4,
      enableLlmReview: false,
    },
  } as never), /admission\.minLength/);
});
