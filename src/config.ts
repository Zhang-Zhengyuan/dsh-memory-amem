import { CONFIG_DEFAULTS } from './invariant.js';
import type { AdmissionPolicyConfig, PluginConfig } from './types.js';

export type PartialPluginConfig = Partial<PluginConfig>;

/** Helper: merge partial admission config into defaults and validate. */
function resolveAdmissionConfig(input: unknown): AdmissionPolicyConfig {
  const defaults = CONFIG_DEFAULTS.admission;
  const base = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const merged: AdmissionPolicyConfig = {
    enabled: typeof base.enabled === 'boolean' ? base.enabled : defaults.enabled,
    minLength: typeof base.minLength === 'number' ? base.minLength : defaults.minLength,
    maxLength: typeof base.maxLength === 'number' ? base.maxLength : defaults.maxLength,
    sensitivePatterns: Array.isArray(base.sensitivePatterns)
      ? base.sensitivePatterns.filter((value): value is string => typeof value === 'string')
      : defaults.sensitivePatterns,
    ephemeralPatterns: Array.isArray(base.ephemeralPatterns)
      ? base.ephemeralPatterns.filter((value): value is string => typeof value === 'string')
      : defaults.ephemeralPatterns,
    keepPatterns: Array.isArray(base.keepPatterns)
      ? base.keepPatterns.filter((value): value is string => typeof value === 'string')
      : defaults.keepPatterns,
    poisonPatterns: Array.isArray(base.poisonPatterns)
      ? base.poisonPatterns.filter((value): value is string => typeof value === 'string')
      : defaults.poisonPatterns,
    semanticDedupThreshold: typeof base.semanticDedupThreshold === 'number'
      ? base.semanticDedupThreshold
      : defaults.semanticDedupThreshold,
    semanticDedupMinOverlap: typeof base.semanticDedupMinOverlap === 'number'
      ? base.semanticDedupMinOverlap
      : defaults.semanticDedupMinOverlap,
    enableLlmReview: typeof base.enableLlmReview === 'boolean'
      ? base.enableLlmReview
      : defaults.enableLlmReview,
  };

  assertInteger('admission.minLength', merged.minLength, 1, 100_000);
  assertInteger('admission.maxLength', merged.maxLength, 1, 1_000_000);
  if (merged.minLength >= merged.maxLength) {
    throw new RangeError('admission.minLength must be strictly less than admission.maxLength');
  }
  assertNumber('admission.semanticDedupThreshold', merged.semanticDedupThreshold, 0, 1);
  assertNumber('admission.semanticDedupMinOverlap', merged.semanticDedupMinOverlap, 0, 1);
  for (const list of [merged.sensitivePatterns, merged.ephemeralPatterns, merged.keepPatterns, merged.poisonPatterns] as const) {
    for (const pattern of list) {
      try {
        new RegExp(pattern);
      } catch (error) {
        throw new TypeError(`admission pattern is not a valid regex: ${pattern} (${(error as Error).message})`);
      }
    }
  }
  return merged;
}

/** Resolve defaults and reject unsafe or nonsensical loader input early. */
export function resolveConfig(options: PartialPluginConfig = {}): PluginConfig {
  const baseConfig = { ...CONFIG_DEFAULTS, ...options } as Record<string, unknown>;
  const config = {
    ...CONFIG_DEFAULTS,
    ...options,
    admission: resolveAdmissionConfig(baseConfig.admission),
  } as PluginConfig;

  if (typeof config.storageDir !== 'string' || config.storageDir.trim().length === 0) {
    throw new TypeError('storageDir must be a non-empty string');
  }
  assertInteger('retrievalK', config.retrievalK, 1, 100);
  assertNumber('hybridAlpha', config.hybridAlpha, 0, 1);
  assertInteger('maxLinksPerNote', config.maxLinksPerNote, 0, 100);
  assertInteger('maxMemoryChars', config.maxMemoryChars, 1, 1_000_000);
  assertInteger('promptMaxChars', config.promptMaxChars, 256, 100_000);
  assertInteger('flushIntervalMs', config.flushIntervalMs, 100, 3_600_000);
  if (config.memoryScope !== 'global' && config.memoryScope !== 'session') {
    throw new TypeError('memoryScope must be "global" or "session"');
  }
  for (const key of ['enableEvolution', 'enableAutoConsolidation', 'enableAutoCapture', 'enablePromptInjection'] as const) {
    if (typeof config[key] !== 'boolean') throw new TypeError(`${key} must be a boolean`);
  }
  if (config.embeddingModel !== 'tfidf-lite') {
    throw new TypeError('embeddingModel must be "tfidf-lite"; no other embedding backend is implemented');
  }
  if (typeof config.llmModel !== 'string' || config.llmModel.trim().length === 0) {
    throw new TypeError('llmModel must be a non-empty string');
  }
  return config;
}

function assertInteger(name: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
}

function assertNumber(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
}
