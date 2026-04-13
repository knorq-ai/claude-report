import { describe, it, expect } from "vitest";
import { ContentFilter } from "../src/core/content-filter.js";
import type { StatusUpdate } from "../src/core/types.js";

function makeUpdate(overrides: Partial<StatusUpdate> = {}): StatusUpdate {
  return {
    type: "status",
    summary: "Working on feature",
    timestamp: new Date(),
    userId: "U123",
    sessionId: "sess-1",
    project: "my-project",
    ...overrides,
  };
}

describe("ContentFilter", () => {
  const filter = new ContentFilter();

  describe("length enforcement", () => {
    it("truncates summary longer than 150 chars", () => {
      const longSummary = "x".repeat(200);
      const result = filter.filter(makeUpdate({ summary: longSummary }));
      expect(result.summary.length).toBe(150);
      expect(result.summary.endsWith("...")).toBe(true);
    });

    it("truncates details longer than 500 chars", () => {
      const longDetails = "y".repeat(600);
      const result = filter.filter(makeUpdate({ details: longDetails }));
      expect(result.details!.length).toBe(500);
      expect(result.details!.endsWith("...")).toBe(true);
    });

    it("preserves short text as-is", () => {
      const result = filter.filter(makeUpdate({ summary: "short" }));
      expect(result.summary).toBe("short");
    });
  });

  describe("secret stripping", () => {
    it("redacts AWS access keys", () => {
      const result = filter.filter(
        makeUpdate({ summary: "Found key AKIAIOSFODNN7EXAMPLE" }),
      );
      expect(result.summary).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(result.summary).toContain("[REDACTED]");
    });

    it("redacts JWT tokens", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
      const result = filter.filter(
        makeUpdate({ summary: `Token: ${jwt}` }),
      );
      expect(result.summary).not.toContain("eyJ");
      expect(result.summary).toContain("[REDACTED]");
    });

    it("redacts Slack bot tokens", () => {
      const result = filter.filter(
        makeUpdate({ summary: "Token is xoxb-1234-5678-abcdef" }),
      );
      expect(result.summary).not.toContain("xoxb-");
      expect(result.summary).toContain("[REDACTED]");
    });

    it("redacts GitHub PATs", () => {
      const result = filter.filter(
        makeUpdate({
          summary: "Using ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
        }),
      );
      expect(result.summary).not.toContain("ghp_");
      expect(result.summary).toContain("[REDACTED]");
    });

    it("redacts key=value secrets", () => {
      const result = filter.filter(
        makeUpdate({ summary: "Set password=mysecretpass123" }),
      );
      expect(result.summary).not.toContain("mysecretpass123");
      expect(result.summary).toContain("[REDACTED]");
    });

    it("preserves clean text", () => {
      const result = filter.filter(
        makeUpdate({ summary: "Implemented user auth" }),
      );
      expect(result.summary).toBe("Implemented user auth");
    });
  });

  describe("path sanitization", () => {
    it("sanitizes absolute paths", () => {
      const result = filter.filter(
        makeUpdate({
          summary: "Editing /Users/yuya/Projects/secret-project/src/index.ts",
        }),
      );
      expect(result.summary).not.toContain("/Users/yuya/Projects");
      expect(result.summary).toContain(".../src/index.ts");
    });

    it("preserves relative paths", () => {
      const result = filter.filter(
        makeUpdate({ summary: "Editing src/index.ts" }),
      );
      expect(result.summary).toBe("Editing src/index.ts");
    });
  });

  describe("containsSecrets", () => {
    it("detects AWS keys", () => {
      expect(filter.containsSecrets("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    });

    it("returns false for clean text", () => {
      expect(filter.containsSecrets("normal text")).toBe(false);
    });
  });
});
