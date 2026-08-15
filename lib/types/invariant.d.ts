/**
 * Public invariants of dsh-tool-memory-amem — pure-data exports that
 * other plugins may safely import without pulling in the engine.
 *
 * Mirrors the `./invariant` export path of every official dsh plugin
 * (e.g. @deepseek-ai/dsh-tool-todo, @linxin666/dsh-client-ui-task-board).
 */
export { name, version } from './index.ts';
/** Plugin config keys accepted by the loader. Stable contract surface. */
export declare const CONFIG_KEYS: readonly ["storageDir", "retrievalK", "hybridAlpha", "enableEvolution", "enableAutoConsolidation", "enableAutoCapture", "enablePromptInjection", "memoryScope", "maxLinksPerNote", "maxMemoryChars", "promptMaxChars", "flushIntervalMs", "embeddingModel", "llmModel"];
export type ConfigKey = (typeof CONFIG_KEYS)[number];
/** Default values for every config key — single source of truth for `apply`. */
export declare const CONFIG_DEFAULTS: {
    readonly storageDir: "~/.dsh/memory-amem";
    readonly retrievalK: 10;
    readonly hybridAlpha: 0.5;
    readonly enableEvolution: true;
    readonly enableAutoConsolidation: true;
    readonly enableAutoCapture: true;
    readonly enablePromptInjection: true;
    readonly memoryScope: "global";
    readonly maxLinksPerNote: 5;
    readonly maxMemoryChars: 12000;
    readonly promptMaxChars: 4000;
    readonly flushIntervalMs: 5000;
    readonly embeddingModel: "tfidf-lite";
    readonly llmModel: "auto";
};
/** Tool names this plugin registers with `ctx.tools.register`. */
export declare const TOOL_NAMES: readonly ["memory_search", "memory_add", "memory_recent", "memory_stats"];
export type ToolName = (typeof TOOL_NAMES)[number];
/** Storage layout version — bump when notes/*.json schema changes. */
export declare const STORAGE_FORMAT_VERSION = 1;
/** Service key for `ctx.provide('memoryAmem', ...)`. */
export declare const SERVICE_KEY = "memoryAmem";
//# sourceMappingURL=invariant.d.ts.map