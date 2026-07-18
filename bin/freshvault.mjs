#!/usr/bin/env node
// freshvault CLI: serve (default) | setup | index | status
import { parseArgs } from "node:util";
import { loadConfig, indexPathFor } from "../src/config.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    vault: { type: "string" },
    model: { type: "string" },
    "ollama-url": { type: "string" },
    data: { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

const [cmd = "serve", posVault] = positionals;
const cliOpts = {
  vault: values.vault ?? posVault,
  model: values.model,
  ollamaUrl: values["ollama-url"],
  data: values.data,
};

if (values.version) {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}

if (values.help || cmd === "help") {
  console.log(`freshvault — your Obsidian vault is Claude's memory

Usage:
  freshvault setup [--vault <path>]     one-time interactive setup
  freshvault serve [vault]              run the MCP server (stdio) — the default
  freshvault index [vault]              one-shot reindex (normally unnecessary)
  freshvault status [vault]             print index stats

Options:
  --vault <path>        vault folder (overrides env/config)
  --model <name>        embedding model (default bge-m3)
  --ollama-url <url>    Ollama endpoint (default http://localhost:11434)
  --data <dir>          index storage dir

Env vars: FRESHVAULT_VAULT, FRESHVAULT_MODEL, FRESHVAULT_OLLAMA_URL, FRESHVAULT_DATA`);
  process.exit(0);
}

switch (cmd) {
  case "setup": {
    const { runSetup } = await import("../src/setup.mjs");
    await runSetup(cliOpts);
    break;
  }
  case "serve": {
    const { runServer } = await import("../src/server.mjs");
    await runServer(loadConfig(cliOpts));
    break;
  }
  case "index": {
    const cfg = loadConfig(cliOpts);
    if (!cfg.vault) die("No vault configured. Run `freshvault setup` first.");
    const { loadIndex, emptyIndex, reconcile, saveIndex } = await import("../src/indexer.mjs");
    const db = (await loadIndex(cfg.indexPath, { model: cfg.model, vault: cfg.vault })) ?? emptyIndex(cfg.model, cfg.vault);
    const r = await reconcile(db, cfg, {
      onProgress: (done, total) => process.stderr.write(`\r  embedding ${done}/${total} chunks`),
    });
    if (r.newChunks) console.error("");
    await saveIndex(cfg.indexPath, db);
    console.error(`done: ${r.changedFiles} changed notes, ${r.deletedChunks} chunks removed, ${r.newChunks} embedded → ${db.records.length} total chunks`);
    break;
  }
  case "status": {
    const cfg = loadConfig(cliOpts);
    if (!cfg.vault) die("No vault configured. Run `freshvault setup` first.");
    const { loadIndex } = await import("../src/indexer.mjs");
    const db = await loadIndex(cfg.indexPath, { model: cfg.model, vault: cfg.vault });
    if (!db) {
      console.log(`no index yet at ${cfg.indexPath} — run \`freshvault setup\` or \`freshvault index\``);
    } else {
      console.log(`vault: ${cfg.vault}`);
      console.log(`notes: ${Object.keys(db.files).length} · chunks: ${db.records.length}`);
      console.log(`model: ${db.model} · last sync: ${db.lastSync ?? "never"}`);
      console.log(`index: ${cfg.indexPath}`);
    }
    break;
  }
  default:
    die(`Unknown command: ${cmd} (try: freshvault --help)`);
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}
