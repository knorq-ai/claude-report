import { describe, it, expect, beforeEach } from "vitest";
import { RateLimiter, tokenSimilarity } from "../src/core/rate-limiter.js";
import type { StatusUpdate, Session } from "../src/core/types.js";

function makeUpdate(overrides: Partial<StatusUpdate> = {}): StatusUpdate {
  return {
    type: "status",
    summary: "Working on auth middleware",
    timestamp: new Date(),
    userId: "U123",
    sessionId: "sess-1",
    project: "my-project",
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "sess-1",
    userId: "U123",
    project: "my-project",
    threadId: null,
    startedAt: new Date().toISOString(),
    lastPostAt: null,
    lastActiveAt: new Date().toISOString(),
    postCount: 0,
    dailyPostCount: 0,
    dailyPostDate: new Date().toISOString().slice(0, 10),
    muted: false,
    ...overrides,
  };
}

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      minIntervalMs: 600_000,
      maxPerSession: 10,
      maxPerDay: 30,
      deduplicationWindowMs: 300_000,
      bypassTypes: ["blocker", "completion"],
    });
  });

  it("allows first post", () => {
    const result = limiter.shouldPost(makeUpdate(), makeSession());
    expect(result.allowed).toBe(true);
  });

  it("blocks when session is muted", () => {
    const result = limiter.shouldPost(
      makeUpdate(),
      makeSession({ muted: true }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("muted");
  });

  it("blocks when session cap reached", () => {
    const result = limiter.shouldPost(
      makeUpdate(),
      makeSession({ postCount: 10 }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Session cap");
  });

  it("blocks when daily cap reached", () => {
    const result = limiter.shouldPost(
      makeUpdate(),
      makeSession({ dailyPostCount: 30 }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Daily cap");
  });

  it("blocks when posting too quickly (uses session.lastPostAt)", () => {
    // Interval check uses persisted session.lastPostAt, not in-memory state
    const recentSession = makeSession({
      lastPostAt: new Date().toISOString(), // just posted
    });
    const result = limiter.shouldPost(makeUpdate(), recentSession);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Rate limited");
  });

  it("allows posting when interval has passed", () => {
    const oldSession = makeSession({
      lastPostAt: new Date(Date.now() - 700_000).toISOString(), // 11+ min ago
    });
    const result = limiter.shouldPost(makeUpdate(), oldSession);
    expect(result.allowed).toBe(true);
  });

  it("blocks similar posts within dedup window (in-process)", () => {
    // Dedup is in-process only (MCP server). Create a limiter with short interval.
    const dedupLimiter = new RateLimiter({
      minIntervalMs: 60_000,
      maxPerSession: 10,
      maxPerDay: 30,
      deduplicationWindowMs: 900_000,
      bypassTypes: ["blocker", "completion"],
    });

    const update1 = makeUpdate({ summary: "Working on auth middleware" });
    dedupLimiter.recordPost(update1);

    // Session lastPostAt is old enough to pass interval check
    const session = makeSession({
      lastPostAt: new Date(Date.now() - 120_000).toISOString(), // 2 min ago
    });

    const update2 = makeUpdate({ summary: "Working on auth middleware" });
    const result = dedupLimiter.shouldPost(update2, session);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Duplicate");
  });

  it("bypasses rate limit for blocker type", () => {
    // Fill up caps
    const session = makeSession({ postCount: 10, dailyPostCount: 30 });
    const result = limiter.shouldPost(
      makeUpdate({ type: "blocker" }),
      session,
    );
    expect(result.allowed).toBe(true);
  });

  it("bypasses rate limit for completion type", () => {
    const session = makeSession({ postCount: 10, dailyPostCount: 30 });
    const result = limiter.shouldPost(
      makeUpdate({ type: "completion" }),
      session,
    );
    expect(result.allowed).toBe(true);
  });
});

describe("tokenSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(tokenSimilarity("hello world", "hello world")).toBe(1);
  });

  it("returns 0 for completely different strings", () => {
    expect(tokenSimilarity("hello world", "foo bar")).toBe(0);
  });

  it("returns correct similarity for partial overlap", () => {
    const sim = tokenSimilarity("pushed to main", "pushed to develop");
    // Tokens: {pushed, to, main} vs {pushed, to, develop}
    // Intersection: {pushed, to} = 2
    // Union: {pushed, to, main, develop} = 4
    // Similarity: 2/4 = 0.5
    expect(sim).toBe(0.5);
  });

  it("handles empty strings", () => {
    expect(tokenSimilarity("", "")).toBe(1);
    expect(tokenSimilarity("hello", "")).toBe(0);
    expect(tokenSimilarity("", "hello")).toBe(0);
  });

  it("is case insensitive", () => {
    expect(tokenSimilarity("Hello World", "hello world")).toBe(1);
  });
});
