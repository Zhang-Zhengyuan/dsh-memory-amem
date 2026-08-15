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
export class HybridRetriever {
    alpha;
    corpus = [];
    notes = [];
    bm25;
    docs = [];
    constructor(opts) {
        this.alpha = opts.alpha;
        this.bm25 = new TfIdfIndex();
    }
    addDocuments(documents) {
        for (const doc of documents) {
            this.corpus.push(doc);
            this.bm25.addDocument(doc);
        }
    }
    addDocument(document) {
        this.corpus.push(document);
        this.bm25.addDocument(document);
    }
    registerNote(note) {
        this.notes.push(note);
    }
    noteAt(index) {
        return this.notes[index];
    }
    size() {
        return this.notes.length;
    }
    retrieve(query, k) {
        if (this.notes.length === 0)
            return [];
        const bm25Scores = this.bm25.score(query);
        const bm25Norm = normalize(bm25Scores);
        const semanticScores = this.semanticScore(query);
        // Element-wise weighted sum — same formula as the A-MEM paper.
        const hybrid = bm25Norm.map((s, i) => this.alpha * s + (1 - this.alpha) * semanticScores[i]);
        const topK = Math.min(k, hybrid.length);
        return topKIndices(hybrid, topK);
    }
    semanticScore(query) {
        const qTokens = tokenize(query);
        const qTf = termFrequency(qTokens);
        const qVec = expandToVocab(qTf, this.bm25.vocab());
        const qNorm = l2(qVec);
        if (qNorm === 0)
            return new Array(this.notes.length).fill(0);
        return this.notes.map((note) => {
            const docTokens = tokenize(this.documentText(note));
            const docTf = termFrequency(docTokens);
            const docVec = expandToVocab(docTf, this.bm25.vocab());
            const docNorm = l2(docVec);
            if (docNorm === 0)
                return 0;
            return dot(qVec, docVec) / (qNorm * docNorm);
        });
    }
    documentText(note) {
        return [note.content, note.context, note.keywords.join(' '), note.tags.join(' ')].join(' ').toLowerCase();
    }
}
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1);
}
function termFrequency(tokens) {
    const tf = new Map();
    for (const t of tokens)
        tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
}
function expandToVocab(tf, vocab) {
    return vocab.map((term) => tf.get(term) ?? 0);
}
function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++)
        s += a[i] * b[i];
    return s;
}
function l2(a) {
    return Math.sqrt(dot(a, a));
}
function normalize(scores) {
    if (scores.length === 0)
        return [];
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min + 1e-6;
    return scores.map((s) => (s - min) / range);
}
function topKIndices(scores, k) {
    const indices = scores.map((score, idx) => ({ score, idx }));
    indices.sort((a, b) => b.score - a.score);
    return indices.slice(0, k).map((x) => x.idx);
}
/**
 * A small TF-IDF index that mimics BM25Okapi's strengths while
 * remaining dependency-free. We use BM25 term weighting with
 * standard k=1.5, b=0.75 choices.
 */
class TfIdfIndex {
    termDocFreq = new Map();
    docCount = 0;
    docs = [];
    docLens = [];
    avgDocLen = 0;
    vocab() {
        return Array.from(this.termDocFreq.keys());
    }
    addDocument(text) {
        const tokens = tokenize(text);
        this.docs.push(tokens);
        this.docLens.push(tokens.length);
        this.docCount += 1;
        const seen = new Set();
        for (const t of tokens) {
            if (!seen.has(t)) {
                seen.add(t);
                this.termDocFreq.set(t, (this.termDocFreq.get(t) ?? 0) + 1);
            }
        }
        this.avgDocLen = this.docLens.reduce((a, b) => a + b, 0) / this.docCount;
    }
    score(query) {
        const qTokens = tokenize(query);
        if (this.docCount === 0)
            return [];
        const k1 = 1.5;
        const b = 0.75;
        return this.docs.map((doc, idx) => {
            const docLen = this.docLens[idx];
            let s = 0;
            for (const q of qTokens) {
                const df = this.termDocFreq.get(q) ?? 0;
                if (df === 0)
                    continue;
                const idf = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));
                let tf = 0;
                for (const t of doc)
                    if (t === q)
                        tf++;
                const norm = tf * (k1 + 1);
                const denom = tf + k1 * (1 - b + b * (docLen / (this.avgDocLen || 1)));
                s += idf * (norm / (denom || 1));
            }
            return s;
        });
    }
}
//# sourceMappingURL=retriever.js.map