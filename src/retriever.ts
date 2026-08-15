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
  alpha: number; // 0 = pure BM25, 1 = pure semantic
  modelName?: string;
}

export interface ScoredIndex {
  index: number;
  score: number;
}

export class HybridRetriever {
  private alpha: number;
  private notes: MemoryNote[] = [];
  private bm25: TfIdfIndex;

  constructor(opts: RetrieverOptions) {
    this.alpha = Math.max(0, Math.min(1, opts.alpha));
    this.bm25 = new TfIdfIndex();
  }

  addDocuments(documents: string[]): void {
    for (const doc of documents) {
      this.bm25.addDocument(doc);
    }
  }

  addDocument(document: string): void {
    this.bm25.addDocument(document);
  }

  registerNote(note: MemoryNote): void {
    this.notes.push(note);
  }

  noteAt(index: number): MemoryNote | undefined {
    return this.notes[index];
  }

  size(): number {
    return this.notes.length;
  }

  rebuild(notes: MemoryNote[]): void {
    this.notes = [];
    this.bm25 = new TfIdfIndex();
    for (const note of notes) {
      this.registerNote(note);
      this.addDocument(this.documentText(note));
    }
  }

  retrieve(query: string, k: number): number[] {
    return this.retrieveScored(query, k).map((result) => result.index);
  }

  retrieveScored(query: string, k: number): ScoredIndex[] {
    if (this.notes.length === 0 || !query.trim() || !Number.isFinite(k) || k <= 0) return [];
    const bm25Scores = this.bm25.score(query);
    const bm25Norm = normalizePositive(bm25Scores);
    const semanticScores = this.semanticScore(query);
    // Element-wise weighted sum — same formula as the A-MEM paper.
    const hybrid: number[] = bm25Norm.map((score, i) =>
      (1 - this.alpha) * score + this.alpha * semanticScores[i],
    );
    const topK = Math.min(Math.floor(k), hybrid.length);
    return topKIndices(hybrid, topK)
      .map((index) => ({ index, score: hybrid[index] }))
      .filter((result) => result.score > 1e-9);
  }

  private semanticScore(query: string): number[] {
    const qTokens = tokenize(query);
    const qTf = termFrequency(qTokens);
    const qVec = expandToVocab(qTf, this.bm25.vocab());
    const qNorm = l2(qVec);
    if (qNorm === 0) return new Array(this.notes.length).fill(0);

    return this.notes.map((note) => {
      const docTokens = tokenize(this.documentText(note));
      const docTf = termFrequency(docTokens);
      const docVec = expandToVocab(docTf, this.bm25.vocab());
      const docNorm = l2(docVec);
      if (docNorm === 0) return 0;
      return dot(qVec, docVec) / (qNorm * docNorm);
    });
  }

  private documentText(note: MemoryNote): string {
    return [note.content, note.context, note.keywords.join(' '), note.tags.join(' ')].join(' ').toLowerCase();
  }
}

function tokenize(text: string): string[] {
  const chunks = text.normalize('NFKC').toLowerCase().match(/\p{Script=Han}+|[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const chunk of chunks) {
    if (/^\p{Script=Han}+$/u.test(chunk)) {
      const chars = Array.from(chunk);
      if (chars.length === 1) tokens.push(chars[0]);
      else {
        tokens.push(chunk);
        for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
      }
    } else if (chunk.length > 1) {
      tokens.push(chunk);
    }
  }
  return tokens;
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function expandToVocab(tf: Map<string, number>, vocab: string[]): number[] {
  return vocab.map((term) => tf.get(term) ?? 0);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function l2(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

function normalizePositive(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const max = Math.max(...scores);
  if (max <= 0) return scores.map(() => 0);
  return scores.map((score) => Math.max(0, score) / max);
}

function topKIndices(scores: number[], k: number): number[] {
  const indices = scores.map((score, idx) => ({ score, idx }));
  indices.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return indices.slice(0, k).map((x) => x.idx);
}

/**
 * A small TF-IDF index that mimics BM25Okapi's strengths while
 * remaining dependency-free. We use BM25 term weighting with
 * standard k=1.5, b=0.75 choices.
 */
class TfIdfIndex {
  private termDocFreq: Map<string, number> = new Map();
  private docCount = 0;
  private docs: string[][] = [];
  private docLens: number[] = [];
  private avgDocLen = 0;

  vocab(): string[] {
    return Array.from(this.termDocFreq.keys());
  }

  addDocument(text: string): void {
    const tokens = tokenize(text);
    this.docs.push(tokens);
    this.docLens.push(tokens.length);
    this.docCount += 1;
    const seen = new Set<string>();
    for (const t of tokens) {
      if (!seen.has(t)) {
        seen.add(t);
        this.termDocFreq.set(t, (this.termDocFreq.get(t) ?? 0) + 1);
      }
    }
    this.avgDocLen = this.docLens.reduce((a, b) => a + b, 0) / this.docCount;
  }

  score(query: string): number[] {
    const qTokens = tokenize(query);
    if (this.docCount === 0) return [];
    const k1 = 1.5;
    const b = 0.75;
    return this.docs.map((doc, idx) => {
      const docLen = this.docLens[idx];
      let s = 0;
      for (const q of qTokens) {
        const df = this.termDocFreq.get(q) ?? 0;
        if (df === 0) continue;
        const idf = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));
        let tf = 0;
        for (const t of doc) if (t === q) tf++;
        const norm = tf * (k1 + 1);
        const denom = tf + k1 * (1 - b + b * (docLen / (this.avgDocLen || 1)));
        s += idf * (norm / (denom || 1));
      }
      return s;
    });
  }
}
