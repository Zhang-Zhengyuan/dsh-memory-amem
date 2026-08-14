# A-MEM DSH Plugin — Architecture Notes

## 1. Why a Cordis plugin

DSH is built on Cordis. Every capability — tools, sessions, prompts
— is a Cordis service that publishes events. The plugin model fits
A-MEM cleanly because:

1. **A-MEM has a single state.** One notes map + one retriever +
   one LLM-callable API. Cordis services match this shape.
2. **A-MEM hooks into well-defined events.** `session/event` is the
   only place we read from; `systemPrompt.injectSection` is the only
   place we write into the agent loop.
3. **A-MEM is provably side-effect minimal.** When the engine has no
   notes, no section is injected. When the LLM call fails, the
   stage logs and the harness continues.

## 2. The 5-step pipeline → 5 functions

| A-MEM step | File | Function |
|---|---|---|
| analyze_content | `analysis.ts` | `AnalysisService.analyze` |
| retrieve_neighbors | `retriever.ts` | `HybridRetriever.retrieve` |
| decide_evolution | `evolution.ts` | `EvolutionService.decide` |
| process_evolution | `memory.ts` | `AgenticMemoryEngine.applyEvolution` |
| persist_link | `memory.ts` | `AgenticMemoryEngine.flush` |

## 3. Retriever design

The original A-MEM uses `sentence-transformers/all-MiniLM-L6-v2` for
embeddings. Running that in Node requires either ONNX or a network
hop. To keep the plugin dependency-free, the default retriever uses
**TF-IDF + cosine similarity** with the same alpha-weighted hybrid
score as the paper:

```
hybrid = alpha * bm25_score + (1 - alpha) * semantic_score
```

`HybridRetriever.documentText()` builds a single string from
`content + context + keywords + tags` — identical to the Python
implementation.

For higher fidelity, see `docs/upgrading.md` — we provide a
`RealEmbeddingRetriever` sketch that uses `@xenova/transformers`.

## 4. Why do we call the LLM 4 times per `add()`?

The A-MEM paper's tightest ablation is the evolution decision. To
preserve the paper's reported mechanism we mirror it exactly:

1. `analyze_content` — extract keywords/context/tags
2. `decide_evolution` — NO_EVOLUTION / STRENGTHEN / UPDATE_NEIGHBOR / STRENGTHEN_AND_UPDATE
3. `strengthen_details` — only if STRENGTHEN or STRENGTHEN_AND_UPDATE
4. `update_neighbors` — only if UPDATE_NEIGHBOR or STRENGTHEN_AND_UPDATE

When `enableEvolution: false` we collapse this to 1 LLM call.

## 5. Why JS rather than Python?

DSH is a TypeScript monorepo. Python would require a separate
sidecar. The prompts are language-agnostic — the only state (notes
+ links) is JSON-serializable, so the engine could be reimplemented
in any language without changing the user-facing behavior.

## 6. Extension points

- **Real embeddings**: swap `HybridRetriever` for `RealEmbeddingRetriever`
- **Conflict resolution**: add a post-step in `applyEvolution` that
  detects two notes with the same key context and time-cuts the older one
- **Selective forgetting**: add a `forget(noteId, reason)` method and
  trigger it from a policy in `index.ts`
- **Visualization**: emit `memory/note-created`, `memory/note-linked`,
  `memory/note-evolved` events for the Web UI to subscribe to
