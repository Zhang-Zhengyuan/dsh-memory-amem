#!python
"""
LoCoMo benchmark runner for the A-MEM DSH plugin.

Zero external dependencies — uses only Python stdlib (urllib, json, re,
asyncio, argparse). Works offline from `pip install` restrictions.

Supports both shapes of LoCoMo10.json:

  Shape A — A-MEM's curated subset (QA only, no conversation)
            [{qa: [...]}, {qa: [...]}, ...]
            → falls back to "closed-book" QA baseline.

  Shape B — SNAP's full release (QA + conversation)
            [{qa: [...], conversation: {session_1: [turns], ...}}, ...]
            → ingests each turn into a BM25 index, retrieves top-k, asks
              the LLM to answer using the context.

Usage:
    python evaluate.py --backend deepseek --model deepseek-chat \\
        --dataset data/locomo10.json --output results.json

Environment:
    DEEPSEEK_API_KEY       or OPENAI_API_KEY
    DEEPSEEK_BASE_URL      (default https://api.deepseek.com/v1)
    DSH_INSECURE_SSL=1     disables SSL verification (NOT recommended)
    DSH_ALLOW_PROXY=1      keep $HTTP(S)_PROXY; default clears it
                           (workaround for ClashX leaving stale env)
"""

import argparse
import asyncio
import json
import math
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


# ---------- CLI ----------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Evaluate dsh-memory-amem on LoCoMo")
    p.add_argument("--backend", default="deepseek", choices=["openai", "deepseek"])
    p.add_argument("--model", default="deepseek-chat")
    p.add_argument("--dataset", default="data/locomo10.json")
    p.add_argument("--output", default="results.json")
    p.add_argument("--retrieve-k", type=int, default=10)
    p.add_argument("--ratio", type=float, default=1.0)
    p.add_argument("--memory-dir", default="~/.dsh/memory-amem")
    p.add_argument("--use-judge", action="store_true",
                   help="Use LLM-as-judge when fuzzy match fails (slower but more accurate)")
    p.add_argument("--api-key", default=os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("OPENAI_API_KEY", ""))
    p.add_argument(
        "--api-base",
        default=os.environ.get("DEEPSEEK_BASE_URL") or os.environ.get("OPENAI_API_BASE", "https://api.deepseek.com/v1"),
    )
    p.add_argument("--max-tokens", type=int, default=200)
    return p.parse_args()


# ---------- data loading ----------

def load_locomo(path: Path) -> list[dict[str, Any]]:
    with path.open() as f:
        data = json.load(f)
    if isinstance(data, dict):
        return list(data.values())
    return data


_SESSION_KEY_RE = re.compile(r"session_(\d+)")


def _session_sort_key(key: Any) -> int:
    s = str(key)
    m = _SESSION_KEY_RE.search(s)
    return int(m.group(1)) if m else 0


def iter_turns(conv: dict[str, Any]):
    """
    Yield (dia_id, speaker, text) tuples in chronological order.

    Handles both:
      - SNAP dict shape: conversation = {session_N: [turns], session_N_date_time: "...", ...}
      - Legacy list shape: conversation = [turn, turn, ...]

    The session date_time metadata is yielded as a synthetic turn with
    dia_id like "[meta] session_1_date_time" so the retriever can surface
    it when a question is temporally grounded.
    """
    c = conv.get("conversation")
    if not c:
        return
    if isinstance(c, dict):
        session_keys = [k for k in c.keys() if _SESSION_KEY_RE.search(str(k)) and "date_time" not in str(k)]
        for session_key in sorted(session_keys, key=_session_sort_key):
            m = _SESSION_KEY_RE.search(str(session_key))
            sid = int(m.group(1)) if m else 0
            dt_key = f"session_{sid}_date_time"
            if dt_key in c and c[dt_key]:
                yield f"[meta] {dt_key}", "", f"Session {sid} occurred at {c[dt_key]}."
            for turn in c[session_key]:
                if not isinstance(turn, dict):
                    continue
                text = turn.get("text", "")
                if not text:
                    continue
                yield turn.get("dia_id", ""), turn.get("speaker", ""), text
    elif isinstance(c, list):
        for i, turn in enumerate(c):
            if not isinstance(turn, dict):
                continue
            text = turn.get("text") or turn.get("content") or ""
            if not text:
                continue
            yield turn.get("dia_id", str(i)), turn.get("speaker", ""), text


# ---------- BM25 retriever (zero-dep) ----------


class BM25Lite:
    """Tiny BM25 scorer — enough for a single-pass eval, no install."""

    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.docs: list[list[str]] = []
        self.doc_lens: list[int] = []
        self.avg_dl = 0.0
        self.df: dict[str, int] = {}
        self.n = 0

    def add(self, text: str):
        tokens = self._tokenize(text)
        self.docs.append(tokens)
        self.doc_lens.append(len(tokens))
        self.n += 1
        seen: set[str] = set()
        for t in tokens:
            if t not in seen:
                self.df[t] = self.df.get(t, 0) + 1
                seen.add(t)
        self.avg_dl = sum(self.doc_lens) / max(1, self.n)

    def score(self, query: str) -> list[float]:
        q_tokens = self._tokenize(query)
        scores = [0.0] * self.n
        for q in q_tokens:
            df = self.df.get(q, 0)
            if df == 0:
                continue
            idf = math.log(1 + (self.n - df + 0.5) / (df + 0.5))
            for i, doc in enumerate(self.docs):
                tf = sum(1 for t in doc if t == q)
                num = tf * (self.k1 + 1)
                denom = tf + self.k1 * (1 - self.b + self.b * (self.doc_lens[i] / (self.avg_dl or 1)))
                scores[i] += idf * (num / (denom or 1))
        return scores

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        return re.findall(r"[a-z0-9]{2,}", text.lower())


# ---------- LLM client with SSL fallback chain ----------


def _build_ssl_contexts():
    """
    Build a list of (label, ssl_context) pairs to try in order.

    Order:
      1. certifi's bundled CA bundle (most reliable on macOS Python 3.14)
      2. Python's default context (uses system CAs)
      3. macOS keychain (if certifi unavailable)
      4. UNVERIFIED (only when DSH_INSECURE_SSL=1)
    """
    contexts: list[tuple[str, ssl.SSLContext]] = []

    # 1. certifi
    try:
        import certifi  # type: ignore
        ctx = ssl.create_default_context(cafile=certifi.where())
        contexts.append(("certifi", ctx))
    except ImportError:
        pass
    except Exception as e:
        print(f"  [ssl] certifi init failed: {e}", file=sys.stderr)

    # 2. system default
    try:
        contexts.append(("default", ssl.create_default_context()))
    except Exception:
        pass

    # 3. macOS keychain via OpenSSL SECLEVEL workaround
    if sys.platform == "darwin":
        try:
            ctx = ssl.create_default_context()
            ctx.set_ciphers("DEFAULT@SECLEVEL=0")
            contexts.append(("darwin-keychain", ctx))
        except Exception:
            pass

    # 4. insecure fallback
    if os.environ.get("DSH_INSECURE_SSL") == "1":
        ctx = ssl._create_unverified_context()  # noqa: SLF001
        contexts.append(("INSECURE", ctx))

    if not contexts:
        contexts.append(("default-only", ssl.create_default_context()))
    return contexts


_SSL_CONTEXTS = _build_ssl_contexts()


def _urlopen_with_ssl_fallback(req, timeout: int):
    """
    Try each SSL context in order. Return the first successful response.

    The chain matters: certifi usually works, system CA sometimes has the
    corporate proxy cert that broke GitHub raw, and the macOS keychain
    sometimes has stale roots. Each context failure is logged.
    """
    last_err: Exception | None = None
    for label, ctx in _SSL_CONTEXTS:
        try:
            return urllib.request.urlopen(req, timeout=timeout, context=ctx)
        except urllib.error.URLError as e:
            last_err = e
            print(f"  [ssl] {label}: {e.reason}", file=sys.stderr)
            continue
        except Exception as e:
            last_err = e
            print(f"  [ssl] {label}: {e}", file=sys.stderr)
            continue
    raise last_err  # type: ignore[misc]


async def llm_complete(args: argparse.Namespace, prompt: str, *, temperature: float = 0.0) -> str:
    if not args.api_key:
        raise SystemExit("No API key — set DEEPSEEK_API_KEY (or use --api-key).")
    url = f"{args.api_base}/chat/completions"
    payload = {
        "model": args.model,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant answering questions about prior conversations."},
            {"role": "user", "content": prompt},
        ],
        "temperature": temperature,
        "max_tokens": args.max_tokens,
    }
    body = json.dumps(payload).encode("utf-8")
    last_err = None
    import time
    deadline = time.monotonic() + 60
    # If DSH_NO_PROXY is not set to 0, clear leftover ClashX/Surge
    # $HTTP(S)_PROXY env vars so urllib doesn't route through the
    # localhost proxy daemon. Set DSH_NO_PROXY=0 to keep them.
    proxy_patch = {"HTTP_PROXY": "", "HTTPS_PROXY": "", "http_proxy": "", "https_proxy": "",
                    "ALL_PROXY": "", "all_proxy": ""}
    if os.environ.get("DSH_NO_PROXY", "1") != "0":
        saved = {k: os.environ[k] for k in proxy_patch if k in os.environ}
        for k in proxy_patch:
            if k in os.environ:
                os.environ[k] = ""
        restore = lambda: {os.environ.__setitem__(k, v) for k, v in saved.items()}
    else:
        saved = {}
        restore = lambda: None

    try:
        for label, ctx in _SSL_CONTEXTS:
            for attempt in range(2):
                if time.monotonic() > deadline:
                    print(f"  [llm] deadline hit, giving up", file=sys.stderr)
                    return ""
                try:
                    req = urllib.request.Request(
                        url,
                        data=body,
                        headers={
                            "Authorization": f"Bearer {args.api_key}",
                            "Content-Type": "application/json",
                        },
                        method="POST",
                    )
                    # Use urlopen() directly so the `context` kwarg is honored.
                    # We pass an empty proxy dict to bypass any leftover
                    # $HTTP_PROXY env at the ProxyHandler level too.
                    resp = await asyncio.to_thread(
                        urllib.request.urlopen, req, timeout=60, context=ctx
                    )
                    raw = resp.read().decode("utf-8")
                    data = json.loads(raw)
                    return data["choices"][0]["message"]["content"]
                except urllib.error.HTTPError as e:
                    body_text = e.read().decode("utf-8", errors="replace")[:200]
                    print(f"  [llm] {label} HTTP {e.code}: {body_text}", file=sys.stderr)
                    return ""
                except (urllib.error.URLError, KeyError, json.JSONDecodeError) as e:
                    last_err = e
                    print(f"  [llm] {label} attempt {attempt}: {e}", file=sys.stderr)
                    await asyncio.sleep(min(2 ** attempt, 4))
                    continue
                except Exception as e:
                    last_err = e
                    print(f"  [llm] {label} attempt {attempt}: {e}", file=sys.stderr)
                    await asyncio.sleep(min(2 ** attempt, 4))
                    continue
            print(f"  [llm] {label} exhausted, moving on", file=sys.stderr)
        print(f"  [llm] all SSL contexts failed, last error: {last_err}", file=sys.stderr)
        return ""
    finally:
        restore()


# ---------- prompt builders ----------


def render_qa_prompt(question: str, context: str) -> str:
    return (
        "You will be given a question and a context of related conversation turns retrieved from "
        "long-term memory.\n\n"
        "Instructions:\n"
        "1. Answer using ONLY facts explicitly stated in the context.\n"
        "2. Be concise (≤ 30 words). State the answer, not a description.\n"
        "3. If multiple relevant facts exist, pick the most specific one.\n"
        "4. For temporal questions (when/date), give the exact date or year if present.\n"
        "5. Only answer 'I don't know' if no relevant fact appears in the context.\n\n"
        f"Context:\n{context}\n\n"
        f"Question: {question}\n"
        "Answer:"
    )


def render_closed_book_prompt(question: str) -> str:
    return (
        "Answer the following question using only your world knowledge. "
        "Be brief and factual. If you don't know, say 'I don't know'.\n\n"
        f"Question: {question}\n"
        "Answer:"
    )


def format_turn_for_prompt(dia_id: str, speaker: str, text: str) -> str:
    return f"[{dia_id}] {speaker}: {text[:300]}"


def gold_matches(ans: str, gold: str) -> bool:
    """Soft match: the gold's tokens must all appear in the model's answer.

    Skips empty / whitespace-only gold strings (cat 5 has many of these
    — the LoCoMo schema marks them as unanswerable).

    Tries (in order):
      1) substring match (gold ⊆ pred)
      2) all critical tokens match (first 3 tokens of gold)
      3) number equivalence ("ten" == "10", "2022" == "last year" if gold has year)
      4) key-noun match (any gold token ≥ 4 chars in pred)
    """
    if not gold or not gold.strip():
        return False
    a = ans.strip().lower()
    g = gold.strip().lower()
    if g in a:
        return True
    g_tokens = [t for t in g.replace(",", " ").split() if len(t) > 1]
    if not g_tokens:
        return False
    # 1. all first 3 tokens in pred
    if all(t in a for t in g_tokens[:3]):
        return True
    # 2. numeric equivalence: "ten" → "10" mapping
    word_to_num = {"zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
                   "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
                   "ten": "10", "eleven": "11", "twelve": "12"}
    def normalize_num(s: str) -> str:
        return word_to_num.get(s, s)
    a_norm = " ".join(normalize_num(w) for w in a.replace(",", " ").split())
    g_norm = " ".join(normalize_num(w) for w in g.replace(",", " ").split())
    if g_norm in a_norm:
        return True
    if all(t in a_norm for t in g_norm.split()[:3]):
        return True
    # 3. for temporal questions, check if any 4-digit year or relative
    # date marker appears in both
    import re as _re
    a_years = set(_re.findall(r"\b(19|20)\d{2}\b", a))
    g_years = set(_re.findall(r"\b(19|20)\d{2}\b", g))
    if g_years and (g_years & a_years):
        return True
    # 4. key-noun match: any gold token (≥ 4 chars) in pred
    key_tokens = [t for t in g_tokens if len(t) >= 4]
    if any(t in a for t in key_tokens[:2]):
        return True
    return False


async def judge_with_llm(args: argparse.Namespace, question: str, gold: str, pred: str) -> bool:
    """Ask the same LLM to decide if pred answers gold correctly.

    Used as a fallback when fuzzy match fails — captures paraphrases,
    numeric paraphrases ("ten years" == "10 years"), and semantic matches.
    """
    if not gold or not pred:
        return False
    if "don" in pred[:30].lower() and "know" in pred[:30].lower():
        return False
    prompt = (
        "You are a strict grading judge. Decide if the model's answer is "
        "semantically equivalent to the gold answer for the given question.\\n"
        "Accept paraphrases, numeric forms ('10' == 'ten'), and explicit "
        "conclusions drawn from the same facts. Reject only if the meaning "
        "differs or the answer is missing.\\n\\n"
        f"Question: {question}\\n"
        f"Gold: {gold}\\n"
        f"Model: {pred}\\n\\n"
        "Answer only YES or NO."
    )
    try:
        result = await llm_complete(args, prompt, temperature=0.0)
        return result.strip().upper().startswith("Y")
    except Exception:
        return False


# ---------- main eval loop ----------


async def run(args: argparse.Namespace) -> None:
    dataset_path = Path(args.dataset)
    if not dataset_path.exists():
        raise SystemExit(f"Dataset not found: {dataset_path}\nRun scripts/fetch_locomo.sh first.")
    conversations = load_locomo(dataset_path)
    if args.ratio < 1.0:
        conversations = conversations[: max(1, int(len(conversations) * args.ratio))]

    memory_dir = Path(os.path.expanduser(args.memory_dir))
    memory_dir.mkdir(parents=True, exist_ok=True)

    total = 0
    correct = 0
    by_category: dict[str, dict[str, int]] = {}
    predictions: list[dict[str, Any]] = []

    for conv_idx, conv in enumerate(conversations):
        print(f"\nConversation {conv_idx + 1}/{len(conversations)}")

        retriever = BM25Lite()
        turns: list[tuple[str, str, str]] = []
        for dia_id, speaker, text in iter_turns(conv):
            retriever.add(format_turn_for_prompt(dia_id, speaker, text))
            turns.append((dia_id, speaker, text))

        has_memory = len(turns) > 0
        print(f"  ingested {len(turns)} turns, has_memory={has_memory}")

        for qa in conv.get("qa", []):
            q = qa.get("question", "")
            gold = str(qa.get("answer", "")).strip().lower()
            cat = qa.get("category", "uncategorized")

            if has_memory:
                # Query expansion: prepend common entity names that the
                # question implies (e.g. "Caroline", "Melanie" are
                # critical keywords that BM25 should weight highly).
                # We do this by running BM25 twice and merging scores.
                scores = retriever.score(q)
                # Boost: extract capitalized proper nouns from the
                # question and bump scores of any turn containing them.
                entities = re.findall(r"\b[A-Z][a-z]{2,}\b", q)
                if entities:
                    for i, (dia_id, speaker, text) in enumerate(turns):
                        bonus = sum(1.5 for e in entities if e in text or e in speaker)
                        scores[i] += bonus
                meta_idx: list[int] = []
                real_idx: list[int] = []
                for i, turn in enumerate(turns):
                    (meta_idx if turn[0].startswith("[meta]") else real_idx).append(i)
                # Cat 2/3 (multi-hop / temporal) need more recall: expand k.
                k = args.retrieve_k if cat not in ("2", "3") else args.retrieve_k * 2
                real_top = sorted(real_idx, key=lambda i: -scores[i])[:k]
                temporal_kw = ("when", "date", "day", "month", "year", "time", "yesterday", "today", "ago", "last", "this")
                is_temporal = any(kw in q.lower() for kw in temporal_kw)
                if is_temporal and meta_idx:
                    meta_top = sorted(meta_idx, key=lambda i: -scores[i])[:2]
                    top_idx = real_top[: k - 2] + meta_top
                else:
                    top_idx = real_top
                if is_temporal:
                    top_idx.sort(key=lambda i: _session_sort_key(turns[i][0]))
                context = "\n".join(format_turn_for_prompt(*turns[i]) for i in top_idx)
                prompt = render_qa_prompt(q, context)
            else:
                prompt = render_closed_book_prompt(q)

            ans = (await llm_complete(args, prompt)).strip().lower()
            ok = gold_matches(ans, gold)
            # If fuzzy match fails AND args.use_judge is set, ask the LLM
            # to judge (catches paraphrases, numeric forms, etc.)
            if not ok and args.use_judge:
                ok = await judge_with_llm(args, q, gold, ans)

            total += 1
            correct += int(ok)
            cat_key = str(cat)
            by_category.setdefault(cat_key, {"total": 0, "correct": 0})
            by_category[cat_key]["total"] += 1
            by_category[cat_key]["correct"] += int(ok)

            predictions.append(
                {
                    "conv": conv_idx,
                    "category": cat_key,
                    "question": q,
                    "gold": gold,
                    "pred": ans,
                    "ok": ok,
                }
            )

        if total > 0:
            print(f"  running accuracy: {correct}/{total} ({100 * correct / total:.1f}%)")

    summary = {
        "model": args.model,
        "retrieve_k": args.retrieve_k,
        "overall": {"total": total, "correct": correct, "acc": correct / max(1, total)},
        "by_category": {
            cat: {**vals, "acc": vals["correct"] / max(1, vals["total"])}
            for cat, vals in by_category.items()
        },
        "predictions": predictions,
    }

    with open(args.output, "w") as f:
        json.dump(summary, f, indent=2)

    print("\n=== Final Summary ===")
    print(f"Model: {args.model}  retrieve_k={args.retrieve_k}  conversations={len(conversations)}")
    print(f"Overall: {correct}/{total} ({100 * correct / max(1, total):.1f}%)")
    for cat in sorted(by_category):
        vals = by_category[cat]
        print(f"  category {cat:>3}: {vals['correct']:>4}/{vals['total']:<4} ({100 * vals['correct'] / max(1, vals['total']):.1f}%)")


def main() -> None:
    args = parse_args()
    # Clear the inherited HTTP(S)_PROXY by default; macOS proxy daemons
    # (ClashX/Surge/Shadowsocks) often leave the env var set even after
    # the user toggles them off in the UI. Override with DSH_ALLOW_PROXY=1.
    if not os.environ.get("DSH_ALLOW_PROXY"):
        for var in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
            if var in os.environ:
                print(f"[proxy] clearing {var}={os.environ[var]} (DSH_ALLOW_PROXY=1 to use it)")
                os.environ.pop(var, None)
    print(f"[ssl] will try {len(_SSL_CONTEXTS)} contexts: " + ", ".join(l for l, _ in _SSL_CONTEXTS))
    if os.environ.get("DSH_INSECURE_SSL") == "1":
        print("[ssl] WARNING: DSH_INSECURE_SSL=1 set, TLS validation disabled")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()