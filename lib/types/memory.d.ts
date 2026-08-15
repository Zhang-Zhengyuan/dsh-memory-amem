/**
 * A-MEM cognitive memory engine.
 *
 * Implements the A-MEM pipeline (NeurIPS 2025):
 *  1. analyze_content      - LLM extracts keywords, context, tags
 *  2. retrieve_neighbors   - hybrid BM25 + semantic top-k
 *  3. decide_evolution     - LLM decides whether to evolve
 *  4. process_evolution    - applies STRENGTHEN / UPDATE_NEIGHBOR
 *  5. persist_link         - writes note+links to storage
 *
 * Storage layout: one JSON file per note under storageDir/notes/<id>.json,
 * plus an index.json containing the current note IDs and embedding refs.
 */
import type { MemoryNote, RetrievalResult, PluginConfig } from './types.js';
export interface EngineDeps {
    llm: {
        generate: (prompt: string, opts?: {
            temperature?: number;
            json?: boolean;
        }) => Promise<string>;
    };
    config: PluginConfig;
    console?: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
}
export declare class AgenticMemoryEngine {
    private notes;
    private retriever;
    private analysis;
    private evolution;
    private storageDir;
    private config;
    private log;
    private dirty;
    private flushTimer;
    constructor(deps: EngineDeps);
    init(): Promise<void>;
    dispose(): Promise<void>;
    /**
     * Main entry — accepts a piece of content (e.g. a user message or
     * a chunk of sub-agent reasoning) and produces a structured note
     * connected to historical memories.
     */
    add(content: string, opts?: {
        conversationId?: string;
        sessionId?: string;
    }): Promise<MemoryNote>;
    /**
     * Retrieve memories relevant to a query (the current user message
     * or agent context).
     */
    search(query: string, k?: number): RetrievalResult[];
    /** Get all notes — used by the prompt injection layer. */
    all(): MemoryNote[];
    /** Get the most relevant notes for the system prompt. */
    topKForPrompt(query: string, k?: number): MemoryNote[];
    stats(): {
        total: number;
        withLinks: number;
        avgLinks: number;
        oldest: number;
        newest: number;
    };
    /** ----- internal helpers ----- */
    private documentText;
    private retrieveNeighbors;
    private applyEvolution;
    private loadFromDisk;
    private markDirty;
    private scheduleFlush;
    flush(): Promise<void>;
}
//# sourceMappingURL=memory.d.ts.map