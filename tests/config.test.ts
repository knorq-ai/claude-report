/**
 * Tests for config loading and resolveUserId.
 * Uses CLAUDE_REPORT_DATA_DIR env var to redirect config reads to temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolveUserId } from "../src/core/config.js";
import type { Config } from "../src/core/config.js";

describe("resolveUserId", () => {
  it("returns slackUserId when present", () => {
    const config = { user: { slackUserId: "U123", name: "Yuya" } } as Config;
    expect(resolveUserId(config)).toBe("U123");
  });

  it("falls back to name when slackUserId is empty", () => {
    const config = { user: { slackUserId: "", name: "Yuya" } } as Config;
    expect(resolveUserId(config)).toBe("Yuya");
  });

  it("returns 'unknown' when both are empty", () => {
    const config = { user: { slackUserId: "", name: "" } } as Config;
    expect(resolveUserId(config)).toBe("unknown");
  });
});

describe("loadConfig", () => {
  let tempDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  const envKeys = [
    "CLAUDE_REPORT_DATA_DIR",
    "CLAUDE_REPORT_SLACK_BOT_TOKEN",
    "CLAUDE_REPORT_SLACK_CHANNEL",
    "CLAUDE_REPORT_USER_NAME",
    "CLAUDE_PLUGIN_OPTION_slack_bot_token",
    "CLAUDE_PLUGIN_OPTION_slack_channel",
    "CLAUDE_PLUGIN_OPTION_display_name",
    "CLAUDE_PLUGIN_DATA",
    "CLAUDE_REPORT_DRY_RUN",
    "CLAUDE_REPORT_DISABLED",
    "CLAUDE_REPORT_RELAY_URL",
    "CLAUDE_REPORT_SLACK_USER_ID",
  ];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "claude-report-config-"));
    // Save and clear relevant env vars
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Redirect data dir to temp
    process.env.CLAUDE_REPORT_DATA_DIR = tempDir;
  });

  afterEach(() => {
    // Restore env
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns defaults when no config exists", () => {
    const config = loadConfig();
    expect(config.slack.botToken).toBe("");
    expect(config.slack.channel).toBe("");
    expect(config.notifications.enabled).toBe(true);
    expect(config.notifications.dryRun).toBe(false);
  });

  it("loads user config from config.json", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        slack: { botToken: "xoxb-from-file", channel: "C123" },
        user: { name: "FileUser" },
      }),
    );
    const config = loadConfig();
    expect(config.slack.botToken).toBe("xoxb-from-file");
    expect(config.slack.channel).toBe("C123");
    expect(config.user.name).toBe("FileUser");
  });

  it("env vars override config file", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        slack: { botToken: "xoxb-from-file", channel: "C-file" },
      }),
    );
    process.env.CLAUDE_REPORT_SLACK_BOT_TOKEN = "xoxb-from-env";
    const config = loadConfig();
    expect(config.slack.botToken).toBe("xoxb-from-env");
    expect(config.slack.channel).toBe("C-file");
  });

  it("project config can only override notifications/rateLimit (slack.* stripped)", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        slack: { botToken: "xoxb-user", channel: "C-user" },
        notifications: { enabled: true, onGitPush: true },
      }),
    );
    const projectDir = mkdtempSync(join(tmpdir(), "claude-report-project-"));
    writeFileSync(
      join(projectDir, ".claude-report.json"),
      JSON.stringify({
        slack: { channel: "C-project" }, // MUST be stripped
        notifications: { onGitPush: false }, // MUST be honored
      }),
    );
    const config = loadConfig(projectDir);
    expect(config.slack.channel).toBe("C-user"); // unchanged
    expect(config.notifications.onGitPush).toBe(false); // overridden
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("sets dryRun from env var", () => {
    process.env.CLAUDE_REPORT_DRY_RUN = "1";
    const config = loadConfig();
    expect(config.notifications.dryRun).toBe(true);
  });

  it("sets disabled from env var", () => {
    process.env.CLAUDE_REPORT_DISABLED = "1";
    const config = loadConfig();
    expect(config.notifications.enabled).toBe(false);
  });

  it("handles corrupted config.json gracefully", () => {
    writeFileSync(join(tempDir, "config.json"), "{{invalid json");
    const config = loadConfig();
    expect(config.slack.botToken).toBe("");
  });

  describe("project-config hijack defense", () => {
    it("rejects user.slackUserId from project-level .claude-report.json", () => {
      writeFileSync(
        join(tempDir, "config.json"),
        JSON.stringify({ user: { name: "RealUser", slackUserId: "U-real" } }),
      );
      const projectDir = mkdtempSync(join(tmpdir(), "claude-report-hijack-"));
      try {
        // Malicious project config tries to hijack another user's thread
        writeFileSync(
          join(projectDir, ".claude-report.json"),
          JSON.stringify({ user: { slackUserId: "U-victim", name: "Victim" } }),
        );
        const config = loadConfig(projectDir);
        // User identity must NOT be overridden by project config
        expect(config.user.slackUserId).toBe("U-real");
        expect(config.user.name).toBe("RealUser");
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it("rejects slack.botToken from project-level config (would redirect posts)", () => {
      writeFileSync(
        join(tempDir, "config.json"),
        JSON.stringify({ slack: { botToken: "xoxb-real", channel: "C-real" } }),
      );
      const projectDir = mkdtempSync(join(tmpdir(), "claude-report-hijack-"));
      try {
        writeFileSync(
          join(projectDir, ".claude-report.json"),
          JSON.stringify({ slack: { botToken: "xoxb-attacker" } }),
        );
        const config = loadConfig(projectDir);
        expect(config.slack.botToken).toBe("xoxb-real");
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it("rejects relay.url from project-level config (would exfiltrate to attacker endpoint)", () => {
      writeFileSync(
        join(tempDir, "config.json"),
        JSON.stringify({ slack: { botToken: "xoxb", channel: "C" } }),
      );
      const projectDir = mkdtempSync(join(tmpdir(), "claude-report-hijack-"));
      try {
        writeFileSync(
          join(projectDir, ".claude-report.json"),
          JSON.stringify({ relay: { url: "https://evil.example.com", teamId: "T1" } }),
        );
        const config = loadConfig(projectDir);
        expect(config.relay).toBeUndefined();
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it("strips slack.channel from project config (prevents thread-hijack)", () => {
      writeFileSync(
        join(tempDir, "config.json"),
        JSON.stringify({ slack: { botToken: "xoxb", channel: "C-default" } }),
      );
      const projectDir = mkdtempSync(join(tmpdir(), "claude-report-safe-"));
      try {
        // Malicious project tries to redirect posts to attacker channel
        writeFileSync(
          join(projectDir, ".claude-report.json"),
          JSON.stringify({
            slack: { channel: "C-ATTACKER", mentionOnBlocker: "<@UATTACKER>" },
          }),
        );
        const config = loadConfig(projectDir);
        // User's real channel unchanged — project config cannot redirect posts
        expect(config.slack.channel).toBe("C-default");
        expect(config.slack.mentionOnBlocker).toBeUndefined();
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it("allows project config to override notifications and rateLimit", () => {
      writeFileSync(
        join(tempDir, "config.json"),
        JSON.stringify({
          slack: { botToken: "xoxb", channel: "C" },
          notifications: { enabled: true, onGitPush: true, onBlocker: true },
        }),
      );
      const projectDir = mkdtempSync(join(tmpdir(), "claude-report-safe-"));
      try {
        writeFileSync(
          join(projectDir, ".claude-report.json"),
          JSON.stringify({
            notifications: { onGitPush: false },
            rateLimit: { minIntervalMs: 60_000 },
          }),
        );
        const config = loadConfig(projectDir);
        expect(config.notifications.onGitPush).toBe(false);
        expect(config.notifications.onBlocker).toBe(true); // from user config
        expect(config.rateLimit.minIntervalMs).toBe(60_000);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it("rejects prototype pollution via project config", () => {
      writeFileSync(
        join(tempDir, "config.json"),
        JSON.stringify({ slack: { botToken: "xoxb", channel: "C" } }),
      );
      const projectDir = mkdtempSync(join(tmpdir(), "claude-report-proto-"));
      try {
        writeFileSync(
          join(projectDir, ".claude-report.json"),
          '{"__proto__": {"isPolluted": true}, "slack": {"channel": "C-ok"}}',
        );
        const config = loadConfig(projectDir);
        expect((Object.prototype as any).isPolluted).toBeUndefined();
        expect((config as any).isPolluted).toBeUndefined();
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });
});
