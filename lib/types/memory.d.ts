/**
 * A-MEM cognitive memory engine.
 *
 * Storage layout: one JSON file per note under storageDir/notes/<id>.json,
 * plus an index.json containing note metadata. Writes are serialized and
 * replaced atomically so an interval flush cannot overwrite a newer change.
 */
import type { MemoryNote, RetrievalResult, PluginConfig } from './types.js';
export interface EngineDeps {
    llm: {
        generate: (prompt: string, opts?: {
            temperature?: number;
            json?: boolean;
        }) => Promise<string>;
        readonly available?: boolean;
    };
    config: PluginConfig;
    console?: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
}
export interface MemoryScopeOptions {
    conversationId?: string;
    sessionId?: string;
}
export declare class AgenticMemoryEngine {
    private notes;
    private retriever;
    private analysis;
    private evolution;
    private storageDir;
    private config;
    private llm;
    private log;
    private revision;
    private persistedRevision;
    private activeFlush;
    private flushTimer;
    private initPromise;
    private initialized;
    private disposed;
    constructor(deps: EngineDeps);
    init(): Promise<void>;
    private initialize;
    dispose(): Promise<void>;
    add(content: string, opts?: MemoryScopeOptions): Promise<MemoryNote>;
    search(query: string, k?: number, opts?: MemoryScopeOptions): RetrievalResult[];
    all(opts?: MemoryScopeOptions): MemoryNote[];
    topKForPrompt(query: string, k?: number, opts?: MemoryScopeOptions): MemoryNote[];
    stats(opts?: MemoryScopeOptions): {
        total: number;
        withLinks: number;
        avgLinks: number;
        oldest: number;
        newest: number;
    };
    private findExactDuplicate;
    private matchesScope;
    private documentText;
    private retrieveNeighbors;
    private applyEvolution;
    private rebuildRetriever;
    private loadFromDisk;
    private markDirty;
    private scheduleFlush;
    flush(): Promise<void>;
    private writeSnapshot;
}
//# sourceMappingURL=memory.d.ts.map