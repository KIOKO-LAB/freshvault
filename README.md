# freshvault

[![CI](https://github.com/KIOKO-LAB/freshvault/actions/workflows/ci.yml/badge.svg)](https://github.com/KIOKO-LAB/freshvault/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/freshvault)](https://www.npmjs.com/package/freshvault)
[![MCP Registry](https://img.shields.io/badge/MCP_registry-io.github.KIOKO--LAB%2Ffreshvault-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=freshvault)
![node](https://img.shields.io/node/v/freshvault)

[한국어](./README.ko.md) · [日本語](./README.ja.md)

**Your Obsidian vault is Claude's memory. Always fresh, always local.**

Every other vault-search MCP makes you re-run an index command, babysit a watch terminal, or click "Update Index" in a web UI. freshvault watches your vault from *inside* the MCP server: edit a note, and Claude sees it seconds later. Automatically. Forever.

![freshvault demo: save a note, the watcher reindexes it automatically, semantic search finds it seconds later](https://raw.githubusercontent.com/KIOKO-LAB/freshvault/main/docs/demo.gif)

- 🔄 **Never reindex** — the file watcher lives in the server process; boot catch-up absorbs offline edits
- 🔒 **100% local** — embeddings via Ollama (`bge-m3`), your notes never leave your machine
- 🌏 **Multilingual by default** — `bge-m3` handles Korean, Japanese, and 100+ languages that English-only defaults fail on
- 🎯 **Benchmark-driven retrieval** — we built BM25 hybrid fusion, measured it on Korean paraphrase queries, watched it hurt (82.5% → 47.5% top-1), and deleted it. Pure dense, on purpose — [receipts](docs/ko-bench.md)
- 🪶 **No vector DB, no Docker, no Python** — JSON metadata + a Float32 sidecar, plain Node, source you can read in one sitting
- 🧠 **Chunking that respects sentences** — YAML frontmatter stripped, splits on paragraph/sentence boundaries (CJK-aware)

## Install

Prerequisites: [Node 20+](https://nodejs.org) and [Ollama](https://ollama.com).

```bash
npx -y freshvault setup
```

That's it. The wizard detects your Obsidian vault, pulls the embedding model, builds the index, and registers with Claude Code. There is no step 2, and there is never a step 2: no `index` command to re-run, no `watch` terminal, no background service.

<details>
<summary>Manual install (Claude Desktop / Cursor / Windsurf)</summary>

```json
{
  "mcpServers": {
    "freshvault": {
      "command": "npx",
      "args": ["-y", "freshvault", "serve"],
      "env": { "FRESHVAULT_VAULT": "/absolute/path/to/your/vault" }
    }
  }
}
```

Claude Code one-liner:

```bash
claude mcp add freshvault -s user -- npx -y freshvault serve
```

</details>

## Use

Just ask Claude about your notes:

> "Search my notes for what I wrote about cache eviction strategies"

Three tools, all read-only:

| tool | what it does |
|---|---|
| `search_notes` | semantic search — finds meaning, not just keywords |
| `get_note_context` | reads a full note after a search hit (path-traversal safe) |
| `index_status` | freshness report: notes/chunks, last sync, watcher state |

## How it works

```
Obsidian vault ──fs.watch──▶ freshvault MCP server ──search_notes──▶ Claude
   (.md files)               (chunks → bge-m3 embeddings              (generation)
                              → one JSON index, incremental)
```

- **Incremental**: only changed/deleted notes are re-embedded (mtime+size diff), debounced 4s
- **Safety net**: a 60s mtime sweep catches events the watcher misses (network drives, atomic-rename editors)
- **Multi-client safe**: first server process becomes the writer (heartbeated lock); others are readers that hot-reload and promote themselves if the writer dies
- **Transactional**: an embedding-server outage mid-index can never lose or corrupt notes
- **Scale**: vectors live in a packed Float32 sidecar (fast startup, compact); brute-force cosine over thousands of chunks is milliseconds. Honest note: search is still linear — sub-100ms into tens of thousands of chunks, but this is not a vector DB replacement for huge corpora

### Multiple vaults

Register one server per vault — index files are kept per-vault automatically:

```bash
claude mcp add work-vault -s user -e FRESHVAULT_VAULT=/path/to/work -- npx -y freshvault serve
claude mcp add personal-vault -s user -e FRESHVAULT_VAULT=/path/to/personal -- npx -y freshvault serve
```

### Other embedding servers (LM Studio, LiteLLM, OpenAI-compatible)

```bash
FRESHVAULT_EMBED_API=openai FRESHVAULT_EMBED_URL=http://localhost:1234 npx -y freshvault serve
```

Anything speaking `/v1/embeddings` works; `FRESHVAULT_EMBED_KEY` for authenticated endpoints (never written to the config file).

## Configuration

Everything works with zero config after `setup`. Override when needed:

| Flag | Env | Default |
|---|---|---|
| `--vault` | `FRESHVAULT_VAULT` | from `setup` |
| `--model` | `FRESHVAULT_MODEL` | `bge-m3` |
| `--ollama-url` | `FRESHVAULT_OLLAMA_URL` | `http://localhost:11434` |
| `--data` | `FRESHVAULT_DATA` | platform data dir |
| — | `FRESHVAULT_EMBED_API` | `ollama` (or `openai`) |
| — | `FRESHVAULT_EMBED_URL` | `http://localhost:1234` (openai mode) |
| — | `FRESHVAULT_EMBED_KEY` | none (openai mode, optional) |

Commands: `setup` · `serve` (default) · `index` (manual escape hatch) · `status`

## Benchmark

A Korean retrieval micro-benchmark ships in-repo (`node scripts/bench.mjs`) — 30 Korean notes, 40 paraphrase queries, comparing embedding models on top-1/MRR. Results in [docs/ko-bench.md](docs/ko-bench.md).

## Roadmap

- `bge-m3-ko` fine-tune option + expanded published benchmark
- MCPB bundle for one-click Claude Desktop install
- Reranking pass for large vaults

## License

MIT © Kioko Lab
