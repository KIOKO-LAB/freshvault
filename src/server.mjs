// freshvault MCP server (stdio).
// The vault watcher lives INSIDE this process: whenever a client keeps the server
// alive, the index keeps itself fresh. On boot, a catch-up reconcile absorbs any
// edits made while no server was running. If another freshvault process already
// holds the writer lock, this one runs as a reader and hot-reloads the index file.
import { watchFile, unwatchFile, statSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadIndex, saveIndex, emptyIndex, reconcile } from "./indexer.mjs";
import { acquireLock, releaseOnExit } from "./lock.mjs";
import { startWatcher } from "./watcher.mjs";
import { searchNotes, formatResults } from "./search.mjs";
import { ollamaUp } from "./ollama.mjs";

const log = (...a) => console.error("[freshvault]", ...a);

export async function runServer(cfg) {
  if (!cfg.vault) {
    log("No vault configured. Run `npx -y freshvault setup` first, or pass a vault path.");
    process.exit(1);
  }

  let db = (await loadIndex(cfg.indexPath, { model: cfg.model, vault: cfg.vault })) ?? emptyIndex(cfg.model, cfg.vault);
  const state = {
    role: "reader",
    watcher: null,
    reconciling: false,
    pending: false,
    lastReconcileAt: db.lastSync ? Date.parse(db.lastSync) : null,
    lastError: null,
  };

  // --- writer election -------------------------------------------------------
  if (acquireLock(cfg.indexPath)) {
    state.role = "writer";
    releaseOnExit(cfg.indexPath);

    const kick = async (reason) => {
      if (state.reconciling) { state.pending = true; return; }
      state.reconciling = true;
      try {
        const r = await reconcile(db, cfg);
        if (r.changedFiles || r.deletedChunks) {
          await saveIndex(cfg.indexPath, db);
          log(`reconciled (${reason}): ${r.changedFiles} changed, ${r.deletedChunks} chunks removed, ${r.newChunks} embedded`);
        }
        state.lastReconcileAt = Date.now();
        state.lastError = null;
      } catch (e) {
        state.lastError = e.message;
        log(`reconcile failed (${reason}): ${e.message} — will retry on next change/sweep`);
      } finally {
        state.reconciling = false;
        if (state.pending) { state.pending = false; kick("pending"); }
      }
    };

    state.watcher = startWatcher(cfg.vault, kick, { debounceMs: 4000, sweepMs: 60000 });
    log(`writer mode · watching ${cfg.vault}${state.watcher.recursiveOk ? "" : " (sweep-only: recursive watch unavailable)"}`);
    kick("boot"); // catch-up scan, non-blocking
  } else {
    // Reader: another server process indexes; we just reload when the file changes.
    log("reader mode · another freshvault process is the writer");
    watchFile(cfg.indexPath, { interval: 5000 }, async () => {
      const fresh = await loadIndex(cfg.indexPath, { model: cfg.model, vault: cfg.vault });
      if (fresh) {
        db = fresh;
        state.lastReconcileAt = db.lastSync ? Date.parse(db.lastSync) : state.lastReconcileAt;
      }
    });
    process.on("exit", () => unwatchFile(cfg.indexPath));
  }

  // --- MCP surface -----------------------------------------------------------
  const server = new Server(
    { name: "freshvault", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_notes",
        description:
          "Semantic search over the user's Obsidian vault (their personal notes). " +
          "Finds note chunks by meaning, not keywords — use for any question about " +
          "the user's notes, knowledge, memos, or past writing. The index auto-updates " +
          "as notes change, so results always reflect the current vault.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to look for (natural language)" },
            top_k: { type: "number", description: "Number of chunks to return (default 5)", default: 5 },
          },
          required: ["query"],
        },
        annotations: { title: "Search vault notes", readOnlyHint: true, openWorldHint: false },
      },
      {
        name: "index_status",
        description:
          "Report the health and freshness of the vault index: note/chunk counts, " +
          "last sync time, watcher state. Use when search results seem stale or empty.",
        inputSchema: { type: "object", properties: {} },
        annotations: { title: "Vault index status", readOnlyHint: true, openWorldHint: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    if (name === "search_notes") {
      if (db.records.length === 0) {
        return text(
          "The vault index is empty. If the server just started on a fresh vault, indexing may still be in progress — try again shortly, or check index_status."
        );
      }
      try {
        const results = await searchNotes(db, cfg, String(args.query ?? ""), clampTopK(args.top_k));
        return text(formatResults(results, db, state));
      } catch (e) {
        return text(`Search failed: ${e.message}\nIf Ollama is not running, start it and try again.`);
      }
    }

    if (name === "index_status") {
      const up = await ollamaUp(cfg.ollamaUrl);
      const lines = [
        `vault: ${cfg.vault}`,
        `notes: ${Object.keys(db.files).length} · chunks: ${db.records.length}`,
        `last sync: ${db.lastSync ?? "never"}${state.lastReconcileAt ? ` (${Math.round((Date.now() - state.lastReconcileAt) / 1000)}s ago)` : ""}`,
        `role: ${state.role}${state.role === "writer" ? ` · watcher: ${state.watcher?.recursiveOk ? "recursive" : "sweep-only"}` : ""}`,
        `reconciling now: ${state.reconciling}`,
        `embedding: ${cfg.model} via ${cfg.ollamaUrl} (${up ? "reachable" : "UNREACHABLE"})`,
        `index file: ${cfg.indexPath}`,
      ];
      if (state.lastError) lines.push(`last error: ${state.lastError}`);
      return text(lines.join("\n"));
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`serving · ${db.records.length} chunks in index`);
}

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

function clampTopK(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(Math.floor(n), 25);
}
