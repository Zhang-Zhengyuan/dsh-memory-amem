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

import { v4 as uuid } from 'uuid';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MemoryNote, MemoryAnalysis, EvolutionDecision, EvolutionResult, RetrievalResult, PluginConfig } from './types.js';
import { AnalysisService } from './analysis.js';
import { EvolutionService } from './evolution.js';
import { HybridRetriever } from './retriever.js';

export interface EngineDeps {
  llm: {
    generate: (prompt: string, opts?: { temperature?: number; json?: boolean }) => Promise<string>;
  };
  config: PluginConfig;
  console?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

export class AgenticMemoryEngine {
  private notes: Map<string, MemoryNote> = new Map();
  private retriever: HybridRetriever;
  private analysis: AnalysisService;
  private evolution: EvolutionService;
  private storageDir: string;
  private config: PluginConfig;
  private log: Required<EngineDeps>['console'];
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(deps: EngineDeps) {
    this.config = deps.config;
    this.storageDir = deps.config.storageDir;
    this.log = deps.console ?? {
      info: (msg: string) => console.log(`[dsh-memory-amem] ${msg}`),
      warn: (msg: string) => console.warn(`[dsh-memory-amem] ${msg}`),
      error: (msg: string) => console.error(`[dsh-memory-amem] ${msg}`),
    };
    this.retriever = new HybridRetriever({
      alpha: this.config.hybridAlpha,
      modelName: this.config.embeddingModel,
    });
    this.analysis = new AnalysisService(deps.llm.generate);
    this.evolution = new EvolutionService(deps.llm.generate);

    this.storageDir = this.storageDir.replace(/^~/, process.env.HOME ?? '');
  }

  async init(): Promise<void> {
    await fs.mkdir(path.join(this.storageDir, 'notes'), { recursive: true });
    await this.loadFromDisk();
    this.log.info(`Loaded ${this.notes.size} memory notes from ${this.storageDir}`);
    this.scheduleFlush();
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
    this.log.info('Disposed, all notes persisted');
  }

  /**
   * Main entry — accepts a piece of content (e.g. a user message or
   * a chunk of sub-agent reasoning) and produces a structured note
   * connected to historical memories.
   */
  async add(content: string, opts: { conversationId?: string; sessionId?: string } = {}): Promise<MemoryNote> {
    if (!content.trim()) throw new Error('Cannot add empty memory');

    // 1. Analyze content
    const analysis = await this.analysis.analyze(content);

    // 2. Find nearest neighbors (hybrid retrieval)
    const neighbors = this.retrieveNeighbors(analysis, this.config.retrievalK);

    // 3. Decide evolution
    const evolution = await this.evolution.decide({
      content,
      analysis,
      neighbors: neighbors.map((r) => r.note),
    });

    // 4. Build the new note
    const now = Date.now();
    const note: MemoryNote = {
      id: uuid(),
      content,
      context: analysis.context,
      keywords: analysis.keywords,
      tags: analysis.tags,
      links: [],
      createdAt: now,
      updatedAt: now,
      evolutionHistory: [{ timestamp: now, type: 'created', reason: 'Initial analysis' }],
      conversationId: opts.conversationId,
      sessionId: opts.sessionId,
    };

    // 5. Apply evolution
    if (this.config.enableEvolution) {
      await this.applyEvolution(note, evolution, neighbors);
    }

    // 6. Persist (note first, then index in retriever)
    this.notes.set(note.id, note);
    this.retriever.registerNote(note);
    this.retriever.addDocument(this.documentText(note));
    this.markDirty();
    this.log.info(`Added note ${note.id} (links=${note.links.length}, tags=${note.tags.length})`);
    return note;
  }

  /**
   * Retrieve memories relevant to a query (the current user message
   * or agent context).
   */
  search(query: string, k?: number): RetrievalResult[] {
    const topK = k ?? this.config.retrievalK;
    return this.retrieveNeighbors({ keywords: query.split(/\s+/), context: query, tags: [] }, topK);
  }

  /** Get all notes — used by the prompt injection layer. */
  all(): MemoryNote[] {
    return Array.from(this.notes.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Get the most relevant notes for the system prompt. */
  topKForPrompt(query: string, k?: number): MemoryNote[] {
    return this.search(query, k ?? this.config.retrievalK).map((r) => r.note);
  }

  stats(): { total: number; withLinks: number; avgLinks: number; oldest: number; newest: number } {
    const notes = Array.from(this.notes.values());
    const withLinks = notes.filter((n) => n.links.length > 0).length;
    const avgLinks = notes.length === 0 ? 0 : notes.reduce((acc, n) => acc + n.links.length, 0) / notes.length;
    const timestamps = notes.map((n) => n.createdAt);
    return {
      total: notes.length,
      withLinks,
      avgLinks,
      oldest: timestamps.length ? Math.min(...timestamps) : 0,
      newest: timestamps.length ? Math.max(...timestamps) : 0,
    };
  }

  /** ----- internal helpers ----- */

  private documentText(note: MemoryNote): string {
    return [note.content, note.context, note.keywords.join(' '), note.tags.join(' ')].join(' ').toLowerCase();
  }

  private retrieveNeighbors(analysis: MemoryAnalysis, k: number): RetrievalResult[] {
    if (this.notes.size === 0) return [];
    const query = [analysis.context, ...analysis.keywords].join(' ');
    const indices = this.retriever.retrieve(query, k);
    return indices
      .map((idx) => this.retriever.noteAt(idx))
      .filter((n): n is MemoryNote => !!n)
      .map((note) => ({ note, score: 1 }));
  }

  private async applyEvolution(
    note: MemoryNote,
    evolution: EvolutionResult,
    neighbors: RetrievalResult[],
  ): Promise<void> {
    const maxLinks = this.config.maxLinksPerNote;
    const decision: EvolutionDecision = evolution.decision;

    if (decision === 'NO_EVOLUTION') return;

    const relatedIds = neighbors.map((n) => n.note.id);

    if (decision === 'STRENGTHEN' || decision === 'STRENGTHEN_AND_UPDATE') {
      const existing = new Set(note.links);
      const candidates = evolution.newLinks ?? relatedIds.slice(0, maxLinks);
      for (const id of candidates) {
        if (id !== note.id && this.notes.has(id) && note.links.length < maxLinks) {
          if (!existing.has(id)) {
            note.links.push(id);
            existing.add(id);
          }
        }
      }
      if (evolution.updatedTags && evolution.updatedTags.length > 0) {
        note.tags = Array.from(new Set([...note.tags, ...evolution.updatedTags]));
      }
      note.evolutionHistory.push({
        timestamp: Date.now(),
        type: 'linked',
        reason: evolution.reason || 'Strengthen links',
        affectedNotes: note.links.slice(),
      });
    }

    if (decision === 'UPDATE_NEIGHBOR' || decision === 'STRENGTHEN_AND_UPDATE') {
      const updates = evolution.updatedNeighbors ?? [];
      for (const upd of updates) {
        const target = this.notes.get(upd.id);
        if (!target) continue;
        if (upd.context) target.context = upd.context;
        if (upd.tags && upd.tags.length > 0) {
          target.tags = Array.from(new Set([...target.tags, ...upd.tags]));
        }
        target.updatedAt = Date.now();
        target.evolutionHistory.push({
          timestamp: Date.now(),
          type: 'context-updated',
          reason: evolution.reason || 'Neighbor update',
        });
        this.markDirty();
      }
    }
    note.updatedAt = Date.now();
  }

  private async loadFromDisk(): Promise<void> {
    const notesDir = path.join(this.storageDir, 'notes');
    try {
      const files = await fs.readdir(notesDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const raw = await fs.readFile(path.join(notesDir, file), 'utf-8');
        const note = JSON.parse(raw) as MemoryNote;
        this.notes.set(note.id, note);
        this.retriever.registerNote(note);
        this.retriever.addDocument(this.documentText(note));
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') this.log.warn(`Failed to load notes: ${err.message}`);
    }
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private scheduleFlush(): void {
    this.flushTimer = setInterval(() => {
      if (this.dirty) void this.flush();
    }, 5000);
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    const notesDir = path.join(this.storageDir, 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    for (const note of this.notes.values()) {
      const file = path.join(notesDir, `${note.id}.json`);
      await fs.writeFile(file, JSON.stringify(note));
    }
    const index = path.join(this.storageDir, 'index.json');
    await fs.writeFile(
      index,
      JSON.stringify({
        notes: Array.from(this.notes.values()).map((n) => ({ id: n.id, updatedAt: n.updatedAt })),
        stats: this.stats(),
      }),
    );
    this.dirty = false;
  }
}
