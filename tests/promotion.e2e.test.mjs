// Two-process failover test: writer is SIGKILLed (no cleanup hooks run, lock
// file left behind with a dead pid) — the reader must promote itself to writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startMockOllama } from "./helpers/mock-ollama.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "freshvault.mjs");

function spawnServer(env) {
  const proc = spawn(process.execPath, [BIN, "serve"], { env, stdio: ["pipe", "pipe", "pipe"] });
  proc.log = "";
  proc.stderr.on("data", d => (proc.log += d.toString()));
  return proc;
}

test("reader promotes to writer after the writer is SIGKILLed", { timeout: 120_000 }, async () => {
  const mock = await startMockOllama();
  const vault = await mkdtemp(join(tmpdir(), "fv-promo-vault-"));
  const dataDir = await mkdtemp(join(tmpdir(), "fv-promo-data-"));
  await writeFile(join(vault, "note.md"), "# Note\nFailover test content lives here.");
  const env = {
    ...process.env,
    FRESHVAULT_VAULT: vault,
    FRESHVAULT_DATA: dataDir,
    FRESHVAULT_MODEL: "mock-model",
    FRESHVAULT_OLLAMA_URL: mock.url,
  };

  const writer = spawnServer(env);
  await waitFor(() => writer.log.includes("writer mode"), 10_000, "first process should become writer");

  const reader = spawnServer(env);
  await waitFor(() => reader.log.includes("reader mode"), 10_000, "second process should become reader");

  writer.kill("SIGKILL"); // no exit hooks → stale lock with dead pid left on disk

  // promotion retry is 15s — allow margin
  await waitFor(() => reader.log.includes("writer mode (promoted)"), 40_000, "reader should promote after writer death");

  reader.kill();
  await mock.close();
  await rm(vault, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

async function waitFor(cond, ms, msg) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await sleep(250);
  }
  assert.fail(`timeout: ${msg}`);
}
