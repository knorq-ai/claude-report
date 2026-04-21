/**
 * Pure rendering tests for buildProjectBlocks.
 *
 * Guards three pre-publish concerns from 0.1.6:
 *  - malicious / tampered project names must not break the mrkdwn code span,
 *  - no single section can blow past Slack's 3000-char limit even if a
 *    caller sends a maxed-out array of maxed-out bullets,
 *  - bullet sanitation (empty, whitespace, too long, non-string) is honored.
 */
import { describe, it, expect } from "vitest";
import {
  buildProjectBlocks,
  BULLETS_PER_PROJECT_MAX,
  BULLET_CHARS_MAX,
  SECTION_CHARS_MAX,
} from "../src/core/usage-stats.js";

type Block = { type: string; text?: { type: string; text: string } };

function sectionText(block: Block): string {
  if (block.type !== "section") throw new Error("not a section block");
  return block.text!.text;
}

describe("buildProjectBlocks", () => {
  it("emits one section per project, sorted by tokens desc", () => {
    const byProject = new Map([
      ["Projects/alpha", { tokens: 100, prompts: 5 }],
      ["Projects/beta",  { tokens: 500, prompts: 2 }],
      ["Projects/gamma", { tokens: 50,  prompts: 1 }],
    ]);
    const blocks = buildProjectBlocks(byProject, {}) as Block[];
    expect(blocks).toHaveLength(3);
    expect(sectionText(blocks[0])).toContain("Projects/beta");
    expect(sectionText(blocks[1])).toContain("Projects/alpha");
    expect(sectionText(blocks[2])).toContain("Projects/gamma");
  });

  it("caps at 10 bullets per project", () => {
    const byProject = new Map([["p", { tokens: 1, prompts: 1 }]]);
    const summaries = { p: Array.from({ length: 50 }, (_, i) => `bullet ${i}`) };
    const blocks = buildProjectBlocks(byProject, summaries) as Block[];
    const text = sectionText(blocks[0]);
    const bulletCount = text.split("\n").filter((l) => l.trim().startsWith("\u2022")).length;
    // Header line also starts with • — total bullet-shaped lines = 10 + 1 header.
    expect(bulletCount).toBe(BULLETS_PER_PROJECT_MAX + 1);
  });

  it("truncates each bullet at BULLET_CHARS_MAX with an ellipsis tail", () => {
    const byProject = new Map([["p", { tokens: 1, prompts: 1 }]]);
    const long = "a".repeat(BULLET_CHARS_MAX * 3);
    const blocks = buildProjectBlocks(byProject, { p: [long] }) as Block[];
    const text = sectionText(blocks[0]);
    // Ellipsis present; bullet payload (after the "    • " prefix) is capped.
    expect(text.includes("\u2026")).toBe(true);
    const bulletLine = text.split("\n").find((l) => l.startsWith("    "))!;
    // "    \u2022 " prefix is 6 chars; payload must equal BULLET_CHARS_MAX.
    const payload = bulletLine.slice(6);
    expect(payload.length).toBe(BULLET_CHARS_MAX);
    expect(payload.endsWith("\u2026")).toBe(true);
  });

  it("filters empty/whitespace/non-string bullets", () => {
    const byProject = new Map([["p", { tokens: 1, prompts: 1 }]]);
    const summaries = {
      p: ["real one", "", "   ", null as any, undefined as any, 42 as any, "second real"],
    };
    const blocks = buildProjectBlocks(byProject, summaries) as Block[];
    const text = sectionText(blocks[0]);
    const bullets = text.split("\n").filter((l) => l.startsWith("    "));
    expect(bullets).toHaveLength(2);
    expect(bullets[0]).toContain("real one");
    expect(bullets[1]).toContain("second real");
  });

  it("renders header only when summaries is missing for a project", () => {
    const byProject = new Map([["Projects/x", { tokens: 1000, prompts: 3 }]]);
    const blocks = buildProjectBlocks(byProject, {}) as Block[];
    const text = sectionText(blocks[0]);
    expect(text).toContain("Projects/x");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("sanitizes backticks and newlines in project names so the code span stays closed", () => {
    const attackerName = "evil`name\n*bold*\n<!channel>";
    const byProject = new Map([[attackerName, { tokens: 1, prompts: 1 }]]);
    const blocks = buildProjectBlocks(byProject, {}) as Block[];
    const text = sectionText(blocks[0]);

    // No backticks leaked into the code span payload.
    const codeSpan = text.match(/`([^`]*)`/);
    expect(codeSpan).not.toBeNull();
    expect(codeSpan![1]).not.toContain("`");
    expect(codeSpan![1]).not.toContain("\n");
    // `<` was entity-escaped rather than left raw for Slack's auto-mention parser.
    expect(codeSpan![1]).not.toContain("<!channel");
    expect(codeSpan![1]).toContain("&lt;");
  });

  it("bounds each section below Slack's 3000-char limit even with max inputs", () => {
    const byProject = new Map([["worst", { tokens: 1, prompts: 1 }]]);
    const big = "x".repeat(BULLET_CHARS_MAX * 2); // double the cap
    const summaries = {
      worst: Array.from({ length: BULLETS_PER_PROJECT_MAX * 3 }, () => big),
    };
    const blocks = buildProjectBlocks(byProject, summaries) as Block[];
    const text = sectionText(blocks[0]);
    expect(text.length).toBeLessThanOrEqual(SECTION_CHARS_MAX);
  });
});
