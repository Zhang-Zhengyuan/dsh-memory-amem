/**
 * AnalysisService — prompt + parser for "analyze new content".
 *
 * Mirrors the A-MEM paper's analyze_content step:
 *   keywords[], context string, tags[]
 *
 * The prompt is taken from the A-MEM robust-prompts file so that
 * any LLM backend works (no JSON-schema dependency). The parser
 * is a JSON-first / section-marker fallback, identical to the
 * Python reference implementation.
 */
import type { MemoryAnalysis } from './types.js';
export type LLMGenerate = (prompt: string, opts?: {
    temperature?: number;
    json?: boolean;
}) => Promise<string>;
export declare class AnalysisService {
    private llm;
    constructor(llm: LLMGenerate);
    analyze(content: string): Promise<MemoryAnalysis>;
}
//# sourceMappingURL=analysis.d.ts.map