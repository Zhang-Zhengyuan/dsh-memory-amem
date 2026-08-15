import { defineTool } from "@deepseek-ai/dsh-tools";
import { v4 } from "uuid";
import { promises } from "node:fs";
import path from "node:path";
//#region src/analysis.ts
const ANALYZE_PROMPT = `Analyze the following content and provide:
1. KEYWORDS: The most important keywords (nouns, verbs, key concepts). Order from most to least important. At least three keywords. Do not include speaker names or time references.
2. CONTEXT: One sentence summarizing the main topic, key points, and purpose.
3. TAGS: Broad categories/themes for classification (domain, format, type). At least three tags.

Respond using EXACTLY this format (one section per header):

KEYWORDS: keyword1, keyword2, keyword3, ...
CONTEXT: A single sentence summarizing the content.
TAGS: tag1, tag2, tag3, ...

Content for analysis:
{content}`;
var AnalysisService = class {
	llm;
	constructor(llm) {
		this.llm = llm;
	}
	async analyze(content) {
		const prompt = ANALYZE_PROMPT.replace("{content}", content);
		return parseAnalysis(await this.llm(prompt, {
			temperature: .3,
			json: false
		}), content);
	}
};
function parseAnalysis(response, original) {
	try {
		const cleaned = stripFences(response);
		const parsed = JSON.parse(cleaned);
		if (parsed && typeof parsed === "object") return validateAnalysis({
			keywords: parseList(parsed.keywords),
			context: typeof parsed.context === "string" ? parsed.context : "",
			tags: parseList(parsed.tags)
		}, original);
	} catch {}
	return validateAnalysis({
		keywords: parseList(_extractSection$1(response, "KEYWORDS", ["CONTEXT", "TAGS"])),
		context: _extractSection$1(response, "CONTEXT", ["TAGS", "KEYWORDS"]).trim(),
		tags: parseList(_extractSection$1(response, "TAGS", ["KEYWORDS", "CONTEXT"]))
	}, original);
}
function validateAnalysis(result, original) {
	let { keywords, context, tags } = result;
	if (keywords.length === 0) keywords = heuristicKeywords(original);
	if (!context) context = heuristicContext(original);
	if (tags.length === 0) tags = keywords.slice(0, 3);
	return {
		keywords: keywords.slice(0, 12),
		context,
		tags: tags.slice(0, 8)
	};
}
function parseList(input) {
	if (Array.isArray(input)) return input.filter((x) => typeof x === "string").map((s) => s.trim()).filter(Boolean);
	if (typeof input === "string") return input.split(/[,\n]/).map((s) => s.replace(/^[-\*\u2022\d.)\s]+/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
	return [];
}
function stripFences(text) {
	return text.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?\s*```$/i, "").trim();
}
function _extractSection$1(text, marker, nextMarkers) {
	const match = new RegExp(`^\\s*${marker}\\s*:\\s*(.*)$`, "im").exec(text);
	if (!match) return "";
	const start = match.index + match[0].length;
	const firstLine = match[1].trim();
	let end = text.length;
	for (const nm of nextMarkers) {
		const nmMatch = new RegExp(`^\\s*${nm}\\s*:`, "im").exec(text.slice(start));
		if (nmMatch) {
			const candidate = start + nmMatch.index;
			if (candidate < end) end = candidate;
		}
	}
	const rest = text.slice(start, end).trim();
	return firstLine && rest ? `${firstLine}\n${rest}` : firstLine || rest;
}
const STOP_WORDS = /* @__PURE__ */ new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"shall",
	"can",
	"need",
	"dare",
	"ought",
	"used",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"out",
	"off",
	"over",
	"under",
	"again",
	"further",
	"then",
	"once",
	"here",
	"there",
	"when",
	"where",
	"why",
	"how",
	"all",
	"both",
	"each",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"no",
	"nor",
	"not",
	"only",
	"own",
	"same",
	"so",
	"than",
	"too",
	"very",
	"just",
	"because",
	"but",
	"and",
	"or",
	"if",
	"while",
	"about",
	"up",
	"it",
	"its",
	"i",
	"me",
	"my",
	"you",
	"your",
	"he",
	"she",
	"they",
	"we",
	"this",
	"that",
	"these",
	"those",
	"what",
	"which",
	"who",
	"whom",
	"says",
	"said",
	"speaker"
]);
function heuristicKeywords(content, max = 5) {
	const words = content.match(/\b[a-zA-Z]{3,}\b/g) ?? [];
	const seen = /* @__PURE__ */ new Set();
	const scored = [];
	for (const w of words) {
		const lower = w.toLowerCase();
		if (STOP_WORDS.has(lower) || seen.has(lower)) continue;
		seen.add(lower);
		const score = /^[A-Z]/.test(w) ? 2 : 1;
		scored.push([lower, score]);
	}
	return scored.sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}
function heuristicContext(content) {
	const match = /^(.+?[.!?])\s/.exec(content);
	if (match) return match[1].trim();
	return content.slice(0, 200).trim();
}
//#endregion
//#region src/evolution.ts
const DECISION_PROMPT = `You are an AI memory evolution agent. Analyze the new memory note and its nearest neighbors to decide if evolution is needed.

New memory:
- Context: {context}
- Content: {content}
- Keywords: {keywords}

Nearest neighbor memories:
{nearest_neighbors_memories}

Based on the relationships between the new memory and its neighbors, decide:
- NO_EVOLUTION: The memory stands alone, no changes needed.
- STRENGTHEN: The new memory should be linked to some neighbors and its tags updated.
- UPDATE_NEIGHBOR: The neighbors' context/tags should be updated based on new understanding.
- STRENGTHEN_AND_UPDATE: Both strengthen and update neighbors.

Respond using EXACTLY this format:
DECISION: <one of NO_EVOLUTION|STRENGTHEN|UPDATE_NEIGHBOR|STRENGTHEN_AND_UPDATE>
REASON: <short justification>`;
const STRENGTHEN_PROMPT = `Given the new memory and its neighbors, provide updated connections and tags.

New memory:
- Content: {content}
- Keywords: {keywords}

Neighbor memories:
{nearest_neighbors_memories}

Which neighbor indices should the new memory connect to? What tags best describe this memory?

Respond using EXACTLY this format:
CONNECTIONS: 0, 2, 3
TAGS: tag1, tag2, tag3, ...`;
const UPDATE_NEIGHBORS_PROMPT = `Given the new memory and its neighbor memories, update each neighbor's context and tags based on a holistic understanding of all these memories together.

New memory:
- Content: {content}
- Context: {context}

Neighbor memories:
{nearest_neighbors_memories}

For each neighbor (indexed 0 to {max_neighbor_idx}), provide updated context and tags. If no change is needed, repeat the original values.

Respond using EXACTLY this format (one block per neighbor):

NEIGHBOR 0:
CONTEXT: updated context sentence
TAGS: tag1, tag2, tag3

NEIGHBOR 1:
CONTEXT: updated context sentence
TAGS: tag1, tag2, tag3

(continue for all {neighbor_count} neighbors)`;
var EvolutionService = class {
	llm;
	constructor(llm) {
		this.llm = llm;
	}
	async decide(input) {
		const neighborsBlock = this.renderNeighbors(input.neighbors);
		const decisionPrompt = DECISION_PROMPT.replace("{context}", input.analysis.context).replace("{content}", input.content).replace("{keywords}", input.analysis.keywords.join(", ")).replace("{nearest_neighbors_memories}", neighborsBlock);
		const { decision, reason } = parseDecision(await this.llm(decisionPrompt, { temperature: .2 }));
		if (decision === "NO_EVOLUTION") return {
			decision,
			reason
		};
		const { connections, tags } = parseStrengthen(await this.llm(STRENGTHEN_PROMPT.replace("{content}", input.content).replace("{keywords}", input.analysis.keywords.join(", ")).replace("{nearest_neighbors_memories}", neighborsBlock), { temperature: .2 }));
		let updatedNeighbors;
		if (decision === "UPDATE_NEIGHBOR" || decision === "STRENGTHEN_AND_UPDATE") {
			const neighborUpdates = parseUpdateNeighbors(await this.llm(UPDATE_NEIGHBORS_PROMPT.replace("{content}", input.content).replace("{context}", input.analysis.context).replace("{nearest_neighbors_memories}", neighborsBlock).replace("{max_neighbor_idx}", String(input.neighbors.length - 1)).replace("{neighbor_count}", String(input.neighbors.length)), { temperature: .2 }), input.neighbors.length);
			updatedNeighbors = input.neighbors.map((n, i) => {
				const upd = neighborUpdates[i] ?? {
					context: "",
					tags: []
				};
				return {
					id: n.id,
					context: upd.context || n.context,
					tags: upd.tags && upd.tags.length > 0 ? upd.tags : n.tags
				};
			});
		}
		return {
			decision,
			reason,
			newLinks: connections.filter((idx) => idx >= 0 && idx < input.neighbors.length).map((idx) => input.neighbors[idx].id),
			updatedTags: tags,
			updatedNeighbors
		};
	}
	renderNeighbors(neighbors) {
		if (neighbors.length === 0) return "(no neighbors)";
		return neighbors.map((n, i) => `[${i}] (id=${n.id.slice(0, 8)}) context="${n.context}" keywords=${n.keywords.join(", ")} tags=${n.tags.join(", ")}`).join("\n");
	}
};
function parseDecision(response) {
	try {
		const cleaned = (response.trim().match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/) ?? [null, response.trim()])[1];
		const json = JSON.parse(cleaned);
		if (json && typeof json === "object") {
			if (json.decision) return {
				decision: normalizeDecision(json.decision),
				reason: json.reason ?? ""
			};
			const should = json.should_evolve;
			const actions = json.actions ?? [];
			if (!should) return {
				decision: "NO_EVOLUTION",
				reason: ""
			};
			const hasStrengthen = actions.includes("strengthen");
			const hasUpdate = actions.includes("update_neighbor");
			if (hasStrengthen && hasUpdate) return {
				decision: "STRENGTHEN_AND_UPDATE",
				reason: ""
			};
			if (hasStrengthen) return {
				decision: "STRENGTHEN",
				reason: ""
			};
			if (hasUpdate) return {
				decision: "UPDATE_NEIGHBOR",
				reason: ""
			};
		}
	} catch {}
	const decisionText = _extractSection(response, "DECISION", ["REASON"]).trim().toUpperCase().replace(/\s+/g, "_");
	const reasonText = _extractSection(response, "REASON", ["DECISION"]).trim();
	return {
		decision: normalizeDecision(decisionText),
		reason: reasonText
	};
}
function normalizeDecision(text) {
	const upper = text.toUpperCase().replace(/\s+/g, "_");
	if (upper === "NO_EVOLUTION" || upper === "STRENGTHEN" || upper === "UPDATE_NEIGHBOR" || upper === "STRENGTHEN_AND_UPDATE") return upper;
	if (upper.includes("STRENGTHEN") && upper.includes("UPDATE")) return "STRENGTHEN_AND_UPDATE";
	if (upper.includes("STRENGTHEN")) return "STRENGTHEN";
	if (upper.includes("UPDATE")) return "UPDATE_NEIGHBOR";
	return "NO_EVOLUTION";
}
function parseStrengthen(response) {
	try {
		const cleaned = (response.trim().match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/) ?? [null, response.trim()])[1];
		const json = JSON.parse(cleaned);
		if (json && typeof json === "object") {
			const conn = json.connections ?? json.suggested_connections ?? [];
			const tags = json.tags ?? json.tags_to_update ?? [];
			return {
				connections: Array.isArray(conn) ? conn.filter((x) => typeof x === "number") : [],
				tags: Array.isArray(tags) ? tags.filter((x) => typeof x === "string") : []
			};
		}
	} catch {}
	const connText = _extractSection(response, "CONNECTIONS", ["TAGS"]);
	const tagsText = _extractSection(response, "TAGS", ["CONNECTIONS"]);
	return {
		connections: connText.split(/[,\n]/).map((s) => parseInt(s.replace(/[^\d-]/g, ""), 10)).filter((n) => !Number.isNaN(n)),
		tags: tagsText.split(/[,\n]/).map((s) => s.replace(/^[-\*\u2022\d.)\s]+/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean)
	};
}
function parseUpdateNeighbors(response, n) {
	const out = [];
	for (let i = 0; i < n; i++) {
		const startMatch = new RegExp(`NEIGHBOR\\s+${i}\\s*:`).exec(response);
		if (!startMatch) {
			out.push({
				context: "",
				tags: []
			});
			continue;
		}
		const start = startMatch.index + startMatch[0].length;
		const nextMatch = new RegExp(`NEIGHBOR\\s+${i + 1}\\s*:`).exec(response.slice(start));
		const end = nextMatch ? start + nextMatch.index : response.length;
		const block = response.slice(start, end);
		const ctx = _extractSection(block, "CONTEXT", ["TAGS"]).trim();
		const tags = _extractSection(block, "TAGS", ["CONTEXT"]).split(/[,\n]/).map((s) => s.replace(/^[-\*\u2022\d.)\s]+/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
		out.push({
			context: ctx,
			tags
		});
	}
	return out;
}
function _extractSection(text, marker, nextMarkers) {
	const match = new RegExp(`^\\s*${marker}\\s*:\\s*(.*)$`, "im").exec(text);
	if (!match) return "";
	const start = match.index + match[0].length;
	const firstLine = match[1].trim();
	let end = text.length;
	for (const nm of nextMarkers) {
		const nmMatch = new RegExp(`^\\s*${nm}\\s*:`, "im").exec(text.slice(start));
		if (nmMatch) {
			const candidate = start + nmMatch.index;
			if (candidate < end) end = candidate;
		}
	}
	const rest = text.slice(start, end).trim();
	return firstLine && rest ? `${firstLine}\n${rest}` : firstLine || rest;
}
//#endregion
//#region src/retriever.ts
var HybridRetriever = class {
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
		if (this.notes.length === 0) return [];
		const bm25Norm = normalize(this.bm25.score(query));
		const semanticScores = this.semanticScore(query);
		const hybrid = bm25Norm.map((s, i) => this.alpha * s + (1 - this.alpha) * semanticScores[i]);
		return topKIndices(hybrid, Math.min(k, hybrid.length));
	}
	semanticScore(query) {
		const qVec = expandToVocab(termFrequency(tokenize(query)), this.bm25.vocab());
		const qNorm = l2(qVec);
		if (qNorm === 0) return new Array(this.notes.length).fill(0);
		return this.notes.map((note) => {
			const docVec = expandToVocab(termFrequency(tokenize(this.documentText(note))), this.bm25.vocab());
			const docNorm = l2(docVec);
			if (docNorm === 0) return 0;
			return dot(qVec, docVec) / (qNorm * docNorm);
		});
	}
	documentText(note) {
		return [
			note.content,
			note.context,
			note.keywords.join(" "),
			note.tags.join(" ")
		].join(" ").toLowerCase();
	}
};
function tokenize(text) {
	return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 1);
}
function termFrequency(tokens) {
	const tf = /* @__PURE__ */ new Map();
	for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
	return tf;
}
function expandToVocab(tf, vocab) {
	return vocab.map((term) => tf.get(term) ?? 0);
}
function dot(a, b) {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
}
function l2(a) {
	return Math.sqrt(dot(a, a));
}
function normalize(scores) {
	if (scores.length === 0) return [];
	const min = Math.min(...scores);
	const range = Math.max(...scores) - min + 1e-6;
	return scores.map((s) => (s - min) / range);
}
function topKIndices(scores, k) {
	const indices = scores.map((score, idx) => ({
		score,
		idx
	}));
	indices.sort((a, b) => b.score - a.score);
	return indices.slice(0, k).map((x) => x.idx);
}
/**
* A small TF-IDF index that mimics BM25Okapi's strengths while
* remaining dependency-free. We use BM25 term weighting with
* standard k=1.5, b=0.75 choices.
*/
var TfIdfIndex = class {
	termDocFreq = /* @__PURE__ */ new Map();
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
		const seen = /* @__PURE__ */ new Set();
		for (const t of tokens) if (!seen.has(t)) {
			seen.add(t);
			this.termDocFreq.set(t, (this.termDocFreq.get(t) ?? 0) + 1);
		}
		this.avgDocLen = this.docLens.reduce((a, b) => a + b, 0) / this.docCount;
	}
	score(query) {
		const qTokens = tokenize(query);
		if (this.docCount === 0) return [];
		const k1 = 1.5;
		const b = .75;
		return this.docs.map((doc, idx) => {
			const docLen = this.docLens[idx];
			let s = 0;
			for (const q of qTokens) {
				const df = this.termDocFreq.get(q) ?? 0;
				if (df === 0) continue;
				const idf = Math.log(1 + (this.docCount - df + .5) / (df + .5));
				let tf = 0;
				for (const t of doc) if (t === q) tf++;
				const norm = tf * 2.5;
				const denom = tf + k1 * (.25 + b * (docLen / (this.avgDocLen || 1)));
				s += idf * (norm / (denom || 1));
			}
			return s;
		});
	}
};
//#endregion
//#region src/memory.ts
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
var AgenticMemoryEngine = class {
	notes = /* @__PURE__ */ new Map();
	retriever;
	analysis;
	evolution;
	storageDir;
	config;
	log;
	dirty = false;
	flushTimer = null;
	constructor(deps) {
		this.config = deps.config;
		this.storageDir = deps.config.storageDir;
		this.log = deps.console ?? {
			info: (msg) => console.log(`[dsh-memory-amem] ${msg}`),
			warn: (msg) => console.warn(`[dsh-memory-amem] ${msg}`),
			error: (msg) => console.error(`[dsh-memory-amem] ${msg}`)
		};
		this.retriever = new HybridRetriever({
			alpha: this.config.hybridAlpha,
			modelName: this.config.embeddingModel
		});
		this.analysis = new AnalysisService(deps.llm.generate);
		this.evolution = new EvolutionService(deps.llm.generate);
		this.storageDir = this.storageDir.replace(/^~/, process.env.HOME ?? "");
	}
	async init() {
		await promises.mkdir(path.join(this.storageDir, "notes"), { recursive: true });
		await this.loadFromDisk();
		this.log.info(`Loaded ${this.notes.size} memory notes from ${this.storageDir}`);
		this.scheduleFlush();
	}
	async dispose() {
		if (this.flushTimer) clearInterval(this.flushTimer);
		await this.flush();
		this.log.info("Disposed, all notes persisted");
	}
	/**
	* Main entry — accepts a piece of content (e.g. a user message or
	* a chunk of sub-agent reasoning) and produces a structured note
	* connected to historical memories.
	*/
	async add(content, opts = {}) {
		if (!content.trim()) throw new Error("Cannot add empty memory");
		const analysis = await this.analysis.analyze(content);
		const neighbors = this.retrieveNeighbors(analysis, this.config.retrievalK);
		const evolution = await this.evolution.decide({
			content,
			analysis,
			neighbors: neighbors.map((r) => r.note)
		});
		const now = Date.now();
		const note = {
			id: v4(),
			content,
			context: analysis.context,
			keywords: analysis.keywords,
			tags: analysis.tags,
			links: [],
			createdAt: now,
			updatedAt: now,
			evolutionHistory: [{
				timestamp: now,
				type: "created",
				reason: "Initial analysis"
			}],
			conversationId: opts.conversationId,
			sessionId: opts.sessionId
		};
		if (this.config.enableEvolution) await this.applyEvolution(note, evolution, neighbors);
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
	search(query, k) {
		const topK = k ?? this.config.retrievalK;
		return this.retrieveNeighbors({
			keywords: query.split(/\s+/),
			context: query,
			tags: []
		}, topK);
	}
	/** Get all notes — used by the prompt injection layer. */
	all() {
		return Array.from(this.notes.values()).sort((a, b) => b.createdAt - a.createdAt);
	}
	/** Get the most relevant notes for the system prompt. */
	topKForPrompt(query, k) {
		return this.search(query, k ?? this.config.retrievalK).map((r) => r.note);
	}
	stats() {
		const notes = Array.from(this.notes.values());
		const withLinks = notes.filter((n) => n.links.length > 0).length;
		const avgLinks = notes.length === 0 ? 0 : notes.reduce((acc, n) => acc + n.links.length, 0) / notes.length;
		const timestamps = notes.map((n) => n.createdAt);
		return {
			total: notes.length,
			withLinks,
			avgLinks,
			oldest: timestamps.length ? Math.min(...timestamps) : 0,
			newest: timestamps.length ? Math.max(...timestamps) : 0
		};
	}
	/** ----- internal helpers ----- */
	documentText(note) {
		return [
			note.content,
			note.context,
			note.keywords.join(" "),
			note.tags.join(" ")
		].join(" ").toLowerCase();
	}
	retrieveNeighbors(analysis, k) {
		if (this.notes.size === 0) return [];
		const query = [analysis.context, ...analysis.keywords].join(" ");
		return this.retriever.retrieve(query, k).map((idx) => this.retriever.noteAt(idx)).filter((n) => !!n).map((note) => ({
			note,
			score: 1
		}));
	}
	async applyEvolution(note, evolution, neighbors) {
		const maxLinks = this.config.maxLinksPerNote;
		const decision = evolution.decision;
		if (decision === "NO_EVOLUTION") return;
		const relatedIds = neighbors.map((n) => n.note.id);
		if (decision === "STRENGTHEN" || decision === "STRENGTHEN_AND_UPDATE") {
			const existing = new Set(note.links);
			const candidates = evolution.newLinks ?? relatedIds.slice(0, maxLinks);
			for (const id of candidates) if (id !== note.id && this.notes.has(id) && note.links.length < maxLinks) {
				if (!existing.has(id)) {
					note.links.push(id);
					existing.add(id);
				}
			}
			if (evolution.updatedTags && evolution.updatedTags.length > 0) note.tags = Array.from(/* @__PURE__ */ new Set([...note.tags, ...evolution.updatedTags]));
			note.evolutionHistory.push({
				timestamp: Date.now(),
				type: "linked",
				reason: evolution.reason || "Strengthen links",
				affectedNotes: note.links.slice()
			});
		}
		if (decision === "UPDATE_NEIGHBOR" || decision === "STRENGTHEN_AND_UPDATE") {
			const updates = evolution.updatedNeighbors ?? [];
			for (const upd of updates) {
				const target = this.notes.get(upd.id);
				if (!target) continue;
				if (upd.context) target.context = upd.context;
				if (upd.tags && upd.tags.length > 0) target.tags = Array.from(/* @__PURE__ */ new Set([...target.tags, ...upd.tags]));
				target.updatedAt = Date.now();
				target.evolutionHistory.push({
					timestamp: Date.now(),
					type: "context-updated",
					reason: evolution.reason || "Neighbor update"
				});
				this.markDirty();
			}
		}
		note.updatedAt = Date.now();
	}
	async loadFromDisk() {
		const notesDir = path.join(this.storageDir, "notes");
		try {
			const files = await promises.readdir(notesDir);
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const raw = await promises.readFile(path.join(notesDir, file), "utf-8");
				const note = JSON.parse(raw);
				this.notes.set(note.id, note);
				this.retriever.registerNote(note);
				this.retriever.addDocument(this.documentText(note));
			}
		} catch (err) {
			if (err.code !== "ENOENT") this.log.warn(`Failed to load notes: ${err.message}`);
		}
	}
	markDirty() {
		this.dirty = true;
	}
	scheduleFlush() {
		this.flushTimer = setInterval(() => {
			if (this.dirty) this.flush();
		}, 5e3);
	}
	async flush() {
		if (!this.dirty) return;
		const notesDir = path.join(this.storageDir, "notes");
		await promises.mkdir(notesDir, { recursive: true });
		for (const note of this.notes.values()) {
			const file = path.join(notesDir, `${note.id}.json`);
			await promises.writeFile(file, JSON.stringify(note));
		}
		const index = path.join(this.storageDir, "index.json");
		await promises.writeFile(index, JSON.stringify({
			notes: Array.from(this.notes.values()).map((n) => ({
				id: n.id,
				updatedAt: n.updatedAt
			})),
			stats: this.stats()
		}));
		this.dirty = false;
	}
};
//#endregion
//#region src/invariant.ts
/** Default values for every config key — single source of truth for `apply`. */
const CONFIG_DEFAULTS = {
	storageDir: "~/.dsh/memory-amem",
	retrievalK: 10,
	hybridAlpha: .5,
	enableEvolution: true,
	enableAutoConsolidation: true,
	maxLinksPerNote: 5,
	embeddingModel: "tfidf-lite",
	llmModel: "auto"
};
/** Service key for `ctx.provide('memoryAmem', ...)`. */
const SERVICE_KEY = "memoryAmem";
//#endregion
//#region src/index.ts
const name = "tool-memory-amem";
const version = "0.2.0";
const inject = [
	"tools",
	"systemPrompt",
	"sessions",
	"llm"
];
/**
* Apply the host half. Receives the Cordis context and the loader-resolved
* config (schema defaults already applied by the DSH loader).
*
* Mirrors the apply() shape of every official DSH plugin
* (see packages/todo/tool-todo, packages/web/tool-web).
*/
function apply(rawCtx, options = {}) {
	const ctx = rawCtx;
	const config = {
		...CONFIG_DEFAULTS,
		...options
	};
	const log = {
		info: (msg) => ctx.logger?.info(`[dsh-tool-memory-amem] ${msg}`),
		warn: (msg) => ctx.logger?.warn(`[dsh-tool-memory-amem] ${msg}`),
		error: (msg) => ctx.logger?.error(`[dsh-tool-memory-amem] ${msg}`)
	};
	const engine = new AgenticMemoryEngine({
		llm: makeLlmAdapter(ctx, log),
		config,
		console: log
	});
	ctx.effect(async () => {
		await engine.init().catch((err) => log.error(`init failed: ${err.message}`));
		return () => {
			engine.dispose().catch((err) => log.error(`dispose failed: ${err.message}`));
		};
	});
	if (ctx.systemPrompt) ctx.systemPrompt.section({
		name: "plugin:tool-memory-amem",
		order: 200,
		text: (assembleCtx) => {
			try {
				const query = lastUserMessage(assembleCtx) ?? "";
				if (!query) return "";
				const notes = engine.topKForPrompt(query, config.retrievalK);
				if (notes.length === 0) return "";
				return renderMemorySection(notes);
			} catch (err) {
				log.warn(`system-prompt inject failed: ${err.message}`);
				return "";
			}
		}
	});
	const tools = ctx.tools;
	if (tools) {
		tools.register(makeMemorySearchTool(engine, config));
		tools.register(makeMemoryAddTool(engine));
		tools.register(makeMemoryStatsTool(engine));
		tools.register(makeMemoryRecentTool(engine));
	}
	ctx.on("session/event", (session, event) => {
		const ev = event;
		if (ev?.type !== "user/message") return;
		const text = extractText(ev.data);
		if (!text || text.length < 4) return;
		const sessionId = session?.id;
		engine.add(text, {
			sessionId,
			conversationId: sessionId
		}).catch((err) => log.warn(`add failed: ${err.message}`));
	});
	ctx.provide(SERVICE_KEY, {
		add: (content) => engine.add(content),
		search: (query, k) => engine.search(query, k),
		stats: () => engine.stats(),
		all: () => engine.all(),
		topKForPrompt: (query, k) => engine.topKForPrompt(query, k)
	});
}
function makeLlmAdapter(ctx, log) {
	const llm = ctx.llm;
	const textFn = llm?.text;
	const generateFn = llm?.generate;
	if (textFn) return {
		available: true,
		generate: async (prompt, opts = {}) => await textFn({
			prompt,
			temperature: opts.temperature ?? .3,
			maxTokens: 1e3
		})
	};
	if (generateFn) return {
		available: true,
		generate: async (prompt, opts = {}) => {
			const out = await generateFn({
				prompt,
				temperature: opts.temperature ?? .3,
				maxTokens: 1e3
			});
			return typeof out === "string" ? out : out.text ?? "";
		}
	};
	log.warn("ctx.llm not available — using fallback analysis (keywords / context will be extracted from raw content)");
	return {
		available: false,
		generate: async (_prompt, _opts = {}) => {
			return `KEYWORDS: (no LLM — using fallback)\nCONTEXT: (no LLM — using fallback)\nTAGS: (no LLM — using fallback)`;
		}
	};
}
function extractText(input) {
	if (!input) return "";
	if (typeof input === "string") return input;
	if (typeof input.content === "string") return input.content;
	const parts = input.parts;
	if (Array.isArray(parts)) return parts.filter((p) => p && p.type === "text").map((p) => p.text ?? "").join("\n");
	if (Array.isArray(input)) return input.map(extractText).join("\n");
	return "";
}
function lastUserMessage(assembleCtx) {
	try {
		const ctxAny = assembleCtx;
		const recent = ctxAny.surface?.recentUserMessages ?? ctxAny.systemPrompt?.recentMessages ?? [];
		for (let i = recent.length - 1; i >= 0; i--) {
			const m = recent[i];
			if (m?.content !== void 0) return extractText(m.content);
		}
	} catch {}
}
function renderMemorySection(notes) {
	return [
		"# Long-term Memory (A-MEM)",
		"The following are relevant notes retrieved from cross-session memory.",
		"Use them when answering questions about prior conversations, established user preferences, or facts the user has shared before.",
		"",
		notes.map((n, i) => {
			const tags = n.tags.length ? `[tags: ${n.tags.join(", ")}]` : "";
			const keywords = n.keywords.length ? `[keywords: ${n.keywords.join(", ")}]` : "";
			return `[memory ${i + 1}] ${n.context} ${tags} ${keywords}\n${n.content.slice(0, 300)}`;
		}).join("\n\n")
	].join("\n");
}
function searchOutputSchema() {
	return {
		type: "object",
		additionalProperties: false,
		properties: {
			query: {
				type: "string",
				required: true
			},
			count: {
				type: "integer",
				required: true
			},
			notes: {
				type: "array",
				required: true,
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						id: {
							type: "string",
							required: true
						},
						context: {
							type: "string",
							required: true
						},
						keywords: {
							type: "array",
							required: true,
							items: { type: "string" }
						},
						tags: {
							type: "array",
							required: true,
							items: { type: "string" }
						},
						content: {
							type: "string",
							required: true
						},
						createdAt: {
							type: "integer",
							required: true
						},
						links: {
							type: "integer",
							required: true
						}
					}
				}
			}
		}
	};
}
function simpleNoteOutputSchema() {
	return {
		type: "object",
		additionalProperties: false,
		properties: {
			id: {
				type: "string",
				required: true
			},
			context: {
				type: "string",
				required: true
			},
			keywords: {
				type: "array",
				required: true,
				items: { type: "string" }
			},
			tags: {
				type: "array",
				required: true,
				items: { type: "string" }
			}
		}
	};
}
function statsOutputSchema() {
	return {
		type: "object",
		additionalProperties: false,
		properties: {
			total: {
				type: "integer",
				required: true
			},
			withLinks: {
				type: "integer",
				required: true
			},
			avgLinks: {
				type: "number",
				required: true
			},
			oldest: {
				type: "integer",
				required: true
			},
			newest: {
				type: "integer",
				required: true
			}
		}
	};
}
function recentOutputSchema() {
	return {
		type: "object",
		additionalProperties: false,
		properties: {
			count: {
				type: "integer",
				required: true
			},
			notes: {
				type: "array",
				required: true,
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						id: {
							type: "string",
							required: true
						},
						context: {
							type: "string",
							required: true
						},
						keywords: {
							type: "array",
							required: true,
							items: { type: "string" }
						},
						tags: {
							type: "array",
							required: true,
							items: { type: "string" }
						},
						content: {
							type: "string",
							required: true
						},
						createdAt: {
							type: "integer",
							required: true
						},
						links: {
							type: "integer",
							required: true
						}
					}
				}
			}
		}
	};
}
function formatSearchOutput(value) {
	if (value.count === 0) return `No memories found for "${value.query}".`;
	return [`Found ${value.count} memories for "${value.query}":`, ...value.notes.map((n, i) => `${i + 1}. [${n.id.slice(0, 8)}] ${n.context}\n   tags: ${n.tags.join(", ")}\n   ${n.content}`)].join("\n\n");
}
function makeMemorySearchTool(engine, config) {
	return defineTool({
		name: "memory_search",
		description: "Search long-term memory for relevant notes. Use before answering questions about previous conversations, user preferences, or established facts. Returns ranked notes with id, context, keywords, tags, and content snippets.",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "The query — natural language or keywords."
			},
			k: {
				type: "integer",
				description: "How many notes to return (default 10)."
			}
		},
		output: {
			schema: searchOutputSchema(),
			render: (_args, value) => [{
				type: "text",
				text: formatSearchOutput(value)
			}]
		},
		execute: async (args) => {
			const results = engine.search(args.query, args.k ?? config.retrievalK);
			return {
				query: args.query,
				count: results.length,
				notes: results.map((r) => ({
					id: r.note.id,
					context: r.note.context,
					keywords: r.note.keywords,
					tags: r.note.tags,
					content: r.note.content.slice(0, 500),
					createdAt: r.note.createdAt,
					links: r.note.links.length
				}))
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Memory search: ${args.query}`,
			kind: "other",
			rawInput: args
		})
	});
}
function makeMemoryAddTool(engine) {
	return defineTool({
		name: "memory_add",
		description: "Manually add a note to long-term memory. The plugin normally auto-captures user messages — only call this when the model must remember something the user did not literally say (a derived preference, an inferred fact, etc.).",
		parameters: { content: {
			type: "string",
			required: true,
			description: "The note content to remember."
		} },
		output: {
			schema: simpleNoteOutputSchema(),
			render: (_args, value) => [{
				type: "text",
				text: `Remembered note ${value.id.slice(0, 8)} (${value.tags.length} tags, ${value.keywords.length} keywords).`
			}]
		},
		execute: async (args) => {
			const note = await engine.add(args.content);
			return {
				id: note.id,
				keywords: note.keywords,
				tags: note.tags,
				context: note.context
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Remember: ${args.content.slice(0, 40)}`,
			kind: "other",
			rawInput: args
		})
	});
}
function makeMemoryStatsTool(engine) {
	return defineTool({
		name: "memory_stats",
		description: "Show memory statistics: total notes, average links, oldest and newest timestamps.",
		parameters: {},
		output: {
			schema: statsOutputSchema(),
			render: (_args, value) => [{
				type: "text",
				text: `Memory has ${value.total} notes (${value.withLinks} with links, avg ${value.avgLinks.toFixed(1)} links/note).`
			}]
		},
		execute: async () => engine.stats(),
		presentCall: () => ({
			card: "generic",
			title: "Memory stats",
			kind: "other",
			rawInput: {}
		})
	});
}
function makeMemoryRecentTool(engine) {
	return defineTool({
		name: "memory_recent",
		description: "List the most recently added memory notes, newest first. Useful for \"what have we talked about lately\".",
		parameters: { limit: {
			type: "integer",
			description: "How many to return (default 20)."
		} },
		output: {
			schema: recentOutputSchema(),
			render: (_args, value) => [{
				type: "text",
				text: value.notes.length === 0 ? "No memories yet." : `${value.notes.length} most recent memories:\n` + value.notes.map((n, i) => `${i + 1}. [${n.id.slice(0, 8)}] ${n.context}`).join("\n")
			}]
		},
		execute: async (args) => {
			const notes = engine.all().slice(0, args.limit ?? 20);
			return {
				count: notes.length,
				notes: notes.map((n) => ({
					id: n.id,
					context: n.context,
					keywords: n.keywords,
					tags: n.tags,
					content: n.content.slice(0, 500),
					createdAt: n.createdAt,
					links: n.links.length
				}))
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Recent memories",
			kind: "other",
			rawInput: args
		})
	});
}
var src_default = {
	name,
	version,
	inject,
	apply
};
//#endregion
export { apply, src_default as default, inject, name, version };

//# sourceMappingURL=index.js.map