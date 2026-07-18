import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkText, emptyIndex, reconcile, loadIndex, saveIndex } from "../src/indexer.mjs";
import { searchNotes } from "../src/search.mjs";
import { startMockOllama } from "./helpers/mock-ollama.mjs";

let mock, vault, dataDir, cfg;

before(async () => {
  mock = await startMockOllama();
  vault = await mkdtemp(join(tmpdir(), "fv-vault-"));
  dataDir = await mkdtemp(join(tmpdir(), "fv-data-"));
  cfg = { vault, model: "mock-model", ollamaUrl: mock.url, indexPath: join(dataDir, "idx.json") };
  await writeFile(join(vault, "cooking.md"), "# Cooking\nKimchi fermentation needs salt brine and time. Napa cabbage works best for kimchi.");
  await writeFile(join(vault, "coding.md"), "# Coding\nTypescript generics constrain type parameters. Interfaces describe object shapes.");
  await mkdir(join(vault, "sub"));
  await writeFile(join(vault, "sub", "travel.md"), "# Travel\nHokkaido in winter: snow festivals in Sapporo and onsen towns near Asahikawa.");
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  await writeFile(join(vault, ".obsidian", "hidden.md"), "should never be indexed");
});

after(async () => {
  await mock.close();
  await rm(vault, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

test("chunkText splits with overlap and skips tiny fragments", () => {
  const chunks = chunkText("x".repeat(2500));
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(c => c.length <= 1000));
  assert.equal(chunkText("short").length, 0); // <20 chars dropped
});

test("initial reconcile indexes all notes, skips dot-dirs", async () => {
  const db = emptyIndex("mock-model", vault);
  const r = await reconcile(db, cfg);
  assert.equal(r.changedFiles, 3);
  assert.equal(Object.keys(db.files).length, 3);
  assert.ok(db.records.length >= 3);
  assert.ok(!db.records.some(rec => rec.path.includes(".obsidian")));
  assert.ok(db.records.every(rec => Array.isArray(rec.vector)));
  await saveIndex(cfg.indexPath, db);
});

test("no-drift reconcile is a no-op with zero embed calls", async () => {
  const db = await loadIndex(cfg.indexPath, { model: "mock-model", vault });
  const callsBefore = mock.stats.embedRequests;
  const r = await reconcile(db, cfg);
  assert.deepEqual(r, { changedFiles: 0, deletedChunks: 0, newChunks: 0 });
  assert.equal(mock.stats.embedRequests, callsBefore);
});

test("editing one note re-embeds only that note", async () => {
  const db = await loadIndex(cfg.indexPath, { model: "mock-model", vault });
  await writeFile(join(vault, "cooking.md"), "# Cooking\nGochujang stew with tofu. Kimchi fermentation basics revisited.");
  // ensure mtime moves even on coarse-mtime filesystems
  const future = new Date(Date.now() + 2000);
  await utimes(join(vault, "cooking.md"), future, future);
  const textsBefore = mock.stats.embeddedTexts;
  const r = await reconcile(db, cfg);
  assert.equal(r.changedFiles, 1);
  assert.equal(mock.stats.embeddedTexts - textsBefore, r.newChunks); // only the changed note's chunks
  await saveIndex(cfg.indexPath, db);
});

test("deleting a note removes its chunks", async () => {
  const db = await loadIndex(cfg.indexPath, { model: "mock-model", vault });
  await rm(join(vault, "coding.md"));
  const r = await reconcile(db, cfg);
  assert.ok(r.deletedChunks >= 1);
  assert.equal(Object.keys(db.files).length, 2);
  assert.ok(!db.records.some(rec => rec.path === "coding.md"));
});

test("semantic search ranks the right note first", async () => {
  const db = emptyIndex("mock-model", vault);
  await reconcile(db, cfg);
  const results = await searchNotes(db, cfg, "sapporo snow festival hokkaido", 3);
  assert.equal(results[0].path, "sub/travel.md");
  assert.ok(results[0].score > results[1].score);
});

test("model mismatch invalidates the index", async () => {
  const db = await loadIndex(cfg.indexPath, { model: "other-model", vault });
  assert.equal(db, null);
});

test("TRANSACTIONAL: embed failure leaves db untouched and drift is re-detected", async () => {
  const db = emptyIndex("mock-model", vault);
  await reconcile(db, cfg); // baseline index
  const chunksBefore = db.records.length;
  const filesBefore = JSON.stringify(db.files);

  await writeFile(join(vault, "cooking.md"), "# Cooking\nEntirely new content about sous vide temperature control.");
  const future = new Date(Date.now() + 4000);
  await utimes(join(vault, "cooking.md"), future, future);

  // Ollama "down": unreachable endpoint → reconcile must throw and NOT mutate db
  const brokenCfg = { ...cfg, ollamaUrl: "http://127.0.0.1:9" };
  await assert.rejects(() => reconcile(db, brokenCfg));
  assert.equal(db.records.length, chunksBefore, "records must be untouched after failure");
  assert.equal(JSON.stringify(db.files), filesBefore, "file bookkeeping must be untouched after failure");

  // Ollama "back up": the SAME drift must be re-detected and indexed
  const r = await reconcile(db, cfg);
  assert.equal(r.changedFiles, 1, "failed file must be retried, not marked as done");
  assert.ok(db.records.some(rec => rec.path === "cooking.md" && rec.text.includes("sous vide")));
});

test("size change with identical mtime is still detected as drift", async () => {
  const db = emptyIndex("mock-model", vault);
  await reconcile(db, cfg);
  // Simulate a coarse-mtime filesystem: rewrite content, force the OLD mtime back
  const meta = db.files["sub/travel.md"];
  await writeFile(join(vault, "sub", "travel.md"), "# Travel\nCompletely different itinerary: Kyushu onsen circuit."); // different length
  const old = new Date(meta.mtime);
  await utimes(join(vault, "sub", "travel.md"), old, old);
  const r = await reconcile(db, cfg);
  assert.equal(r.changedFiles, 1, "same-mtime different-size rewrite must be reindexed");
});
