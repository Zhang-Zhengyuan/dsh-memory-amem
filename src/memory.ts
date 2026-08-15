/**
 * A-MEM cognitive memory engine.
 *
 * Storage layout: one JSON file per note under storageDir/notes/<id>.json,
 * plus an index.json containing note metadata. Writes are serialized and
 * replaced atomically so an interval flush cannot overwrite a newer change.
 */

import { v4 as uuid } from 'uuid';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryNote, MemoryAnalysis, EvolutionDecision, EvolutionResult, RetrievalResult, PluginConfig } from './types.js';
import { AnalysisService } from './analysis.js';
import { EvolutionService } from './evolution.js';
import { HybridRetriever } from './retriever.js';

export interface EngineDeps {
  llm: {
    generate: (prompt: string, opts?: { temperature?: number; json?: boolean }) => Promise<string>;
    readonly available?: boolean;
  };
  config: PluginConfig;
  console?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

export interface MemoryScopeOptions {
  conversationId?: string;
  sessionId?: string;
}

export class AgenticMemoryEngine {
  private notes = new Map<string, MemoryNote>();
  private retriever: HybridRetriever;
  private analysis: AnalysisService;
  private evolution: EvolutionService;
  private storageDir: string;
  private config: PluginConfig;
  private llm: EngineDeps['llm'];
  private log: Required<EngineDeps>['console'];
  private revision = 0;
  private persistedRevision = 0;
  private activeFlush: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private disposed = false;

  constructor(deps: EngineDeps) {
    this.config = deps.config;
    this.llm = deps.llm;
    this.storageDir = expandHome(deps.config.storageDir);
    this.log = deps.console ?? {
      info: (msg: string) => console.log(`[dsh-memory-amem] ${msg}`),
      warn: (msg: string) => console.warn(`[dsh-memory-amem] ${msg}`),
      error: (msg: string) => console.error(`[dsh-memory-amem] ${msg}`),
    };
    this.retriever = new HybridRetriever({ alpha: this.config.hybridAlpha, modelName: this.config.embeddingModel });
    this.analysis = new AnalysisService(deps.llm.generate);
    this.evolution = new EvolutionService(deps.llm.generate);
  }

  init(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Memory engine is disposed'));
    this.initPromise ??= this.initialize();
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(path.join(this.storageDir, 'notes'), { recursive: true });
    await this.loadFromDisk();
    this.initialized = true;
    this.log.info(`Loaded ${this.notes.size} memory notes from ${this.storageDir}`);
    this.scheduleFlush();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.initPromise) await this.initPromise.catch(() => undefined);
    if (this.initialized) await this.flush();
    this.log.info('Disposed, all notes persisted');
  }

  async add(content: string, opts: MemoryScopeOptions = {}): Promise<MemoryNote> {
    await this.init();
    const cleanContent = content.trim();
    if (!cleanContent) throw new Error('Cannot add empty memory');
    if (cleanContent.length > this.config.maxMemoryChars) {
      throw new RangeError(`Memory exceeds maxMemoryChars (${this.config.maxMemoryChars})`);
    }

    if (this.config.enableAutoConsolidation) {
      const duplicate = this.findExactDuplicate(cleanContent, opts.sessionId);
      if (duplicate) {
        duplicate.updatedAt = Date.now();
        duplicate.evolutionHistory.push({ timestamp: duplicate.updatedAt, type: 'merged', reason: 'Exact duplicate consolidated' });
        this.markDirty();
        return duplicate;
      }
    }

    const analysis = await this.analysis.analyze(cleanContent);
    const neighbors = this.retrieveNeighbors(analysis, this.config.retrievalK, opts.sessionId);
    const evolution = this.config.enableEvolution && this.llm.available !== false && neighbors.length > 0
      ? await this.evolution.decide({ content: cleanContent, analysis, neighbors: neighbors.map((result) => result.note) })
      : { decision: 'NO_EVOLUTION' as const, reason: 'Evolution disabled or no relevant neighbors' };

    const now = Date.now();
    const note: MemoryNote = {
      id: uuid(),
      content: cleanContent,
      context: analysis.context,
      keywords: analysis.keywords,
      tags: analysis.tags,
      links: [],
      createdAt: now,
      updatedAt: now,
      evolutionHistory: [{ timestamp: now, type: 'created', reason: 'Initial analysis' }],
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    };

    const changedNeighbor = this.config.enableEvolution ? await this.applyEvolution(note, evolution, neighbors) : false;
    this.notes.set(note.id, note);
    if (changedNeighbor) this.rebuildRetriever();
    else {
      this.retriever.registerNote(note);
      this.retriever.addDocument(this.documentText(note));
    }
    this.markDirty();
    this.log.info(`Added note ${note.id} (links=${note.links.length}, tags=${note.tags.length})`);
    return note;
  }

  search(query: string, k?: number, opts: MemoryScopeOptions = {}): RetrievalResult[] {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];
    const topK = boundedCount(k ?? this.config.retrievalK, this.config.retrievalK, 100);
    return this.retrieveNeighbors({ keywords: [], context: cleanQuery, tags: [] }, topK, opts.sessionId);
  }

  all(opts: MemoryScopeOptions = {}): MemoryNote[] {
    return Array.from(this.notes.values())
      .filter((note) => this.matchesScope(note, opts.sessionId))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  topKForPrompt(query: string, k?: number, opts: MemoryScopeOptions = {}): MemoryNote[] {
    return this.search(query, k ?? this.config.retrievalK, opts).map((result) => result.note);
  }

  stats(opts: MemoryScopeOptions = {}): { total: number; withLinks: number; avgLinks: number; oldest: number; newest: number } {
    return statsFor(this.all(opts));
  }

  private findExactDuplicate(content: string, sessionId?: string): MemoryNote | undefined {
    const normalized = normalizeContent(content);
    return Array.from(this.notes.values()).find((note) =>
      this.matchesScope(note, sessionId) && normalizeContent(note.content) === normalized,
    );
  }

  private matchesScope(note: MemoryNote, sessionId?: string): boolean {
    if (this.config.memoryScope === 'global') return true;
    return note.sessionId === sessionId;
  }

  private documentText(note: MemoryNote): string {
    return [note.content, note.context, note.keywords.join(' '), note.tags.join(' ')].join(' ').toLowerCase();
  }

  private retrieveNeighbors(analysis: MemoryAnalysis, k: number, sessionId?: string): RetrievalResult[] {
    if (this.notes.size === 0) return [];
    const query = [analysis.context, ...analysis.keywords].join(' ').trim();
    if (!query) return [];
    return this.retriever.retrieveScored(query, this.notes.size)
      .map(({ index, score }) => ({ note: this.retriever.noteAt(index), score }))
      .filter((result): result is RetrievalResult => result.note !== undefined && this.matchesScope(result.note, sessionId))
      .slice(0, k);
  }

  private async applyEvolution(note: MemoryNote, evolution: EvolutionResult, neighbors: RetrievalResult[]): Promise<boolean> {
    const maxLinks = this.config.maxLinksPerNote;
    const decision: EvolutionDecision = evolution.decision;
    if (decision === 'NO_EVOLUTION') return false;

    const relatedIds = neighbors.map((result) => result.note.id);
    if (decision === 'STRENGTHEN' || decision === 'STRENGTHEN_AND_UPDATE') {
      const existing = new Set(note.links);
      const candidates = evolution.newLinks ?? relatedIds.slice(0, maxLinks);
      for (const id of candidates) {
        if (id !== note.id && this.notes.has(id) && note.links.length < maxLinks && !existing.has(id)) {
          note.links.push(id);
          existing.add(id);
        }
      }
      if (evolution.updatedTags?.length) note.tags = Array.from(new Set([...note.tags, ...evolution.updatedTags]));
      note.evolutionHistory.push({
        timestamp: Date.now(),
        type: 'linked',
        reason: evolution.reason || 'Strengthen links',
        affectedNotes: note.links.slice(),
      });
    }

    let changedNeighbor = false;
    if (decision === 'UPDATE_NEIGHBOR' || decision === 'STRENGTHEN_AND_UPDATE') {
      for (const update of evolution.updatedNeighbors ?? []) {
        const target = this.notes.get(update.id);
        if (!target) continue;
        if (update.context) target.context = update.context;
        if (update.tags?.length) target.tags = Array.from(new Set([...target.tags, ...update.tags]));
        target.updatedAt = Date.now();
        target.evolutionHistory.push({ timestamp: target.updatedAt, type: 'context-updated', reason: evolution.reason || 'Neighbor update' });
        changedNeighbor = true;
        this.markDirty();
      }
    }
    note.updatedAt = Date.now();
    return changedNeighbor;
  }

  private rebuildRetriever(): void {
    this.retriever.rebuild(Array.from(this.notes.values()));
  }

  private async loadFromDisk(): Promise<void> {
    const notesDir = path.join(this.storageDir, 'notes');
    let files: string[];
    try {
      files = (await fs.readdir(notesDir)).sort();
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') this.log.warn(`Failed to list notes: ${errorMessage(error)}`);
      return;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(notesDir, file), 'utf8');
        const candidate: unknown = JSON.parse(raw);
        if (!isMemoryNote(candidate) || file !== `${candidate.id}.json`) {
          throw new Error('invalid note schema or filename/id mismatch');
        }
        if (candidate.content.length > this.config.maxMemoryChars) {
          throw new Error(`content exceeds maxMemoryChars (${this.config.maxMemoryChars})`);
        }
        this.notes.set(candidate.id, candidate);
      } catch (error: unknown) {
        this.log.warn(`Skipped corrupt note ${file}: ${errorMessage(error)}`);
      }
    }
    this.rebuildRetriever();
  }

  private markDirty(): void {
    this.revision += 1;
  }

  private scheduleFlush(): void {
    this.flushTimer = setInterval(() => {
      if (this.persistedRevision < this.revision) {
        void this.flush().catch((error: unknown) => this.log.error(`flush failed: ${errorMessage(error)}`));
      }
    }, this.config.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  async flush(): Promise<void> {
    while (this.persistedRevision < this.revision) {
      if (this.activeFlush) {
        await this.activeFlush;
        continue;
      }
      const targetRevision = this.revision;
      const task = this.writeSnapshot(targetRevision);
      this.activeFlush = task;
      try {
        await task;
      } finally {
        if (this.activeFlush === task) this.activeFlush = null;
      }
    }
  }

  private async writeSnapshot(targetRevision: number): Promise<void> {
    const notesDir = path.join(this.storageDir, 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    const notes = Array.from(this.notes.values()).map((note) => structuredClone(note));
    for (const note of notes) await atomicWrite(path.join(notesDir, `${note.id}.json`), JSON.stringify(note));
    await atomicWrite(path.join(this.storageDir, 'index.json'), JSON.stringify({
      notes: notes.map((note) => ({ id: note.id, updatedAt: note.updatedAt })),
      stats: statsFor(notes),
    }));
    this.persistedRevision = Math.max(this.persistedRevision, targetRevision);
  }
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (/^~[\\/]/.test(input)) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

function boundedCount(value: number, fallback: number, max: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}

function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

function statsFor(notes: MemoryNote[]): { total: number; withLinks: number; avgLinks: number; oldest: number; newest: number } {
  const withLinks = notes.filter((note) => note.links.length > 0).length;
  const timestamps = notes.map((note) => note.createdAt);
  return {
    total: notes.length,
    withLinks,
    avgLinks: notes.length === 0 ? 0 : notes.reduce((sum, note) => sum + note.links.length, 0) / notes.length,
    oldest: timestamps.length ? Math.min(...timestamps) : 0,
    newest: timestamps.length ? Math.max(...timestamps) : 0,
  };
}

function isMemoryNote(value: unknown): value is MemoryNote {
  if (!value || typeof value !== 'object') return false;
  const note = value as Partial<MemoryNote>;
  return typeof note.id === 'string'
    && /^[A-Za-z0-9-]+$/.test(note.id)
    && typeof note.content === 'string'
    && typeof note.context === 'string'
    && stringArray(note.keywords)
    && stringArray(note.tags)
    && stringArray(note.links)
    && Number.isFinite(note.createdAt)
    && Number.isFinite(note.updatedAt)
    && Array.isArray(note.evolutionHistory);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

async function atomicWrite(file: string, data: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${uuid()}.tmp`;
  await fs.writeFile(temporary, data, 'utf8');
  try {
    await fs.rename(temporary, file);
  } catch (error: unknown) {
    if (errorCode(error) !== 'EEXIST' && errorCode(error) !== 'EPERM') throw error;
    await fs.writeFile(file, data, 'utf8');
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
