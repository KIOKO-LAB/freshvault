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

/**
 * Strip YAML frontmatter — metadata pollutes embeddings, never helps retrieval.
 * Conservative on purpose: only strips when the block actually LOOKS like YAML
 * (a leading `---` horizontal rule, or a `--- a/file` diff line inside a code
 * fence, must never cause silent content loss — worse than indexing metadata).
 */
export function stripFrontmatter(text) {
  if (!text.startsWith("---\n")) return text;
  const lines = text.split("\n");
  let close = -1;
  for (let i = 1; i < Math.min(lines.length, 100); i++) {
    if (/^---\s*$/.test(lines[i])) { close = i; break; }
  }
  if (close === -1) return text;
  const inner = lines.slice(1, close).filter(l => l.trim() !== "");
  // Every line must be YAML-shaped: `key: …`, an indented continuation, or a list item.
  const yamlish = inner.length > 0 && inner.every(
    l => /^["']?[\w.-]+["']?\s*:/.test(l) || /^\s/.test(l) || /^-\s/.test(l)
  );
  if (!yamlish) return text;
  return lines.slice(close + 1).join("\n");
}

// Boundary-aware chunking: prefer paragraph breaks, then sentence ends —
// including CJK terminators and Korean sentence endings (…다. …요. …까?) —
// so chunks don't cut mid-sentence. Falls back to a hard cut when a single
// sentence exceeds the budget.
// ASCII terminators need trailing whitespace (protects "3.5", "v0.2"); fullwidth
// CJK terminators (。！？…) end sentences with NO following space in ja/zh prose.
const SENTENCE_END = /[.!?](?=\s|$)|[。！？…]/g;

function lastBoundary(piece) {
  // 1) paragraph break in the back half
  const para = piece.lastIndexOf("\n\n");
  if (para > piece.length * 0.4) return para + 2;
  // 2) sentence end in the back half
  let best = -1;
  SENTENCE_END.lastIndex = 0;
  for (let m; (m = SENTENCE_END.exec(piece)); ) best = m.index + 1;
  if (best > piece.length * 0.4) return best;
  // 3) line break
  const line = piece.lastIndexOf("\n");
  if (line > piece.length * 0.4) return line + 1;
  return piece.length; // hard cut
}

export function chunkText(text) {
  const chunks = [];
  const clean = stripFrontmatter(text.replace(/\r/g, ""));
  let i = 0;
  while (i < clean.length) {
    const window = clean.slice(i, i + CHUNK_CHARS);
    const cut = window.length < CHUNK_CHARS ? window.length : lastBoundary(window);
    const piece = window.slice(0, cut).trim();
    if (piece.length > 20) chunks.push(piece);
    if (i + cut >= clean.length) break;
    // overlap: step back, but never past the cut (guarantees forward progress)
    i += Math.max(cut - CHUNK_OVERLAP, Math.ceil(cut / 2));
  }
  return chunks;
}

export function emptyIndex(model, vaultPath) {
  return { version: INDEX_VERSION, model, vault: vaultPath, files: {}, records: [], count: 0, lastSync: null };
}

// v3 format: metadata + chunk text in <name>.json, vectors packed as Float32
// in a <name>.bin sidecar (16-byte header: magic, GENERATION, count, dim).
// The JSON is the commit point: it is renamed into place AFTER the bin. The
// loader cross-validates count/dim AND a per-save random generation token
// stored in both files — a crash between the two renames can otherwise pair a
// stale JSON with a newer bin of identical count/dim, silently attaching
// vectors to the wrong records. Any mismatch → rebuild from scratch.
const BIN_MAGIC = 0x46564958; // "FVIX"

export function binPathFor(indexPath) {
  return indexPath.replace(/\.json$/i, ".bin");
}

export async function loadIndex(indexPath, { model, vault } = {}) {
  if (!existsSync(indexPath)) return null;
  try {
    const db = JSON.parse(await readFile(indexPath, "utf8"));
    if (db.version !== INDEX_VERSION) return null; // format change → rebuild
    if (model && db.model !== model) return null;  // model change → rebuild
    if (vault && db.vault !== vault) return null;

    const count = db.records.length;
    if (count === 0) return db;
    const buf = await readFile(binPathFor(indexPath));
    const header = new DataView(buf.buffer, buf.byteOffset, 16);
    const dim = header.getUint32(12, true);
    if (
      header.getUint32(0, true) !== BIN_MAGIC ||
      header.getUint32(4, true) !== (db.gen >>> 0) || // generation token — same save?
      header.getUint32(8, true) !== count ||
      buf.byteLength !== 16 + count * dim * 4
    ) return null; // json/bin out of sync → rebuild

    // Zero-copy views: each record's vector is a subarray of one big Float32Array.
    const all = new Float32Array(buf.buffer, buf.byteOffset + 16, count * dim);
    db.records.forEach((r, i) => { r.vector = all.subarray(i * dim, (i + 1) * dim); });
    return db;
  } catch {
    return null; // corrupt → rebuild
  }
}

export async function saveIndex(indexPath, db) {
  await mkdir(dirname(indexPath), { recursive: true });
  const count = db.records.length;
  const dim = count ? db.records[0].vector.length : 0;
  for (const r of db.records) {
    if (r.vector.length !== dim) {
      throw new Error("embedding dimension mismatch across records — model/provider changed mid-index; delete the index files to rebuild");
    }
  }
  const gen = (Math.random() * 0xffffffff) >>> 0; // per-save generation token
  db.gen = gen;

  // pack vectors
  const bin = Buffer.alloc(16 + count * dim * 4);
  bin.writeUInt32LE(BIN_MAGIC, 0);
  bin.writeUInt32LE(gen, 4);
  bin.writeUInt32LE(count, 8);
  bin.writeUInt32LE(dim, 12);
  const all = new Float32Array(bin.buffer, bin.byteOffset + 16, count * dim);
  db.records.forEach((r, i) => all.set(r.vector, i * dim));

  // metadata JSON without vectors
  const meta = {
    ...db,
    dim,
    gen,
    records: db.records.map(({ vector, ...rest }) => rest),
  };

  const binPath = binPathFor(indexPath);
  const binTmp = `${binPath}.tmp-${process.pid}`;
  const jsonTmp = `${indexPath}.tmp-${process.pid}`;
  await writeFile(binTmp, bin);
  await writeFile(jsonTmp, JSON.stringify(meta));
  await rename(binTmp, binPath);   // vectors first…
  await rename(jsonTmp, indexPath); // …then the JSON commit point
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
  const expectedDim = db.records[0]?.vector?.length;
  for (let i = 0; i < fresh.length; i += EMBED_BATCH) {
    const batch = fresh.slice(i, i + EMBED_BATCH);
    const vectors = await embed(batch.map(r => r._embedText), cfg);
    if (expectedDim && vectors[0]?.length !== expectedDim) {
      throw new Error(
        `embedding dimension changed (${expectedDim} → ${vectors[0]?.length}) — model/provider mismatch; delete the index files to rebuild`
      );
    }
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
