import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

vi.mock("../src/core/config.js", async () => {
  const actual = await vi.importActual("../src/core/config.js");
  return {
    ...actual,
    getStateDir: () => tempDir,
  };
});

import {
  getOrCreateSession,
  readCurrentSession,
  readSessionForProject,
  updateSession,
  updateSessionForProject,
} from "../src/core/session.js";

describe("session management", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-report-session-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a new session", () => {
    const session = getOrCreateSession("U123", "my-project");
    expect(session.userId).toBe("U123");
    expect(session.project).toBe("my-project");
    expect(session.sessionId).toBeTruthy();
    expect(session.threadId).toBeNull();
    expect(session.postCount).toBe(0);
    expect(session.muted).toBe(false);
  });

  it("reuses existing session within staleness threshold", () => {
    const session1 = getOrCreateSession("U123", "my-project");
    const session2 = getOrCreateSession("U123", "my-project");
    expect(session2.sessionId).toBe(session1.sessionId);
  });

  it("creates independent sessions for different projects", () => {
    const sessionA = getOrCreateSession("U123", "project-a");
    const sessionB = getOrCreateSession("U123", "project-b");
    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);

    // Both should be independently readable
    const readA = readSessionForProject("U123", "project-a");
    const readB = readSessionForProject("U123", "project-b");
    expect(readA!.project).toBe("project-a");
    expect(readB!.project).toBe("project-b");
  });

  it("reads current session (most recently active)", () => {
    getOrCreateSession("U123", "project-a");
    const created = getOrCreateSession("U123", "project-b");
    const read = readCurrentSession();
    expect(read).not.toBeNull();
    // project-b was created last, so it should be the most recently active
    expect(read!.sessionId).toBe(created.sessionId);
  });

  it("updates session fields via updateSessionForProject", () => {
    getOrCreateSession("U123", "my-project");
    const updated = updateSessionForProject("U123", "my-project", {
      muted: true,
      postCount: 5,
      threadId: "t-123",
    });
    expect(updated).not.toBeNull();
    expect(updated!.muted).toBe(true);
    expect(updated!.postCount).toBe(5);
    expect(updated!.threadId).toBe("t-123");
  });

  it("updates do not leak between projects", () => {
    getOrCreateSession("U123", "project-a");
    getOrCreateSession("U123", "project-b");

    updateSessionForProject("U123", "project-a", {
      threadId: "thread-a",
      postCount: 3,
    });
    updateSessionForProject("U123", "project-b", {
      threadId: "thread-b",
      postCount: 7,
    });

    const a = readSessionForProject("U123", "project-a");
    const b = readSessionForProject("U123", "project-b");
    expect(a!.threadId).toBe("thread-a");
    expect(a!.postCount).toBe(3);
    expect(b!.threadId).toBe("thread-b");
    expect(b!.postCount).toBe(7);
  });

  it("updateSession (generic) updates most recently active session", () => {
    getOrCreateSession("U123", "my-project");
    const updated = updateSession({ muted: true, postCount: 5 });
    expect(updated).not.toBeNull();
    expect(updated!.muted).toBe(true);
    expect(updated!.postCount).toBe(5);
  });

  it("returns null when no session exists", () => {
    const session = readCurrentSession();
    expect(session).toBeNull();
  });

  it("returns null for unvisited project", () => {
    const session = readSessionForProject("U123", "no-such-project");
    expect(session).toBeNull();
  });
});
