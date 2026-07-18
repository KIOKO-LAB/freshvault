// Semantic search over an in-memory index.
import { embed, cosine } from "./ollama.mjs";

export async function searchNotes(db, cfg, query, topK = 5) {
  const [qv] = await embed(query, cfg);
  return db.records
    .map(r => ({ title: r.title, path: r.path, chunk: r.chunk, text: r.text, score: cosine(qv, r.vector) }))
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
  return `${header}\n\n${body}`;
}
