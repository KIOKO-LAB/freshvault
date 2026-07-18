// Incremental vault indexer: walk → mtime+size diff → chunk → embed → atomic save.
// reconcile() is TRANSACTIONAL: the db is only mutated after all embeddings
// succeed, so an Ollama outage mid-reconcile never loses notes — the same drift
// is simply detected again on the next attempt.
import { readdir, readFile, writeFile, stat, rename, mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { CHUNK_CHARS, CHUNK_OVERLAP, INDEX_VERSION } from "./config.mjs";
import { embed } from "./ollama.mjs";

const EMBED_BATCH = 32;

export async function walkVault(vaultPath) {
  const out = [];
  const seenDirs = new Set(); // realpaths — symlink cycle guard
  try {
    seenDirs.add(await realpath(vaultPath));
  } catch {
    return out; // vault dir missing
  }

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
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const s = await stat(p); // follows the link
          isDir = s.isDirectory();
          isFile = s.isFile();
        } catch {
          continue; // broken link
        }
      }
      if (isDir) {
        try {
          const real = await realpath(p);
          if (seenDirs.has(real)) continue;
          seenDirs.add(real);
        } catch {
          continue;
        }
        await walk(p);
      } else if (isFile && e.name.endsWith(".md")) {
        try {
          const s = await stat(p);
          out.push({
            path: p,
            rel: relative(vaultPath, p).split(sep).join("/"),
            mtime: s.mtimeMs,
            size: s.size,
          });
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
    if (vault && db.vault !== vault) return null;
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

function fileMetaChanged(prev, f) {
  if (!prev) return true;
  // Legacy format stored a bare mtime number; treat as changed to upgrade entry.
  if (typeof prev === "number") return true;
  return prev.mtime !== f.mtime || prev.size !== f.size;
}

/**
 * Reconcile the index with the vault on disk. Mutates `db` ONLY on full success.
 * Returns { changedFiles, deletedChunks, newChunks } — all 0 means no drift.
 * Throws (leaving db untouched) if embedding fails, so callers can retry later.
 */
export async function reconcile(db, cfg, { onProgress } = {}) {
  const files = await walkVault(cfg.vault);
  const current = new Map(files.map(f => [f.rel, f]));

  const deletedRels = new Set(Object.keys(db.files).filter(rel => !current.has(rel)));
  const changed = files.filter(f => fileMetaChanged(db.files[f.rel], f));

  if (changed.length === 0 && deletedRels.size === 0) {
    return { changedFiles: 0, deletedChunks: 0, newChunks: 0 };
  }

  // --- stage (no db mutation) ----------------------------------------------
  const fresh = [];
  const newMeta = {};
  for (const f of changed) {
    let raw;
    try {
      raw = await readFile(f.path, "utf8");
    } catch {
      continue; // vanished between walk and read — next reconcile sees it as deleted
    }
    const title = f.rel.replace(/\.md$/, "");
    for (const [ci, text] of chunkText(raw).entries()) {
      // Prefix the title so short chunks keep note-level context in the vector.
      fresh.push({ title, path: f.rel, chunk: ci, text, _embedText: `# ${title}\n${text}` });
    }
    newMeta[f.rel] = { mtime: f.mtime, size: f.size };
  }

  // --- embed (throws on failure → nothing committed) -----------------------
  for (let i = 0; i < fresh.length; i += EMBED_BATCH) {
    const batch = fresh.slice(i, i + EMBED_BATCH);
    const vectors = await embed(batch.map(r => r._embedText), cfg);
    batch.forEach((r, j) => { r.vector = vectors[j]; delete r._embedText; });
    onProgress?.(Math.min(i + EMBED_BATCH, fresh.length), fresh.length);
  }

  // --- commit ---------------------------------------------------------------
  const replacedSet = new Set(Object.keys(newMeta));
  let deletedChunks = 0;
  db.records = db.records.filter(r => {
    if (deletedRels.has(r.path)) { deletedChunks += 1; return false; }
    if (replacedSet.has(r.path)) return false; // superseded by fresh chunks
    return true;
  });
  for (const rel of deletedRels) delete db.files[rel];
  Object.assign(db.files, newMeta);
  db.records.push(...fresh);
  db.count = db.records.length;
  db.lastSync = new Date().toISOString();
  return { changedFiles: changed.length, deletedChunks, newChunks: fresh.length };
}
