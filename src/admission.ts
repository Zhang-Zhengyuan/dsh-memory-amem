/**
 * Memory admission policy — v0.3.0.
 *
 * Decides whether a candidate memory note should be stored, before it
 * reaches the persistence and analysis pipeline. Goal: keep the memory
 * store signal-dense (high precision, acceptable recall) while being
 * fully deterministic, dependency-free, and prompt-injection safe.
 *
 * Design choices (see README → "Admission policy"):
 *   - Pure functions / no I/O. The gate is fully reproducible.
 *   - 4 precedence levels: HARD_BLOCK > HARD_KEEP > SOFT_SKIP > UNCERTAIN.
 *   - Default rule set targets the three failure classes we already saw:
 *       1. Sensitive content (tokens, IP, email, credentials).
 *       2. Ephemeral chat noise (greetings, filler, error logs).
 *       3. Strong keep signals (decisions, commit hashes, file paths).
 *   - User-supplied patterns (sensitivePatterns / ephemeralPatterns /
 *     keepPatterns) are merged with defaults. User rules win on a tie.
 *
 * Future directions (out of scope for v0.3.0, intended for v0.4.0+):
 *   - LLM-based admission for the UNCERTAIN region (`enableLlmReview: true`).
 *   - Per-session learning of missed-admissions / over-admissions.
 *   - A decision audit log consumable by the future memory browser UI.
 */

import type { AdmissionContext, AdmissionDecision, AdmissionPolicyConfig, AdmissionRule, MemoryNote } from './types.js';

// ---------- Exported error ----------
/** Thrown by the engine when admission rejects a candidate note. */
export class AdmissionRejectedError extends Error {
  readonly decision: AdmissionDecision;
  constructor(decision: AdmissionDecision) {
    super(`admission rejected (${decision.kind}): ${decision.reason}`);
    this.name = 'AdmissionRejectedError';
    this.decision = decision;
  }
}

// ---------- Precedence ----------
/** Higher number wins. Ties resolve to the first declared rule. */
const PRECEDENCE: Record<AdmissionDecision['kind'], number> = {
  hard_block: 100,
  hard_keep: 90,
  soft_skip: 50,
  uncertain: 0,
};

// ---------- Built-in rule library ----------
// Each rule is intentionally narrow. Patterns are anchored where useful,
// case-sensitive for identifiers/tokens, case-insensitive for natural
// language. The `match` function returns the rule only when the candidate
// text definitely belongs to its category; ambiguous text is left for
// the UNCERTAIN bucket so LLM-based admission (v0.4.0) can decide.

interface RuleSpec {
  id: string;
  description: string;
  decision: AdmissionDecision['kind'];
  match: (text: string) => boolean;
}

const BUILTIN_SENSITIVE: RuleSpec[] = [
  {
    id: 'sensitive.bearer',
    description: 'Bearer / OAuth token literal',
    decision: 'hard_block',
    match: (text) => /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/.test(text),
  },
  {
    id: 'sensitive.github-token',
    description: 'GitHub personal access token (ghp_, ghs_, gho_, ghu_, ghr_)',
    decision: 'hard_block',
    match: (text) => /\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(text),
  },
  {
    id: 'sensitive.openai-key',
    description: 'OpenAI / similar sk-/pk- API key literal',
    decision: 'hard_block',
    match: (text) => /\bsk-[A-Za-z0-9_-]{20,}\b/.test(text),
  },
  {
    id: 'sensitive.aws-access-key',
    description: 'AWS access key id literal',
    decision: 'hard_block',
    match: (text) => /\bAKIA[0-9A-Z]{16}\b/.test(text),
  },
  {
    id: 'sensitive.private-key-block',
    description: 'PEM private key block',
    decision: 'hard_block',
    match: (text) => /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/.test(text),
  },
  {
    id: 'sensitive.password-assignment',
    description: 'Inline password assignment (password=..., pwd: "...")',
    decision: 'hard_block',
    match: (text) => /(password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]+/i.test(text),
  },
  {
    id: 'sensitive.email-pii',
    description: 'Email address (potential PII)',
    decision: 'hard_block',
    match: (text) => /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(text),
  },
  {
    id: 'sensitive.ip-literal',
    description: 'Public IPv4 literal (192/8 and above — exclude 0/127/169.254/224+ reserved)',
    decision: 'hard_block',
    match: (text) => {
      const m = text.match(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/);
      if (!m) return false;
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (a === 0 || a === 127 || a >= 224) return false;
      if (a === 169 && b === 254) return false;
      if (a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31) {
        // RFC1918 private — still sensitive in many contexts but lower confidence.
        // We still block, but rely on context (`host:`/`server:` keyword) below.
        return /\b(host|server|domain|api|endpoint|address)\b/i.test(text);
      }
      return true;
    },
  },
  {
    id: 'sensitive.jwt',
    description: 'JWT-shaped triple-base64 string',
    decision: 'hard_block',
    match: (text) => /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(text),
  },
];

const BUILTIN_EPHEMERAL: RuleSpec[] = [
  {
    id: 'ephemeral.pure-greeting',
    description: 'Pure greeting / acknowledgment with no information',
    decision: 'soft_skip',
    match: (text) => {
      const t = text.trim();
      if (t.length > 32) return false;
      return /^(hi|hello|hey|yo|你好|您好|嗨|嗨在吗)\s*[!！,。.\s]*$/i.test(t)
        || /^(ok|好的|收到|嗯|thanks|thank you|thx|got it)\s*[!！,。.\s]*$/i.test(t);
    },
  },
  {
    id: 'ephemeral.filler-turn',
    description: 'Filler turn with no semantic payload',
    decision: 'soft_skip',
    match: (text) => {
      const t = text.trim().toLowerCase();
      if (t.length > 24) return false;
      return /^(please wait|hold on|one sec|one moment|等等|稍等|等一下|再看下|先这样)$/.test(t);
    },
  },
  {
    id: 'ephemeral.stack-trace',
    description: 'Raw stack trace / error log fragment',
    decision: 'soft_skip',
    match: (text) => /\s+at\s+\S+\s*\(/.test(text) && /\.(js|ts|mjs|cjs|py|java|rb|go|rs):\d+/.test(text),
  },
];

const BUILTIN_KEEP: RuleSpec[] = [
  {
    id: 'keep.explicit-decision',
    description: 'User signals an explicit decision / preference',
    decision: 'hard_keep',
    match: (text) => /\b(we('?ll| will| have|'?ve)(?: decided)?|we'?re(?: going)?|I('?ve| have) decided|let'?s|决定|我们决定|我决定|以后(用|都用))\b/i.test(text)
      || /(决定(用|选择|采用|改用|换成|迁移到|改用))/.test(text),
  },
  {
    id: 'keep.commit-hash',
    description: 'Git-style SHA / commit reference',
    decision: 'hard_keep',
    match: (text) => /\bcommit\s+[0-9a-f]{7,40}\b/i.test(text) || /\b[0-9a-f]{7,40}\b(?=\s*\.\.\.[0-9a-f]{7,40})/.test(text),
  },
  {
    id: 'keep.file-path',
    description: 'Explicit project file path (abs or repo-relative)',
    decision: 'hard_keep',
    match: (text) => {
      const hasSegment = /\/[A-Za-z0-9_.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|swift|kt|vue|svelte|md|json|yaml|yml|toml|sql|sh|bash)\b/.test(text);
      const hasPathToken = /(\.\/|\.\.\/|src\/|lib\/|app\/|packages\/)/.test(text);
      return hasSegment && hasPathToken;
    },
  },
  {
    id: 'keep.preference-marker',
    description: 'User marks a personal preference explicitly',
    decision: 'hard_keep',
    match: (text) => /\b(I prefer|I like|I dislike|I hate|I always|I never|my default|my setup)\b/i.test(text)
      || /(我(偏好|喜欢|习惯|总是|从不|通常))/.test(text),
  },
  {
    id: 'keep.verified-fix',
    description: 'A verified fix that worked (with explicit evidence)',
    decision: 'hard_keep',
    match: (text) => /\b(fixed by|fixed with|workaround|resolved by|fixed in commit)\b/i.test(text)
      || /(用.{1,30}修复|已修复|解决方案是|可行的方案|解决方法是用)/.test(text),
  },
];

/**
 * v0.3.0 — defensive rules against the OWASP ASI06 / MINJA family of
 * "remember this forever" memory-poisoning attacks. These short-circuit to
 * `hard_block` because they are attacker fingerprints (planted instructions
 * that piggy-back on legitimate-looking sentences), not legitimate user
 * preferences. Reference:
 *   - https://christian-schneider.net/blog/persistent-memory-poisoning-in-ai-agents/
 *   - MINJA paper (NeurIPS 2025)
 *   - OWASP Top 10 for Agentic Applications (2026), ASI06
 */
const BUILTIN_POISON: RuleSpec[] = [
  {
    id: 'poison.remember-forever',
    description: 'Planted instruction to remember a fact across all future sessions',
    decision: 'hard_block',
    match: (text) => /\b(?:remember|记住|请记住|务必记住|切记)\b[^\n.]{0,80}?\b(?:forever|always|forevermore|永远|以后都|以后永远|今后所有|以后所有)\b/i.test(text)
      || /\b(?:forever|永远|永久)\b[^\n.]{0,40}?(remember|记住)/.test(text)
      || /\b(?:remember|记住|请记住|务必记住|切记)\b[^\n.]{0,80}?(?:for (?:future|next) (?:sessions|use|reference))/.test(text),
  },
  {
    id: 'poison.always-prefer',
    description: 'Planted directive to "always prefer X" designed to bias future behaviour',
    decision: 'hard_block',
    match: (text) => /(?:\b(?:always|every time|at all times)\b|总是|永远都|永远用|每次都)[^\n.]{0,80}?(?:\b(?:prefer|use|choose|do|send|reply|answer|include|avoid)\b|使用|采用|用|写|发)/i.test(text)
      || /\b(?:prefer|use|choose|do)\b[^\n.]{0,80}?(\b(?:always|every time)\b|总是|永远都|永远用)/i.test(text),
  },
  {
    id: 'poison.future-context',
    description: '"Important context for later sessions" / "context to remember" planted directive',
    decision: 'hard_block',
    match: (text) => /\b(important context|critical context|note for (future|later|next)|for future (use|reference|sessions)|context to remember|memory note|save this (fact|detail|for later))\b/i.test(text)
      || /(重要(背景|上下文)|关键(背景|上下文)|供以后(参考|查看)|以后查看|记住这个|以后提一下|以后都要)/.test(text),
  },
  {
    id: 'poison.exfiltration-recipient',
    description: 'Plant a recipient address where future outputs should be sent',
    decision: 'hard_block',
    match: (text) => /\b(?:send|forward|email|wire|transfer|pay)\b[^\n.]{0,120}?\b(?:to|at|address)\b[^\n.]{0,80}?(?:\b(?:whenever|if|when)\b|每次|如果|一旦)/i.test(text),
  },
];

// ---------- Decision logic ----------
function compileUserPatterns(patterns: readonly string[] | undefined): RegExp[] {
  if (!patterns || patterns.length === 0) return [];
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern));
    } catch {
      // Invalid user pattern is dropped silently. This is a hard-block library,
      // we never want a misconfigured plugin to crash-load an agent.
    }
  }
  return compiled;
}

function decideByRules(rules: RuleSpec[], text: string): AdmissionDecision | undefined {
  for (const rule of rules) {
    if (rule.match(text)) {
      return {
        kind: rule.decision,
        reason: rule.description,
        matchedRule: rule.id,
      };
    }
  }
  return undefined;
}

function coerce(admitKind: AdmissionDecision['kind'], ruleId: string, reason: string, fallback: AdmissionDecision['kind']): AdmissionDecision {
  if (admitKind === fallback) return { kind: admitKind, reason, matchedRule: ruleId };
  return { kind: admitKind, reason, matchedRule: ruleId };
}

/** Apply a precedence-aware merge across an array of decisions. */
function pickStrongest(decisions: Array<AdmissionDecision | undefined>): AdmissionDecision | undefined {
  let best: AdmissionDecision | undefined;
  for (const decision of decisions) {
    if (!decision) continue;
    if (!best || PRECEDENCE[decision.kind] > PRECEDENCE[best.kind]) best = decision;
  }
  return best;
}

// ---------- Public API ----------
export interface AdmissionPolicyOptions {
  /** Merged defaults (from `resolveConfig().admission`). */
  config: AdmissionPolicyConfig;
  /** Logger injected by the engine / host. */
  console?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export class AdmissionPolicy {
  private readonly sensitiveRules: RuleSpec[];
  private readonly ephemeralRules: RuleSpec[];
  private readonly keepRules: RuleSpec[];
  private readonly poisonRules: RuleSpec[];
  private readonly enabled: boolean;
  private readonly minLength: number;
  private readonly maxLength: number;
  private readonly userSensitive: RegExp[];
  private readonly userEphemeral: RegExp[];
  private readonly userKeep: RegExp[];
  private readonly userPoison: RegExp[];
  private readonly console?: { info: (msg: string) => void; warn: (msg: string) => void };

  constructor(options: AdmissionPolicyOptions) {
    this.enabled = options.config.enabled;
    this.minLength = options.config.minLength;
    this.maxLength = options.config.maxLength;
    this.console = options.console;
    this.sensitiveRules = BUILTIN_SENSITIVE;
    this.ephemeralRules = BUILTIN_EPHEMERAL;
    this.keepRules = BUILTIN_KEEP;
    this.poisonRules = BUILTIN_POISON;
    this.userSensitive = compileUserPatterns(options.config.sensitivePatterns);
    this.userEphemeral = compileUserPatterns(options.config.ephemeralPatterns);
    this.userKeep = compileUserPatterns(options.config.keepPatterns);
    this.userPoison = compileUserPatterns(options.config.poisonPatterns ?? []);
  }

  /**
   * Decide whether the candidate should enter long-term memory.
   *
   * Precedence: any HARD_BLOCK > any HARD_KEEP > any SOFT_SKIP.
   * UNCERTAIN is a soft "ask the LLM later" signal and never wins over
   * an explicit rule hit.
   *
   * Edge cases:
   *   - Disabled policy → always `{kind: 'hard_keep', reason: 'policy disabled', matchedRule: 'system.disabled'}`.
   *   - Empty text → soft_skip (so the caller logs and skips).
   *   - Too short / too long → soft_skip / hard_block respectively.
   */
  decide(context: AdmissionContext): AdmissionDecision {
    if (!this.enabled) {
      return { kind: 'hard_keep', reason: 'admission policy disabled', matchedRule: 'system.disabled' };
    }

    const text = context.text.trim();
    if (text.length === 0) {
      return { kind: 'soft_skip', reason: 'empty content after trim', matchedRule: 'system.empty' };
    }

    // 0. Poison / social-engineering gate. Runs *first* because the
    //    payload may carry secrets, paths or decisions that would
    //    individually look innocent. Blocking on the attack signature
    //    means an attacker cannot dodge it by re-writing the payload.
    const userPoisonHit = this.userPoison.find((re) => re.test(text));
    if (userPoisonHit) {
      return {
        kind: 'hard_block',
        reason: `matched user poison pattern: ${userPoisonHit.source}`,
        matchedRule: 'user.poison',
      };
    }
    const poisonHit = decideByRules(this.poisonRules, text);
    if (poisonHit) return poisonHit;

    // 1. Sensitive block — user rules first then built-ins. Sensitive checks
    //    come before ephemeral/keep so that a token pasted inside a stack
    //    trace is still caught.
    const userSensitiveHit = this.userSensitive.find((re) => re.test(text));
    if (userSensitiveHit) {
      return {
        kind: 'hard_block',
        reason: `matched user sensitive pattern: ${userSensitiveHit.source}`,
        matchedRule: 'user.sensitive',
      };
    }
    const sensitiveHit = decideByRules(this.sensitiveRules, text);
    if (sensitiveHit) return sensitiveHit;

    // 2. Ephemeral noise — short greetings, filler turns, and stack trace
    //    fragments are skipped regardless of how they look. We run this
    //    BEFORE keep rules because a stack trace happens to contain file
    //    paths that would otherwise match keep.file-path.
    const userEphemeralHit = this.userEphemeral.find((re) => re.test(text));
    if (userEphemeralHit) {
      return {
        kind: 'soft_skip',
        reason: `matched user ephemeral pattern: ${userEphemeralHit.source}`,
        matchedRule: 'user.ephemeral',
      };
    }
    const ephemeralHit = decideByRules(this.ephemeralRules, text);
    if (ephemeralHit) return ephemeralHit;

    // 3. Strong keep signals.
    const userKeepHit = this.userKeep.find((re) => re.test(text));
    if (userKeepHit) {
      return {
        kind: 'hard_keep',
        reason: `matched user keep pattern: ${userKeepHit.source}`,
        matchedRule: 'user.keep',
      };
    }
    const keepHit = decideByRules(this.keepRules, text);
    if (keepHit) return keepHit;

    // 4. Length bracket — only after the semantic rules have had a chance.
    if (text.length < this.minLength) {
      return { kind: 'soft_skip', reason: `below minLength (${this.minLength})`, matchedRule: 'system.too-short' };
    }
    if (text.length > this.maxLength) {
      return { kind: 'hard_block', reason: `exceeds maxLength (${this.maxLength})`, matchedRule: 'system.too-long' };
    }

    // 5. Default: let it through, but mark uncertain so v0.4.0 can audit.
    return {
      kind: 'uncertain',
      reason: 'no rule matched; relying on downstream analysis',
      matchedRule: 'system.default',
    };
  }

  /** Returns a snapshot of the active rule set (useful for diagnostics / UI). */
  rules(): AdmissionRule[] {
    const toRule = (spec: RuleSpec): AdmissionRule => ({
      id: spec.id,
      description: spec.description,
      decision: spec.decision,
    });
    return [
      ...this.poisonRules.map(toRule),
      ...this.sensitiveRules.map(toRule),
      ...this.keepRules.map(toRule),
      ...this.ephemeralRules.map(toRule),
      ...this.userPoison.map((re, i) => ({
        id: `user.poison.${i}`,
        description: `user-supplied poison pattern ${re.source}`,
        decision: 'hard_block' as const,
      })),
      ...this.userSensitive.map((re, i) => ({
        id: `user.sensitive.${i}`,
        description: `user-supplied sensitive pattern ${re.source}`,
        decision: 'hard_block' as const,
      })),
      ...this.userEphemeral.map((re, i) => ({
        id: `user.ephemeral.${i}`,
        description: `user-supplied ephemeral pattern ${re.source}`,
        decision: 'soft_skip' as const,
      })),
      ...this.userKeep.map((re, i) => ({
        id: `user.keep.${i}`,
        description: `user-supplied keep pattern ${re.source}`,
        decision: 'hard_keep' as const,
      })),
    ];
  }

  /** Reports a successful admission for downstream audit/log use. */
  logAccepted(decision: AdmissionDecision, source: AdmissionContext['source']): void {
    if (decision.kind === 'hard_keep' && this.console) {
      this.console.info(`admission: keep (${decision.matchedRule}) [${source}]`);
    } else if (decision.kind === 'uncertain' && this.console) {
      this.console.info(`admission: accept (${decision.matchedRule}) [${source}]`);
    }
  }

  /** Re-export the error class for callers that need `instanceof` checks. */
  static readonly RejectedError = AdmissionRejectedError;
}

/** Helper for the engine: returns true when the decision should be stored. */
export function isAcceptingDecision(decision: AdmissionDecision): boolean {
  return decision.kind === 'hard_keep' || decision.kind === 'uncertain';
}

/** Helper for the engine: returns true when the decision should be hard-rejected. */
export function isHardRejectingDecision(decision: AdmissionDecision): boolean {
  return decision.kind === 'hard_block' || decision.kind === 'soft_skip';
}

/**
 * Compute the trust score to attach to a freshly-admitted note.
 *
 * Inputs:
 *   - `decision`: the matching admission decision (`hard_keep` or `uncertain`).
 *   - `source`: caller provenance (`auto_capture` / `tool_call` / `service`).
 *
 * The score is consumed at retrieval time by re-ranking multipliers; it
 * does not gate admission. See `agent/src/memory.ts` for the helper
 * `applyTrustRerank` that uses it.
 */
export function computeTrustScore(
  decision: AdmissionDecision,
  source: AdmissionContext['source'],
): number {
  const explicit = decision.kind === 'hard_keep';
  switch (source) {
    case 'tool_call':
    case 'service':
      return explicit ? 0.9 : 0.6;
    case 'auto_capture':
      return explicit ? 0.7 : 0.5;
    default:
      return 0.5;
  }
}

/**
 * Optional retrieval-time helper: demote low-trust notes without dropping
 * them. The factor `pow(trustScore, 2)` is intentionally steep so that a
 * trust score of 0.5 keeps only 25% of the original score, while a 0.9
 * keeps 81%. The caller decides whether to use the result; v0.3.0 ships
 * the function and an opt-in wiring (see `MemoryNote.trustScore`).
 */
export function applyTrustRerank<T extends { score: number; note: MemoryNote }>(
  results: readonly T[],
): T[] {
  return results.map((result) => ({
    ...result,
    note: result.note,
    score: result.score * Math.pow(result.note.trustScore ?? 0.5, 2),
  }));
}
