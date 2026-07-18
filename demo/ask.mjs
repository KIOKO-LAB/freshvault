#!/usr/bin/env node
// Demo client: asks a freshvault server (real MCP JSON-RPC over stdio) and
// pretty-prints the answer. This is exactly what Claude does when it calls
// search_notes — driven from the CLI for demo purposes.
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const query = process.argv[2];
if (!query) {
  console.error('usage: node ask.mjs "your question"');
  process.exit(1);
}

const BIN = process.env.FRESHVAULT_BIN
  ?? join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "freshvault.mjs");
const proc = spawn(process.execPath, [BIN, "serve"], { stdio: ["pipe", "pipe", "ignore"] });
proc.on("exit", (code) => {
  if (pending.size > 0) {
    console.error(`server exited early (code ${code}) — check FRESHVAULT_BIN/FRESHVAULT_VAULT`);
    process.exit(1);
  }
});
setTimeout(() => { console.error("timeout"); process.exit(1); }, 15000).unref();

let nextId = 1;
const pending = new Map();
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
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* ignore */ }
  }
});

function send(method, params = {}, isNotification = false) {
  const msg = { jsonrpc: "2.0", method, params };
  if (!isNotification) msg.id = nextId++;
  proc.stdin.write(JSON.stringify(msg) + "\n");
  if (isNotification) return null;
  return new Promise((res) => pending.set(msg.id, res));
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ask", version: "0" } });
send("notifications/initialized", {}, true);
const res = await send("tools/call", { name: "search_notes", arguments: { query, top_k: 2 } });
proc.kill();

const text = res.result?.content?.[0]?.text ?? "(no result)";
const [header, ...rest] = text.split("\n\n");
console.log(dim(`  ${header}`));
for (const block of rest.join("\n\n").split("\n\n---\n\n")) {
  const lines = block.split("\n");
  const title = lines[0]?.replace(/^## /, "");
  const source = lines[1]?.replace(/^source: /, "");
  const body = lines.slice(3).join(" ").slice(0, 140);
  console.log(`\n  ${cyan(bold(title ?? ""))}`);
  console.log(`  ${dim(source ?? "")}`);
  console.log(`  ${body}${body.length >= 140 ? "…" : ""}`);
}
console.log(`\n  ${green("✔")} ${dim("fresh from the vault — no reindex, ever")}`);
process.exit(0);
