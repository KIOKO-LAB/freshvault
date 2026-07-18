# freshvault

**Your Obsidian vault is Claude's memory. Always fresh, always local.**

Every other vault-search MCP makes you re-run an index command, babysit a watch terminal, or click "Update Index" in a web UI. freshvault watches your vault from *inside* the MCP server: edit a note, and Claude sees it seconds later. Automatically. Forever.

![freshvault demo: save a note, the watcher reindexes it automatically, semantic search finds it seconds later](https://raw.githubusercontent.com/KIOKO-LAB/freshvault/main/docs/demo.gif)

- 🔄 **Never reindex** — the file watcher lives in the server process; boot catch-up absorbs offline edits
- 🔒 **100% local** — embeddings via Ollama (`bge-m3`), your notes never leave your machine
- 🌏 **Multilingual by default** — `bge-m3` handles Korean, Japanese, and 100+ languages that English-only defaults fail on
- 🪶 **No vector DB, no Docker, no Python** — one JSON file, plain Node, source you can read in ten minutes

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

Claude calls `search_notes` (semantic — finds meaning, not keywords) and answers grounded in your actual notes, with sources. `index_status` shows freshness: notes/chunks indexed, last sync seconds ago, watcher state.

## How it works

```
Obsidian vault ──fs.watch──▶ freshvault MCP server ──search_notes──▶ Claude
   (.md files)               (chunks → bge-m3 embeddings              (generation)
                              → one JSON index, incremental)
```

- **Incremental**: only changed/deleted notes are re-embedded (mtime diff), debounced 4s
- **Safety net**: a 60s mtime sweep catches events the watcher misses (network drives, atomic-rename editors)
- **Multi-client safe**: first server process becomes the writer; others are readers that hot-reload the index
- **Honest scale**: brute-force cosine over a few thousand chunks is milliseconds; a 187-note vault indexes to a 15MB JSON. For 5k+ note vaults, a binary index is on the roadmap

## Configuration

Everything works with zero config after `setup`. Override when needed:

| Flag | Env | Default |
|---|---|---|
| `--vault` | `FRESHVAULT_VAULT` | from `setup` |
| `--model` | `FRESHVAULT_MODEL` | `bge-m3` |
| `--ollama-url` | `FRESHVAULT_OLLAMA_URL` | `http://localhost:11434` |
| `--data` | `FRESHVAULT_DATA` | platform data dir |

Commands: `setup` · `serve` (default) · `index` (manual escape hatch) · `status`

## Roadmap

- Korean-optimized pipeline (`bge-m3-ko`) + published retrieval benchmark vs English-only defaults
- Binary vector sidecar for 5k+ note vaults
- MCPB bundle for one-click Claude Desktop install
- `get_note_context` tool (full note + neighbors after a hit)

## License

MIT © Kioko Lab
