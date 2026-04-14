/**
 * Tests for fs-utils: atomicWriteJson and withFileLock.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteJson, withFileLock } from "../src/core/fs-utils.js";

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
    const files = require("node:fs").readdirSync(tempDir);
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
});
