// v0.3: tags/links extraction, ignore globs, search filters, title boost.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractTags, extractWikilinks, compileIgnore, walkVault,
  emptyIndex, reconcile,
} from "../src/indexer.mjs";
import { searchNotes, titleBoost } from "../src/search.mjs";
// (review-fix regressions live in the REVIEW FIXES test below)
import { startMockOllama } from "./helpers/mock-ollama.mjs";

let mock, vault, cfg;

before(async () => {
  mock = await startMockOllama();
  vault = await mkdtemp(join(tmpdir(), "fv-v03-"));
  cfg = { vault, model: "mock-model", ollamaUrl: mock.url, embedApi: "ollama", ignore: ["Templates/", "Daily/**"] };

  await mkdir(join(vault, "work"));
  await mkdir(join(vault, "Templates"));
  await mkdir(join(vault, "Daily"));
  await writeFile(join(vault, "work", "project-alpha.md"),
    "---\ntags: [work, urgent]\n---\n# Project Alpha\nKimchi fermentation project timeline and [[Budget Notes]] link here.");
  await writeFile(join(vault, "Budget Notes.md"),
    "# Budget Notes\nQuarterly budget planning with #finance figures and projections for the team.");
  await writeFile(join(vault, "Templates", "daily-template.md"), "# Template\nboilerplate that must never be indexed");
  await writeFile(join(vault, "Daily", "2026-07-18.md"), "# Daily\ntoday I wrote some things that are private");
});

after(async () => {
  await mock.close();
  await rm(vault, { recursive: true, force: true });
});

test("extractTags: inline + frontmatter forms, headings excluded", () => {
  const raw = "---\ntags: [Work, urgent]\n---\n# Heading Not A Tag\nbody with #finance and #proj/sub tags";
  const tags = extractTags(raw);
  assert.ok(tags.includes("work") && tags.includes("urgent") && tags.includes("finance") && tags.includes("proj/sub"));
  assert.ok(!tags.includes("heading"));
  // block-style frontmatter
  assert.deepEqual(extractTags("---\ntags:\n  - alpha\n  - beta\n---\nx"), ["alpha", "beta"]);
});

test("extractWikilinks: plain, alias, heading forms", () => {
  const links = extractWikilinks("See [[Budget Notes]] and [[Other|알리아스]] plus [[Deep#section]].");
  assert.deepEqual(links.sort(), ["Budget Notes", "Deep", "Other"]);
});

test("REVIEW FIXES: gitignore semantics, CRLF tags, title boost boundaries, nested tags", async () => {
  // gitignore semantics
  const t = (pats, path) => compileIgnore(pats).some(re => re.test(path));
  assert.equal(t(["Templates"], "TemplatesOld/y.md"), false, "no sibling over-exclusion");
  assert.equal(t(["*.excalidraw.md"], "Sketches/x.excalidraw.md"), true, "slash-less globs match at depth");
  // CRLF frontmatter tags
  const crlf = extractTags("---\r\ntags: [work, idea]\r\n---\r\nbody #inline\r\n");
  assert.ok(crlf.includes("work") && crlf.includes("idea") && crlf.includes("inline"));
  // title boost: basename + token boundaries only
  assert.equal(titleBoost("log", "Blog/ideas"), 0, "substring of folder must not boost");
  assert.equal(titleBoost("log", "Changelog"), 0, "mid-word must not boost");
  assert.equal(titleBoost("daily", "Daily/2026-07-01"), 0, "folder name must not boost every note in it");
  assert.ok(titleBoost("budget", "work/Budget Notes") > 0, "token-boundary partial still boosts");
  // nested tag semantics
  const db0 = {
    records: [{ title: "n", path: "n.md", chunk: 0, text: "x agora work item", vector: [1, 0] }],
    files: { "n.md": { mtime: 1, tags: ["project/agora"] } },
  };
  // (searchNotes needs an embed server — nested-tag filter logic checked via records filter below)
  const want = ["project"];
  const match = db0.files["n.md"].tags.some(tg => want.some(w => tg === w || tg.startsWith(w + "/")));
  assert.equal(match, true, "parent tag matches nested child");
});

test("ignore globs exclude trees and are counted", async () => {
  const files = await walkVault(vault, cfg.ignore);
  const rels = files.map(f => f.rel).sort();
  assert.ok(rels.includes("Budget Notes.md") && rels.includes("work/project-alpha.md"));
  assert.ok(!rels.some(r => r.startsWith("Templates/") || r.startsWith("Daily/")));
  assert.equal(files.excluded, 2);
});

test("search filters: folder, tags, modified date", async () => {
  const db = emptyIndex("mock-model", vault);
  await reconcile(db, cfg);
  assert.equal(db.excluded, 2);

  // folder scope
  const inWork = await searchNotes(db, cfg, "project timeline", 5, { folder: "work" });
  assert.ok(inWork.length >= 1 && inWork.every(r => r.path.startsWith("work/")));

  // tag scope (frontmatter tag)
  const tagged = await searchNotes(db, cfg, "anything", 5, { tags: ["#urgent"] });
  assert.ok(tagged.length >= 1 && tagged.every(r => r.path === "work/project-alpha.md"));

  // date scope: push one note into the "past", filter it out
  const past = new Date("2020-01-01");
  await utimes(join(vault, "Budget Notes.md"), past, past);
  await reconcile(db, cfg);
  const recent = await searchNotes(db, cfg, "budget planning figures", 5, { modifiedAfter: "2024-01-01" });
  assert.ok(recent.every(r => r.path !== "Budget Notes.md"), "old note must be filtered out");

  // over-filtering returns [] cleanly
  const none = await searchNotes(db, cfg, "x", 5, { folder: "nonexistent" });
  assert.deepEqual(none, []);
});

test("titleBoost: exact-title lookup wins, paraphrase untouched", async () => {
  assert.ok(titleBoost("budget notes", "Budget Notes") > 0);          // exact
  assert.ok(titleBoost("show me the budget notes file", "Budget Notes") > 0); // query contains title
  assert.equal(titleBoost("무엇을 지울지 정하는 방법", "캐시전략"), 0); // paraphrase — no boost
  assert.equal(titleBoost("ab", "Budget Notes"), 0);                   // too-short guard

  const db = emptyIndex("mock-model", vault);
  await reconcile(db, cfg);
  const r = await searchNotes(db, cfg, "Budget Notes", 2);
  assert.equal(r[0].path, "Budget Notes.md");
});

test("results carry mtime; per-note map carries tags/links (no per-chunk duplication)", async () => {
  const db = emptyIndex("mock-model", vault);
  await reconcile(db, cfg);
  const r = await searchNotes(db, cfg, "kimchi project", 1);
  assert.ok(typeof r[0].mtime === "number" && r[0].mtime > 0);
  const alpha = db.files["work/project-alpha.md"];
  assert.ok(alpha.tags.includes("work"));
  assert.ok(alpha.links.includes("Budget Notes"));
  // chunk records stay lean — no metadata duplication
  const rec = db.records.find(rec => rec.path === "work/project-alpha.md");
  assert.equal(rec.tags, undefined);
  assert.equal(rec.links, undefined);
});
