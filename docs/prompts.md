# A-MEM DSH Plugin — Embedded Prompts

All four prompts are quoted verbatim from the **robust** A-MEM
implementation (WujiangXu/A-mem `llm_text_parsers.py`). The
robust set was chosen because it works with any LLM backend —
no JSON-schema dependency, no function calling.

## 1. ANALYZE_CONTENT_PROMPT

```
Analyze the following content and provide:
1. KEYWORDS: The most important keywords (nouns, verbs, key concepts). Order from most to least important. At least three keywords. Do not include speaker names or time references.
2. CONTEXT: One sentence summarizing the main topic, key points, and purpose.
3. TAGS: Broad categories/themes for classification (domain, format, type). At least three tags.

Respond using EXACTLY this format (one section per header):

KEYWORDS: keyword1, keyword2, keyword3, ...
CONTEXT: A single sentence summarizing the content.
TAGS: tag1, tag2, tag3, ...

Content for analysis:
{content}
```

## 2. EVOLUTION_DECISION_PROMPT

```
You are an AI memory evolution agent. Analyze the new memory note and its nearest neighbors to decide if evolution is needed.

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
REASON: <short justification>
```

## 3. STRENGTHEN_DETAILS_PROMPT

```
Given the new memory and its neighbors, provide updated connections and tags.

New memory:
- Content: {content}
- Keywords: {keywords}

Neighbor memories:
{nearest_neighbors_memories}

Which neighbor indices should the new memory connect to? What tags best describe this memory?

Respond using EXACTLY this format:
CONNECTIONS: 0, 2, 3
TAGS: tag1, tag2, tag3, ...
```

## 4. UPDATE_NEIGHBORS_PROMPT

```
Given the new memory and its neighbor memories, update each neighbor's context and tags based on a holistic understanding of all these memories together.

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

(continue for all {neighbor_count} neighbors)
```

## 5. Focused-Keywords Fallback (heuristic)

When the LLM returns a malformed response, the parser falls back to
extracting capitalized terms and common nouns — see
`_heuristic_keywords` in `src/analysis.ts`. This matches the
heuristic in the A-MEM Python reference.

## Differences from the published A-MEM

The only intentional divergence:

- We use **section-marker format** (KEYWORDS: / CONTEXT: / TAGS:)
  instead of the strict JSON schema, because (a) section-markers are
  cheaper, (b) they work with any backend, and (c) the A-MEM
  repository itself ships `llm_text_parsers.py` as the recommended
  path. The JSON schema path is preserved as a fallback.
