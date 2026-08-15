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
import type { PluginConfig, MemoryNote } from './types.ts';
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
    logger?: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    effect: (fn: () => (() => void | Promise<void>) | void | Promise<void | (() => void | Promise<void>)>) => void;
    on: (event: string, handler: (...args: unknown[]) => unknown) => void;
    provide: (key: string, value: unknown) => () => void;
    systemPrompt?: {
        section: (spec: {
            name: string;
            order: number;
            text: string | ((ctx: unknown) => string);
        }) => () => void;
    };
    tools?: {
        register: (def: unknown) => () => void;
    };
    llm?: {
        text?: (opts: {
            prompt: string;
            temperature?: number;
            maxTokens?: number;
        }) => Promise<string>;
        generate?: (opts: {
            prompt: string;
            temperature?: number;
            maxTokens?: number;
        }) => Promise<string | {
            text?: string;
        }>;
        stream?: (opts: {
            provider: string;
            model: string;
            messages: Array<{
                id: string;
                role: 'user';
                content: Array<{
                    type: 'text';
                    text: string;
                }>;
                source: {
                    kind: 'plugin';
                    plugin: string;
                };
            }>;
            system?: string;
            temperature?: number;
            maxTokens?: number;
        }) => AsyncIterable<DshStreamChunk>;
        listProviders?: () => Array<{
            id: string;
            name: string;
        }>;
        listModels?: (provider: string) => Promise<Array<{
            provider: string;
            id: string;
            name: string;
        }>>;
    };
}
interface DshStreamChunk {
    type: string;
    text?: string;
    block?: {
        type: string;
        text?: string;
    };
    reason?: {
        kind: string;
        failure?: {
            message?: string;
        };
    };
}
export declare function makeLlmAdapter(ctx: DshContext, config: PluginConfig, log: {
    error: (msg: string) => void;
    warn: (msg: string) => void;
    info: (msg: string) => void;
}): {
    generate: (prompt: string, opts?: {
        temperature?: number;
        json?: boolean;
    }) => Promise<string>;
    available: boolean;
};
export declare function extractText(input: unknown, depth?: number): string;
export declare function lastUserMessage(assembleCtx: unknown): string | undefined;
export declare function renderMemorySection(notes: MemoryNote[], maxChars: number, scope: PluginConfig['memoryScope']): string;
declare const _default: {
    name: string;
    version: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
//# sourceMappingURL=index.d.ts.map