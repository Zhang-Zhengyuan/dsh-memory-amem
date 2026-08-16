# dsh-tool-memory-amem

> Long-term agentic memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
> Implementation of [A-MEM](https://arxiv.org/abs/2502.12110) (NeurIPS 2025).
>
> **[中文文档 / Chinese README](README.zh.md)**

DSH ships its own chat agents but has no first-class memory: every new session
starts from zero. `dsh-tool-memory-amem` plugs an A-MEM style agentic memory into
DSH — every user message is captured as a structured note, automatically
linked to existing memories through an LLM-driven evolution step, and
re-injected into the system prompt on every turn so the model can recall
prior conversations.

This plugin follows the canonical DSH plugin model used by every community
plugin in the DSH ecosystem (same package layout as
[`@linxin666/dsh-tool-describe-image`](https://github.com/zhu1090093659/dsh-web-ui/tree/main/packages/dsh-tool-describe-image),
same installation via `dsh plugin --profile web add`).

[![LoCoMo overall accuracy](https://img.shields.io/badge/LoCoMo%20v2-28.6%25-blueviolet)]()
[![LoCoMo multi-hop](https://img.shields.io/badge/Cat%202%20multi--hop-45.9%25-blueviolet)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-green)]()
![Version](https://img.shields.io/badge/version-0.2.0-blue)

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

**Pipeline** (A-MEM §3 plus the v0.3.0 admission gate):
1. **Admission gate** *(v0.3.0)* — deterministic, dependency-free rule-based
   classifier. `hard_block` (sensitive tokens, oversized blobs) and
   `soft_skip` (greetings, filler turns, stack traces) terminate the pipeline
   immediately. `hard_keep` and `uncertain` let the candidate through.
2. **Analyze content** — LLM extracts `keywords[]`, a one-sentence `context`,
   and broad `tags[]`. Falls back to a TF heuristic if the LLM produces nothing
   usable.
3. **Retrieve neighbors** — BM25 (k₁=1.5, b=0.75) over the corpus of note
   documents, α-blended with a TF-IDF semantic score. Returns the top-k notes.
4. **Decide evolution** — LLM picks one of
   `NO_EVOLUTION | STRENGTHEN | UPDATE_NEIGHBOR | STRENGTHEN_AND_UPDATE`.
5. **Apply evolution** — `STRENGTHEN` adds new links and tags.
   `UPDATE_NEIGHBOR` rewrites the context/tags of related notes.
6. **Persist note** — `notes/<uuid>.json` flushed every 5 seconds; index
   reloaded on next `init()`.

**DSH integration** — the plugin follows the canonical DSH plugin model
used by every community plugin (see [`@linxin666/dsh-tool-describe-image`](https://github.com/zhu1090093659/dsh-web-ui)
and the [official plugin guide](https://github.com/zhu1090093659/dsh-web-ui/blob/main/docs/plugins.md)):

| Hook | What we register |
|---|---|
| `cordis.patch.yml` (single line) | Plugin row `id: tool-memory-amem`, `name: @zhang-zhengyuan/dsh-tool-memory-amem` |
| `package.json` `dsh.bundle.patch` | Path to the cordis patch — what `dsh plugin add` reads |
| `package.json` `dsh.client.inject` | `@deepseek-ai/dsh-client-ui-slots` (reserved for v0.2.0 panel) |
| `src/index.ts` `apply(ctx, config)` | Host half — runs in DSH host process |
| `src/client/index.ts` `apply(ctx)` | Browser half — runs in dsh web GUI (UI slot stub for v0.2.0) |
| `src/invariant.ts` | Public constants (config keys, tool names, service key) — safe for other plugins to import |

The four runtime integrations inside the host half:

- **System prompt** — `ctx.systemPrompt.section({ name: 'plugin:tool-memory-amem', order: 200, text: dynamic })`.
  Order 200 sits in the tool-guidance band (same slot as `dsh-task-board`'s
  announcement); the `text` is re-evaluated every turn with the user's
  current message so context is always fresh.
- **Session events** — `ctx.on('session/event', listener)` filters
  `event.type === 'user/message'` and feeds the text into the engine.
- **Tools** — `ctx.tools.register(...)` exposes four tools to the model:
  `memory_search`, `memory_add`, `memory_recent`, `memory_stats`.
- **Service exposure** — `ctx.provide('memoryAmem', api)` lets other
  plugins consume the engine directly via `ctx.inject(['memoryAmem'], ...)`.

---

## LoCoMo benchmark scores (v0.2.0)

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

## Tools

The plugin registers four model-facing tools. All four are declared via
`defineTool` from `@deepseek-ai/dsh-tools`; their `parameters` and
`output.schema` follow the canonical DSH shape (per-property
`required: true` for required fields; omit `required` for optional
ones — see troubleshooting below for the exact rule).

| Tool | Required params | Optional params | Output |
|---|---|---|---|
| `memory_search` | `query: string` | `k: int` (default `retrievalK=10`) | `{ query, count, notes: [{ id, context, keywords, tags, content, createdAt, links, score }] }` |
| `memory_add` | `content: string` | — | `{ id, context, keywords, tags }` |
| `memory_recent` | — | `limit: int` (default `20`) | `{ count, notes: [{ id, context, keywords, tags, content, createdAt, links }] }` |
| `memory_stats` | — | — | `{ total, withLinks, avgLinks, oldest, newest }` |

All four tools return their `output` to the model rendered as plain
text (see `output.render` in `src/index.ts`); the raw JSON is still
available for downstream plugins that consume `ctx.get('memoryAmem')`.

### System-prompt section

In addition to the tools, the plugin registers a dynamic system-prompt
section (order `200`, in the tool-guidance band) that runs the
top-`retrievalK` notes for the current user message and prepends them
to the system prompt before the LLM call. The model sees relevant
prior memories on every turn without having to call `memory_search`
explicitly. The section is transparent — it disappears when the note
store is empty.

---

## Installation into a DSH checkout

Use a `file:` dependency for local development. Unlike `link:`, it installs
the plugin's runtime dependencies and avoids unresolved packages such as
`uuid`.

```powershell
Set-Location D:\path\to\dsh-memory-amem
corepack pnpm install
corepack pnpm build

Set-Location D:\path\to\deepseek-harness
corepack pnpm dsh plugin --profile web add "file:D:\path\to\dsh-memory-amem"
corepack pnpm dsh --profile web
```

The package already declares `dsh.bundle.patch`. Do not also pass its
`cordis.patch.yml` with `--patch`, because that inserts the same plugin id
twice. If `pnpm` is not on `PATH`, use `corepack pnpm` or the absolute
`pnpm.cmd` bundled with your DSH environment.

This plugin installs as a **bundle layer** in the DSH loader. The loader
applies patches in this order — `dsh-base`, `dsh-web-app` (web profile),
your profile's `cordis.patch.yml`, the home-level `cordis.patch.yml`, then
any `--patch` overlays. Installing dsh-memory-amem adds one more bundle
layer on top of `dsh-base` + `dsh-web-app` so every agent gets the
`memory_*` tools and the dynamic system-prompt section. See
[`docs/architecture.md`](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/architecture.md#profiles)
in the DSH repo for the full layered composition model.

### Option 1: bundled installer (mirrors zhu1090093659/dsh-web-ui)

This is the path the official DSH plugin family documents
([`dsh-web-ui` README](https://github.com/zhu1090093659/dsh-web-ui)):

```sh
# 1. clone the plugin repo (this one — or your fork)
git clone https://github.com/Zhang-Zhengyuan/dsh-memory-amem.git
cd dsh-memory-amem

# 2. install + build
pnpm install
pnpm run build

# 3. register it as a bundle layer in the web profile
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add file:/absolute/path/to/dsh-memory-amem

# 4. boot
pnpm dsh --profile web
```

The bundled installer does all of steps 2–3b in one shot:

```sh
# from dsh-memory-amem/
bash scripts/install_into_dsh.sh /path/to/deepseek-harness
```

The profile-local `file:` install is self-contained. Re-run the add command
after rebuilding to refresh the profile copy.

**Verify**:

```sh
pnpm dsh --profile web --dump-config | grep -A1 tool-memory-amem
# should print:
#   - id: tool-memory-amem
#     name: '@zhang-zhengyuan/dsh-tool-memory-amem'
```

**Uninstall**:

```sh
bash scripts/install_into_dsh.sh --unlink /path/to/deepseek-harness
```

### Option 2: `--patch` overlay (for quick local testing)

If you only want to try the plugin without going through the bundle
layer, apply our patch file as an overlay to the running web command:

```sh
# from dsh-memory-amem/
pnpm install
pnpm run build
pnpm link --global

# from DSH monorepo
pnpm link --global @zhang-zhengyuan/dsh-tool-memory-amem
pnpm dsh web --patch "$(pwd)/../dsh-memory-amem/cordis.patch.yml"
```

The patch overlay reaches every bundle row (see comment in
[`examples/web-cordis/cordis.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/main/examples/web-cordis/cordis.yml)),
so the plugin is mounted alongside `dsh-base` and `dsh-web-app`.

### Option 3: edit the profile's `cordis.patch.yml` directly

For a persistent install that survives `pnpm dsh plugin` operations:

```sh
# from dsh-memory-amem/
pnpm install && pnpm run build
pnpm link --global

# from DSH monorepo
pnpm link --global @zhang-zhengyuan/dsh-tool-memory-amem

cat >> ~/.dsh/profiles/web/cordis.patch.yml << 'YAML'

# dsh-memory-amem — long-term agentic memory (A-MEM)
- insert:
    - id: tool-memory-amem
      name: '@zhang-zhengyuan/dsh-tool-memory-amem'
YAML

pnpm dsh web
```

### Troubleshooting

**`ERR_PNPM_IGNORED_BUILDS` on `pnpm dsh plugin add`**: pnpm 11+ blocks
dependency build scripts by default. The profile's `pnpm-workspace.yaml`
at `~/.dsh/profiles/web/pnpm-workspace.yaml` needs an `allowBuilds` entry,
or the offending package's build script must be approved one-shot. This
repo's `pnpm-workspace.yaml` already lists `esbuild` and `cpu-features` for
the dsh-memory-amem install itself; the **profile** config is separate.

```sh
# add to ~/.dsh/profiles/web/pnpm-workspace.yaml:
allowBuilds:
  - esbuild
  - cpu-features
```

Then rerun `pnpm dsh plugin --profile web add file:<repo>`.

**`Module not found '@zhang-zhengyuan/dsh-tool-memory-amem'` at boot**: the
package name isn't on the loader's resolution path. Run
`pnpm dsh plugin --profile web add file:<repo>` to wire it in.

**Hooked but no tool appears in the UI**: restart `pnpm dsh web` after
install; the loader only reads the bundle layer list at boot.

**`failed to apply loader entry tool-memory-amem: unsupported JSON schema:
schema.properties.X.required must be true when present`** (raised at
boot, the loader refuses the entry and the rest of the harness comes up
without the plugin): DSH's `parameterSchemaSpecToJsonSchema` /
`valueSchemaSpecToJsonSchema` reject `required: false` outright. The
`required` field, if you put it on a property, must be the literal
boolean `true` — to mark an optional field, **omit** the `required`
field entirely:

```ts
// WRONG — `required: false` on an optional parameter → DSH rejects:
parameters: {
  k: { type: 'integer', required: false, description: '…' },   // ← bad
}

// RIGHT — omit `required` for optional fields:
parameters: {
  k: { type: 'integer', description: '…' },
}
```

For the `output.schema` side, per-property `required: true` is the
shape `defineTool` accepts — the compiler lifts those into a
top-level `required: [...]` on the wire schema. The canonical DSH
reference is
[`@linxin666/dsh-tool-describe-image`](https://github.com/zhu1090093659/dsh-web-ui/tree/main/packages/dsh-tool-describe-image/src/index.ts);
see the "Invalid schema for function" section below for the full rule
set.

`test/schema.test.ts` re-derives the validator's rejection messages
locally and asserts every output schema in `src/index.ts` stays in the
correct shape, so a regression surfaces in `node --test test/*.test.ts`
instead of at DSH boot time.

**`failed to import loader entry <id>: client-modules: bundle
/plugins/<id>/client.js?rev=… loaded without registering "<id>" via
__ModuleLoader__.load`**: the browser half's bundle (`lib/client.js`)
is fetched by the web shell but the script never calls
`window.__ModuleLoader__.load({ id, factory })`. The DSH web Loader
expects that exact handoff (see
[`@deepseek-ai/deepseek-harness/packages/client/tsdown.client.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/tsdown.client.ts)
lines 269–271 for the canonical banner/footer pair) — without it the
factory never registers and every subsequent `require("<id>")` throws.

The source file just `export function apply(ctx) { … }` (mirroring
in-tree browser plugins like `@deepseek-ai/dsh-client-ui-trajectory`);
the wrapper is **build-time decoration**, not source code. The
`tsdown.config.ts` `clientConfig` must declare:

```ts
outputOptions: {
  entryFileNames: 'client.js',
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
  footer: 'return module.exports; } });',
  intro: 'var module = { exports: {} }; var exports = module.exports;',
},
```

Two side effects to mind:

1. **`format` must be `'cjs'`** (not `'esm'`): the factory closure needs
   a `module.exports` sink the body writes to. ESM has no equivalent.
2. **`src/client/index.ts` must not `import` from `../invariant.ts`**:
   the host half's invariant re-exports `name`/`version` from
   `src/index.ts`, which transitively pulls in `uuid` and other
   server-only deps. Rolldown does not tree-shake those out of a CJS
   bundle, and the client bundle ships `require("uuid")` — which the
   loader's module table cannot answer, and the factory throws. Inline
   any pure-data constant the browser half needs as a literal.

`test/client-bundle.test.ts` re-derives the wrapper contract from the
emitted `lib/client.js` (asserting the `__ModuleLoader__.load` call,
the right id, the `module.exports` sink, the absence of stray
`require()` calls, and the absence of an `../invariant.ts` import in
the source) so a regression surfaces in `node --test test/*.test.ts`
instead of in the browser console.

**`Invalid schema for function 'memory_add': schema must be a JSON
Schema of 'type: "object"', got 'type: null'`** (raised mid-turn, the
whole LLM call fails): the runtime walks every tool's `parameters` and
`output.schema` through `@deepseek-ai/dsh-tools` before the tool hits
the wire. Both compile paths share one rule (the
`describe-image` plugin in
[`zhu1090093659/dsh-web-ui`](https://github.com/zhu1090093659/dsh-web-ui/tree/main/packages/dsh-tool-describe-image)
is the canonical reference for this shape):

1. **Per-property `required: true` is accepted** on both `parameters`
   and `output.schema` properties — the compilers lift them into a
   top-level `required: [...]` array on the wire-format schema.
2. **`required: false` is rejected** with
   `parameters.<name>.required must be true when present` /
   `schema.properties.<name>.required must be true when present`.
   Mark an optional field by **omitting** the `required` field
   entirely (the engine falls back to its own default — `retrievalK`
   for `k` on `memory_search`, `args.limit ?? 20` for `limit` on
   `memory_recent`).
3. **Top-level `required: [...]` is rejected** on `output.schema`
   (`schema.required is not supported by the value schema DSL`) — it
   only appears on the wire-format output, never in the source.

Use `defineTool` from `@deepseek-ai/dsh-tools` rather than bare tool
objects: the helper gives TypeScript a literal-typed schema so
`InferValue<O>` (used to type `execute`'s return) narrows correctly,
and it pulls in the canonical argument and output projections so a
DSH upgrade doesn't silently shift the contract.

`test/schema.test.ts` imports the real `valueSchemaSpecToJsonSchema`
and `parameterSchemaSpecToJsonSchema` from `@deepseek-ai/dsh-tools`,
extracts the four `*OutputSchema()` returns from `src/index.ts` via
a brace-walking shim, compiles each through both paths, and asserts
the compiled schemas are `type: "object"` with non-empty `properties`
and a lifted `required: [...]` array — so any of the three rejection
modes (per-property `required: false`, top-level `required` on
`output.schema`, empty schema) fails the test before the harness can
boot.

**No auxiliary LLM is available**: the plugin uses DSH's public
`ctx.llm.stream()` API. `llmModel: auto` selects the first registered
provider/model; `provider:model` selects an explicit route. If no provider
exists or a call fails, the plugin logs once, uses deterministic multilingual
analysis, and skips evolution. Note creation and retrieval continue working.

### Option 4: standalone HTTP inspector (for the web panel)

```sh
pnpm run dump   # writes web/dump.json from your existing storage
npx serve web    # opens the panel at http://localhost:3000
```

The panel falls back to reading `dump.json` when no WebSocket is
configured — useful for static inspection of exported memories.

---

## Configuration

All options come from the `config:` block in a later cordis patch; the plugin
resolves and validates the defaults itself. Override per-host via
`~/.dsh/cordis.patch.yml` (see [DSH patch format](https://github.com/zhu1090093659/dsh-web-ui/blob/main/docs/plugins.md)):

| Option | Default | Description |
|---|---|---|
| `storageDir` | `~/.dsh/memory-amem` | Where notes live (one JSON per note + `index.json`). |
| `retrievalK` | `10` | Top-k neighbors for system-prompt injection and search. |
| `hybridAlpha` | `0.5` | BM25 ↔ semantic blend weight (0 = pure BM25, 1 = pure semantic). |
| `enableEvolution` | `true` | Run LLM evolution only when relevant neighbors exist. |
| `enableAutoConsolidation` | `true` | Consolidate exact duplicates instead of storing another note. |
| `enableAutoCapture` | `true` | Capture only real DSH messages with source `kind: user`. |
| `enablePromptInjection` | `true` | Inject bounded notes marked explicitly as untrusted historical data. |
| `memoryScope` | `global` | `global` cross-session recall, or `session` isolation. |
| `maxLinksPerNote` | `5` | Cap outbound links. |
| `maxMemoryChars` | `12000` | Maximum accepted note/message length. |
| `promptMaxChars` | `4000` | Hard bound for the complete memory prompt section. |
| `flushIntervalMs` | `5000` | Serialized background flush interval in milliseconds. |
| `embeddingModel` | `tfidf-lite` | Retriever backend (only `tfidf-lite` ships in v0.2.0). |
| `llmModel` | `auto` | First discovered model, a model id, or `provider:model`. |
| `admission.*` | `enabled:true, minLength:8, maxLength:2000, ...` | v0.3.0 admission gate (see below). |

The `admission` block is a namespace; accepted keys are listed below.

| `admission.*` key | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch. Set to `false` to bypass the gate and store every candidate. |
| `minLength` | `8` | Below this length (after trim) the candidate is `soft_skip`ped. |
| `maxLength` | `2000` | Above this length (after trim) the candidate is `hard_block`ed. |
| `sensitivePatterns` | `[]` | Extra raw regex patterns promoted to `hard_block` (e.g. `\\binternal-token-\\d+`). |
| `ephemeralPatterns` | `[]` | Extra raw regex patterns promoted to `soft_skip` (e.g. `^\\[scratch\\]`). |
| `keepPatterns` | `[]` | Extra raw regex patterns promoted to `hard_keep` (e.g. `\\bonly use Hono\\b`). |
| `poisonPatterns` | `[]` | Extra raw regex patterns promoted to `hard_block` against memory-poisoning attacks. |
| `semanticDedupThreshold` | `0.85` | Top-1 neighbour score above which a near-duplicate is consolidated. Set to `1.0` to disable. |
| `semanticDedupMinOverlap` | `0.4` | Minimum Jaccard keyword overlap (in `[0, 1]`) the candidate must share with the top-1 neighbour. |
| `enableLlmReview` | `false` | Reserved for v0.4.0. When `true`, the `uncertain` region is forwarded to a cheap LLM classifier. |

---

## Admission policy (v0.3.0)

Every candidate memory note flows through a four-stage gate **before** it
reaches analysis, evolution, or persistence. Each stage is dependency-free
and deterministic at this version; the architecture deliberately follows
the three-stage pattern recommended by the [Adaptive Memory Admission
Control](https://doi.org/10.48550/arxiv.2603.04549) literature while the
**LLM utility assessor** is kept as a reserved v0.4.0 toggle.

### Stage 1 — Rule-based feature extraction (microseconds)

```
poison   → hard_block  (memory-poisoning attack fingerprints)
sensitive→ hard_block  (secrets, PII, public IPs)
ephemeral→ soft_skip   (greetings, filler, stack traces)
keep     → hard_keep   (explicit decisions, paths, commit refs)
length   → soft_skip / hard_block
default  → uncertain   (kept; flagged for optional LLM review)
```

The poison rule set ships with fingerprints tuned to the OWASP Top 10 for
Agentic Applications (2026) ASI06 family and the
[MINJA](https://christian-schneider.net/blog/persistent-memory-poisoning-in-ai-agents/)
attack methodology:

- `remember X forever` / `记住这个 永远` / `务必记住 永久`
- `always prefer X` / `总是用 X` / `永远都 写`
- `important context for future reference` / `重要背景 供以后参考` /
  `记住这个 以后提一下`
- `send X to <address> whenever Y` — recipient-planting for future exfiltration

Both English and Chinese variants are matched. Add custom fingerprints via
`admission.poisonPatterns`.

**Built-in sensitive rules**: `Bearer xxx` / GitHub `gh*_…` / `sk-…` /
`AKIA…` / `-----BEGIN … PRIVATE KEY-----` / inline `password=…` / email
address / public IPv4 literal / RFC1918 IPv4 with a `host`/`server`
keyword / JWT-shaped triple-base64 string.

**Built-in ephemeral rules**: pure greetings (`hi` / `你好` / `好的` /
`ok` / `thanks` / …), filler turns (`稍等` / `hold on` / …), stack trace
fragments (lines containing `at … (.ts:42:7)`).

**Built-in keep rules**: explicit decision markers (`we've decided`,
`let's use`, `决定用`, `我们决定`, …), commit SHAs and `a..b` ranges,
repo-relative file paths (e.g. `src/api/users.ts`), preference markers
(`I always …`, `我偏好 …`), and verified-fix markers (`fixed by …`,
`用 X 修复了`).

**Precedence**: `poison > sensitive > ephemeral > keep > length > uncertain`.
A sensitive match always wins; a stack trace is rejected even though it
contains file paths; a hard_keep decision is not blocked by `minLength`.

### Stage 1.5 — Semantic near-duplicate consolidation

After the rule filter, the engine reuses the existing `HybridRetriever`
(BM25 + TF-IDF cosine) to find the top-1 neighbour of the candidate.
If its score clears `admission.semanticDedupThreshold` *and* the candidate
shares at least `admission.semanticDedupMinOverlap` Jaccard keywords
with the neighbour, the engine consolidates the candidate into the
neighbour (writes a `merged` entry into its `evolutionHistory`) instead of
storing a fresh note. This mirrors the dedup pass used by
[LongMemEval](https://github.com/xiaowu0162/LongMemEval)'s pruning step
and costs no extra LLM calls — the retrieval already happens for the
evolution step.

Set `semanticDedupThreshold: 1.0` to fall back to exact-match-only
consolidation. Semantic dedup respects `memoryScope`; notes from
different sessions are never merged together.

### Stage 2 — Trust score on every note

Every newly admitted note carries `trustScore: number` in `[0, 1]`,
populated by `computeTrustScore(decision, source)`:

|                       | `hard_keep` | `uncertain` |
| --------------------- | ----------- | ----------- |
| `tool_call` / `service` | **0.9**     | 0.6         |
| `auto_capture`          | 0.7         | **0.5**     |

The score is a continuous signal, not a gate. v0.3.0 ships
`applyTrustRerank()` from `src/admission.ts`:

```ts
const reranked = applyTrustRerank(engine.search(query, 10));
// score *= pow(note.trustScore, 2)  — trust 0.5 keeps only 25%, 0.9 keeps 81%
```

The default search path is unchanged; wire `applyTrustRerank` into your
own UI to demote low-trust entries without dropping them. v0.4.0 will
flip the default once per-host evaluation shows the cut-off.

Legacy notes written by v0.2.0 (without `trustScore`) are hydrated to
`0.5` at load time — no migration script needed.

### Stage 3 — Retrieval-time re-rank (v0.4.0 hook)

Reserved. v0.4.0 will expose `enableTrustRerank: true` to fold
`applyTrustRerank` into the default search path.

### Observability

Every decision is recorded (capped at 200) and exposed through the service
surface:

```ts
ctx.memoryAmem.dumpAdmissions()    // recent {context, decision, timestamp}
ctx.memoryAmem.admissionRules()    // snapshot of active rule set
ctx.memoryAmem.stats()             // trust score distribution available via dsh-web-ui v0.4.0
```

A rejected auto-capture is logged at `info` level (not `warn`) — a blocked
candidate is the policy doing its job, not a failure. Oversized user
messages above `maxMemoryChars` are still rejected by the existing loader
sanity check and logged at `warn`.

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
│   ├── index.ts            Host half: apply() + tool/section registration
│   ├── client/index.ts     Browser half: UI slot stub (v0.2.0 marker)
│   ├── invariant.ts        Public constants (config keys, tool names, service key)
│   ├── memory.ts           AgenticMemoryEngine (analyze + retrieve + evolve)
│   ├── analysis.ts         LLM-driven keyword/context/tag extraction
│   ├── evolution.ts        LLM-driven strengthen/update-neighbor decision
│   ├── retriever.ts        BM25 + TF-IDF cosine hybrid
│   └── types.ts            Core domain types
├── test/                   node:test unit tests
├── scripts/
│   ├── evaluate.py         LoCoMo evaluation harness (Python, deepseek SDK)
│   ├── dump_memory.mjs     Static dump writer for the offline web panel
│   └── install_into_dsh.sh pnpm-link helper for native DSH integration
├── web/                    Static HTML/CSS/JS panel (inspection UI)
├── mcp/                    Standalone MCP server (zero-DSH-intrusion path)
├── data/locomo10.json      LoCoMo benchmark data (10 conversations)
├── cordis.patch.yml        Single-line plugin row (`dsh.bundle.patch` target)
├── tsdown.config.ts        tsdown config for host + browser bundles
├── tsconfig.build.json     emit config (writes to lib/)
└── tsconfig.json           typecheck config (extends build)
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
`openai`-compatible DeepSeek; the native plugin uses `ctx.llm.stream`;
the MCP server uses `fetch` against `/chat/completions`.

---

## License

MIT. See [LICENSE](LICENSE).
