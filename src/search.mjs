// Dense semantic search (cosine over bge-m3 vectors) — ON PURPOSE.
// We benchmarked hybrid BM25 fusion on Korean paraphrase queries
// (tests/fixtures/ko-bench.json) and every fusion strategy HURT:
//   dense-only 82.5% top-1 · blend 0.9/0.1 70% · rare-boost 62.5% · RRF 37.5%
// Korean is agglutinative — raw-token lexical matching is mostly noise.
// Receipts: docs/ko-bench.md. (The lexical code lives in scripts/bench.mjs.)
import { embed, cosine } from "./ollama.mjs";

/**
 * Exact-title lookup boost — the #1 quality complaint against pure-vector
 * search is "I typed the note's own title and it didn't come back"
 * (obsidian-copilot #331/#367/#1799). Matches the note BASENAME only, at token
 * boundaries only — "log" must never boost "Changelog" or everything under
 * "Blog/". Paraphrase queries untouched — verified on ko-bench (82.5% → 82.5%).
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bounded = (needle) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(needle)}(?:[^\\p{L}\\p{N}]|$)`, "u");

export function titleBoost(queryLower, title) {
  const base = title.split("/").pop().toLowerCase();
  const q = queryLower.trim();
  if (base.length < 3 || q.length < 3) return 0;
  if (q === base) return 0.15;
  // the query contains the full note name as a distinct token run
  if (q.length > base.length && bounded(base).test(q)) return 0.15;
  // the note name contains the query at a token boundary ("budget" → "Budget Notes")
  if (base.length > q.length && q.length >= 4 && bounded(q).test(base)) return 0.1;
  return 0;
}

export async function searchNotes(db, cfg, query, topK = 5, filters = {}) {
  const noteMeta = db.files ?? {};
  let records = db.records;

  if (filters.folder) {
    const prefix = String(filters.folder).replace(/^\/+|\/+$/g, "") + "/";
    records = records.filter(r => r.path.startsWith(prefix));
  }
  const tagList = Array.isArray(filters.tags) ? filters.tags : filters.tags ? [filters.tags] : [];
  if (tagList.length) {
    const want = tagList.map(t => String(t).replace(/^#/, "").toLowerCase());
    // Obsidian nested-tag semantics: filtering by "project" matches "project/agora"
    records = records.filter(r =>
      noteMeta[r.path]?.tags?.some(t => want.some(w => t === w || t.startsWith(w + "/")))
    );
  }
  if (filters.modifiedAfter) {
    const after = Date.parse(filters.modifiedAfter);
    if (!Number.isNaN(after)) records = records.filter(r => noteMeta[r.path]?.mtime >= after);
  }
  if (filters.modifiedBefore) {
    const before = Date.parse(filters.modifiedBefore);
    if (!Number.isNaN(before)) records = records.filter(r => noteMeta[r.path]?.mtime <= before);
  }
  if (records.length === 0) return [];

  const [qv] = await embed(query, cfg);
  const q = String(query).toLowerCase();

  // Score everything, materialize result objects only for the top-K.
  const scores = new Float64Array(records.length);
  for (let i = 0; i < records.length; i++) {
    scores[i] = cosine(qv, records[i].vector) + titleBoost(q, records[i].title);
  }
  return Array.from(scores.keys())
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, topK)
    .map(i => {
      const r = records[i];
      return {
        title: r.title,
        path: r.path,
        chunk: r.chunk,
        text: r.text,
        mtime: noteMeta[r.path]?.mtime,
        score: scores[i],
      };
    });
}

export function formatResults(results, db, { lastReconcileAt } = {}) {
  if (results.length === 0) {
    return "No results. If you used folder/tags/date filters, they may have excluded everything — try relaxing them or check index_status.";
  }
  const ago = lastReconcileAt ? `${Math.round((Date.now() - lastReconcileAt) / 1000)}s ago` : "unknown";
  const header = `index: ${Object.keys(db.files).length} notes / ${db.records.length} chunks · last sync ${ago}`;
  const body = results.map((r, i) => {
    const modified = r.mtime ? ` · modified ${new Date(r.mtime).toISOString().slice(0, 10)}` : "";
    return `## ${i + 1}. ${r.title}  (score ${r.score.toFixed(3)}${modified})\nsource: ${r.path}\n\n${r.text}`;
  }).join("\n\n---\n\n");
  return `${header}\n\n${body}\n\n(tip: use get_note_context with a source path to read a full note)`;
}
