#!/usr/bin/env node
// Korean retrieval micro-benchmark: top-1 accuracy + MRR over the ko-bench
// fixture, per embedding model. Measures both dense-only and freshvault's
// hybrid (dense+BM25) path.
//
// Usage: node scripts/bench.mjs [model ...]   (default: bge-m3 nomic-embed-text)
// Requires: Ollama running with the models pulled.
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { embed, cosine } from "../src/ollama.mjs";
import { lexicalScores, tokenize } from "../src/search.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const models = process.argv.slice(2).length ? process.argv.slice(2) : ["bge-m3", "nomic-embed-text"];
const ollamaUrl = process.env.FRESHVAULT_OLLAMA_URL ?? "http://localhost:11434";

const { notes, queries } = JSON.parse(await readFile(join(HERE, "..", "tests", "fixtures", "ko-bench.json"), "utf8"));
console.error(`ko-bench: ${notes.length} notes, ${queries.length} queries\n`);

const records = notes.map(n => ({ title: n.title, text: n.text }));
const rows = [];

for (const model of models) {
  const cfg = { embedApi: "ollama", ollamaUrl, model };
  const t0 = Date.now();
  const noteVecs = [];
  for (let i = 0; i < records.length; i += 16) {
    const batch = records.slice(i, i + 16);
    noteVecs.push(...await embed(batch.map(r => `# ${r.title}\n${r.text}`), cfg));
  }
  const queryVecs = [];
  for (let i = 0; i < queries.length; i += 16) {
    const batch = queries.slice(i, i + 16);
    queryVecs.push(...await embed(batch.map(q => q.q), cfg));
  }
  const embedMs = Date.now() - t0;

  const evalMode = (rank) => {
    let top1 = 0, mrr = 0;
    rank.forEach(r => { if (r === 0) top1++; mrr += 1 / (r + 1); });
    return { top1: top1 / queries.length, mrr: mrr / queries.length };
  };

  // dense-only ranks
  const denseRanks = queries.map((q, qi) => {
    const scored = noteVecs.map((v, ni) => ({ ni, s: cosine(queryVecs[qi], v) })).sort((a, b) => b.s - a.s);
    return scored.findIndex(x => records[x.ni].title === q.expect);
  });

  // hybrid ranks (freshvault's actual path: 0.7 dense + 0.3 lexical)
  const hybridRanks = queries.map((q, qi) => {
    const lex = lexicalScores(records.map(r => ({ title: r.title, text: r.text })), tokenize(q.q));
    const lexMax = Math.max(...lex, 1e-6);
    const scored = noteVecs
      .map((v, ni) => ({ ni, s: 0.7 * cosine(queryVecs[qi], v) + 0.3 * (lex[ni] / lexMax) }))
      .sort((a, b) => b.s - a.s);
    return scored.findIndex(x => records[x.ni].title === q.expect);
  });

  const dense = evalMode(denseRanks);
  const hybrid = evalMode(hybridRanks);
  rows.push({ model, dense, hybrid, embedMs });
  console.error(`${model}: dense top1 ${(dense.top1 * 100).toFixed(1)}% · hybrid top1 ${(hybrid.top1 * 100).toFixed(1)}% (${embedMs}ms embed)`);
}

console.log(`\n| model | dense top-1 | dense MRR | hybrid(rejected) top-1 | hybrid(rejected) MRR |`);
console.log(`|---|---|---|---|---|`);
for (const r of rows) {
  console.log(`| ${r.model} | ${(r.dense.top1 * 100).toFixed(1)}% | ${r.dense.mrr.toFixed(3)} | ${(r.hybrid.top1 * 100).toFixed(1)}% | ${r.hybrid.mrr.toFixed(3)} |`);
}
console.log(`\n(${notes.length} Korean notes, ${queries.length} paraphrase/colloquial queries — fixture: tests/fixtures/ko-bench.json)`);
