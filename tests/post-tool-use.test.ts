/**
 * Tests for post-tool-use hook event detection logic.
 * Imports the real exported functions — no duplicated copies.
 */
import { describe, it, expect } from "vitest";
import {
  detectBashEvent,
  detectTaskEvent,
  getToolOutput,
  parseTaskOutput,
} from "../src/hooks/post-tool-use.js";

// extractBranch and isTestCommand are not exported (internal helpers),
// but they are exercised through detectBashEvent.

// ---------------------------------------------------------------------------
// detectBashEvent
// ---------------------------------------------------------------------------

describe("detectBashEvent", () => {
  describe("git push", () => {
    it("detects successful push", () => {
      const result = detectBashEvent(
        "git push origin main",
        "To github.com:user/repo.git\n   abc1234..def5678  main -> main",
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe("push");
      expect(result!.summary).toContain("main");
    });

    it("returns null on failed push", () => {
      const result = detectBashEvent(
        "git push origin main",
        "error: failed to push some refs",
      );
      expect(result).toBeNull();
    });

    it("ignores dry-run push", () => {
      const result = detectBashEvent(
        "git push --dry-run origin main",
        "To github.com:user/repo.git\n   abc..def  main -> main",
      );
      expect(result).toBeNull();
    });

    it("detects push in chained command", () => {
      const result = detectBashEvent(
        "git add . && git commit -m 'fix' && git push origin develop",
        "[develop abc1234] fix\nTo github.com:user/repo.git\n   111..222  develop -> develop",
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe("push");
    });

    it("extracts branch from command args", () => {
      const result = detectBashEvent(
        "git push origin develop",
        "To github.com:user/repo.git\n   abc..def  develop -> develop",
      );
      expect(result!.metadata!.branch).toBe("develop");
    });

    it("extracts resolved branch name from output (prefers output over command)", () => {
      const result = detectBashEvent(
        "git push origin HEAD:refs/heads/feature",
        "To github.com:user/repo.git\n   abc..def  HEAD -> feature",
      );
      // Output's "HEAD -> feature" is the resolved destination branch name,
      // which is more user-friendly than the raw refspec.
      expect(result!.metadata!.branch).toBe("feature");
    });

    it("falls back to output parsing when no command args", () => {
      const result = detectBashEvent(
        "git push",
        "To github.com:user/repo.git\n   abc1234..def5678  main -> main",
      );
      expect(result!.metadata!.branch).toBe("main");
    });
  });

  describe("git commit", () => {
    it("detects successful commit", () => {
      const result = detectBashEvent(
        "git commit -m 'Add auth middleware'",
        "[main abc1234] Add auth middleware\n 2 files changed",
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe("status");
      expect(result!.summary).toContain("Add auth middleware");
    });

    it("extracts branch name from output", () => {
      const result = detectBashEvent(
        "git commit -m 'fix bug'",
        "[feature/auth abc1234] fix bug\n 1 file changed",
      );
      expect(result!.metadata!.branch).toBe("feature/auth");
    });

    it("returns null on failed commit", () => {
      const result = detectBashEvent(
        "git commit -m 'test'",
        "nothing to commit, working tree clean",
      );
      expect(result).toBeNull();
    });

    it("ignores dry-run commit", () => {
      const result = detectBashEvent(
        "git commit --dry-run -m 'test'",
        "[main abc1234] test\n 1 file changed",
      );
      expect(result).toBeNull();
    });

    it("truncates long commit messages to 100 chars", () => {
      const longMsg = "x".repeat(200);
      const result = detectBashEvent(
        "git commit -m 'long'",
        `[main abc1234] ${longMsg}\n 1 file changed`,
      );
      expect(result!.summary.length).toBeLessThanOrEqual(111); // "Committed: " + 100
    });
  });

  describe("gh pr create", () => {
    it("detects PR creation", () => {
      const result = detectBashEvent(
        "gh pr create --title 'Fix auth' --body 'Details'",
        "https://github.com/user/repo/pull/42",
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe("completion");
      expect(result!.summary).toContain("pull/42");
    });

    it("returns null when PR creation fails", () => {
      const result = detectBashEvent(
        "gh pr create --title 'Fix'",
        "pull request create failed: already exists",
      );
      expect(result).toBeNull();
    });
  });

  describe("test failures", () => {
    it("detects exit code failure", () => {
      const result = detectBashEvent(
        "npm test",
        "Test suite failed\nExit code 1",
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe("blocker");
    });

    it("detects explicit failure count", () => {
      const result = detectBashEvent(
        "npx vitest",
        "Tests: 3 failed, 10 passed\n",
      );
      expect(result).not.toBeNull();
      expect(result!.summary).toBe("Tests failing: 3 failures");
    });

    it("detects 'exited with code' pattern", () => {
      const result = detectBashEvent(
        "npm test",
        "process exited with code 2",
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe("blocker");
    });

    it("does NOT false-positive on 'error' in passing output", () => {
      const result = detectBashEvent(
        "npm test",
        "✓ error handling tests\n✓ error boundary tests\nAll tests passed",
      );
      expect(result).toBeNull();
    });

    it("does NOT false-positive on 'exited with 0'", () => {
      const result = detectBashEvent(
        "npm test",
        "Process exited with code 0\nAll tests passed",
      );
      expect(result).toBeNull();
    });

    it("does NOT false-positive on 'exited with' without code", () => {
      const result = detectBashEvent(
        "npm test",
        "Worker exited with success\nAll tests passed",
      );
      expect(result).toBeNull();
    });

    it("ignores non-test commands", () => {
      const result = detectBashEvent(
        "npm run build",
        "Error: compilation failed\nExit code 1",
      );
      expect(result).toBeNull();
    });

    it("recognizes various test runners", () => {
      for (const cmd of ["npm test", "npx vitest", "npx jest", "pytest", "go test ./...", "cargo test", "make test", "yarn test", "pnpm test"]) {
        const result = detectBashEvent(cmd, "3 failed\nExit code 1");
        expect(result, `should detect failure for: ${cmd}`).not.toBeNull();
      }
    });
  });

  describe("non-matching commands", () => {
    it("returns null for unrecognized commands", () => {
      expect(detectBashEvent("ls -la", "file1\nfile2")).toBeNull();
      expect(detectBashEvent("npm run build", "done")).toBeNull();
      expect(detectBashEvent("echo hello", "hello")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// parseTaskOutput
// ---------------------------------------------------------------------------

describe("parseTaskOutput", () => {
  it("parses JSON output", () => {
    const result = parseTaskOutput(JSON.stringify({
      subject: "Implement auth",
      description: "Added JWT middleware",
    }));
    expect(result.subject).toBe("Implement auth");
    expect(result.description).toBe("Added JWT middleware");
  });

  it("parses text with quoted values", () => {
    const result = parseTaskOutput('subject: "Fix login bug"\ndescription: "Updated validation"');
    expect(result.subject).toBe("Fix login bug");
    expect(result.description).toBe("Updated validation");
  });

  it("parses text with unquoted values", () => {
    const result = parseTaskOutput("subject: Fix the login flow\ndescription: Changed auth handler");
    expect(result.subject).toBe("Fix the login flow");
    expect(result.description).toBe("Changed auth handler");
  });

  it("returns empty for empty input", () => {
    expect(parseTaskOutput("")).toEqual({});
  });

  it("returns empty for unparseable input", () => {
    expect(parseTaskOutput("random text without structure")).toEqual({});
  });

  it("handles JSON with missing fields", () => {
    const result = parseTaskOutput(JSON.stringify({ other: "field" }));
    expect(result.subject).toBeUndefined();
    expect(result.description).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getToolOutput
// ---------------------------------------------------------------------------

describe("getToolOutput", () => {
  it("returns tool_output string when present", () => {
    const result = getToolOutput({
      tool_name: "Bash",
      tool_input: {},
      tool_output: "hello world",
    });
    expect(result).toBe("hello world");
  });

  it("returns tool_response string when tool_output is absent", () => {
    const result = getToolOutput({
      tool_name: "Bash",
      tool_input: {},
      tool_response: "from response",
    });
    expect(result).toBe("from response");
  });

  it("extracts stdout from structured tool_response object", () => {
    const result = getToolOutput({
      tool_name: "Bash",
      tool_input: {},
      tool_response: {
        stdout: "[main abc1234] test\nTo github.com:user/repo.git\n   abc..def  main -> main",
        stderr: "",
        interrupted: false,
      },
    });
    expect(result).toContain("[main abc1234]");
    expect(result).toContain("To github.com");
  });

  it("falls back to stderr when stdout is empty", () => {
    const result = getToolOutput({
      tool_name: "Bash",
      tool_input: {},
      tool_response: {
        stdout: "",
        stderr: "To github.com:user/repo.git\n   abc..def  main -> main",
      },
    });
    expect(result).toContain("To github.com");
  });

  it("concatenates stdout and stderr when both present", () => {
    const result = getToolOutput({
      tool_name: "Bash",
      tool_input: {},
      tool_response: {
        stdout: "[main abc] commit msg",
        stderr: "To github.com:user/repo.git",
      },
    });
    expect(result).toContain("[main abc] commit msg");
    expect(result).toContain("To github.com");
  });

  it("returns empty string when stdout is missing from object", () => {
    const result = getToolOutput({
      tool_name: "Bash",
      tool_input: {},
      tool_response: { interrupted: false },
    });
    expect(result).toBe("");
  });

  it("returns empty string when stdout is null", () => {
    const result = getToolOutput({
      tool_name: "Bash",
      tool_input: {},
      tool_response: { stdout: null, stderr: "" } as any,
    });
    expect(result).toBe("");
  });

  it("returns empty string when both fields are absent", () => {
    const result = getToolOutput({
      tool_name: "Bash",
      tool_input: {},
    });
    expect(result).toBe("");
  });

  it("prefers tool_output over tool_response", () => {
    const result = getToolOutput({
      tool_name: "Bash",
      tool_input: {},
      tool_output: "from output",
      tool_response: { stdout: "from response" },
    });
    expect(result).toBe("from output");
  });
});

// ---------------------------------------------------------------------------
// detectTaskEvent
// ---------------------------------------------------------------------------

describe("detectTaskEvent", () => {
  it("extracts subject from structured tool_response", () => {
    const result = detectTaskEvent(
      { taskId: "7", status: "completed" },
      "",
      { taskId: "7", status: "completed", subject: "Implement auth middleware" },
    );
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Task completed: Implement auth middleware");
  });

  it("prefers tool_input.subject over rawResponse", () => {
    const result = detectTaskEvent(
      { taskId: "7", status: "completed", subject: "From input" },
      "",
      { subject: "From response" },
    );
    expect(result!.summary).toBe("Task completed: From input");
  });

  it("falls back to parsed output subject", () => {
    const result = detectTaskEvent(
      { taskId: "7", status: "completed" },
      JSON.stringify({ subject: "From output" }),
    );
    expect(result!.summary).toBe("Task completed: From output");
  });

  it("falls back to task ID when no subject available", () => {
    const result = detectTaskEvent(
      { taskId: "7", status: "completed" },
      "",
    );
    expect(result!.summary).toBe("Task completed: #7");
  });

  it("returns null for non-completed tasks", () => {
    const result = detectTaskEvent(
      { taskId: "7", status: "in_progress" },
      "",
    );
    expect(result).toBeNull();
  });

  it("extracts description from structured response", () => {
    const result = detectTaskEvent(
      { taskId: "7", status: "completed" },
      "",
      { subject: "Auth", description: "Added JWT middleware" },
    );
    expect(result!.details).toBe("Added JWT middleware");
  });
});
