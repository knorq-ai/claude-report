/**
 * Covers the slug-dir dedup fold in getDailyUsage: within a single
 * ~/.claude/projects/<slug> directory, if all sibling transcripts that expose
 * a cwd agree on one canonical project name, we fold cwd-less sessions onto
 * that name. If siblings disagree, we must refuse to fold.
 *
 * extractCwdFromTranscript only scans the first 8 KB, so a long first entry
 * (compact-summary continuations, big system reminders, etc.) makes a session
 * fall back to the slug dir name and produce a phantom second row in Slack.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { getDailyUsage } from "../src/core/usage-stats.js";

// Build a transcript line with a real assistant turn so parseTranscript counts it.
function transcriptLines(opts: {
  cwd?: string;
  date: string; // YYYY-MM-DD
  padCwdPast8k?: boolean;
}): string {
  const ts = `${opts.date}T10:00:00.000Z`;
  const lines: string[] = [];

  // Optional: stuff a huge meta entry BEFORE the one that would carry cwd, so
  // extractCwdFromTranscript's 8 KB window runs out first and cwd is lost.
  if (opts.padCwdPast8k) {
    const filler = "x".repeat(10_000);
    lines.push(JSON.stringify({ type: "user", isMeta: true, timestamp: ts, message: { content: filler } }));
  }

  if (opts.cwd) {
    lines.push(JSON.stringify({ type: "user", cwd: opts.cwd, timestamp: ts, message: { content: "hi" } }));
  } else {
    lines.push(JSON.stringify({ type: "user", timestamp: ts, message: { content: "hi" } }));
  }

  // Real assistant turn with usage so the session is counted.
  lines.push(JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: {
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: "text", text: "ok" }],
    },
  }));
  return lines.join("\n") + "\n";
}

describe("getDailyUsage — slug-dir dedup fold", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "claude-report-dedup-"));
    origHome = process.env.HOME;
    process.env.HOME = tmp;
    if (homedir() !== tmp) throw new Error("homedir() did not follow HOME; skip");
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("folds a cwd-less session onto the canonical name when a sibling has cwd", () => {
    const date = "2026-04-21";
    const slug = "-Users-me-Projects-claude-report";
    const dirPath = join(tmp, ".claude", "projects", slug);
    mkdirSync(dirPath, { recursive: true });

    // Sibling A: has cwd in the first entry → project "Projects/claude-report"
    writeFileSync(
      join(dirPath, "aaa.jsonl"),
      transcriptLines({ cwd: "/Users/me/Projects/claude-report", date }),
      "utf-8",
    );
    // Sibling B: cwd pushed past the 8 KB window → falls back to slug
    writeFileSync(
      join(dirPath, "bbb.jsonl"),
      transcriptLines({ cwd: "/Users/me/Projects/claude-report", date, padCwdPast8k: true }),
      "utf-8",
    );

    const usage = getDailyUsage(date);
    const names = new Set(usage.sessions.map((s) => s.project));

    // Both sessions end up under the canonical name — no slug-form phantom row.
    expect(names.has("Projects/claude-report")).toBe(true);
    expect(names.has(slug)).toBe(false);
    expect(usage.sessions.length).toBe(2);
  });

  it("refuses to fold when sibling cwds disagree (no silent mis-attribution)", () => {
    const date = "2026-04-21";
    const slug = "-Users-me-ambiguous";
    const dirPath = join(tmp, ".claude", "projects", slug);
    mkdirSync(dirPath, { recursive: true });

    writeFileSync(
      join(dirPath, "a.jsonl"),
      transcriptLines({ cwd: "/Users/me/Projects/alpha", date }),
      "utf-8",
    );
    writeFileSync(
      join(dirPath, "b.jsonl"),
      transcriptLines({ cwd: "/Users/me/Projects/beta", date }),
      "utf-8",
    );
    writeFileSync(
      join(dirPath, "c.jsonl"),
      transcriptLines({ cwd: "/Users/me/Projects/alpha", date, padCwdPast8k: true }),
      "utf-8",
    );

    const usage = getDailyUsage(date);
    const names = new Set(usage.sessions.map((s) => s.project));

    // Alpha and Beta both surface as distinct readable names; the cwd-less
    // session stays on the slug fallback rather than being folded into one
    // of them.
    expect(names.has("Projects/alpha")).toBe(true);
    expect(names.has("Projects/beta")).toBe(true);
    expect(names.has(slug)).toBe(true);
  });

  it("leaves slug name in place when no sibling exposes a cwd", () => {
    const date = "2026-04-21";
    const slug = "-Users-me-Projects-nocwd";
    const dirPath = join(tmp, ".claude", "projects", slug);
    mkdirSync(dirPath, { recursive: true });

    writeFileSync(
      join(dirPath, "a.jsonl"),
      transcriptLines({ date, padCwdPast8k: true }),
      "utf-8",
    );

    const usage = getDailyUsage(date);
    expect(usage.sessions.map((s) => s.project)).toEqual([slug]);
  });
});
