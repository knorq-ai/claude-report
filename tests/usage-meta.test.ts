/**
 * Tests that parseTranscript skips synthetic role:user entries Claude Code
 * injects into transcripts: `isMeta: true` (local-command stdout, caveats,
 * <system-reminder> blocks) and `isCompactSummary: true` (the synthetic
 * "session continued from previous conversation" entry that appears after
 * /compact). Counting them inflates the daily-report "Prompts" metric.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { getDailyUsage } from "../src/core/usage-stats.js";

// The parser reads ~/.claude/projects; to avoid touching the real dir we
// redirect HOME to a tempdir for the duration of the test.
describe("parseTranscript / daily usage — synthetic user entries", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "claude-report-meta-"));
    origHome = process.env.HOME;
    process.env.HOME = tmp;
    // getProjectsDir() = join(homedir(), ".claude", "projects")
    mkdirSync(join(tmp, ".claude", "projects", "-test-project"), { recursive: true });
    // Sanity: homedir() reflects HOME on darwin/linux/wsl for this process
    if (homedir() !== tmp) throw new Error("homedir() did not follow HOME; skip");
  });

  afterEach(() => {
    if (origHome) process.env.HOME = origHome;
    else delete process.env.HOME;
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeTranscript(sessionId: string, entries: any[]) {
    const path = join(tmp, ".claude", "projects", "-test-project", `${sessionId}.jsonl`);
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"), "utf-8");
  }

  it("does NOT count isMeta user entries as prompts", () => {
    const ts = new Date().toISOString();
    const date = ts.slice(0, 10);
    writeTranscript("s1", [
      // First real user entry — sets cwd for projectNameFromPath
      { type: "user", timestamp: ts, cwd: "/fake/project", message: { content: "real prompt" } },
      // Injected stdout — should be ignored
      { type: "user", isMeta: true, timestamp: ts, message: { content: "<local-command-stdout>...</local-command-stdout>" } },
      // <system-reminder> reminder — should be ignored
      { type: "user", isMeta: true, timestamp: ts, message: { content: "<system-reminder>reminder text</system-reminder>" } },
      // Assistant turn so the session isn't dropped for assistantTurns === 0
      { type: "assistant", timestamp: ts, message: { model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "ok" }] } },
    ]);

    const usage = getDailyUsage(date);
    expect(usage.totals.sessionCount).toBe(1);
    expect(usage.totals.userMessages).toBe(1); // only the real prompt, not the 2 isMeta
    expect(usage.totals.assistantTurns).toBe(1);
  });

  it("does NOT count isCompactSummary as a prompt", () => {
    const ts = new Date().toISOString();
    const date = ts.slice(0, 10);
    writeTranscript("s2", [
      { type: "user", timestamp: ts, cwd: "/fake/project", message: { content: "pre-compact prompt" } },
      { type: "assistant", timestamp: ts, message: { model: "claude-sonnet-4-6", usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: "text", text: "answer" }] } },
      // Auto-compact injects this
      { type: "user", isCompactSummary: true, timestamp: ts, message: { content: "This session is being continued from a previous conversation..." } },
      { type: "user", timestamp: ts, message: { content: "post-compact prompt" } },
      { type: "assistant", timestamp: ts, message: { model: "claude-sonnet-4-6", usage: { input_tokens: 200, output_tokens: 80 }, content: [{ type: "text", text: "answer2" }] } },
    ]);

    const usage = getDailyUsage(date);
    expect(usage.totals.userMessages).toBe(2); // pre + post, NOT the compact summary
    expect(usage.totals.assistantTurns).toBe(2);
  });

  it("still counts legitimate user prompts (regression: the filter must not be too aggressive)", () => {
    const ts = new Date().toISOString();
    const date = ts.slice(0, 10);
    writeTranscript("s3", [
      { type: "user", timestamp: ts, cwd: "/fake/project", message: { content: "prompt 1" } },
      { type: "user", timestamp: ts, message: { content: "prompt 2" } },
      { type: "user", timestamp: ts, message: { content: "prompt 3" } },
      { type: "assistant", timestamp: ts, message: { model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "ok" }] } },
    ]);

    const usage = getDailyUsage(date);
    expect(usage.totals.userMessages).toBe(3);
  });

  it("still ignores tool_result entries (existing behavior preserved)", () => {
    const ts = new Date().toISOString();
    const date = ts.slice(0, 10);
    writeTranscript("s4", [
      { type: "user", timestamp: ts, cwd: "/fake/project", message: { content: "real" } },
      // API-protocol tool_result — must still be skipped
      { type: "user", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: "x", content: "output" }] } },
      { type: "assistant", timestamp: ts, message: { model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "ok" }] } },
    ]);

    const usage = getDailyUsage(date);
    expect(usage.totals.userMessages).toBe(1);
  });
});
