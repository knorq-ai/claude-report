/**
 * Tests for the Codex watcher's pure event-translation logic. The
 * filesystem-tailing layer is deliberately not exercised here — real
 * end-to-end behavior is verified by running the daemon against live
 * `~/.codex/sessions/**` once installed.
 */
import { describe, it, expect } from "vitest";
import { eventFromCodexLine } from "../src/codex-watcher/index.js";

describe("eventFromCodexLine", () => {
  it("returns null for non-event_msg entries", () => {
    expect(eventFromCodexLine({ type: "session_meta", payload: {} })).toBeNull();
    expect(eventFromCodexLine({ type: "turn_context", payload: {} })).toBeNull();
    expect(eventFromCodexLine({ type: "response_item", payload: {} })).toBeNull();
  });

  it("returns null for unknown event_msg subtypes", () => {
    expect(
      eventFromCodexLine({
        type: "event_msg",
        timestamp: "2026-04-27T10:00:00Z",
        payload: { type: "user_message", message: "hi" },
      }),
    ).toBeNull();
    expect(
      eventFromCodexLine({
        type: "event_msg",
        timestamp: "2026-04-27T10:00:00Z",
        payload: { type: "token_count", info: null },
      }),
    ).toBeNull();
  });

  it("detects git push from exec_command_end + aggregated_output", () => {
    const out = eventFromCodexLine({
      type: "event_msg",
      timestamp: "2026-04-27T10:00:00Z",
      payload: {
        type: "exec_command_end",
        command: ["/bin/zsh", "-lc", "git push origin main"],
        cwd: "/Users/x/Projects/foo",
        aggregated_output: "To github.com:user/repo.git\n   abc..def  main -> main\n",
        exit_code: 0,
        status: "completed",
      },
    });
    expect(out).not.toBeNull();
    expect(out!.event.type).toBe("push");
    expect(out!.event.summary).toContain("Pushed to main");
    expect(out!.ctx.cwd).toBe("/Users/x/Projects/foo");
  });

  it("detects git commit from heredoc-style commit message", () => {
    const out = eventFromCodexLine({
      type: "event_msg",
      timestamp: "2026-04-27T10:00:00Z",
      payload: {
        type: "exec_command_end",
        command: ["/bin/zsh", "-lc", "git commit -m 'fix: codex watcher edge case'"],
        cwd: "/Users/x/Projects/foo",
        aggregated_output: "[main abc1234] fix: codex watcher edge case\n 1 file changed, 1 insertion(+)\n",
        exit_code: 0,
        status: "completed",
      },
    });
    expect(out).not.toBeNull();
    expect(out!.event.type).toBe("status");
    expect(out!.event.summary).toContain("fix: codex watcher edge case");
  });

  it("detects test failures from non-zero exit + failure count", () => {
    const out = eventFromCodexLine({
      type: "event_msg",
      timestamp: "2026-04-27T10:00:00Z",
      payload: {
        type: "exec_command_end",
        command: ["/bin/zsh", "-lc", "npx vitest run"],
        cwd: "/Users/x/Projects/foo",
        aggregated_output: "FAIL  src/foo.test.ts > bar\nTests: 3 failed, 50 passed\n",
        exit_code: 1,
        status: "completed",
      },
    });
    expect(out).not.toBeNull();
    expect(out!.event.type).toBe("blocker");
    expect(out!.event.summary).toContain("3 failures");
  });

  it("returns null when a benign command produces no event", () => {
    const out = eventFromCodexLine({
      type: "event_msg",
      timestamp: "2026-04-27T10:00:00Z",
      payload: {
        type: "exec_command_end",
        command: ["/bin/zsh", "-lc", "ls -la"],
        cwd: "/Users/x/Projects/foo",
        aggregated_output: "total 0\n",
        exit_code: 0,
      },
    });
    expect(out).toBeNull();
  });

  it("falls back to stdout+stderr when aggregated_output is missing", () => {
    const out = eventFromCodexLine({
      type: "event_msg",
      timestamp: "2026-04-27T10:00:00Z",
      payload: {
        type: "exec_command_end",
        command: ["/bin/zsh", "-lc", "git push origin feat/x"],
        cwd: "/Users/x/Projects/foo",
        stdout: "",
        stderr: "To github.com:user/repo.git\n * [new branch]      feat/x -> feat/x\n",
        exit_code: 0,
      },
    });
    expect(out).not.toBeNull();
    expect(out!.event.type).toBe("push");
    expect(out!.event.summary).toContain("feat/x");
  });

  it("captures cwd and turn_id from the payload", () => {
    const out = eventFromCodexLine({
      type: "event_msg",
      timestamp: "2026-04-27T10:00:00Z",
      payload: {
        type: "exec_command_end",
        command: ["/bin/zsh", "-lc", "git push origin main"],
        cwd: "/Users/x/Projects/bar",
        turn_id: "abc-123",
        aggregated_output: "To github.com:user/repo.git\n   1..2  main -> main\n",
        exit_code: 0,
      },
    });
    expect(out!.ctx.cwd).toBe("/Users/x/Projects/bar");
    expect(out!.ctx.sessionId).toBe("abc-123");
  });

  it("ignores malformed payloads without crashing", () => {
    expect(eventFromCodexLine({})).toBeNull();
    expect(eventFromCodexLine({ type: "event_msg" })).toBeNull();
    expect(eventFromCodexLine({ type: "event_msg", payload: { type: "exec_command_end" } })).toBeNull();
    expect(
      eventFromCodexLine({
        type: "event_msg",
        payload: { type: "exec_command_end", command: "not-an-array" },
      }),
    ).toBeNull();
  });
});
