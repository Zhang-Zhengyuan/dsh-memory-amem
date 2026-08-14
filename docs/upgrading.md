# Upgrading the Retriever

## Why the default is TF-IDF

The default `HybridRetriever` is dependency-free so the plugin is
lightweight and works offline. The paper uses
`sentence-transformers/all-MiniLM-L6-v2` for embeddings.

## Option A — ONNX Runtime (Node-side)

```bash
pnpm add @xenova/transformers
```

Then in `src/retriever.ts` add:

```ts
import { pipeline, env } from '@xenova/transformers';

env.cacheDir = '~/.dsh/memory-amem/models';

export class OnnxRetriever extends HybridRetriever {
  private extractor: any;
  constructor(opts: RetrieverOptions) {
    super(opts);
    this.extractor = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  async addDocument(text: string): Promise<void> {
    const emb = await this.extractor(text);
    // ... use emb.data as the embedding vector
  }
}
```

## Option B — Out-of-process Sidecar

```ts
// Call a local Python sentence-transformer server
async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch('http://localhost:8080/embed', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  return (await res.json()).embedding;
}
```

This is the cleanest path if you want to keep the Python ecosystem
(where `sentence-transformers` is best-supported) but expose the
service over HTTP.

## Cost-vs-quality trade-off

| Backend | Latency | Quality | Disk |
|---|---|---|---|
| TF-IDF (default) | ~0ms | medium | 0 |
| ONNX MiniLM | ~50ms | high | ~80 MB |
| Remote sentence-transformer | ~200ms | high | 0 |

For interactive agent use, ONNX is the sweet spot. For batch
backfills, the remote sidecar is fine.
