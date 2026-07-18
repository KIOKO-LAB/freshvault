// Single-writer election via a heartbeated pid lockfile next to the index file.
// Multiple MCP clients (Claude Code + Desktop) may spawn servers on the same
// vault; exactly one becomes the writer (indexes), the rest are readers.
//
// Staleness is decided by BOTH signals:
//  - pid liveness (fast path: dead pid → stale immediately)
//  - heartbeat age (a lock not refreshed within LOCK_STALE_MS is stale even if
//    the pid "exists" — covers pid recycling after crash/reboot, EPERM pids,
//    and SIGKILLed writers)
// The writer refreshes the lock every HEARTBEAT_MS; if the refresh discovers
// another pid in the file (lost a steal race), it reports failure so the server
// can demote itself — guaranteeing at most one writer settles.
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const HEARTBEAT_MS = 60_000;
export const LOCK_STALE_MS = 3 * HEARTBEAT_MS;

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

function payload() {
  return JSON.stringify({ pid: process.pid, started: Date.now(), updated: Date.now() });
}

function readHolder(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null; // missing or unreadable/corrupt
  }
}

function holderIsFresh(holder) {
  if (!holder || typeof holder.pid !== "number") return false;
  if (!pidAlive(holder.pid)) return false;
  const beat = holder.updated ?? holder.started ?? 0;
  return Date.now() - beat < LOCK_STALE_MS;
}

/** Try to become the writer. Returns true if we hold the lock. */
export function acquireLock(indexPath) {
  const lockPath = lockPathFor(indexPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, payload(), { flag: "wx" });
      // TOCTOU guard: a concurrent staler may have unlinked our fresh lock and
      // written its own — only trust the lock if the file still names us.
      return readHolder(lockPath)?.pid === process.pid;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (holderIsFresh(readHolder(lockPath))) return false; // live writer exists
      try {
        unlinkSync(lockPath); // stale → steal and retry
      } catch { /* raced with another stealer */ }
    }
  }
  return false;
}

/**
 * Writer heartbeat: refresh `updated`. Returns false if we no longer own the
 * lock (steal race lost) — caller must demote to reader.
 */
export function heartbeatLock(indexPath) {
  const lockPath = lockPathFor(indexPath);
  const holder = readHolder(lockPath);
  if (holder && holder.pid !== process.pid) return false; // someone else owns it
  try {
    if (holder) {
      writeFileSync(lockPath, JSON.stringify({ ...holder, updated: Date.now() }));
    } else {
      writeFileSync(lockPath, payload(), { flag: "wx" }); // vanished → reclaim
    }
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(indexPath) {
  const lockPath = lockPathFor(indexPath);
  const holder = readHolder(lockPath);
  if (holder?.pid === process.pid) {
    try {
      unlinkSync(lockPath);
    } catch { /* already gone */ }
  }
}

let exitHookInstalled = false;

/** Best-effort release on process death. Idempotent. */
export function releaseOnExit(indexPath) {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const release = () => releaseLock(indexPath);
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
}
