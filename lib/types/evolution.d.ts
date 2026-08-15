/**
 * EvolutionService — prompt + parser for the evolution decision step.
 *
 * Mirrors A-MEM's evolution_controller:
 *   prompt:     should the new memory evolve? Strengthen / update neighbors?
 *   parser:     JSON-first / section-marker fallback, with heuristic
 *               JSON key normalization (should_evolve → decision).
 */
import type { EvolutionResult, MemoryAnalysis, MemoryNote } from './types.js';
import type { LLMGenerate } from './analysis.js';
export interface EvolutionInput {
    content: string;
    analysis: MemoryAnalysis;
    neighbors: MemoryNote[];
}
export declare class EvolutionService {
    private llm;
    constructor(llm: LLMGenerate);
    decide(input: EvolutionInput): Promise<EvolutionResult>;
    private renderNeighbors;
}
//# sourceMappingURL=evolution.d.ts.map