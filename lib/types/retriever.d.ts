/**
 * HybridRetriever — BM25 + semantic cosine, Node-side.
 *
 * For semantic embeddings we use a deterministic lightweight
 * embedding (term-frequency + IDF) so the plugin works offline
 * without any model download. A-MEM's authors note that the specific
 * retriever is interchangeable; this implementation matches the
 * paper's alpha-weighted hybrid scoring while keeping the plugin
 * self-contained.
 *
 * If a real sentence-transformer model is available via the
 * `transformers` runtime and the user opts in via config, the
 * loader can swap it in via the DshRetrieverAdapter (see index.ts).
 */
import type { MemoryNote } from './types.js';
export interface RetrieverOptions {
    alpha: number;
    modelName?: string;
}
export interface ScoredIndex {
    index: number;
    score: number;
}
export declare class HybridRetriever {
    private alpha;
    private notes;
    private bm25;
    constructor(opts: RetrieverOptions);
    addDocuments(documents: string[]): void;
    addDocument(document: string): void;
    registerNote(note: MemoryNote): void;
    noteAt(index: number): MemoryNote | undefined;
    size(): number;
    rebuild(notes: MemoryNote[]): void;
    retrieve(query: string, k: number): number[];
    retrieveScored(query: string, k: number): ScoredIndex[];
    private semanticScore;
    private documentText;
}
//# sourceMappingURL=retriever.d.ts.map