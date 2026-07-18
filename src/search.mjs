// Dense semantic search (cosine over bge-m3 vectors) — ON PURPOSE.
// We benchmarked hybrid BM25 fusion on Korean paraphrase queries
// (tests/fixtures/ko-bench.json) and every fusion strategy HURT:
//   dense-only 82.5% top-1 · blend 0.9/0.1 70% · rare-boost 62.5% · RRF 37.5%
// Korean is agglutinative — raw-token lexical matching is mostly noise
// ("메모리에서" never matches "메모리"). Receipts: docs/ko-bench.md.
// lexicalScores/tokenize stay exported for the benchmark harness only.
import { embed, cosine } from "./ollama.mjs";

/** Unicode-aware tokenizer: letters/numbers runs, lowercased. Works for ko/ja/en. */
export function tokenize(text) {
  return (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/**
 * BM25-lite over the chunk corpus. Computed on the fly per query — at
 * personal-vault scale (thousands of chunks) this is sub-millisecond work.
 */
export function lexicalScores(records, queryTokens) {
  const N = records.length || 1;
  const docTokens = records.map(r => tokenize(`${r.title} ${r.text}`));
  const avgLen = docTokens.reduce((s, t) => s + t.length, 0) / N || 1;

  // document frequency per query token
  const df = new Map();
  for (const qt of new Set(queryTokens)) {
    let n = 0;
    for (const toks of docTokens) if (toks.includes(qt)) n++;
    df.set(qt, n);
  }

  const k1 = 1.2, b = 0.75;
  return docTokens.map(toks => {
    let score = 0;
    const len = toks.length || 1;
    for (const qt of new Set(queryTokens)) {
      const n = df.get(qt) ?? 0;
      if (n === 0) continue;
      const tf = toks.filter(t => t === qt).length;
      if (tf === 0) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (len / avgLen)));
    }
    return score;
  });
}

export async function searchNotes(db, cfg, query, topK = 5) {
  const [qv] = await embed(query, cfg);
  return db.records
    .map(r => ({
      title: r.title,
      path: r.path,
      chunk: r.chunk,
      text: r.text,
      score: cosine(qv, r.vector),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function formatResults(results, db, { lastReconcileAt } = {}) {
  if (results.length === 0) return "No results — the index may be empty. Check index_status.";
  const ago = lastReconcileAt ? `${Math.round((Date.now() - lastReconcileAt) / 1000)}s ago` : "unknown";
  const header = `index: ${Object.keys(db.files).length} notes / ${db.records.length} chunks · last sync ${ago}`;
  const body = results.map((r, i) =>
    `## ${i + 1}. ${r.title}  (score ${r.score.toFixed(3)})\nsource: ${r.path}\n\n${r.text}`
  ).join("\n\n---\n\n");
  return `${header}\n\n${body}\n\n(tip: use get_note_context with a source path to read a full note)`;
}
