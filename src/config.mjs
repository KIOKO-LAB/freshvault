// Config resolution: CLI flags > env vars > ~/.config/freshvault/config.json > defaults
import { homedir, platform } from "node:os";
import { join, resolve, basename } from "node:path";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const DEFAULT_MODEL = "bge-m3";
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const CHUNK_CHARS = 1000;
export const CHUNK_OVERLAP = 150;
export const INDEX_VERSION = 1;

export function configDir() {
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "freshvault");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg || join(homedir(), ".config"), "freshvault");
}

export function dataDir() {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "freshvault");
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "freshvault", "data");
    default: {
      const xdg = process.env.XDG_DATA_HOME;
      return join(xdg || join(homedir(), ".local", "share"), "freshvault");
    }
  }
}

export function configFilePath() {
  return join(configDir(), "config.json");
}

export function readConfigFile() {
  try {
    return JSON.parse(readFileSync(configFilePath(), "utf8"));
  } catch {
    return {};
  }
}

export function writeConfigFile(cfg) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2) + "\n");
}

// One index file per vault, keyed by vault path hash — allows multiple vaults.
export function indexPathFor(vaultPath, dir) {
  const abs = resolve(vaultPath);
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 10);
  const slug = (basename(abs).replace(/[^\w-]+/g, "_").slice(0, 40)) || "vault";
  return join(dir, `${slug}-${hash}.json`);
}

export function loadConfig(cliOpts = {}) {
  const file = readConfigFile();
  const vault = cliOpts.vault ?? process.env.FRESHVAULT_VAULT ?? file.vault ?? null;
  const model = cliOpts.model ?? process.env.FRESHVAULT_MODEL ?? file.model ?? DEFAULT_MODEL;
  const ollamaUrl = (cliOpts.ollamaUrl ?? process.env.FRESHVAULT_OLLAMA_URL ?? file.ollamaUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  const data = cliOpts.data ?? process.env.FRESHVAULT_DATA ?? file.data ?? dataDir();
  return {
    vault: vault ? resolve(vault) : null,
    model,
    ollamaUrl,
    dataDir: data,
    indexPath: vault ? indexPathFor(vault, data) : null,
  };
}
