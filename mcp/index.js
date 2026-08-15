/**
 * MCP server for dsh-memory-amem.
 *
 * Speaks JSON-RPC 2.0 over stdio. Exposes four tools that mirror the
 * native plugin's surface:
 *   memory_search, memory_add, memory_recent, memory_stats
 *
 * No external MCP SDK dependency: the protocol is small enough to
 * implement inline and keeping it zero-dep matches the plugin's
 * "self-contained" stance.
 *
 * Run with:
 *   node mcp/index.js
 *
 * The server requires the parent dsh-memory-amem package to be built
 * (so lib/memory.js exists). All A-MEM work happens in the engine.
 */

import { AgenticMemoryEngine } from '../lib/memory.js';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const STORAGE_DIR = process.env.DSH_MEMORY_AMEM_DIR || path.join(os.homedir(), '.dsh/memory-amem');

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

// LLM adapter: hits the DeepSeek Chat Completions endpoint over fetch.
const llm = {
  available: Boolean(DEEPSEEK_API_KEY),
  generate: async (prompt, opts = {}) => {
    if (!DEEPSEEK_API_KEY) return '';
    const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.DSH_MEMORY_AMEM_MODEL || 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: opts.temperature ?? 0.3,
        max_tokens: 1000,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM call failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  },
};

const log = {
  info: (msg) => process.stderr.write(`[dsh-memory-amem mcp] ${msg}\n`),
  warn: (msg) => process.stderr.write(`[dsh-memory-amem mcp] warn: ${msg}\n`),
  error: (msg) => process.stderr.write(`[dsh-memory-amem mcp] error: ${msg}\n`),
};

await fs.mkdir(STORAGE_DIR, { recursive: true });

const engine = new AgenticMemoryEngine({
  llm,
  config: {
    storageDir: STORAGE_DIR,
    retrievalK: 10,
    hybridAlpha: 0.5,
    enableEvolution: true,
    enableAutoConsolidation: true,
    enableAutoCapture: false,
    enablePromptInjection: false,
    memoryScope: 'global',
    maxLinksPerNote: 5,
    maxMemoryChars: 12_000,
    promptMaxChars: 4_000,
    flushIntervalMs: 5_000,
    embeddingModel: 'tfidf-lite',
    llmModel: 'auto',
  },
  console: log,
});
await engine.init();
log.info(`engine ready (storage=${STORAGE_DIR})`);

// ----- MCP JSON-RPC handlers -----

const TOOLS = [
  {
    name: 'memory_search',
    description:
      'Search long-term memory for relevant notes. Returns ranked notes with id, context, keywords, tags, and content snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The query — natural language or keywords.' },
        k: { type: 'integer', description: 'How many notes to return (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_add',
    description:
      'Manually add a note to long-term memory. Normally auto-captures user messages — only call this for derived facts.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The note content to remember.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_stats',
    description: 'Show memory statistics: total notes, average links, oldest and newest timestamps.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_recent',
    description: 'List the most recently added memory notes, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many to return (default 20).' },
      },
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'memory_search': {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new TypeError('query must be a non-empty string');
      const results = engine.search(args.query, boundedCount(args.k, 10));
      return {
        query: args.query,
        count: results.length,
        notes: results.map((r) => ({
          id: r.note.id,
          context: r.note.context,
          keywords: r.note.keywords,
          tags: r.note.tags,
          content: r.note.content.slice(0, 500),
          createdAt: r.note.createdAt,
          links: r.note.links.length,
          score: r.score,
        })),
      };
    }
    case 'memory_add': {
      if (typeof args.content !== 'string' || !args.content.trim()) throw new TypeError('content must be a non-empty string');
      const note = await engine.add(args.content);
      return {
        id: note.id,
        context: note.context,
        keywords: note.keywords,
        tags: note.tags,
      };
    }
    case 'memory_stats': {
      return engine.stats();
    }
    case 'memory_recent': {
      const notes = engine.all().slice(0, boundedCount(args.limit, 20));
      return {
        count: notes.length,
        notes: notes.map((n) => ({
          id: n.id,
          context: n.context,
          keywords: n.keywords,
          tags: n.tags,
          content: n.content.slice(0, 500),
          createdAt: n.createdAt,
          links: n.links.length,
        })),
      };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

const handlers = {
  initialize: (params) => ({
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'dsh-memory-amem', version: '0.2.0' },
  }),
  'tools/list': () => ({ tools: TOOLS }),
  'tools/call': async (params) => {
    const { name, arguments: args = {} } = params;
    try {
      const value = await callTool(name, args);
      return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
  'notifications/initialized': () => null,
  ping: () => ({}),
};

function reply(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function replyError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

// ----- stdio transport -----

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (err) {
    replyError(null, -32700, `parse error: ${err.message}`);
    return;
  }
  const { id, method, params } = request;
  const handler = handlers[method];
  if (!handler) {
    if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
    return;
  }
  Promise.resolve()
    .then(() => handler(params ?? {}))
    .then((result) => {
      if (id !== undefined) reply(id, result);
    })
    .catch((err) => {
      log.error(`${method}: ${err.message}`);
      if (id !== undefined) replyError(id, -32603, err.message);
    });
});

function boundedCount(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 100) : fallback;
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await engine.dispose();
  process.exit(0);
}

rl.once('close', shutdown);
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
