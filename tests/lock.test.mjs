import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, lockPathFor } from "../src/lock.mjs";

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
