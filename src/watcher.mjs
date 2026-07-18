// In-process vault watcher: fs.watch(recursive) + debounce, with a periodic
// mtime sweep as a safety net (network mounts, atomic-rename editors, missed events).
// Reconcile is a cheap no-op when there is no drift, so the sweep is safe to run often.
import { watch } from "node:fs";

export function startWatcher(vaultPath, onDirty, { debounceMs = 4000, sweepMs = 60000 } = {}) {
  let timer = null;
  let closed = false;
  let fsWatcher = null;
  let recursiveOk = false;

  const schedule = (reason) => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => onDirty(reason), debounceMs);
  };

  try {
    fsWatcher = watch(vaultPath, { recursive: true }, (_event, filename) => {
      // filename may be null on some platforms — treat as "something changed"
      if (filename) {
        const name = String(filename);
        if (!name.endsWith(".md")) return;
        if (name.split(/[\\/]/).some(part => part.startsWith("."))) return; // .obsidian etc.
      }
      schedule("watch");
    });
    fsWatcher.on("error", () => { /* keep sweep as fallback */ });
    recursiveOk = true;
  } catch {
    recursiveOk = false; // e.g. recursive unsupported → sweep-only mode
  }

  const sweep = setInterval(() => onDirty("sweep"), sweepMs);
  sweep.unref?.();

  return {
    recursiveOk,
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(sweep);
      fsWatcher?.close();
    },
  };
}
