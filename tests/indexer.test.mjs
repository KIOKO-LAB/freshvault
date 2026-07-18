import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkText, stripFrontmatter, emptyIndex, reconcile, loadIndex, saveIndex } from "../src/indexer.mjs";
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

test("stripFrontmatter removes YAML header, keeps body", () => {
  const md = "---\ntitle: 회의록\ntags: [work]\n---\n# 본문\n실제 내용이 여기 있다.";
  assert.equal(stripFrontmatter(md), "# 본문\n실제 내용이 여기 있다.");
  assert.equal(stripFrontmatter("no frontmatter here at all"), "no frontmatter here at all");
  // frontmatter never reaches the chunks
  const chunks = chunkText(md + " 충분히 길게 만들기 위한 내용 추가.");
  assert.ok(chunks.every(c => !c.includes("tags:")));
});

test("stripFrontmatter NEVER eats real content (hr-first notes, diff lines)", () => {
  // leading horizontal rule + another rule later — content between is prose, not YAML
  const hrNote = "---\n\n# My Note\n\nImportant content here.\n\n---\n\nMore content";
  assert.equal(stripFrontmatter(hrNote), hrNote);
  // a `--- a/file.js` diff line inside a code fence must not close the block
  const diffNote = "---\nprose line without colon\n```\n--- a/file.js\n+++ b/file.js\n```\nrest";
  assert.equal(stripFrontmatter(diffNote), diffNote);
});

test("chunkText splits continuous Japanese prose at 。 (no trailing space)", () => {
  const ja = "これは日本語の文章です。スペースなしで続きます。".repeat(60); // ~1440 chars, no spaces
  const chunks = chunkText(ja);
  assert.ok(chunks.length >= 2);
  for (const c of chunks.slice(0, -1)) {
    assert.match(c.trim(), /[。！？…]$/, `chunk should end at fullwidth terminator: …${c.slice(-20)}`);
  }
});

test("GENERATION: stale JSON + newer bin of same count is rejected", async () => {
  const idxPath = join(dataDir, "gen-test.json");
  const v = () => Array.from({ length: 8 }, () => Math.random());
  const mk = (tag) => ({
    version: 3, model: "mock-model", vault, gen: undefined,
    files: { "a.md": { mtime: 1, size: 1 } },
    records: [
      { title: "a", path: "a.md", chunk: 0, text: `${tag}-one`, vector: v() },
      { title: "a", path: "a.md", chunk: 1, text: `${tag}-two`, vector: v() },
    ],
    count: 2, lastSync: null,
  });
  const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
  await saveIndex(idxPath, mk("gen1"));
  const staleJson = await rf(idxPath);          // keep generation-1 JSON
  await saveIndex(idxPath, mk("gen2"));         // generation-2 bin+json (same count/dim)
  await wf(idxPath, staleJson);                 // simulate crash between the two renames
  const loaded = await loadIndex(idxPath, { model: "mock-model", vault });
  assert.equal(loaded, null, "mismatched generation must force a rebuild, not silent misassignment");
});

test("chunkText prefers sentence boundaries (Korean + CJK terminators)", () => {
  // Two Korean sentences whose combined length exceeds one chunk window:
  const s1 = "첫 번째 문장은 여기서 끝납니다. ".repeat(20);       // ~360 chars of complete sentences
  const s2 = "두 번째 블록의 문장도 마침표로 끝나요. ".repeat(30); // pushes past 1000
  const chunks = chunkText(s1 + s2);
  assert.ok(chunks.length >= 2);
  // every chunk should end at a sentence boundary, not mid-sentence
  for (const c of chunks.slice(0, -1)) {
    assert.match(c.trim(), /[.!?。！？…]$/, `chunk should end on sentence boundary: …${c.slice(-30)}`);
  }
});

test("chunkText survives a single giant sentence (hard cut, forward progress)", () => {
  const giant = "가".repeat(5000); // no boundaries at all
  const chunks = chunkText(giant);
  assert.ok(chunks.length >= 5);
  assert.ok(chunks.every(c => c.length <= 1000));
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
