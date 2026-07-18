# Korean retrieval benchmark (ko-bench)

**TL;DR: the default local embedding model everyone uses is English-only, and it costs you 72 points of top-1 accuracy on Korean. Also: we built hybrid BM25 fusion, benchmarked it, and deleted it.**

Fixture: [`tests/fixtures/ko-bench.json`](../tests/fixtures/ko-bench.json) — 30 Korean personal-vault-style notes, 40 queries deliberately written to NOT share keywords with their target note (25 paraphrase, 10 colloquial, 5 Korean-English code-switching). Reproduce with:

```bash
node scripts/bench.mjs bge-m3 nomic-embed-text
```

## Embedding model comparison (dense cosine, top-1 / MRR)

| model | top-1 | MRR | note |
|---|---|---|---|
| **bge-m3** (freshvault default) | **82.5%** | **0.894** | multilingual, ~1.2GB |
| nomic-embed-text (common Ollama default) | 10.0% | 0.189 | English-only — near-random on Korean |

`nomic-embed-text` is the de-facto default in most local RAG tutorials and tools. On Korean paraphrase queries it retrieves the right note **1 time in 10**. This is why freshvault defaults to `bge-m3`.

## Why freshvault is dense-only (the feature we deleted)

We implemented dense+BM25 hybrid scoring, assumed it would help, then measured (bge-m3 embeddings, same fixture):

| fusion strategy | top-1 |
|---|---|
| **dense only** | **82.5%** |
| dense 0.9 + BM25 0.1 | 70.0% |
| dense + rare-term boost (df ≤ 15%) | 62.5% |
| dense 0.7 + BM25 0.3 | 47.5% |
| RRF (k=60) | 37.5% |

Every fusion variant made Korean retrieval worse. Korean is agglutinative — surface tokens carry particles (`메모리에서` ≠ `메모리`), so raw-token lexical matching fires mostly on incidental shared words and overrides correct dense rankings. A proper Korean morphological analyzer might change this; a naive BM25 does not, so it's gone.

Caveats, honestly stated:

- The fixture is small (30/40) and synthetic — written to test paraphrase retrieval, which is dense embeddings' home turf and lexical matching's worst case. Exact-identifier lookup ("find the note with XYZZY-9000") is the case hybrid would help; it's rarer in note-vault usage.
- Generated + human-reviewed dataset, single run, one machine. Treat as directional, not SOTA-grade. The point stands at this effect size.
- `bge-m3-ko` (Korean fine-tune) evaluation is planned next.
