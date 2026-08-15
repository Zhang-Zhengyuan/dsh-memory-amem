/**
 * dsh-tool-memory-amem — host loader entry for DeepSeek Harness.
 *
 * Hooks the A-MEM engine into DSH's session lifecycle:
 *   - after every user message:       run analyze + evolution, persist note
 *   - before every assistant turn:    inject relevant notes as a system-prompt
 *                                     section (order 200, tool-guidance band)
 *   - in the model context:           expose four `memory_*` tools
 *   - for other plugins:              expose `ctx.memoryAmem` service
 *
 * The plugin is intentionally side-effect minimal: when no memories exist
 * yet it injects nothing, and when the engine fails it logs and lets the
 * harness continue without memory.
 *
 * Install with:
 *   dsh plugin --profile web add link:<repo>
 * or after publishing to npm:
 *   dsh plugin --profile web add @yourname/dsh-tool-memory-amem
 *
 * The plugin declares both halves in package.json (`dsh.client`); the
 * browser half lives in src/client/index.ts and currently only reserves
 * the UI slot for a future memory panel.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AgenticMemoryEngine } from './memory.ts'
import type { PluginConfig, MemoryNote } from './types.ts'
import { CONFIG_DEFAULTS, SERVICE_KEY } from './invariant.ts'

export const name = 'tool-memory-amem'
export const version = '0.2.0'
export const inject = ['tools', 'systemPrompt', 'sessions', 'llm']

export type AmemPluginConfig = Partial<PluginConfig>

/**
 * Apply the host half. Receives the Cordis context and the loader-resolved
 * config (schema defaults already applied by the DSH loader).
 *
 * Mirrors the apply() shape of every official DSH plugin
 * (see packages/todo/tool-todo, packages/web/tool-web).
 */
export function apply(rawCtx: Context, options: AmemPluginConfig = {}): void {
  const ctx = rawCtx as DshContext
  const config: PluginConfig = { ...CONFIG_DEFAULTS, ...options }

  const log = {
    info: (msg: string) => ctx.logger?.info(`[dsh-tool-memory-amem] ${msg}`),
    warn: (msg: string) => ctx.logger?.warn(`[dsh-tool-memory-amem] ${msg}`),
    error: (msg: string) => ctx.logger?.error(`[dsh-tool-memory-amem] ${msg}`),
  }

  // Adapters over DSH services so the engine stays backend-agnostic
  // (re-usable from the Python eval harness and unit tests).
  const llm = makeLlmAdapter(ctx, log)
  const engine = new AgenticMemoryEngine({ llm, config, console: log })

  ctx.effect(async () => {
    await engine.init().catch((err) => log.error(`init failed: ${(err as Error).message}`))
    return () => {
      void engine.dispose().catch((err) => log.error(`dispose failed: ${(err as Error).message}`))
    }
  })

  // 1. System-prompt section: dynamic per turn, queries the user's current message.
  //    Order 200 puts the section in the tool-guidance band (task-board's SECTION_ORDER).
  if (ctx.systemPrompt) {
    ctx.systemPrompt.section({
      name: 'plugin:tool-memory-amem',
      order: 200,
      text: (assembleCtx: unknown) => {
        try {
          const query = lastUserMessage(assembleCtx) ?? ''
          if (!query) return ''
          const notes = engine.topKForPrompt(query, config.retrievalK)
          if (notes.length === 0) return ''
          return renderMemorySection(notes)
        } catch (err) {
          log.warn(`system-prompt inject failed: ${(err as Error).message}`)
          return ''
        }
      },
    })
  }

  // 2. Tools: the model (and user via UI) can search / inspect / manage memory.
  //    Tool definitions follow DSH's ToolDefinition shape — see packages/core/tools.
  //    We avoid the `@deepseek-ai/dsh-tools/defineTool` helper to stay
  //    zero-dep; the registered objects satisfy the same contract.
  const tools = ctx.tools
  if (tools) {
    tools.register(makeMemorySearchTool(engine, config))
    tools.register(makeMemoryAddTool(engine))
    tools.register(makeMemoryStatsTool(engine))
    tools.register(makeMemoryRecentTool(engine))
  }

  // 3. Listen to user messages and persist them as notes.
  //    session/event carries (session, event) where event.type discriminates
  //    message-producing turns from internal control events.
  ctx.on('session/event', (session: unknown, event: unknown) => {
    const ev = event as { type?: string; data?: unknown }
    if (ev?.type !== 'user/message') return
    const text = extractText(ev.data)
    if (!text || text.length < 4) return
    const sessionId = (session as { id?: string })?.id
    void engine.add(text, { sessionId, conversationId: sessionId })
      .catch((err) => log.warn(`add failed: ${(err as Error).message}`))
  })

  // 4. Expose the engine as a service so other plugins can consume it.
  ctx.provide(SERVICE_KEY, {
    add: (content: string) => engine.add(content),
    search: (query: string, k?: number) => engine.search(query, k),
    stats: () => engine.stats(),
    all: () => engine.all(),
    topKForPrompt: (query: string, k?: number) => engine.topKForPrompt(query, k),
  })
}

// ----- type shims -----

/**
 * Minimal structural shape for the bits of the Cordis context this plugin
 * uses. DSH augments `Context` with concrete services (`systemPrompt`,
 * `tools`, `sessions`, `llm`) via `declare module '@deepseek-ai/cordis'`
 * inside its monorepo; an out-of-tree consumer that pulls the public SDK
 * sees only the base shape, so we mirror what we need here. This is the
 * same trick used by every other out-of-tree dsh plugin (verified in
 * @linxin666/dsh-tool-describe-image and @linxin666/dsh-ssh).
 */
interface DshContext {
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  effect: (fn: () => (() => void) | void | Promise<void | (() => void)>) => void;
  on: (event: string, handler: (...args: unknown[]) => unknown) => void;
  provide: (key: string, value: unknown) => () => void;
  systemPrompt?: { section: (spec: { name: string; order: number; text: string | ((ctx: unknown) => string) }) => () => void };
  tools?: { register: (def: unknown) => () => void };
  llm?: {
    text?: (opts: { prompt: string; temperature?: number; maxTokens?: number }) => Promise<string>;
    generate?: (opts: { prompt: string; temperature?: number; maxTokens?: number }) => Promise<string | { text?: string }>;
  };
}

// ----- helpers -----

function makeLlmAdapter(
  ctx: DshContext,
  log: { error: (msg: string) => void; warn: (msg: string) => void; info: (msg: string) => void },
): { generate: (prompt: string, opts?: { temperature?: number; json?: boolean }) => Promise<string>; available: boolean } {
  const llm = ctx.llm;
  const textFn = llm?.text;
  const generateFn = llm?.generate;
  if (textFn) {
    return {
      available: true,
      generate: async (prompt: string, opts: { temperature?: number; json?: boolean } = {}) =>
        await textFn({ prompt, temperature: opts.temperature ?? 0.3, maxTokens: 1000 }),
    };
  }
  if (generateFn) {
    return {
      available: true,
      generate: async (prompt: string, opts: { temperature?: number; json?: boolean } = {}) => {
        const out = await generateFn({ prompt, temperature: opts.temperature ?? 0.3, maxTokens: 1000 });
        return typeof out === 'string' ? out : (out.text ?? '');
      },
    };
  }
  // Graceful degradation: no LLM plugin is mounted. Return a parseable
  // fallback that mirrors the input so the parser's section-marker fallback
  // in analysis.ts / evolution.ts extracts heuristic metadata from the raw
  // content. The note still persists — just without LLM-enriched keywords /
  // context / evolution. Log once so the user knows.
  log.warn('ctx.llm not available — using fallback analysis (keywords / context will be extracted from raw content)');
  return {
    available: false,
    generate: async (_prompt: string, _opts: { temperature?: number; json?: boolean } = {}) => {
      // analysis.ts: ANALYZE_PROMPT asks for KEYWORDS: / CONTEXT: / TAGS:.
      // We echo back a parseable stub; parseAnalysis()'s section-marker fallback
      // will call heuristicKeywords() / heuristicContext() on the original content.
      return `KEYWORDS: (no LLM — using fallback)\nCONTEXT: (no LLM — using fallback)\nTAGS: (no LLM — using fallback)`;
    },
  };
}

function extractText(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof (input as { content?: unknown }).content === 'string') {
    return (input as { content: string }).content;
  }
  const parts = (input as { parts?: Array<{ type: string; text?: string }> }).parts;
  if (Array.isArray(parts)) {
    return parts.filter((p) => p && p.type === 'text').map((p) => p.text ?? '').join('\n');
  }
  if (Array.isArray(input)) return input.map(extractText).join('\n');
  return '';
}

function lastUserMessage(assembleCtx: unknown): string | undefined {
  try {
    const ctxAny = assembleCtx as {
      surface?: { recentUserMessages?: Array<{ content?: unknown }> };
      systemPrompt?: { recentMessages?: Array<{ role?: string; content?: unknown }> };
    };
    const recent = ctxAny.surface?.recentUserMessages ?? ctxAny.systemPrompt?.recentMessages ?? [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i] as { content?: unknown };
      if (m?.content !== undefined) return extractText(m.content);
    }
  } catch {
    // ignore
  }
  return undefined;
}

function renderMemorySection(notes: MemoryNote[]): string {
  const blocks = notes
    .map((n, i) => {
      const tags = n.tags.length ? `[tags: ${n.tags.join(', ')}]` : '';
      const keywords = n.keywords.length ? `[keywords: ${n.keywords.join(', ')}]` : '';
      return `[memory ${i + 1}] ${n.context} ${tags} ${keywords}\n${n.content.slice(0, 300)}`;
    })
    .join('\n\n');
  return [
    '# Long-term Memory (A-MEM)',
    'The following are relevant notes retrieved from cross-session memory.',
    'Use them when answering questions about prior conversations, established user preferences, or facts the user has shared before.',
    '',
    blocks,
  ].join('\n');
}

// ----- JSON Schemas for tool outputs (lossless-JSON, validated by registry) -----
//
// DSH's `valueSchemaSpecToJsonSchema` (the runtime path for `output.schema`)
// walks the author-facing DSL and:
//   1. requires `type: 'object'` + `additionalProperties: true | false` at
//      the schema root;
//   2. accepts per-property `required: true` (and lifts them into a top-level
//      `required: [...]` array on the compiled schema). `required: false` is
//      rejected (`schema.properties.<name>.required must be true when
//      present`); mark an optional property by omitting `required`. See
//      code-mode.ts in dsh-tools for the same pattern and
//      zhu1090093659/dsh-web-ui/packages/dsh-tool-describe-image/src/
//      index.ts for the canonical reference (per-property `required: true`
//      on `text`, `model`, `image`, etc.).
//
// `parameterSchemaSpecToJsonSchema` (the runtime path for `parameters`)
// enforces the same rule: `required: true` lifts to top-level `required`,
// `required: false` is rejected, and the way to mark an optional parameter
// is to omit the `required` field. The describe-image plugin's `prompt`
// parameter (`{ type: 'string', description: '...' }`) is the reference.

function searchOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', required: true },
      count: { type: 'integer', required: true },
      notes: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            context: { type: 'string', required: true },
            keywords: { type: 'array', required: true, items: { type: 'string' } },
            tags: { type: 'array', required: true, items: { type: 'string' } },
            content: { type: 'string', required: true },
            createdAt: { type: 'integer', required: true },
            links: { type: 'integer', required: true },
          },
        },
      },
    },
  } as const satisfies import('@deepseek-ai/dsh-tools').ValueSchemaSpec;
}

function simpleNoteOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      context: { type: 'string', required: true },
      keywords: { type: 'array', required: true, items: { type: 'string' } },
      tags: { type: 'array', required: true, items: { type: 'string' } },
    },
  } as const satisfies import('@deepseek-ai/dsh-tools').ValueSchemaSpec;
}

function statsOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      total: { type: 'integer', required: true },
      withLinks: { type: 'integer', required: true },
      avgLinks: { type: 'number', required: true },
      oldest: { type: 'integer', required: true },
      newest: { type: 'integer', required: true },
    },
  } as const satisfies import('@deepseek-ai/dsh-tools').ValueSchemaSpec;
}

function recentOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      count: { type: 'integer', required: true },
      notes: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            context: { type: 'string', required: true },
            keywords: { type: 'array', required: true, items: { type: 'string' } },
            tags: { type: 'array', required: true, items: { type: 'string' } },
            content: { type: 'string', required: true },
            createdAt: { type: 'integer', required: true },
            links: { type: 'integer', required: true },
          },
        },
      },
    },
  } as const satisfies import('@deepseek-ai/dsh-tools').ValueSchemaSpec;
}

function formatSearchOutput(value: {
  query: string;
  count: number;
  notes: Array<{ id: string; context: string; keywords: string[]; tags: string[]; content: string }>;
}): string {
  if (value.count === 0) return `No memories found for "${value.query}".`;
  return [
    `Found ${value.count} memories for "${value.query}":`,
    ...value.notes.map((n, i) =>
      `${i + 1}. [${n.id.slice(0, 8)}] ${n.context}\n   tags: ${n.tags.join(', ')}\n   ${n.content}`,
    ),
  ].join('\n\n');
}

// ----- Tool factory functions -----

function makeMemorySearchTool(engine: AgenticMemoryEngine, config: PluginConfig) {
  return defineTool({
    name: 'memory_search',
    description:
      'Search long-term memory for relevant notes. Use before answering questions about previous conversations, user preferences, or established facts. Returns ranked notes with id, context, keywords, tags, and content snippets.',
    parameters: {
      query: { type: 'string', required: true, description: 'The query — natural language or keywords.' },
      // `k` is optional (defaults to `config.retrievalK`); omit
      // `required` to mark the field optional — the parameter DSL
      // rejects `required: false` (`parameters.k.required must be true
      // when present`); see describe-image's `prompt` field.
      k: { type: 'integer', description: 'How many notes to return (default 10).' },
    },
    output: { schema: searchOutputSchema(), render: (_args: unknown, value: unknown) => [{ type: 'text', text: formatSearchOutput(value as Parameters<typeof formatSearchOutput>[0]) }] },
    execute: async (args: { query: string; k?: number }) => {
      const results = engine.search(args.query, args.k ?? config.retrievalK);
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
        })),
      };
    },
    presentCall: (args: { query: string }) => ({ card: 'generic', title: `Memory search: ${args.query}`, kind: 'other', rawInput: args }),
  });
}

function makeMemoryAddTool(engine: AgenticMemoryEngine) {
  return defineTool({
    name: 'memory_add',
    description:
      'Manually add a note to long-term memory. The plugin normally auto-captures user messages — only call this when the model must remember something the user did not literally say (a derived preference, an inferred fact, etc.).',
    parameters: {
      content: { type: 'string', required: true, description: 'The note content to remember.' },
    },
    output: {
      schema: simpleNoteOutputSchema(),
      render: (_args: unknown, value: { id: string; tags: string[]; keywords: string[] }) => [{
        type: 'text',
        text: `Remembered note ${value.id.slice(0, 8)} (${value.tags.length} tags, ${value.keywords.length} keywords).`,
      }],
    },
    execute: async (args: { content: string }) => {
      const note = await engine.add(args.content);
      return { id: note.id, keywords: note.keywords, tags: note.tags, context: note.context };
    },
    presentCall: (args: { content: string }) => ({ card: 'generic', title: `Remember: ${args.content.slice(0, 40)}`, kind: 'other', rawInput: args }),
  });
}

function makeMemoryStatsTool(engine: AgenticMemoryEngine) {
  return defineTool({
    name: 'memory_stats',
    description: 'Show memory statistics: total notes, average links, oldest and newest timestamps.',
    parameters: {},
    output: {
      schema: statsOutputSchema(),
      render: (_args: unknown, value: { total: number; withLinks: number; avgLinks: number }) => [{
        type: 'text',
        text: `Memory has ${value.total} notes (${value.withLinks} with links, avg ${value.avgLinks.toFixed(1)} links/note).`,
      }],
    },
    execute: async () => engine.stats(),
    presentCall: () => ({ card: 'generic', title: 'Memory stats', kind: 'other', rawInput: {} }),
  });
}

function makeMemoryRecentTool(engine: AgenticMemoryEngine) {
  return defineTool({
    name: 'memory_recent',
    description: 'List the most recently added memory notes, newest first. Useful for "what have we talked about lately".',
    parameters: {
      // `limit` is optional (defaults to 20); see `memory_search.k`.
      limit: { type: 'integer', description: 'How many to return (default 20).' },
    },
    output: {
      schema: recentOutputSchema(),
      render: (_args: unknown, value: { notes: Array<{ id: string; context: string }> }) => [{
        type: 'text',
        text: value.notes.length === 0
          ? 'No memories yet.'
          : `${value.notes.length} most recent memories:\n` + value.notes.map((n, i) =>
              `${i + 1}. [${n.id.slice(0, 8)}] ${n.context}`
            ).join('\n'),
      }],
    },
    execute: async (args: { limit?: number }) => {
      const notes = engine.all().slice(0, args.limit ?? 20);
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
    },
    presentCall: (args: unknown) => ({ card: 'generic', title: 'Recent memories', kind: 'other', rawInput: args }),
  });
}

export default { name, version, inject, apply };
