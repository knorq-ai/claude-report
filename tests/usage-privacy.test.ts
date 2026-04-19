/**
 * Tests for the privacy filter: recomputeUsageTotals must include the cost
 * recompute, otherwise opted-out project tokens still leak via the Slack
 * header (flagged as a blocker by both 0.1.2 PE reviews).
 */
import { describe, it, expect } from "vitest";
import { recomputeUsageTotals } from "../src/core/usage-stats.js";
import type { DailyUsage, SessionUsage } from "../src/core/usage-stats.js";

function makeSession(partial: Partial<SessionUsage>): SessionUsage {
  return {
    sessionId: partial.sessionId ?? "s",
    project: partial.project ?? "p",
    model: partial.model ?? "claude-sonnet-4-6",
    inputTokens: partial.inputTokens ?? 0,
    outputTokens: partial.outputTokens ?? 0,
    cacheReadTokens: partial.cacheReadTokens ?? 0,
    cacheWriteTokens: partial.cacheWriteTokens ?? 0,
    userMessages: partial.userMessages ?? 0,
    assistantTurns: partial.assistantTurns ?? 0,
    startedAt: "2026-04-19T00:00:00Z",
    lastActiveAt: "2026-04-19T00:00:00Z",
    activities: [],
    ...(partial.cwd ? { cwd: partial.cwd } : {}),
  };
}

function baseUsage(sessions: SessionUsage[]): DailyUsage {
  return {
    date: "2026-04-19",
    sessions,
    totals: {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      userMessages: 0, assistantTurns: 0, sessionCount: 0,
    },
    estimatedCostUsd: 0,
    activities: [],
  };
}

describe("recomputeUsageTotals", () => {
  it("recomputes sessionCount, token totals, and cost from current sessions", () => {
    const sessions = [
      makeSession({ model: "claude-sonnet-4-6", inputTokens: 1_000_000, outputTokens: 1_000_000, userMessages: 5, assistantTurns: 10 }),
      makeSession({ model: "claude-sonnet-4-6", inputTokens: 500_000,   outputTokens: 500_000,   userMessages: 3, assistantTurns: 7 }),
    ];
    const usage = baseUsage(sessions);

    recomputeUsageTotals(usage);

    // sonnet pricing: input $3 / output $15 per 1M
    // (1M + 0.5M) * $3 + (1M + 0.5M) * $15 = 4.5 + 22.5 = $27.00
    expect(usage.totals.sessionCount).toBe(2);
    expect(usage.totals.inputTokens).toBe(1_500_000);
    expect(usage.totals.outputTokens).toBe(1_500_000);
    expect(usage.totals.userMessages).toBe(8);
    expect(usage.totals.assistantTurns).toBe(17);
    expect(usage.estimatedCostUsd).toBeCloseTo(27.0, 2);
  });

  it("after filtering out a session, cost does NOT include the filtered session", () => {
    // Regression guard for the 0.1.2 bug: totals were recomputed but cost was not.
    const kept    = makeSession({ sessionId: "k", model: "claude-sonnet-4-6", inputTokens: 1_000_000, outputTokens: 0 });
    const dropped = makeSession({ sessionId: "d", model: "claude-opus-4-6",   inputTokens: 1_000_000, outputTokens: 0 });
    const usage = baseUsage([kept, dropped]);

    // Simulate the privacy filter step.
    usage.sessions = usage.sessions.filter((s) => s.sessionId !== "d");
    recomputeUsageTotals(usage);

    // Sonnet $3/1M input only — NOT opus $15/1M.
    expect(usage.totals.sessionCount).toBe(1);
    expect(usage.totals.inputTokens).toBe(1_000_000);
    expect(usage.estimatedCostUsd).toBeCloseTo(3.0, 2);
  });

  it("handles empty sessions (all filtered out) without NaN", () => {
    const usage = baseUsage([]);
    recomputeUsageTotals(usage);
    expect(usage.totals.sessionCount).toBe(0);
    expect(usage.totals.inputTokens).toBe(0);
    expect(usage.estimatedCostUsd).toBe(0);
  });

  it("uses per-model pricing (mixed models)", () => {
    const usage = baseUsage([
      makeSession({ model: "claude-opus-4-6",   inputTokens: 1_000_000 }), // $15/1M
      makeSession({ model: "claude-haiku-4-5",  inputTokens: 1_000_000 }), // $0.80/1M
    ]);
    recomputeUsageTotals(usage);
    expect(usage.estimatedCostUsd).toBeCloseTo(15.0 + 0.8, 2);
  });
});
