/**
 * Core type definitions for the A-MEM DSH memory plugin.
 *
 * Based on the A-MEM paper (NeurIPS 2025):
 * "A-MEM: Agentic Memory for LLM Agents"
 * Xu, Liang, Mei, Gao, Tan, Zhang (2025)
 * https://arxiv.org/abs/2502.12110
 */
export interface MemoryNote {
    id: string;
    content: string;
    context: string;
    keywords: string[];
    tags: string[];
    links: string[];
    createdAt: number;
    updatedAt: number;
    evolutionHistory: EvolutionEvent[];
    conversationId?: string;
    sessionId?: string;
}
export interface EvolutionEvent {
    timestamp: number;
    type: 'created' | 'linked' | 'tag-updated' | 'context-updated' | 'merged';
    reason: string;
    affectedNotes?: string[];
}
export interface MemoryAnalysis {
    keywords: string[];
    context: string;
    tags: string[];
}
export type EvolutionDecision = 'NO_EVOLUTION' | 'STRENGTHEN' | 'UPDATE_NEIGHBOR' | 'STRENGTHEN_AND_UPDATE';
export interface EvolutionResult {
    decision: EvolutionDecision;
    reason: string;
    newLinks?: string[];
    updatedTags?: string[];
    updatedNeighbors?: Array<{
        id: string;
        context: string;
        tags: string[];
    }>;
}
export interface RetrievalResult {
    note: MemoryNote;
    score: number;
}
export interface PluginConfig {
    storageDir: string;
    retrievalK: number;
    hybridAlpha: number;
    enableEvolution: boolean;
    enableAutoConsolidation: boolean;
    enableAutoCapture: boolean;
    enablePromptInjection: boolean;
    memoryScope: 'global' | 'session';
    maxLinksPerNote: number;
    maxMemoryChars: number;
    promptMaxChars: number;
    flushIntervalMs: number;
    embeddingModel: string;
    llmModel: string;
}
//# sourceMappingURL=types.d.ts.map