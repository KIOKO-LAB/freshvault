// Interactive setup wizard: detect vault → check Ollama → pull model → initial
// index → save config → register with Claude. Designed to be the ONLY command a
// user ever has to think about.
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, writeConfigFile, readConfigFile, indexPathFor, DEFAULT_MODEL } from "./config.mjs";
import { ollamaUp, hasModel } from "./ollama.mjs";
import { loadIndex, emptyIndex, reconcile, saveIndex } from "./indexer.mjs";

const isWin = platform() === "win32";

function obsidianConfigCandidates() {
  switch (platform()) {
    case "darwin":
      return [join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json")];
    case "win32":
      return [join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "obsidian", "obsidian.json")];
    default:
      return [
        join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "obsidian", "obsidian.json"),
        join(homedir(), ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json"), // flatpak
        join(homedir(), "snap", "obsidian", "current", ".config", "obsidian", "obsidian.json"), // snap
      ];
  }
}

export function detectVaults() {
  for (const p of obsidianConfigCandidates()) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      const vaults = Object.values(j.vaults ?? {})
        .map(v => v.path)
        .filter(v => v && existsSync(v));
      if (vaults.length) return vaults;
    } catch { /* try next */ }
  }
  return [];
}

function commandExists(cmd) {
  const probe = isWin ? "where" : "which";
  return spawnSync(probe, [cmd], { stdio: "ignore", shell: isWin }).status === 0;
}

export async function runSetup(cliOpts = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const say = (s = "") => console.error(s);
  try {
    say("");
    say("freshvault setup — your vault becomes Claude's memory");
    say("──────────────────────────────────────────────────────");

    // 1) vault
    let vault = cliOpts.vault ?? null;
    if (!vault) {
      const found = detectVaults();
      if (found.length === 1) {
        const yn = (await rl.question(`Found Obsidian vault: ${found[0]}\nUse it? [Y/n] `)).trim().toLowerCase();
        if (yn === "" || yn === "y" || yn === "yes") vault = found[0];
      } else if (found.length > 1) {
        say("Found Obsidian vaults:");
        found.forEach((v, i) => say(`  ${i + 1}. ${v}`));
        const pick = Number((await rl.question(`Which one? [1-${found.length}] `)).trim());
        if (pick >= 1 && pick <= found.length) vault = found[pick - 1];
      }
      while (!vault) {
        const manual = (await rl.question("Path to your vault (folder with .md notes): ")).trim();
        if (manual && existsSync(resolve(manual))) vault = resolve(manual);
        else say("  That path doesn't exist — try again.");
      }
    }
    vault = resolve(vault);

    // 2) Ollama
    const cfg = loadConfig({ ...cliOpts, vault });
    if (!(await ollamaUp(cfg.ollamaUrl))) {
      say(`\nOllama is not reachable at ${cfg.ollamaUrl}.`);
      if (commandExists("ollama")) {
        say("Ollama is installed but not running. Start it (`ollama serve`, or the menu-bar app) and re-run:");
      } else {
        say("Install it first:");
        if (platform() === "darwin") say("  brew install ollama && brew services start ollama");
        else if (isWin) say("  winget install Ollama.Ollama");
        else say("  curl -fsSL https://ollama.com/install.sh | sh");
        say("Then re-run:");
      }
      say("  npx -y freshvault setup");
      process.exitCode = 1;
      return;
    }
    say(`\n✓ Ollama reachable at ${cfg.ollamaUrl}`);

    // 3) persist config FIRST — even if later steps fail, `serve` can pick up
    // from here and index on boot.
    writeConfigFile({ ...readConfigFile(), vault, model: cfg.model, ollamaUrl: cfg.ollamaUrl });
    say(`✓ Config saved`);

    // 4) embedding model
    let modelReady = await hasModel(cfg.ollamaUrl, cfg.model);
    if (!modelReady) {
      const yn = (await rl.question(`Embedding model "${cfg.model}" is not pulled yet (~1.2GB for ${DEFAULT_MODEL}). Pull now? [Y/n] `)).trim().toLowerCase();
      if (yn === "" || yn === "y" || yn === "yes") {
        const r = spawnSync("ollama", ["pull", cfg.model], { stdio: ["ignore", "inherit", "inherit"], shell: isWin });
        modelReady = r.status === 0 && (await hasModel(cfg.ollamaUrl, cfg.model));
        if (!modelReady) say(`ollama pull did not complete — run \`ollama pull ${cfg.model}\` manually later.`);
      }
    }

    // 5) initial index (skipped gracefully when the model isn't there yet —
    // the server indexes on boot once the model exists)
    const indexPath = indexPathFor(vault, cfg.dataDir);
    if (modelReady) {
      say(`✓ Embedding model: ${cfg.model}`);
      try {
        const db = (await loadIndex(indexPath, { model: cfg.model, vault })) ?? emptyIndex(cfg.model, vault);
        say("\nIndexing vault (one-time; later updates are automatic)…");
        const res = await reconcile(db, { ...cfg, vault, indexPath }, {
          onProgress: (done, total) => process.stderr.write(`\r  embedding ${done}/${total} chunks`),
        });
        if (res.newChunks) say("");
        await saveIndex(indexPath, db);
        const noteCount = Object.keys(db.files).length;
        say(`✓ Indexed: ${noteCount} notes / ${db.records.length} chunks`);
        if (noteCount === 0) say(`  (no .md files found in ${vault} — is that the right folder?)`);
        if (db.records.length > 20000) say(`  warning: large vault — JSON index may be slow; binary index is on the roadmap`);
      } catch (e) {
        say(`\nInitial indexing failed: ${e.message}`);
        say("Not a problem — the server will index automatically on first run once this is fixed.");
      }
    } else {
      say(`Skipping initial index. When ready: ollama pull ${cfg.model}`);
      say("The server will build the index automatically on its first run after that.");
    }

    // 6) register with Claude
    say("");
    const addCmd = ["mcp", "add", "freshvault", "-s", "user", "--", "npx", "-y", "freshvault", "serve"];
    if (commandExists("claude")) {
      const yn = (await rl.question(`Register with Claude Code now? (runs: claude ${addCmd.join(" ")}) [Y/n] `)).trim().toLowerCase();
      if (yn === "" || yn === "y" || yn === "yes") {
        const r = spawnSync("claude", addCmd, { stdio: ["ignore", "inherit", "inherit"], shell: isWin });
        say(r.status === 0 ? "✓ Registered with Claude Code" : "Registration failed — run the command above manually.");
      }
    } else {
      say("Claude Code CLI not found — register manually:");
      say(`  claude ${addCmd.join(" ")}`);
    }
    say("\nFor Claude Desktop / Cursor / Windsurf, add to your MCP config:");
    say(JSON.stringify({ mcpServers: { freshvault: { command: "npx", args: ["-y", "freshvault", "serve"] } } }, null, 2));
    say("\nDone. Edit a note — it's searchable seconds later. Try asking Claude:");
    say('  "Search my notes for …"');
  } finally {
    rl.close();
  }
}
