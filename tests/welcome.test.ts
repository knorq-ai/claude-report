/**
 * Tests for welcome message idempotency (without hitting Slack API).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

vi.mock("../src/core/config.js", async () => {
  const actual = await vi.importActual("../src/core/config.js");
  return {
    ...actual,
    getDataDir: () => tempDir,
  };
});

// Mock the WebClient to avoid real Slack calls. Welcome.ts uses a default
// import due to @slack/web-api being CJS, so we mock both the default and
// named exports.
const MockWebClientImpl = vi.fn().mockImplementation(() => ({
  chat: {
    postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "1234.5678" }),
  },
}));
vi.mock("@slack/web-api", () => ({
  default: { WebClient: MockWebClientImpl },
  WebClient: MockWebClientImpl,
  retryPolicies: { fiveRetriesInFiveMinutes: {} },
}));

const { sendWelcomeIfNeeded } = await import("../src/core/welcome.js");
const WebClient = MockWebClientImpl;

function makeConfig(overrides: Record<string, any> = {}) {
  return {
    slack: { botToken: "xoxb-test-token", channel: "C-test", ...overrides.slack },
    user: { name: "TestUser", slackUserId: "U123", ...overrides.user },
    notifications: { enabled: true, dryRun: false, onGitPush: true, onBlocker: true, onCompletion: true, verbosity: "normal" as const, ...overrides.notifications },
    rateLimit: { minIntervalMs: 600000, maxPerSession: 10, maxPerDay: 30, deduplicationWindowMs: 900000, bypassTypes: [] },
  };
}

describe("sendWelcomeIfNeeded", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-report-welcome-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("sends welcome and writes marker on first call", async () => {
    await sendWelcomeIfNeeded(makeConfig());
    expect(existsSync(join(tempDir, "welcome-sent.json"))).toBe(true);
  });

  it("does not send welcome if marker already exists", async () => {
    writeFileSync(join(tempDir, "welcome-sent.json"), JSON.stringify({ sentAt: "2024-01-01" }));
    await sendWelcomeIfNeeded(makeConfig());
    // WebClient constructor should not have been called
    expect(WebClient).not.toHaveBeenCalled();
  });

  it("skips when bot token is missing", async () => {
    await sendWelcomeIfNeeded(makeConfig({ slack: { botToken: "", channel: "C-test" } }));
    expect(existsSync(join(tempDir, "welcome-sent.json"))).toBe(false);
  });

  it("skips when channel is missing", async () => {
    await sendWelcomeIfNeeded(makeConfig({ slack: { botToken: "xoxb-test", channel: "" } }));
    expect(existsSync(join(tempDir, "welcome-sent.json"))).toBe(false);
  });

  it("does not write marker if Slack call fails", async () => {
    WebClient.mockImplementationOnce(() => ({
      chat: {
        postMessage: vi.fn().mockRejectedValue(new Error("Slack API error")),
      },
    }) as any);

    await sendWelcomeIfNeeded(makeConfig());
    expect(existsSync(join(tempDir, "welcome-sent.json"))).toBe(false);
  });
});
