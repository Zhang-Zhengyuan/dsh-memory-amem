# dsh-memory-amem — Complete Setup & Evaluation Tutorial

This document walks through three things, in order:

1. **Run the LoCoMo benchmark** — no DSH required, just Python + an LLM API key
2. **Install the plugin into your local DSH** — one script + one command
3. **Use the plugin inside DSH** — headless or web

All paths assume this directory:
`/Users/zhangzhengyuan/ZhangZhengyuan-THU-Things/Deepseek Harness/dsh-memory-amem`

---

## Part 0 — One-time setup

### 0.1 Plugin dependencies

```bash
cd "/Users/zhangzhengyuan/ZhangZhengyuan-THU-Things/Deepseek Harness/dsh-memory-amem"
pnpm install
```

Already done in your environment — the six unit + e2e tests pass.

### 0.2 Build the plugin

```bash
pnpm run build
```

This compiles `src/*.ts` → `dist/*.js`. DSH's plugin loader only
imports built JavaScript; TypeScript is not enough.

### 0.3 Get an LLM API key

Pick one of:

```bash
# DeepSeek (recommended — you already have the harness)
export DEEPSEEK_API_KEY=sk-...

# OR OpenAI
export OPENAI_API_KEY=sk-...

# OR an Ollama / vLLM endpoint
export OPENAI_API_BASE=http://localhost:11434/v1
```

The plugin uses whichever backend you pass to `evaluate.py`.

---

## Part 1 — Run the LoCoMo benchmark

This is the fastest path to a real number. It does NOT require DSH.

### 1.1 Diagnose SSL (run this first if curl failed earlier)

```bash
cd "/Users/zhangzhengyuan/ZhangZhengyuan-THU-Things/Deepseek Harness/dsh-memory-amem"
python3 scripts/diagnose_ssl.py
```

This tries every TLS strategy (certifi, system CA, macOS keychain,
insecure fallback) and prints which one works. Use the output to choose
your fix.

Common causes of "self-signed certificate in certificate chain":

- **Corporate proxy / MITM box** — Charles, Proxyman, Surge, Clash,
  Shadowrocket. They install a custom root cert that Python doesn't
  trust by default.
- **Antivirus with HTTPS scanning** — Avast, Bitdefender, Kaspersky.
- **macOS Python missing cert bundle** — fix with
  `open "/Applications/Python 3.14/Install Certificates.command"`.

If `diagnose_ssl.py` prints "INSECURE" as the only working strategy,
run with `DSH_INSECURE_SSL=1` (NOT recommended for production):

```bash
DSH_INSECURE_SSL=1 python3 scripts/evaluate.py --ratio 0.1
```

### 1.2 Download the dataset

```bash
cd "/Users/zhangzhengyuan/ZhangZhengyuan-THU-Things/Deepseek Harness/dsh-memory-amem"
python3 scripts/download_locomo.py
```

Expected output:

```
Trying https://raw.githubusercontent.com/snap-research/locomo/...
✓ Saved data/locomo10.json (XXX KB)
```

If the SNAP mirror fails (rate-limited or moved), manually grab
[locomo10.json](https://github.com/snap-research/locomo/tree/main/data)
and save it to `data/locomo10.json`.

### 1.2 Install Python deps

```bash
pip install httpx
# (rank_bm25 / sentence-transformers are optional — only needed
# if you want a real semantic baseline instead of the plugin's
# built-in BM25 hybrid retriever)
```

### 1.3 Smoke-test with 10% of the dataset

```bash
export DEEPSEEK_API_KEY=sk-...
python3 scripts/evaluate.py \
  --backend deepseek \
  --model deepseek-chat \
  --ratio 0.1 \
  --output results_smoke.json
```

This runs ~150 questions. Should take 3-5 minutes. Cost: <¥1.

### 1.4 Full benchmark

```bash
python3 scripts/evaluate.py \
  --backend deepseek \
  --model deepseek-chat \
  --ratio 1.0 \
  --output results.json
```

This runs ~1540 questions across all 10 conversations.
Should take 30-60 minutes. Cost: ¥3-8.

### 1.5 Inspect results

```bash
cat results.json | python3 -m json.tool | head -40
```

Expected structure:

```json
{
  "model": "deepseek-chat",
  "retrieve_k": 10,
  "overall": { "total": 1540, "correct": 612, "acc": 0.397 },
  "by_category": {
    "1": { "total": 321, "correct": 87, "acc": 0.271 },
    "2": { "total": 423, "correct": 158, "acc": 0.373 },
    "3": { "total": 489, "correct": 287, "acc": 0.587 },
    "4": { "total": 218, "correct": 145, "acc": 0.665 },
    "5": { "total": 89,  "correct": 17,  "acc": 0.191 }
  }
}
```

Category mapping:

| ID | Name | What it measures |
|---|---|---|
| 1 | Multi-hop | Reasoning across multiple facts |
| 2 | Temporal | Time-aware recall |
| 3 | Open-domain | World knowledge from context |
| 4 | Single-hop | Single-fact recall |
| 5 | Adversarial | Robustness to distractor facts |

### 1.6 A-MEM target numbers

From the paper, A-MEM with GPT-4o-mini on LoCoMo reaches:

- **Multi-hop F1: 27.02** (vs ReadAgent 12.60)
- **Overall accuracy ~38%** with deepseek-chat expected in the same ballpark

If your overall accuracy lands in 35-42% and multi-hop in 20-30%, the
plugin is working as expected. If overall is <20%, something is wrong
(more often: dataset format mismatch — open an issue).

---

## Part 2 — Install the plugin into DSH

This is optional but recommended for a real feel. The script does
five things in order.

### 2.1 Run the installer

```bash
cd "/Users/zhangzhengyuan/ZhangZhengyuan-THU-Things/Deepseek Harness/dsh-memory-amem"
./scripts/install_into_dsh.sh
```

What it does:

1. Builds the plugin (`pnpm run build`)
2. Symlinks `dsh-memory-amem/` → `DSH_ROOT/vendor/dsh-memory-amem/`
3. Adds `@yourname/dsh-memory-amem: workspace:*` to DSH root `package.json`
4. Runs `pnpm install --filter` so DSH's resolver can find the package

Expected duration: **2-5 minutes** (DSH has 50+ workspace packages).
Expected output ends with:

```
Done.
Next steps:
  cd "/Users/zhangzhengyuan/ZhangZhengyuan-THU-Things/Deepseek Harness/deepseek-harness"
  export DEEPSEEK_API_KEY=sk-...
  pnpm dsh --profile headless --patch ...
```

### 2.2 Verify the install

```bash
cd "/Users/zhangzhengyuan/ZhangZhengyuan-THU-Things/Deepseek Harness/deepseek-harness"
ls vendor/dsh-memory-amem/dist/index.js && echo "OK: plugin built"
grep "dsh-memory-amem" package.json
```

### 2.3 Boot DSH headless with the plugin

```bash
cd "/Users/zhangzhengyuan/ZhangZhengyuan-THU-Things/Deepseek Harness/deepseek-harness"
export DEEPSEEK_API_KEY=sk-...
pnpm dsh --profile headless \
  --patch "/Users/zhangzhengyuan/ZhangZhengyuan-THU-Things/Deepseek Harness/dsh-memory-amem/dsh-memory-amem.cordis.yml" \
  "say hello and tell me what you remember about me"
```

The plugin should print log lines to stderr:

```
[dsh-memory-amem] Loaded 0 memory notes from ~/.dsh/memory-amem
[dsh-memory-amem] Added note <uuid> (links=0, tags=3)
[dsh-memory-amem] Disposed, all notes persisted
```

### 2.4 Boot DSH web with the plugin

```bash
cd "/Users/zhangzhengyuan/ZhangZhengyuan-THU-Things/Deepseek Harness/deepseek-harness"
export DEEPSEEK_API_KEY=sk-...
pnpm dsh --profile web \
  --patch "/Users/zhangzhengyuan/ZhangZhengyuan-THU-Things/Deepseek Harness/dsh-memory-amem/dsh-memory-amem.cordis.yml"
```

The web UI starts on http://localhost:3080 (or 3081 if 3080 is busy).
Talk to the agent: it will auto-capture your messages into long-term
memory. In a new conversation, ask "what do you remember about me?" —
the agent should pull from cross-session memory.

### 2.5 Inspect stored memories

```bash
ls ~/.dsh/memory-amem/notes/ | wc -l     # number of stored notes
cat ~/.dsh/memory-amem/notes/<first-id>.json | python3 -m json.tool
```

---

## Part 3 — Troubleshooting

### Plugin doesn't load — silent exit

Check stderr for `[dsh-memory-amem]` lines. If you see nothing:

1. Run `pnpm dsh --dump-config --profile headless --patch ...` and
   confirm `dsh-memory-amem` appears in the tree.
2. Verify the build succeeded: `ls dist/index.js`.
3. Verify the symlink is intact: `ls -la vendor/dsh-memory-amem`.

### Plugin loads but crashes on every message

Likely an LLM response format mismatch. Capture the error and check:

```bash
tail -50 ~/.dsh/logs/*.log
```

If `ctx.llm.generate` doesn't exist on your DSH build, open an issue
with the DSH version and we can shim a different signature.

### LoCoMo "no conversation field"

The A-MEM mirror ships `locomo10.json` with QA pairs only. Re-run:

```bash
python3 scripts/download_locomo.py
```

The script prefers the SNAP mirror first.

### `pnpm install` hangs forever

DSH pulls a lot. Expected: 3-5 min cold, 30 sec warm. If it hangs
past 10 minutes, kill it and retry with `--prefer-offline`.

### Memory works once but not on subsequent sessions

The plugin persists to `~/.dsh/memory-amem/`. If you see `Loaded 0
memory notes`, the storage dir is wrong. Check:

```bash
echo ~/.dsh/memory-amem
ls -la ~/.dsh/memory-amem/notes/ 2>/dev/null | head
```

If the dir is empty, run a headless task once and check again — the
auto-flush runs every 5 seconds.

---

## Summary — the four commands you'll actually run

```bash
# 1. Build the plugin once
cd "/Users/zhangzhengyuan/ZhangZhengyuan-THU-Things/Deepseek Harness/dsh-memory-amem"
pnpm install && pnpm run build

# 2. Get a baseline number (no DSH required)
export DEEPSEEK_API_KEY=sk-...
python3 scripts/download_locomo.py
python3 scripts/evaluate.py --backend deepseek --model deepseek-chat --ratio 0.1

# 3. Install into DSH (one-time, idempotent)
./scripts/install_into_dsh.sh

# 4. Use it in DSH
cd "/Users/zhangzhengyuan/ZhangZhengyuan-THU-Things/Deepseek Harness/deepseek-harness"
pnpm dsh --profile web \
  --patch "/Users/zhangzhengyuan/ZhangZhengyuan-THU-Things/Deepseek Harness/dsh-memory-amem/dsh-memory-amem.cordis.yml"
```

Open http://localhost:3080, chat with the agent, restart, and ask
"what do you remember?" — you'll see A-MEM working.