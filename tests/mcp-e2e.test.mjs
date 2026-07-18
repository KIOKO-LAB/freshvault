// Full-stack test: spawn the real server binary, speak MCP JSON-RPC over stdio,
// verify search reflects live note edits (the product's core promise).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startMockOllama } from "./helpers/mock-ollama.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "freshvault.mjs");

let mock, vault, dataDir, proc, nextId = 1;
const pendingReplies = new Map();

function send(method, params = {}, isNotification = false) {
  const msg = { jsonrpc: "2.0", method, params };
  if (!isNotification) msg.id = nextId++;
  proc.stdin.write(JSON.stringify(msg) + "\n");
  if (isNotification) return null;
  return new Promise((resolve, reject) => {
    pendingReplies.set(msg.id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000).unref();
  });
}

before(async () => {
  mock = await startMockOllama();
  vault = await mkdtemp(join(tmpdir(), "fv-e2e-vault-"));
  dataDir = await mkdtemp(join(tmpdir(), "fv-e2e-data-"));
  await writeFile(join(vault, "recipes.md"), "# Recipes\nBibimbap needs gochujang sauce and seasonal vegetables over rice.");

  proc = spawn(process.execPath, [BIN, "serve"], {
    env: {
      ...process.env,
      FRESHVAULT_VAULT: vault,
      FRESHVAULT_DATA: dataDir,
      FRESHVAULT_MODEL: "mock-model",
      FRESHVAULT_OLLAMA_URL: mock.url,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pendingReplies.has(msg.id)) {
          pendingReplies.get(msg.id)(msg);
          pendingReplies.delete(msg.id);
        }
      } catch { /* non-JSON noise */ }
    }
  });

  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fv-test", version: "0" },
  });
  assert.equal(init.result.serverInfo.name, "freshvault");
  send("notifications/initialized", {}, true);
});

after(async () => {
  proc.kill();
  await mock.close();
  await rm(vault, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

test("tools/list exposes search_notes and index_status with read-only annotations", async () => {
  const res = await send("tools/list");
  const tools = res.result.tools;
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, ["index_status", "search_notes"]);
  assert.ok(tools.every(t => t.annotations?.readOnlyHint === true));
});

test("boot catch-up indexes pre-existing notes; search finds them", async () => {
  let text = "";
  for (let i = 0; i < 60; i++) { // wait out the boot reconcile
    const res = await send("tools/call", { name: "search_notes", arguments: { query: "bibimbap gochujang rice" } });
    text = res.result.content[0].text;
    if (text.includes("recipes")) break;
    await sleep(500);
  }
  assert.match(text, /recipes/);
  assert.match(text, /last sync/);
});

test("CORE PROMISE: a newly created note becomes searchable automatically", async () => {
  await writeFile(join(vault, "stargazing.md"), "# Stargazing\nOrion nebula viewing needs dark skies and a telescope with good aperture.");
  let found = false;
  for (let i = 0; i < 60 && !found; i++) { // debounce 4s + embed time
    await sleep(500);
    const res = await send("tools/call", { name: "search_notes", arguments: { query: "orion nebula telescope" } });
    found = res.result.content[0].text.includes("stargazing");
  }
  assert.ok(found, "new note should be searchable without any manual reindex");
});

test("index_status reports writer role and freshness", async () => {
  const res = await send("tools/call", { name: "index_status", arguments: {} });
  const text = res.result.content[0].text;
  assert.match(text, /role: writer/);
  assert.match(text, /notes: 2/);
  assert.match(text, /reachable/);
});
