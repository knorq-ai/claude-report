/**
 * Tests for fs-utils: atomicWriteJson and withFileLock.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { atomicWriteJson, withFileLock, LockTimeoutError } from "../src/core/fs-utils.js";

describe("atomicWriteJson", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-report-fs-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes valid JSON to file", () => {
    const file = join(tempDir, "test.json");
    atomicWriteJson(file, { key: "value" });
    const data = JSON.parse(readFileSync(file, "utf-8"));
    expect(data.key).toBe("value");
  });

  it("creates parent directories", () => {
    const file = join(tempDir, "nested", "dir", "test.json");
    atomicWriteJson(file, { ok: true });
    expect(existsSync(file)).toBe(true);
  });

  it("overwrites existing file atomically", () => {
    const file = join(tempDir, "test.json");
    atomicWriteJson(file, { version: 1 });
    atomicWriteJson(file, { version: 2 });
    const data = JSON.parse(readFileSync(file, "utf-8"));
    expect(data.version).toBe(2);
  });

  it("does not leave temp files on success", () => {
    const file = join(tempDir, "test.json");
    atomicWriteJson(file, { ok: true });
    const files = readdirSync(tempDir);
    expect(files.filter((f: string) => f.startsWith(".tmp-"))).toHaveLength(0);
  });
});

describe("withFileLock", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-report-lock-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("executes the callback and returns its result", () => {
    const file = join(tempDir, "test.json");
    const result = withFileLock(file, () => 42);
    expect(result).toBe(42);
  });

  it("cleans up lock directory after execution", () => {
    const file = join(tempDir, "test.json");
    withFileLock(file, () => {});
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("cleans up lock directory even on error", () => {
    const file = join(tempDir, "test.json");
    try {
      withFileLock(file, () => { throw new Error("test"); });
    } catch { /* expected */ }
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("allows sequential lock acquisition", () => {
    const file = join(tempDir, "test.json");
    const results: number[] = [];
    withFileLock(file, () => results.push(1));
    withFileLock(file, () => results.push(2));
    expect(results).toEqual([1, 2]);
  });

  it("protects read-modify-write from interleaving", () => {
    const file = join(tempDir, "counter.json");
    atomicWriteJson(file, { count: 0 });

    // Simulate sequential locked increments
    for (let i = 0; i < 10; i++) {
      withFileLock(file, () => {
        const data = JSON.parse(readFileSync(file, "utf-8"));
        data.count += 1;
        atomicWriteJson(file, data);
      });
    }

    const final = JSON.parse(readFileSync(file, "utf-8"));
    expect(final.count).toBe(10);
  });

  it("throws LockTimeoutError on contention (does NOT silently run unlocked)", () => {
    const file = join(tempDir, "contested.json");
    // Simulate a live holder by creating the lock dir with our own PID
    mkdirSync(`${file}.lock`);
    writeFileSync(join(`${file}.lock`, "owner"), String(process.pid), "utf-8");

    // Second acquire should time out (current process IS alive — won't steal)
    expect(() => withFileLock(file, () => 42)).toThrow(LockTimeoutError);

    // Cleanup
    rmSync(`${file}.lock`, { recursive: true, force: true });
  });

  it("steals locks whose owner PID is dead", () => {
    const file = join(tempDir, "stale.json");
    mkdirSync(`${file}.lock`);
    // Write a PID that's extremely unlikely to exist (but it also needs age >LOCK_STALE_MS)
    // Best-effort: use PID 99999999 which is reserved and will always be ESRCH
    writeFileSync(join(`${file}.lock`, "owner"), "99999999", "utf-8");
    // Age the lock directory
    const past = Date.now() - 60_000;
    const { utimesSync } = require("node:fs");
    utimesSync(`${file}.lock`, past / 1000, past / 1000);

    // This call must steal and succeed
    const result = withFileLock(file, () => "stolen");
    expect(result).toBe("stolen");
  });

  it("survives concurrent writers across child processes (lost-update protection)", async () => {
    const distIndex = join(process.cwd(), "dist/core/index.js");
    if (!existsSync(distIndex)) {
      // Dist not built — skip (tsup build runs before tests in CI)
      return;
    }
    const file = join(tempDir, "counter.json");
    atomicWriteJson(file, { count: 0 });

    const scriptFile = join(tempDir, "worker.mjs");
    const workerScript = [
      `import { readFileSync } from "node:fs";`,
      `import { atomicWriteJson, withFileLock } from ${JSON.stringify(distIndex)};`,
      `const [, , file, iterations] = process.argv;`,
      `for (let i = 0; i < Number(iterations); i++) {`,
      `  withFileLock(file, () => {`,
      `    const data = JSON.parse(readFileSync(file, "utf-8"));`,
      `    data.count += 1;`,
      `    atomicWriteJson(file, data);`,
      `  });`,
      `}`,
    ].join("\n");
    writeFileSync(scriptFile, workerScript);

    const WORKERS = 4;
    const ITERATIONS = 25;
    const procs = Array.from({ length: WORKERS }, () =>
      new Promise<number>((resolve) => {
        const p = spawn("node", [scriptFile, file, String(ITERATIONS)], {
          stdio: "ignore",
        });
        p.on("exit", (code) => resolve(code ?? 1));
      }),
    );
    const codes = await Promise.all(procs);
    // All workers must exit cleanly
    for (const c of codes) expect(c).toBe(0);

    const final = JSON.parse(readFileSync(file, "utf-8"));
    expect(final.count).toBe(WORKERS * ITERATIONS);
  }, 30_000);
});
