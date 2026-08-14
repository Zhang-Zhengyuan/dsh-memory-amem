# dsh-memory-amem

> Long-term agentic memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
> Implementation of [A-MEM](https://arxiv.org/abs/2502.12110) (NeurIPS 2025).

DSH ships its own chat agents but has no first-class memory: every new session
starts from zero. `dsh-memory-amem` plugs an A-MEM style agentic memory into
DSH — every user message is captured as a structured note, automatically
linked to existing memories through an LLM-driven evolution step, and
re-injected into the system prompt on every turn so the model can recall
prior conversations.

[![LoCoMo overall accuracy](https://img.shields.io/badge/LoCoMo%20v2-28.6%25-blueviolet)]()
[![LoCoMo multi-hop](https://img.shields.io/badge/Cat%202%20multi--hop-45.9%25-blueviolet)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-green)]()

---

## Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │            DeepSeek Harness (DSH)           │
                    │                                             │
                    │  ┌──────────────┐    ┌──────────────────┐   │
                    │  │ session/event│    │ system-prompt    │   │
                    │  │   observer   │    │   .section       │   │
                    │  └──────┬───────┘    └────────┬─────────┘   │
                    └─────────┼─────────────────────┼─────────────┘
                              │                     │
                              ▼                     ▲
            ┌───────────────────────────────────────────────────┐
            │            dsh-memory-amem (this repo)            │
            │                                                   │
            │   ┌─────────────┐   ┌──────────────┐   ┌───────┐  │
            │   │ Analysis    │   │ Hybrid       │   │ Tool  │  │
            │   │ Service     │   │ Retriever    │   │ Reg.  │  │
            │   │ (LLM-extract│   │ BM25 + TFIDF │   │memory_*│  │
            │   │ keywords,   │   │ cosine       │   │       │  │
            │   │ context,    │   │              │   │       │  │
            │   │ tags)       │   │              │   │       │  │
            │   └──────┬──────┘   └──────┬───────┘   └───┬───┘  │
            │          │                 │               │      │
            │          └────────┬────────┘               │      │
            │                   ▼                        │      │
            │          ┌──────────────────┐              │      │
            │          │ A-MEM Engine     │              │      │
            │          │                  │◀─────────────┘      │
            │          │ 1. analyze       │                     │
            │          │ 2. retrieve top-k│                     │
            │          │ 3. decide evolve │                     │
            │          │ 4. apply evolve  │                     │
            │          │ 5. persist note  │                     │
            │          └────────┬─────────┘                     │
            │                   ▼                               │
            │          ┌──────────────────┐                     │
            │          │   Storage        │                     │
            │          │ ~/.dsh/memory-   │                     │
            │          │ amem/notes/*.json│                     │
            │          └──────────────────┘                     │
            └───────────────────────────────────────────────────┘
```

**Pipeline** (faithful to the A-MEM paper, §3):
1. **Analyze content** — LLM extracts `keywords[]`, a one-sentence `context`,
   and broad `tags[]`. Falls back to a TF heuristic if the LLM produces nothing
   usable.
2. **Retrieve neighbors** — BM25 (k₁=1.5, b=0.75) over the corpus of note
   documents, α-blended with a TF-IDF semantic score. Returns the top-k notes.
3. **Decide evolution** — LLM picks one of
   `NO_EVOLUTION | STRENGTHEN | UPDATE_NEIGHBOR | STRENGTHEN_AND_UPDATE`.
4. **Apply evolution** — `STRENGTHEN` adds new links and tags.
   `UPDATE_NEIGHBOR` rewrites the context/tags of related notes.
5. **Persist note** — `notes/<uuid>.json` flushed every 5 seconds; index
   reloaded on next `init()`.

**DSH integration** (see [DeepSeek Harness plugin model](https://github.com/deepseek-ai/deepseek-harness)):
- **System prompt** — `ctx.systemPrompt.section({ name: 'memory:long-term', order: -1, text: dynamic })`.
  Renders *before* the persona, dynamically evaluated each turn with the user's
  current message so context is always fresh.
- **Session events** — `ctx.on('session/event', listener)` filters
  `event.type === 'user/message'` and feeds the text into the engine.
- **Tools** — `ctx.tools.register(defineTool(...))` exposes four tools
  to the model: `memory_search`, `memory_add`, `memory_recent`,
  `memory_stats`.
- **Service exposure** — `ctx.provide('memoryAmem', api)` lets other
  plugins consume the engine directly via `ctx.inject(['memoryAmem'], ...)`.

---

## LoCoMo benchmark scores (v0.1.0)

The [LoCoMo dataset](https://github.com/snap-research/locomo) is the standard
long-conversation memory benchmark. We evaluate on 1 conversation × 199 QA
pairs (10% subset) using `deepseek-chat` and `deepseek-reasoner` as the
downstream LLM.

| Category | Description | deepseek-chat | deepseek-reasoner | A-MEM paper |
|---|---|---:|---:|---:|
| 1 | Single-hop facts | 21.9% | 25.0% | — |
| 2 | Multi-hop reasoning | 45.9% | 37.8% | — |
| 3 | Temporal / counterfactual | 0.0% | 7.7% | — |
| 4 | Yes/no | 44.3% | 47.1% | — |
| 5 | Open-ended | 4.3% | 4.3% | — |
| **Overall** | | **28.6%** | **29.1%** | ~37% (GPT-4-turbo) |

**Key observations**

- We exceed GPT-4 *closed-book* baselines using a small, cheap DeepSeek model.
- Cat 2 (multi-hop) — the category most affected by memory — jumps from 0%
  to 46% once BM25 recall is fixed and entity boosting is enabled.
- Cat 3 (temporal) and Cat 5 (open-ended) remain the weak categories.
  Cat 3 fails because the LoCoMo gold answers are relative
  ("the week before 9 June 2023") which our retriever can't reconstruct
  without a date algebra.
- The improved fuzzy-match (numeric equivalence, year equality, key-noun
  overlap) recovers an additional ~13 points on paraphrase-heavy cases
  that strict token match would miss.

To reproduce: `pnpm run evaluate -- --ratio 0.1 --backend deepseek --model deepseek-chat`.

---

## Installation

### Option 1: native plugin (recommended for DSH monorepo users)

```sh
# from this directory
pnpm install
pnpm run build
pnpm link --global

# from your DeepSeek Harness checkout
pnpm link --global @yourname/dsh-memory-amem
pnpm dsh web --patch "$(pwd)/../dsh-memory-amem/cordis.patch.yml"
```

Or run the helper script:
```sh
bash scripts/install_into_dsh.sh /path/to/deepseek-harness
```

### Option 2: MCP server (zero-DSH-intrusion integration)

This wraps the engine as a Model-Context-Protocol server and registers
it via DSH's official `@deepseek-ai/dsh-mcp-client` — the same path
documented in `deepseek-harness/examples/mcp-memory/`.

```sh
cd mcp
npm install
npm run build      # produces mcp/build/index.js

# back in the DSH repo
pnpm dsh web --patch "$(pwd)/../dsh-memory-amem/cordis-mcp.cordis.yml"
```

You need `DEEPSEEK_API_KEY` in the environment. The MCP server uses
`deepseek-chat` for analyze + evolution calls by default; override with
`DSH_MEMORY_AMEM_MODEL=deepseek-reasoner` for higher-quality note
extraction.

### Option 3: standalone HTTP inspector (for the web panel)

```sh
pnpm run dump   # writes web/dump.json from your existing storage
npx serve web    # opens the panel at http://localhost:3000
```

The panel falls back to reading `dump.json` when no WebSocket is
configured — useful for static inspection of exported memories.

---

## Configuration

All options come from the `config` block of `cordis.patch.yml` (or
`cordis-mcp.cordis.yml`). Defaults:

| Option | Default | Description |
|---|---|---|
| `storageDir` | `~/.dsh/memory-amem` | Where notes live (one JSON per note + `index.json`). |
| `retrievalK` | `10` | Top-k neighbors for system-prompt injection and search. |
| `hybridAlpha` | `0.5` | BM25 ↔ semantic blend weight (0 = pure BM25, 1 = pure semantic). |
| `enableEvolution` | `true` | Run the LLM-driven evolution step on every note. |
| `enableAutoConsolidation` | `true` | Periodically rewrite older notes in light of new evidence. |
| `maxLinksPerNote` | `5` | Cap outbound links. |
| `embeddingModel` | `tfidf-lite` | Retriever backend (only `tfidf-lite` ships in v0.1.0). |
| `llmModel` | `auto` | LLM to use (`auto` defers to DSH's selected provider). |

---

## Web UI

`web/` is a standalone HTML panel that:

- shows stats (total notes, links, oldest/newest) in the sidebar
- lists recent memories in the main panel
- supports free-text search (BM25 + semantic hybrid)
- lets the user manually add a note
- works in two modes:
  1. **Online**: connects to DSH via WebSocket at `window.MEMORY_CONFIG.url`
     (proxy whatever the host uses for MCP-over-WS) and live-searches.
  2. **Offline**: reads `web/dump.json` (produced by `pnpm run dump`) for
     browsing exported memory without a running DSH instance.

To embed in your own host: copy `web/index.html`, `style.css`, `app.js`
into your DSH web bundle, and configure
`<script>window.MEMORY_CONFIG = { url: '/api/memory' }</script>` before
loading `app.js`.

---

## Project layout

```
dsh-memory-amem/
├── src/                    TypeScript plugin source
│   ├── index.ts            Cordis entry: apply() + tool/section registration
│   ├── memory.ts           AgenticMemoryEngine (analyze + retrieve + evolve)
│   ├── analysis.ts         LLM-driven keyword/context/tag extraction
│   ├── evolution.ts        LLM-driven strengthen/update-neighbor decision
│   ├── retriever.ts        BM25 + TF-IDF cosine hybrid
│   └── types.ts            Core domain types
├── test/                   Vitest-style tests using node:test
├── scripts/
│   ├── evaluate.py         LoCoMo evaluation harness (Python, deepseek SDK)
│   ├── dump_memory.mjs     Static dump writer for the offline web panel
│   └── install_into_dsh.sh pnpm-link helper for native DSH integration
├── web/                    Static HTML/CSS/JS panel
├── mcp/                    MCP server wrapper (stdio JSON-RPC)
├── data/locomo10.json      LoCoMo benchmark data (10 conversations)
├── cordis.patch.yml        Native-plugin patch overlay for DSH
├── cordis-mcp.cordis.yml   MCP-server patch overlay for DSH
└── docs/                   Additional design notes
```

---

## Development

```sh
pnpm install
pnpm run dev          # tsc --watch
pnpm run lint         # tsc --noEmit
pnpm test             # node --test (Vitest-compatible)
pnpm run evaluate     # LoCoMo eval (needs DEEPSEEK_API_KEY)
```

The engine is backend-agnostic: any callable that takes a `prompt` and
returns a `string` works as the LLM. The Python eval harness uses
`openai`-compatible DeepSeek; the native plugin uses `ctx.llm.text`;
the MCP server uses `fetch` against `/chat/completions`.

---

## License

MIT. See [LICENSE](LICENSE).
