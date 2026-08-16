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
  /**
   * v0.3.0 — admission-origin trust score in [0, 1].
   *
   * Default semantics:
   *   - 0.9  — `tool_call` / `service` path, matched an explicit `hard_keep`
   *            rule (decision / preference / verified-fix).
   *   - 0.7  — `auto_capture` path, matched a `hard_keep` rule.
   *   - 0.6  — `tool_call` / `service` path, fell through to `uncertain`.
   *   - 0.5  — `auto_capture` path, fell through to `uncertain`.
   *
   * Always non-negative. A separate retrieval-time hook can re-rank by
   * `score * pow(trustScore, 2)` to demote low-trust entries without
   * dropping them; v0.3.0 ships the scoring and the helper but does not
   * wire the re-rank into the default top-K.
   */
  trustScore: number;
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

export type EvolutionDecision =
  | 'NO_EVOLUTION'
  | 'STRENGTHEN'
  | 'UPDATE_NEIGHBOR'
  | 'STRENGTHEN_AND_UPDATE';

export interface EvolutionResult {
  decision: EvolutionDecision;
  reason: string;
  newLinks?: string[];
  updatedTags?: string[];
  updatedNeighbors?: Array<{ id: string; context: string; tags: string[] }>;
}

export interface RetrievalResult {
  note: MemoryNote;
  score: number;
}

// ---------- Admission (v0.3.0) ----------

/** Where a candidate memory note originates. */
export type AdmissionSource = 'auto_capture' | 'tool_call' | 'service';

/**
 * Where the admission decision lives on the precedence ladder.
 *   - `hard_block` / `soft_skip` → memory must NOT be persisted.
 *   - `hard_keep` / `uncertain`  → memory proceeds to analysis.
 * `uncertain` is a "no rule matched" sentinel that v0.4.0 may upgrade to
 * an LLM-reviewed decision.
 */
export type AdmissionDecisionKind = 'hard_block' | 'soft_skip' | 'hard_keep' | 'uncertain';

export interface AdmissionDecision {
  kind: AdmissionDecisionKind;
  /** Human-readable explanation (used in logs and the future UI audit panel). */
  reason: string;
  /** Stable id of the rule that produced the decision, e.g. `sensitive.bearer`. */
  matchedRule: string;
}

export interface AdmissionContext {
  /** The candidate text after trim. */
  text: string;
  /** Optional session scope (matches `MemoryNote.sessionId`). */
  sessionId?: string;
  /** Optional source message id (used for auto-capture dedup). */
  messageId?: string;
  /** Which surface produced the candidate. */
  source: AdmissionSource;
  /** Optional turn index inside the session (small positive integers). */
  turnIndex?: number;
  /** True when the most recent message was already admitted. */
  hasRecentAdmission?: boolean;
}

export interface AdmissionRule {
  id: string;
  description: string;
  decision: AdmissionDecisionKind;
}

export interface AdmissionPolicyConfig {
  /** Master switch. When false the engine stores every candidate unchanged. */
  enabled: boolean;
  /** Below this length (after trim) the candidate is `soft_skip`ped. */
  minLength: number;
  /** Above this length (after trim) the candidate is `hard_block`ed. */
  maxLength: number;
  /** Extra raw regex patterns promoted to `hard_block`. */
  sensitivePatterns: readonly string[];
  /** Extra raw regex patterns promoted to `soft_skip`. */
  ephemeralPatterns: readonly string[];
  /** Extra raw regex patterns promoted to `hard_keep`. */
  keepPatterns: readonly string[];
  /**
   * v0.3.0 — extra raw regex patterns promoted to `hard_block` against
   * social-engineering / memory-poisoning attacks. Ships with a built-in
   * library tuned to the OWASP ASI06 / MINJA fingerprint family.
   */
  poisonPatterns: readonly string[];
  /**
   * v0.3.0 — semantic-dedup threshold in `[0, 1]`. When the top-1
   * HybridRetriever neighbor of a candidate exceeds this score *and*
   * shares at least `semanticDedupMinOverlap` keywords with the
   * candidate, the engine consolidates into the neighbor instead of
   * storing a fresh note. Set to `1.0` to disable semantic dedup and
   * fall back to exact-match-only consolidation. The default `0.85`
   * mirrors the value used by LongMemEval's pruning pass.
   */
  semanticDedupThreshold: number;
  /**
   * v0.3.0 — minimum keyword overlap (Jaccard index, in `[0, 1]`) the
   * candidate must share with the top-1 neighbor for semantic dedup to
   * fire. Prevents false positives where two unrelated notes happen to
   * score highly on a single high-IDF term.
   */
  semanticDedupMinOverlap: number;
  /**
   * v0.4.0 — when true the `uncertain` region is forwarded
   * to a cheap LLM classifier. Defaults to false to keep the gate
   * dependency-free and deterministic.
   */
  enableLlmReview: boolean;
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
  /** v0.3.0 — admission gate configuration. */
  admission: AdmissionPolicyConfig;
}
