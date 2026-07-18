// freshvault MCP server (stdio).
// The vault watcher lives INSIDE this process: whenever a client keeps the server
// alive, the index keeps itself fresh. On boot, a catch-up reconcile absorbs any
// edits made while no server was running.
//
// Multi-process model: the first server on a vault wins the writer lock and
// indexes; others run as readers that hot-reload the index file. Roles are NOT
// permanent — readers periodically retry the lock and promote themselves when
// the writer dies, and a writer that loses a heartbeat race demotes itself.
import { watchFile, unwatchFile } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadIndex, saveIndex, emptyIndex, reconcile } from "./indexer.mjs";
import { acquireLock, releaseLock, releaseOnExit, heartbeatLock, HEARTBEAT_MS } from "./lock.mjs";
import { startWatcher } from "./watcher.mjs";
import { searchNotes, formatResults } from "./search.mjs";
import { ollamaUp } from "./ollama.mjs";

const PROMOTE_RETRY_MS = 15_000;
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
    heartbeat: null,
    promoteTimer: null,
    reconciling: false,
    pending: false,
    bootReconcileDone: false,
    lastReconcileAt: db.lastSync ? Date.parse(db.lastSync) : null,
    lastError: null,
  };
  releaseOnExit(cfg.indexPath); // safe for readers too: only unlinks our own lock

  // --- writer role -----------------------------------------------------------
  const kick = async (reason) => {
    if (state.role !== "writer") return;
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
      log(`reconcile failed (${reason}): ${e.message} — nothing was lost; will retry on next change/sweep`);
    } finally {
      state.reconciling = false;
      if (reason === "boot") state.bootReconcileDone = true;
      if (state.pending) { state.pending = false; kick("pending"); }
    }
  };

  function becomeWriter(reason) {
    state.role = "writer";
    state.watcher = startWatcher(cfg.vault, kick, { debounceMs: 4000, sweepMs: 60000 });
    state.heartbeat = setInterval(() => {
      if (!heartbeatLock(cfg.indexPath)) {
        log("lost writer lock to another process — demoting to reader");
        becomeReader("demoted");
      }
    }, HEARTBEAT_MS);
    state.heartbeat.unref?.();
    log(`writer mode (${reason}) · watching ${cfg.vault}${state.watcher.recursiveOk ? "" : " (sweep-only: recursive watch unavailable)"}`);
    kick(reason === "promoted" ? "promoted" : "boot"); // catch-up scan, non-blocking
  }

  // --- reader role -----------------------------------------------------------
  const reloadIndex = async () => {
    const fresh = await loadIndex(cfg.indexPath, { model: cfg.model, vault: cfg.vault });
    if (fresh) {
      db = fresh;
      state.lastReconcileAt = db.lastSync ? Date.parse(db.lastSync) : state.lastReconcileAt;
    }
  };

  function becomeReader(reason) {
    state.role = "reader";
    state.watcher?.close();
    state.watcher = null;
    clearInterval(state.heartbeat);
    state.heartbeat = null;
    state.bootReconcileDone = true; // a writer elsewhere owns freshness
    watchFile(cfg.indexPath, { interval: 5000 }, reloadIndex);
    // Re-election: when the writer dies, the first reader to notice takes over.
    state.promoteTimer = setInterval(() => {
      if (acquireLock(cfg.indexPath)) {
        clearInterval(state.promoteTimer);
        state.promoteTimer = null;
        unwatchFile(cfg.indexPath, reloadIndex);
        becomeWriter("promoted");
      }
    }, PROMOTE_RETRY_MS);
    state.promoteTimer.unref?.();
    log(`reader mode (${reason}) · another freshvault process is the writer`);
  }

  if (acquireLock(cfg.indexPath)) becomeWriter("boot");
  else becomeReader("boot");

  // --- shutdown --------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = (why) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${why})`);
    state.watcher?.close();
    clearInterval(state.heartbeat);
    clearInterval(state.promoteTimer);
    unwatchFile(cfg.indexPath, reloadIndex);
    releaseLock(cfg.indexPath);
    process.exit(0);
  };
  // Without this, fs.watch/watchFile keep the event loop alive after the MCP
  // client closes stdio — leaving an orphaned, lock-holding process.
  process.stdin.on("end", () => shutdown("stdin end"));
  process.stdin.on("close", () => shutdown("stdin close"));

  // --- MCP surface -----------------------------------------------------------
  const server = new Server(
    { name: "freshvault", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  server.onclose = () => shutdown("transport closed");

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
        if (state.bootReconcileDone && Object.keys(db.files).length === 0 && !state.lastError) {
          return text(
            `The configured vault contains no markdown notes — check the vault path: ${cfg.vault}\n` +
            `(freshvault indexes .md files; folders starting with "." are skipped)`
          );
        }
        return text(
          state.lastError
            ? `The index is empty and the last indexing attempt failed: ${state.lastError}\nFix that (usually: start Ollama), then just search again — indexing retries automatically.`
            : "The vault index is empty. If the server just started on a fresh vault, indexing may still be in progress — try again shortly, or check index_status."
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
      const noteCount = Object.keys(db.files).length;
      const lines = [
        `vault: ${cfg.vault}`,
        `notes: ${noteCount} · chunks: ${db.records.length}`,
        `last successful sync: ${db.lastSync ?? "never"}`,
        `last check: ${state.lastReconcileAt ? `${Math.round((Date.now() - state.lastReconcileAt) / 1000)}s ago` : "not yet"}`,
        `role: ${state.role}${state.role === "writer" ? ` · watcher: ${state.watcher?.recursiveOk ? "recursive" : "sweep-only"}` : " (another process indexes)"}`,
        `reconciling now: ${state.reconciling}`,
        `embedding: ${cfg.model} via ${cfg.ollamaUrl} (${up ? "reachable" : "UNREACHABLE — start Ollama"})`,
        `index file: ${cfg.indexPath}`,
      ];
      if (noteCount === 0 && state.bootReconcileDone && !state.lastError) {
        lines.push(`note: the vault has no .md files — is the path right?`);
      }
      if (state.lastError) lines.push(`last error: ${state.lastError}`);
      if (db.records.length > 20000) {
        lines.push(`warning: ${db.records.length} chunks — large vault; JSON index may be slow (binary index is on the roadmap)`);
      }
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
