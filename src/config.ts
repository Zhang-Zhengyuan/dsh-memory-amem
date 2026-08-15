import { CONFIG_DEFAULTS } from './invariant.js';
import type { PluginConfig } from './types.js';

export type PartialPluginConfig = Partial<PluginConfig>;

/** Resolve defaults and reject unsafe or nonsensical loader input early. */
export function resolveConfig(options: PartialPluginConfig = {}): PluginConfig {
  const config = { ...CONFIG_DEFAULTS, ...options } as PluginConfig;

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
