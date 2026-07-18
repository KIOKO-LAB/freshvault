import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, heartbeatLock, lockPathFor, LOCK_STALE_MS } from "../src/lock.mjs";

test("lock: acquire, re-acquire fails, release frees", () => {
  const idx = join(mkdtempSync(join(tmpdir(), "fv-lock-")), "idx.json");
  assert.equal(acquireLock(idx), true);
  // A second acquire from the SAME live pid still sees a live holder → false.
  assert.equal(acquireLock(idx), false);
  releaseLock(idx);
  assert.equal(acquireLock(idx), true);
  releaseLock(idx);
});

test("lock: stale lock from a dead pid is stolen", () => {
  const idx = join(mkdtempSync(join(tmpdir(), "fv-lock-")), "idx.json");
  // PID 2^22+ is above default pid_max on Linux and improbable elsewhere.
  writeFileSync(lockPathFor(idx), JSON.stringify({ pid: 4999999, started: 0 }));
  assert.equal(acquireLock(idx), true);
  assert.equal(JSON.parse(readFileSync(lockPathFor(idx), "utf8")).pid, process.pid);
  releaseLock(idx);
});

test("lock: corrupt lockfile is treated as stale", () => {
  const idx = join(mkdtempSync(join(tmpdir(), "fv-lock-")), "idx.json");
  writeFileSync(lockPathFor(idx), "not json");
  assert.equal(acquireLock(idx), true);
  releaseLock(idx);
});

test("lock: expired heartbeat is stale even when the pid is alive (pid recycling)", () => {
  const idx = join(mkdtempSync(join(tmpdir(), "fv-lock-")), "idx.json");
  // A LIVE pid (our own) but a heartbeat far past the TTL → must be stealable.
  writeFileSync(lockPathFor(idx), JSON.stringify({
    pid: process.pid, started: 0, updated: Date.now() - LOCK_STALE_MS - 1000,
  }));
  assert.equal(acquireLock(idx), true);
  releaseLock(idx);
});

test("lock: heartbeat refreshes own lock, reports loss of a stolen lock", () => {
  const idx = join(mkdtempSync(join(tmpdir(), "fv-lock-")), "idx.json");
  assert.equal(acquireLock(idx), true);
  assert.equal(heartbeatLock(idx), true); // ours → refreshed
  writeFileSync(lockPathFor(idx), JSON.stringify({ pid: 4999999, started: Date.now(), updated: Date.now() }));
  assert.equal(heartbeatLock(idx), false); // stolen → must demote
});
