import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgenticMemoryEngine } from '../src/memory.js';
import { resolveConfig } from '../src/config.js';

const fallbackLlm = { available: false, generate: async () => '' };

test('serialized flushes persist every note and corrupt files do not block loading', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-amem-persist-'));
  const warnings: string[] = [];
  const config = resolveConfig({ storageDir: dir, flushIntervalMs: 60_000 });
  const logger = { info: () => undefined, warn: (message: string) => warnings.push(message), error: () => undefined };

  try {
    const writer = new AgenticMemoryEngine({ llm: fallbackLlm, config, console: logger });
    await writer.init();
    await Promise.all(Array.from({ length: 12 }, (_, index) => writer.add(`并发持久化记录 ${index} 数据库`)));
    await Promise.all([writer.flush(), writer.flush(), writer.flush()]);
    await writer.dispose();

    await fs.writeFile(path.join(dir, 'notes', '000-corrupt.json'), '{not-json', 'utf8');
    const reader = new AgenticMemoryEngine({ llm: fallbackLlm, config, console: logger });
    await reader.init();
    assert.equal(reader.stats().total, 12);
    assert.ok(warnings.some((message) => message.includes('000-corrupt.json')));
    const files = await fs.readdir(path.join(dir, 'notes'));
    assert.equal(files.filter((file) => file.endsWith('.tmp')).length, 0);
    await reader.dispose();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('session scope prevents cross-session search and statistics leakage', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-amem-scope-'));
  const config = resolveConfig({ storageDir: dir, memoryScope: 'session', enableEvolution: false });
  const engine = new AgenticMemoryEngine({ llm: fallbackLlm, config });
  try {
    await engine.init();
    await engine.add('甲会话偏好 SQLite 数据库', { sessionId: 'a' });
    await engine.add('乙会话偏好 PostgreSQL 数据库', { sessionId: 'b' });
    assert.equal(engine.stats({ sessionId: 'a' }).total, 1);
    assert.equal(engine.search('PostgreSQL', 5, { sessionId: 'a' }).length, 0);
    assert.equal(engine.search('PostgreSQL', 5, { sessionId: 'b' }).length, 1);
  } finally {
    await engine.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
