import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectVaults } from "../src/setup.mjs";

test("detectVaults skips Obsidian Sandbox (vaults inside the config dir)", () => {
  const configDir = mkdtempSync(join(tmpdir(), "fv-obsidian-cfg-"));
  const realVault = mkdtempSync(join(tmpdir(), "fv-real-vault-"));
  const sandbox = join(configDir, "Obsidian Sandbox");
  mkdirSync(sandbox);
  const obsidianJson = join(configDir, "obsidian.json");
  writeFileSync(obsidianJson, JSON.stringify({
    vaults: {
      a1: { path: realVault, ts: 1 },
      a2: { path: sandbox, ts: 2 }, // Obsidian's demo vault — must be excluded
    },
  }));
  const found = detectVaults([obsidianJson]);
  assert.deepEqual(found, [realVault]);
});

test("detectVaults returns [] when only the sandbox exists", () => {
  const configDir = mkdtempSync(join(tmpdir(), "fv-obsidian-cfg2-"));
  const sandbox = join(configDir, "Obsidian Sandbox");
  mkdirSync(sandbox);
  const obsidianJson = join(configDir, "obsidian.json");
  writeFileSync(obsidianJson, JSON.stringify({ vaults: { a: { path: sandbox } } }));
  assert.deepEqual(detectVaults([obsidianJson]), []);
});
