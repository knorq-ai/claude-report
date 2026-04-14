import { writeFileSync, renameSync, unlinkSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Atomic JSON write: write to temp file then rename.
 * Prevents corruption from concurrent hook processes.
 * Cleans up temp file on failure.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}.json`);
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

const LOCK_RETRY_MS = 10;
const LOCK_MAX_RETRIES = 30; // 300ms max wait
const LOCK_STALE_MS = 5000; // auto-release stale locks after 5s

/**
 * Advisory file lock using mkdir (atomic on all OSes).
 * Protects read-modify-write cycles from concurrent hook processes.
 * Falls through without lock on timeout — hooks must never block indefinitely.
 */
export function withFileLock<T>(filePath: string, fn: () => T): T {
  const lockDir = `${filePath}.lock`;
  let acquired = false;

  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      mkdirSync(lockDir);
      acquired = true;
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      // Check for stale lock
      try {
        const { mtimeMs } = statSync(lockDir);
        if (Date.now() - mtimeMs > LOCK_STALE_MS) {
          try { rmdirSync(lockDir); } catch { /* race with another cleaner */ }
          continue;
        }
      } catch { /* lock dir vanished — retry will succeed */ }
      // Busy-wait (acceptable for hooks — short-lived, sub-second)
      const start = Date.now();
      while (Date.now() - start < LOCK_RETRY_MS) { /* spin */ }
    }
  }

  try {
    return fn();
  } finally {
    if (acquired) {
      try { rmdirSync(lockDir); } catch { /* best-effort */ }
    }
  }
}
