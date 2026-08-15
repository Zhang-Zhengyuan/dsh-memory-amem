/**
 * Public invariants of dsh-tool-memory-amem — pure-data exports that
 * other plugins may safely import without pulling in the engine.
 *
 * Mirrors the `./invariant` export path of every official dsh plugin
 * (e.g. @deepseek-ai/dsh-tool-todo, @linxin666/dsh-client-ui-task-board).
 */

export { name, version } from './index.ts'

/** Plugin config keys accepted by the loader. Stable contract surface. */
export const CONFIG_KEYS = [
  'storageDir',
  'retrievalK',
  'hybridAlpha',
  'enableEvolution',
  'enableAutoConsolidation',
  'maxLinksPerNote',
  'embeddingModel',
  'llmModel',
] as const

export type ConfigKey = (typeof CONFIG_KEYS)[number]

/** Default values for every config key — single source of truth for `apply`. */
export const CONFIG_DEFAULTS = {
  storageDir: '~/.dsh/memory-amem',
  retrievalK: 10,
  hybridAlpha: 0.5,
  enableEvolution: true,
  enableAutoConsolidation: true,
  maxLinksPerNote: 5,
  embeddingModel: 'tfidf-lite',
  llmModel: 'auto',
} as const satisfies Record<ConfigKey, unknown>

/** Tool names this plugin registers with `ctx.tools.register`. */
export const TOOL_NAMES = [
  'memory_search',
  'memory_add',
  'memory_recent',
  'memory_stats',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

/** Storage layout version — bump when notes/*.json schema changes. */
export const STORAGE_FORMAT_VERSION = 1

/** Service key for `ctx.provide('memoryAmem', ...)`. */
export const SERVICE_KEY = 'memoryAmem'
