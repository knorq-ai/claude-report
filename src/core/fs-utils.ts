import {
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  rmdirSync,
  statSync,
} from "node:fs";
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
const LOCK_STALE_MS = 30_000; // only steal locks whose owner PID is dead
const LOCK_MAX_AGE_MS = 60_000; // absolute fallback if owner PID unreadable

/** Synchronously sleep without pegging CPU (uses Atomics.wait on a SAB). */
function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

/** Check if a process is alive. Returns false only when PID is clearly dead. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH = no such process; EPERM = exists but we can't signal it (still alive)
    return err?.code !== "ESRCH";
  }
}

export class LockTimeoutError extends Error {
  constructor(filePath: string) {
    super(`lock timeout: ${filePath}`);
    this.name = "LockTimeoutError";
  }
}

/**
 * Advisory file lock using mkdir (atomic on all OSes).
 * Protects read-modify-write cycles from concurrent hook processes.
 *
 * Throws LockTimeoutError on contention timeout — callers must decide whether
 * to surface or swallow. NEVER falls through unlocked (that would defeat the point).
 *
 * Stale-lock detection: only steals when the owner PID is demonstrably dead,
 * OR when the lock is older than LOCK_MAX_AGE_MS (absolute fallback).
 */
export function withFileLock<T>(filePath: string, fn: () => T): T {
  const lockDir = `${filePath}.lock`;
  const ownerFile = join(lockDir, "owner");
  let acquired = false;

  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      mkdirSync(lockDir);
      // Best-effort: write our PID so others can check liveness
      try { writeFileSync(ownerFile, String(process.pid), "utf-8"); } catch { /* non-fatal */ }
      acquired = true;
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;

      // Check if the current holder is dead (or lock is ancient)
      const now = Date.now();
      let shouldSteal = false;
      try {
        const st = statSync(lockDir);
        const age = now - st.mtimeMs;
        let ownerDead = false;
        try {
          const pidRaw = readFileSync(ownerFile, "utf-8").trim();
          const pid = Number.parseInt(pidRaw, 10);
          if (pid && !isProcessAlive(pid)) ownerDead = true;
        } catch { /* no owner file — use age heuristic only */ }
        if ((ownerDead && age > LOCK_STALE_MS) || age > LOCK_MAX_AGE_MS) {
          shouldSteal = true;
        }
      } catch { /* lock dir vanished — retry will succeed immediately */ }

      if (shouldSteal) {
        try { unlinkSync(ownerFile); } catch { /* */ }
        try { rmdirSync(lockDir); } catch { /* race — another cleaner won */ }
        continue; // retry mkdir immediately without sleeping
      }

      sleepSync(LOCK_RETRY_MS);
    }
  }

  if (!acquired) {
    throw new LockTimeoutError(filePath);
  }

  try {
    return fn();
  } finally {
    try { unlinkSync(ownerFile); } catch { /* best-effort */ }
    try { rmdirSync(lockDir); } catch { /* best-effort */ }
  }
}
