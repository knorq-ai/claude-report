import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonFileStore } from "../src/core/store.js";
import type { Session, StatusUpdate } from "../src/core/types.js";

describe("JsonFileStore", () => {
  let tempDir: string;
  let store: JsonFileStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-report-test-"));
    store = new JsonFileStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const testSession: Session = {
    sessionId: "sess-1",
    userId: "U123",
    project: "test-project",
    threadId: "t-1234",
    startedAt: "2024-01-01T00:00:00Z",
    lastPostAt: null,
    lastActiveAt: "2024-01-01T00:00:00Z",
    postCount: 0,
    dailyPostCount: 0,
    dailyPostDate: "2024-01-01",
    muted: false,
  };

  describe("sessions", () => {
    it("saves and retrieves a session", async () => {
      await store.saveSession(testSession);
      const result = await store.getActiveSession("U123", "test-project");
      expect(result).toEqual(testSession);
    });

    it("returns null for missing session", async () => {
      const result = await store.getActiveSession("U999", "no-project");
      expect(result).toBeNull();
    });

    it("updates a session", async () => {
      await store.saveSession(testSession);
      await store.updateSession("sess-1", { postCount: 5, muted: true });
      const result = await store.getActiveSession("U123", "test-project");
      expect(result!.postCount).toBe(5);
      expect(result!.muted).toBe(true);
    });
  });

  describe("updates", () => {
    it("saves and retrieves updates", async () => {
      const update: StatusUpdate & { threadId: string } = {
        type: "status",
        summary: "Test update",
        timestamp: new Date("2024-01-01T10:00:00Z"),
        userId: "U123",
        sessionId: "sess-1",
        project: "test-project",
        threadId: "t-1234",
      };

      await store.saveUpdate(update);
      const results = await store.getRecentUpdates("sess-1");
      expect(results).toHaveLength(1);
      expect(results[0].summary).toBe("Test update");
    });

    it("returns empty for no updates", async () => {
      const results = await store.getRecentUpdates("sess-none");
      expect(results).toHaveLength(0);
    });
  });

  describe("reply watermarks", () => {
    it("saves and retrieves watermark", async () => {
      const ts = new Date("2024-01-01T12:00:00Z");
      await store.setLastSeenReplyTimestamp("t-1234", ts);
      const result = await store.getLastSeenReplyTimestamp("t-1234");
      expect(result).toEqual(ts);
    });

    it("returns null for missing watermark", async () => {
      const result = await store.getLastSeenReplyTimestamp("t-missing");
      expect(result).toBeNull();
    });
  });
});
