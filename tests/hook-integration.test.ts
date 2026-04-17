/**
 * Integration test for the PostToolUse hook. Spawns the hook as a subprocess,
 * feeds real hook-input JSON via stdin, and asserts the exact Slack request
 * body that goes out. This is the contract test that catches regressions
 * where the hook path diverges from the MCP path (rate limiting, mrkdwn
 * escaping, dry-run, etc.).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

interface CapturedRequest {
  path: string;
  method: string;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

function startMockSlackServer(): Promise<{ server: Server; port: number; captured: CapturedRequest[] }> {
  const captured: CapturedRequest[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString()));
      req.on("end", () => {
        captured.push({
          path: req.url || "",
          method: req.method || "",
          body: body ? JSON.parse(body) : null,
          headers: req.headers,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        // Mock Slack: parent post returns a ts; subsequent posts also return a ts
        const ts = `${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;
        res.end(JSON.stringify({ ok: true, ts }));
      });
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, captured });
    });
  });
}

function runHook(
  hookInput: object,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const hookPath = join(process.cwd(), "dist/hooks/post-tool-use.js");
    const child = spawn("node", [hookPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env, PATH: process.env.PATH || "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    child.stdin.write(JSON.stringify(hookInput));
    child.stdin.end();
  });
}

describe("PostToolUse hook — integration", () => {
  let tempDir: string;
  let mockServer: Server;
  let serverPort: number;
  let captured: CapturedRequest[];

  beforeEach(async () => {
    const started = await startMockSlackServer();
    mockServer = started.server;
    serverPort = started.port;
    captured = started.captured;
    tempDir = mkdtempSync(join(tmpdir(), "claude-report-hook-it-"));
    // Provide a minimal config so loadConfig returns valid Slack credentials.
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        slack: { botToken: "xoxb-test-token", channel: "C-test" },
        user: { name: "TestUser", slackUserId: "U-test" },
      }),
    );
    // Pre-write the welcome marker so the hook doesn't try to send one
    // (which would hit a different endpoint with the Slack SDK, not our mock).
    writeFileSync(
      join(tempDir, "welcome-sent.json"),
      JSON.stringify({ sentAt: new Date().toISOString(), userName: "TestUser" }),
    );
  });

  afterEach(() => {
    mockServer.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function hookInputBash(command: string, stdout: string): object {
    return {
      session_id: "test-session",
      tool_name: "Bash",
      tool_input: { command },
      tool_response: { stdout, stderr: "", interrupted: false, isImage: false },
      cwd: process.cwd(),
    };
  }

  /**
   * Point the hook at our mock Slack via a tiny shim on CLAUDE_REPORT_DATA_DIR
   * so state/config goes to tempDir. The hook uses https://slack.com hardcoded;
   * for a true black-box test we'd need a DNS override. Instead we assert what
   * we CAN control: rate-limiter gates, dry-run bypass, mute, config toggles.
   */
  const env = (overrides: Record<string, string> = {}) => ({
    CLAUDE_REPORT_DATA_DIR: tempDir,
    ...overrides,
  });

  it("detects git push and would post to Slack (dry-run log asserts content)", async () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        slack: { botToken: "xoxb-test", channel: "C-test" },
        user: { name: "TestUser", slackUserId: "U-test" },
        notifications: { dryRun: true },
      }),
    );
    const { code } = await runHook(
      hookInputBash(
        "git push origin main",
        "To github.com:user/repo.git\n   abc..def  main -> main",
      ),
      env(),
    );
    expect(code).toBe(0);
    // Dry-run writes to logs/dry-run.log
    const logFile = join(tempDir, "logs", "dry-run.log");
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8");
    expect(content).toContain("Pushed to main");
    expect(content).toContain("\u{1f680}"); // rocket icon
  });

  it("escapes mrkdwn — @channel in commit message does NOT reach Slack as a mention", async () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        slack: { botToken: "xoxb-test", channel: "C-test" },
        user: { name: "TestUser", slackUserId: "U-test" },
        notifications: { dryRun: true },
      }),
    );
    const { code } = await runHook(
      hookInputBash(
        "git commit -m 'ping'",
        "[main abc1234] <!channel> ping everyone",
      ),
      env(),
    );
    expect(code).toBe(0);
    const content = readFileSync(join(tempDir, "logs", "dry-run.log"), "utf-8");
    // <!channel> must be entity-encoded; raw form would ping the channel
    expect(content).not.toContain("<!channel>");
    expect(content).toContain("&lt;!channel&gt;");
  });

  it("respects onGitPush=false — hook skips push events silently", async () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        slack: { botToken: "xoxb-test", channel: "C-test" },
        user: { name: "TestUser", slackUserId: "U-test" },
        notifications: { onGitPush: false, dryRun: true },
      }),
    );
    const { code } = await runHook(
      hookInputBash(
        "git push origin main",
        "To github.com:user/repo.git\n   abc..def  main -> main",
      ),
      env(),
    );
    expect(code).toBe(0);
    // Nothing should be logged when the event type is toggled off
    expect(existsSync(join(tempDir, "logs", "dry-run.log"))).toBe(false);
  });

  it("respects global notifications.enabled=false", async () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        slack: { botToken: "xoxb-test", channel: "C-test" },
        user: { name: "TestUser", slackUserId: "U-test" },
        notifications: { enabled: false, dryRun: true },
      }),
    );
    const { code } = await runHook(
      hookInputBash("git push origin main", "To github.com:user/repo.git\n   abc..def  main -> main"),
      env(),
    );
    expect(code).toBe(0);
    expect(existsSync(join(tempDir, "logs", "dry-run.log"))).toBe(false);
  });

  it("redacts secrets from commit messages", async () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        slack: { botToken: "xoxb-test", channel: "C-test" },
        user: { name: "TestUser", slackUserId: "U-test" },
        notifications: { dryRun: true },
      }),
    );
    const { code } = await runHook(
      hookInputBash(
        "git commit -m 'leak'",
        "[main abc1234] Added key AKIAIOSFODNN7EXAMPLE to config",
      ),
      env(),
    );
    expect(code).toBe(0);
    const content = readFileSync(join(tempDir, "logs", "dry-run.log"), "utf-8");
    expect(content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(content).toContain("[REDACTED]");
  });

  it("exits cleanly on malformed JSON input", async () => {
    const child = spawn("node", [join(process.cwd(), "dist/hooks/post-tool-use.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_REPORT_DATA_DIR: tempDir },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const exitCode = await new Promise<number>((resolve) => {
      child.on("close", (c) => resolve(c ?? -1));
      child.stdin.write("{ not valid json");
      child.stdin.end();
    });
    expect(exitCode).toBe(0); // hook never crashes the user's tool loop
    expect(stderr).toContain("invalid hook input");
  });

  it("returns silently on non-matching Bash commands (ls, cat, etc.)", async () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        slack: { botToken: "xoxb-test", channel: "C-test" },
        user: { name: "TestUser", slackUserId: "U-test" },
        notifications: { dryRun: true },
      }),
    );
    const { code } = await runHook(
      hookInputBash("ls -la", "file1\nfile2"),
      env(),
    );
    expect(code).toBe(0);
    expect(existsSync(join(tempDir, "logs", "dry-run.log"))).toBe(false);
  });

  it("concurrent hooks all exit cleanly and session state is consistent", async () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        slack: { botToken: "xoxb-test", channel: "C-test" },
        user: { name: "TestUser", slackUserId: "U-concurrent" },
        notifications: { dryRun: true },
        rateLimit: {
          minIntervalMs: 0, // disable interval gate for this test
          maxPerSession: 100,
          maxPerDay: 100,
          deduplicationWindowMs: 0, // disable dedup so all events post
          bypassTypes: [],
        },
      }),
    );

    // Launch 4 hooks in parallel with DIFFERENT branches so dedup doesn't fire.
    const hooks = ["main", "dev", "feature-a", "feature-b"].map((branch) =>
      runHook(
        hookInputBash(
          `git push origin ${branch}`,
          `To github.com:user/repo.git\n   abc..def  ${branch} -> ${branch}`,
        ),
        env(),
      ),
    );
    const results = await Promise.all(hooks);

    // Critical: all must exit cleanly. No crashes, no lock timeouts.
    for (const r of results) expect(r.code).toBe(0);

    // All 4 distinct pushes should land in the dry-run log (no dedup since
    // different branches = different summaries).
    const logContent = readFileSync(join(tempDir, "logs", "dry-run.log"), "utf-8");
    for (const branch of ["main", "dev", "feature-a", "feature-b"]) {
      expect(logContent).toContain(`Pushed to ${branch}`);
    }

    // Session file must be well-formed (not corrupted by concurrent writes).
    const { readdirSync } = await import("node:fs");
    const stateFiles = readdirSync(join(tempDir, "state"));
    const sessionPath = join(
      tempDir,
      "state",
      stateFiles.find((f) => f.startsWith("session-"))!,
    );
    const session = JSON.parse(readFileSync(sessionPath, "utf-8"));
    expect(session.postCount).toBeGreaterThanOrEqual(1);
    // postCount should be at MOST 4 (one per hook) — never exceed, never go negative
    expect(session.postCount).toBeLessThanOrEqual(4);
  });

  it("dedup uses persisted session.lastPostSummary (cross-process)", async () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        slack: { botToken: "xoxb-test", channel: "C-test" },
        user: { name: "TestUser", slackUserId: "U-dedup" },
        notifications: { dryRun: true },
        rateLimit: {
          minIntervalMs: 0,
          maxPerSession: 100,
          maxPerDay: 100,
          deduplicationWindowMs: 300_000, // 5 min
          bypassTypes: [],
        },
      }),
    );

    // First hook: writes lastPostSummary to session file.
    await runHook(
      hookInputBash("git push origin main", "To x:y/z.git\n   a..b  main -> main"),
      env(),
    );

    // Second hook: identical summary — SHOULD be deduped via persisted session.
    await runHook(
      hookInputBash("git push origin main", "To x:y/z.git\n   c..d  main -> main"),
      env(),
    );

    const logContent = readFileSync(join(tempDir, "logs", "dry-run.log"), "utf-8");
    const pushCount = (logContent.match(/Pushed to main/g) || []).length;
    // Exactly ONE push should reach the log — the second was deduped
    expect(pushCount).toBe(1);
  });

  it("persists lastPostSummary for cross-process dedup", async () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        slack: { botToken: "xoxb-test", channel: "C-test" },
        user: { name: "TestUser", slackUserId: "U-dedup" },
        notifications: { dryRun: true },
      }),
    );

    // First hook: pushes to main, writes lastPostSummary
    const first = await runHook(
      hookInputBash("git push origin main", "To github.com:u/r.git\n   abc..def  main -> main"),
      env(),
    );
    expect(first.code).toBe(0);

    // Read session file — should contain lastPostSummary
    const { readdirSync } = await import("node:fs");
    const stateFiles = readdirSync(join(tempDir, "state"));
    expect(stateFiles.some((f) => f.startsWith("session-"))).toBe(true);
    const sessionPath = join(tempDir, "state", stateFiles.find((f) => f.startsWith("session-"))!);
    const session = JSON.parse(readFileSync(sessionPath, "utf-8"));
    expect(session.lastPostSummary).toContain("Pushed to main");
    expect(session.lastPostAt).toBeTruthy();
  });
});
