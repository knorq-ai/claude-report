/**
 * Tests for the Codex session parser.
 *
 * Covers the corrections surfaced by the Codex agent during scoping:
 *   - total_tokens is cumulative; repeated snapshots must not double-count
 *   - sessions can be entirely outside the target date and must be ignored
 *   - giant lines (compacted events) must not OOM the parser
 *   - quota snapshot is captured even when token info is null
 *   - schema is unversioned — unknown event types are silently tolerated
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { getCodexDailyUsage } from "../src/core/usage-stats-codex.js";
import { mergeDailyUsages, recomputeUsageTotals } from "../src/core/usage-stats.js";
import type { DailyUsage } from "../src/core/usage-stats.js";

describe("getCodexDailyUsage", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "claude-report-codex-"));
    origHome = process.env.HOME;
    process.env.HOME = tmp;
    if (homedir() !== tmp) throw new Error("homedir() did not follow HOME; skip");
  });

  afterEach(() => {
    if (origHome) process.env.HOME = origHome;
    else delete process.env.HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Write a Codex session JSONL inside ~/.codex/sessions/YYYY/MM/DD/. */
  function writeSession(date: string, name: string, entries: any[]): string {
    const [y, m, d] = date.split("-");
    const dir = join(tmp, ".codex", "sessions", y, m, d);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-${name}.jsonl`);
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"), "utf-8");
    return path;
  }

  function ts(date: string, hh: string, mm = "00"): string {
    return `${date}T${hh}:${mm}:00.000Z`;
  }

  it("sums tokens via max(0, total_now - total_prev) — repeated snapshots don't double-count", async () => {
    const date = "2026-04-27";
    writeSession(date, "abc-001", [
      {
        type: "session_meta",
        timestamp: ts(date, "10"),
        payload: { id: "s1", cwd: "/Users/x/Projects/foo", cli_version: "0.125.0" },
      },
      // First real token snapshot — total advances to 1000
      {
        type: "event_msg",
        timestamp: ts(date, "10", "01"),
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 800, output_tokens: 200, cached_input_tokens: 100, total_tokens: 1000 },
          },
          rate_limits: { plan_type: "plus", primary: { used_percent: 5 }, secondary: { used_percent: 20 } },
        },
      },
      // Repeated snapshot — same total, no advance. Must NOT double-count.
      {
        type: "event_msg",
        timestamp: ts(date, "10", "02"),
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 800, output_tokens: 200, cached_input_tokens: 100, total_tokens: 1000 },
          },
          rate_limits: { plan_type: "plus", primary: { used_percent: 5 }, secondary: { used_percent: 20 } },
        },
      },
      // Real advance — total now 2500. Delta = 1500 (input +700, output +800).
      {
        type: "event_msg",
        timestamp: ts(date, "10", "03"),
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 1500, output_tokens: 1000, cached_input_tokens: 200, total_tokens: 2500 },
          },
          rate_limits: { plan_type: "plus", primary: { used_percent: 8 }, secondary: { used_percent: 22 } },
        },
      },
    ]);

    const usage = await getCodexDailyUsage(date);
    expect(usage.totals.sessionCount).toBe(1);
    expect(usage.totals.inputTokens).toBe(1500); // 800 + 700, NOT 800+800+700
    expect(usage.totals.outputTokens).toBe(1000); // 200 + 800
    expect(usage.totals.cacheReadTokens).toBe(200); // 100 + 100
  });

  it("ignores sessions whose only events fall outside the target date", async () => {
    const target = "2026-04-27";
    const yesterday = "2026-04-26";
    writeSession(yesterday, "old-002", [
      { type: "session_meta", timestamp: ts(yesterday, "10"), payload: { id: "s2", cwd: "/Users/x/Projects/bar" } },
      {
        type: "event_msg",
        timestamp: ts(yesterday, "11"),
        payload: { type: "user_message", message: "do a thing" },
      },
      {
        type: "event_msg",
        timestamp: ts(yesterday, "12"),
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0, total_tokens: 150 } },
        },
      },
    ]);
    // Bump mtime so the file passes the cutoff check
    utimesSync(
      join(tmp, ".codex", "sessions", "2026", "04", "26", "rollout-old-002.jsonl"),
      new Date(`${target}T08:00:00Z`),
      new Date(`${target}T08:00:00Z`),
    );

    const usage = await getCodexDailyUsage(target);
    expect(usage.totals.sessionCount).toBe(0);
    expect(usage.totals.inputTokens).toBe(0);
  });

  it("attributes a session to the cwd from session_meta and prefers a later turn_context cwd", async () => {
    const date = "2026-04-27";
    writeSession(date, "cwd-003", [
      { type: "session_meta", timestamp: ts(date, "10"), payload: { id: "s3", cwd: "/Users/x/Projects/initial" } },
      { type: "turn_context", timestamp: ts(date, "10", "30"), payload: { cwd: "/Users/x/Projects/changed" } },
      {
        type: "event_msg",
        timestamp: ts(date, "11"),
        payload: { type: "user_message", message: "hello" },
      },
      {
        type: "event_msg",
        timestamp: ts(date, "11", "01"),
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, total_tokens: 15 } },
        },
      },
    ]);

    const usage = await getCodexDailyUsage(date);
    expect(usage.sessions).toHaveLength(1);
    // projectNameFromPath truncates to last 2 segments of the home-relative path
    expect(usage.sessions[0].project).toBe("Projects/changed");
  });

  it("captures the latest quota snapshot across multiple sessions", async () => {
    const date = "2026-04-27";
    writeSession(date, "quota-004", [
      { type: "session_meta", timestamp: ts(date, "09"), payload: { id: "s4", cwd: "/Users/x/Projects/q1" } },
      {
        type: "event_msg",
        timestamp: ts(date, "09", "30"),
        payload: {
          type: "token_count",
          info: null,
          rate_limits: { plan_type: "plus", primary: { used_percent: 10 }, secondary: { used_percent: 30 } },
        },
      },
    ]);
    writeSession(date, "quota-005", [
      { type: "session_meta", timestamp: ts(date, "14"), payload: { id: "s5", cwd: "/Users/x/Projects/q2" } },
      {
        type: "event_msg",
        timestamp: ts(date, "14", "30"),
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, total_tokens: 2 } },
          rate_limits: { plan_type: "plus", primary: { used_percent: 25 }, secondary: { used_percent: 55 } },
        },
      },
    ]);

    const usage = await getCodexDailyUsage(date);
    expect(usage.codexQuota).toBeDefined();
    expect(usage.codexQuota?.planType).toBe("plus");
    // Latest snapshot (14:30) wins
    expect(usage.codexQuota?.primaryPct).toBe(25);
    expect(usage.codexQuota?.secondaryPct).toBe(55);
  });

  it("tolerates unknown event types and giant compacted lines without crashing", async () => {
    const date = "2026-04-27";
    const giant = "x".repeat(500_000); // 500KB — would OOM if we held onto it
    writeSession(date, "tolerant-006", [
      { type: "session_meta", timestamp: ts(date, "10"), payload: { id: "s6", cwd: "/Users/x/Projects/big" } },
      // Unknown top-level type — must be silently ignored
      { type: "future_event", timestamp: ts(date, "10", "01"), payload: { foo: "bar" } },
      // Unknown event_msg subtype — same treatment
      {
        type: "event_msg",
        timestamp: ts(date, "10", "02"),
        payload: { type: "mcp_tool_call_end", call_id: "x" },
      },
      // Giant compacted line
      {
        type: "event_msg",
        timestamp: ts(date, "10", "03"),
        payload: { type: "context_compacted", content: giant },
      },
      // Valid token snapshot after — must still be counted
      {
        type: "event_msg",
        timestamp: ts(date, "10", "04"),
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 50, output_tokens: 25, cached_input_tokens: 0, total_tokens: 75 } },
        },
      },
      {
        type: "event_msg",
        timestamp: ts(date, "10", "05"),
        payload: { type: "task_complete" },
      },
    ]);

    const usage = await getCodexDailyUsage(date);
    expect(usage.sessions).toHaveLength(1);
    expect(usage.sessions[0].inputTokens).toBe(50);
    expect(usage.sessions[0].assistantTurns).toBe(1);
  });

  it("extracts user prompts and shell-derived activities", async () => {
    const date = "2026-04-27";
    writeSession(date, "act-007", [
      { type: "session_meta", timestamp: ts(date, "10"), payload: { id: "s7", cwd: "/Users/x/Projects/acts" } },
      {
        type: "event_msg",
        timestamp: ts(date, "10", "01"),
        payload: { type: "user_message", message: "ship the codex parser please" },
      },
      {
        type: "event_msg",
        timestamp: ts(date, "10", "02"),
        payload: {
          type: "exec_command_end",
          command: ["/bin/zsh", "-lc", "git push origin main"],
          cwd: "/Users/x/Projects/acts",
        },
      },
      {
        type: "event_msg",
        timestamp: ts(date, "10", "03"),
        payload: {
          type: "exec_command_end",
          command: ["/bin/zsh", "-lc", "npx vitest run"],
          cwd: "/Users/x/Projects/acts",
        },
      },
      {
        type: "event_msg",
        timestamp: ts(date, "10", "04"),
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, total_tokens: 2 } },
        },
      },
    ]);

    const usage = await getCodexDailyUsage(date);
    const s = usage.sessions[0];
    expect(s).toBeDefined();
    expect(s.userMessages).toBe(1);
    const types = s.activities.map((a) => a.type);
    expect(types).toContain("prompt");
    expect(types).toContain("push");
    expect(types).toContain("test");
  });

  it("marks all sessions with source: codex", async () => {
    const date = "2026-04-27";
    writeSession(date, "src-008", [
      { type: "session_meta", timestamp: ts(date, "10"), payload: { id: "s8", cwd: "/Users/x/Projects/src" } },
      {
        type: "event_msg",
        timestamp: ts(date, "10", "01"),
        payload: { type: "user_message", message: "marker prompt" },
      },
      {
        type: "event_msg",
        timestamp: ts(date, "10", "02"),
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, total_tokens: 2 } },
        },
      },
    ]);

    const usage = await getCodexDailyUsage(date);
    for (const s of usage.sessions) expect(s.source).toBe("codex");
  });
});

describe("mergeDailyUsages + recomputeUsageTotals", () => {
  function makeUsage(date: string, partial: Partial<DailyUsage>): DailyUsage {
    return {
      date,
      sessions: partial.sessions ?? [],
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        userMessages: 0,
        assistantTurns: 0,
        sessionCount: 0,
      },
      estimatedCostUsd: 0,
      activities: partial.activities ?? [],
      codexQuota: partial.codexQuota,
    };
  }

  it("excludes Codex sessions from $ cost but sums their tokens into totals", () => {
    const date = "2026-04-27";
    const claude = makeUsage(date, {
      sessions: [
        {
          sessionId: "cc-1",
          project: "p/a",
          model: "claude-sonnet-4-6",
          source: "claude-code",
          inputTokens: 1_000_000, // 1M @ $3 = $3
          outputTokens: 100_000,  // 100K @ $15 = $1.50
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          userMessages: 1,
          assistantTurns: 1,
          startedAt: "",
          lastActiveAt: "",
          activities: [],
        },
      ],
    });
    const codex = makeUsage(date, {
      sessions: [
        {
          sessionId: "cx-1",
          project: "p/b",
          model: "codex/0.125.0",
          source: "codex",
          inputTokens: 2_000_000,
          outputTokens: 50_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          userMessages: 1,
          assistantTurns: 1,
          startedAt: "",
          lastActiveAt: "",
          activities: [],
        },
      ],
      codexQuota: { planType: "plus", primaryPct: 30, secondaryPct: 46, capturedAt: "x" },
    });

    const merged = mergeDailyUsages(claude, codex);
    expect(merged.totals.sessionCount).toBe(2);
    expect(merged.totals.inputTokens).toBe(3_000_000);
    expect(merged.totals.outputTokens).toBe(150_000);
    expect(merged.codexQuota?.planType).toBe("plus");
    // Cost = $3.00 (Claude input) + $1.50 (Claude output) — Codex contributes $0
    expect(merged.estimatedCostUsd).toBeCloseTo(4.5, 4);
  });
});
