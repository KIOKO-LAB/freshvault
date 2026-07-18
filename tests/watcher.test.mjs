import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startWatcher } from "../src/watcher.mjs";

test("watcher fires onDirty after a note change (debounced)", async () => {
  const vault = await mkdtemp(join(tmpdir(), "fv-watch-"));
  let fired = 0;
  const w = startWatcher(vault, () => { fired += 1; }, { debounceMs: 200, sweepMs: 60_000 });
  try {
    if (!w.recursiveOk) return; // platform without recursive watch: sweep covers it, skip
    await sleep(100); // let the watcher settle
    await writeFile(join(vault, "note.md"), "# hello\nfresh content");
    // generous window for CI runners
    for (let i = 0; i < 50 && fired === 0; i++) await sleep(100);
    assert.ok(fired >= 1, "onDirty should fire after debounce");
  } finally {
    w.close();
    await rm(vault, { recursive: true, force: true });
  }
});

test("watcher ignores non-md and dotfile changes", async () => {
  const vault = await mkdtemp(join(tmpdir(), "fv-watch2-"));
  let fired = 0;
  const w = startWatcher(vault, () => { fired += 1; }, { debounceMs: 100, sweepMs: 60_000 });
  try {
    if (!w.recursiveOk) return;
    await sleep(100);
    await writeFile(join(vault, "image.png"), "binary-ish");
    await writeFile(join(vault, ".hidden.md"), "dot");
    await sleep(600);
    assert.equal(fired, 0);
  } finally {
    w.close();
    await rm(vault, { recursive: true, force: true });
  }
});
