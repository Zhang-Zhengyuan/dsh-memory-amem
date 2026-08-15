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
import type { Context } from '@deepseek-ai/cordis';
import type { PluginConfig } from './types.ts';
export declare const name = "tool-memory-amem";
export declare const version = "0.2.0";
export declare const inject: string[];
export type AmemPluginConfig = Partial<PluginConfig>;
/**
 * Apply the host half. Receives the Cordis context and the loader-resolved
 * config (schema defaults already applied by the DSH loader).
 *
 * Mirrors the apply() shape of every official DSH plugin
 * (see packages/todo/tool-todo, packages/web/tool-web).
 */
export declare function apply(rawCtx: Context, options?: AmemPluginConfig): void;
declare const _default: {
    name: string;
    version: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
//# sourceMappingURL=index.d.ts.map