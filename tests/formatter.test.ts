import { describe, it, expect } from "vitest";
import {
  formatSlackBlocks,
  formatDailyParent,
  formatPlainText,
} from "../src/core/formatter.js";
import type { StatusUpdate } from "../src/core/types.js";

function makeUpdate(overrides: Partial<StatusUpdate> = {}): StatusUpdate {
  return {
    type: "status",
    summary: "Implementing auth middleware",
    timestamp: new Date("2024-06-15T14:30:00Z"),
    userId: "U123",
    sessionId: "sess-1",
    project: "my-project",
    ...overrides,
  };
}

describe("formatSlackBlocks", () => {
  it("formats a status update with blocks", () => {
    const blocks = formatSlackBlocks(makeUpdate(), "Yuya");
    expect(blocks).toHaveLength(2);
    // Section block with text
    expect((blocks[0] as any).type).toBe("section");
    expect((blocks[0] as any).text.text).toContain("Implementing auth middleware");
    // Context block with time
    expect((blocks[1] as any).type).toBe("context");
  });

  it("includes branch in context if provided", () => {
    const blocks = formatSlackBlocks(
      makeUpdate({ metadata: { branch: "feat/auth" } }),
      "Yuya",
    );
    const context = (blocks[1] as any).elements[0].text;
    expect(context).toContain("feat/auth");
  });

  it("includes details in section", () => {
    const blocks = formatSlackBlocks(
      makeUpdate({ details: "Added JWT validation" }),
      "Yuya",
    );
    expect((blocks[0] as any).text.text).toContain("Added JWT validation");
  });
});

describe("formatDailyParent", () => {
  it("formats a daily parent message", () => {
    const result = formatDailyParent("Yuya", "my-project", "2024-06-15");
    expect(result.text).toContain("Yuya");
    expect(result.text).toContain("2024-06-15");
    expect(result.blocks).toHaveLength(1);
  });
});

describe("formatPlainText", () => {
  it("formats a plain text update", () => {
    const text = formatPlainText(makeUpdate(), "Yuya");
    expect(text).toContain("[Status]");
    expect(text).toContain("Implementing auth middleware");
    expect(text).toContain("Yuya");
  });

  it("includes branch info", () => {
    const text = formatPlainText(
      makeUpdate({ metadata: { branch: "feat/auth" } }),
      "Yuya",
    );
    expect(text).toContain("feat/auth");
  });

  it("formats blocker type", () => {
    const text = formatPlainText(makeUpdate({ type: "blocker" }), "Yuya");
    expect(text).toContain("[Blocker]");
  });
});
