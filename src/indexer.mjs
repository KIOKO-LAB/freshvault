// Incremental vault indexer: walk → mtime diff → chunk → embed → atomic save.
import { readdir, readFile, writeFile, stat, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { CHUNK_CHARS, CHUNK_OVERLAP, INDEX_VERSION } from "./config.mjs";
import { embed } from "./ollama.mjs";

const EMBED_BATCH = 32;

export async function walkVault(vaultPath) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir vanished mid-walk
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // .obsidian, .trash, .git …
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          const s = await stat(p);
          out.push({ path: p, rel: relative(vaultPath, p).split(sep).join("/"), mtime: s.mtimeMs });
        } catch { /* deleted mid-walk */ }
      }
    }
  }
  await walk(vaultPath);
  return out;
}

export function chunkText(text) {
  const chunks = [];
  const clean = text.replace(/\r/g, "");
  const step = CHUNK_CHARS - CHUNK_OVERLAP;
  for (let i = 0; i < clean.length; i += step) {
    const piece = clean.slice(i, i + CHUNK_CHARS).trim();
    if (piece.length > 20) chunks.push(piece);
    if (i + CHUNK_CHARS >= clean.length) break;
  }
  return chunks;
}

export function emptyIndex(model, vaultPath) {
  return { version: INDEX_VERSION, model, vault: vaultPath, files: {}, records: [], count: 0, lastSync: null };
}

export async function loadIndex(indexPath, { model, vault } = {}) {
  if (!existsSync(indexPath)) return null;
  try {
    const db = JSON.parse(await readFile(indexPath, "utf8"));
    if (db.version !== INDEX_VERSION) return null; // format change → rebuild
    if (model && db.model !== model) return null;  // model change → rebuild
    if (vault && db.vault !== vault) return null;  // different vault at same path (shouldn't happen)
    return db;
  } catch {
    return null; // corrupt → rebuild
  }
}

export async function saveIndex(indexPath, db) {
  await mkdir(dirname(indexPath), { recursive: true });
  const tmp = `${indexPath}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(db));
  await rename(tmp, indexPath); // atomic on same filesystem
}

/**
 * Reconcile the index with the vault on disk. Mutates `db`.
 * Returns { changedFiles, deletedChunks, newChunks } — all 0 means no drift.
 */
export async function reconcile(db, cfg, { onProgress } = {}) {
  const files = await walkVault(cfg.vault);
  const current = new Map(files.map(f => [f.rel, f]));

  // 1) drop chunks of deleted notes
  const before = db.records.length;
  db.records = db.records.filter(r => current.has(r.path));
  for (const rel of Object.keys(db.files)) {
    if (!current.has(rel)) delete db.files[rel];
  }
  const deletedChunks = before - db.records.length;

  // 2) find created/modified notes (mtime drift)
  const changed = files.filter(f => db.files[f.rel] !== f.mtime);
  if (changed.length === 0 && deletedChunks === 0) return { changedFiles: 0, deletedChunks: 0, newChunks: 0 };

  // 3) drop old chunks of changed notes, then re-chunk
  const changedSet = new Set(changed.map(f => f.rel));
  db.records = db.records.filter(r => !changedSet.has(r.path));

  const fresh = [];
  for (const f of changed) {
    let raw;
    try {
      raw = await readFile(f.path, "utf8");
    } catch {
      continue; // deleted between walk and read
    }
    const title = f.rel.replace(/\.md$/, "");
    for (const [ci, text] of chunkText(raw).entries()) {
      // Prefix the title so short chunks keep note-level context in the vector.
      fresh.push({ title, path: f.rel, chunk: ci, text, _embedText: `# ${title}\n${text}` });
    }
    db.files[f.rel] = f.mtime;
  }

  // 4) embed in batches
  for (let i = 0; i < fresh.length; i += EMBED_BATCH) {
    const batch = fresh.slice(i, i + EMBED_BATCH);
    const vectors = await embed(batch.map(r => r._embedText), cfg);
    batch.forEach((r, j) => { r.vector = vectors[j]; delete r._embedText; });
    onProgress?.(Math.min(i + EMBED_BATCH, fresh.length), fresh.length);
  }

  db.records.push(...fresh);
  db.count = db.records.length;
  db.lastSync = new Date().toISOString();
  return { changedFiles: changed.length, deletedChunks, newChunks: fresh.length };
}
