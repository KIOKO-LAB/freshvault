// Single-writer election via a pid lockfile next to the index file.
// Multiple MCP clients (Claude Code + Desktop) may spawn servers on the same vault;
// exactly one becomes the writer (indexes), the rest are readers (hot-reload).
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function lockPathFor(indexPath) {
  return `${indexPath}.lock`;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours
  }
}

/** Try to become the writer. Returns true if we hold the lock. */
export function acquireLock(indexPath) {
  const lockPath = lockPathFor(indexPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: Date.now() }), { flag: "wx" });
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch { /* unreadable → treat as stale */ }
      if (holder && pidAlive(holder.pid)) return false; // live writer exists
      try {
        unlinkSync(lockPath); // stale (dead pid) → steal and retry
      } catch { /* raced with another stealer */ }
    }
  }
  return false;
}

export function releaseLock(indexPath) {
  const lockPath = lockPathFor(indexPath);
  try {
    const holder = JSON.parse(readFileSync(lockPath, "utf8"));
    if (holder.pid === process.pid) unlinkSync(lockPath);
  } catch { /* already gone */ }
}

/** Best-effort release on process death. */
export function releaseOnExit(indexPath) {
  const release = () => releaseLock(indexPath);
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
}
