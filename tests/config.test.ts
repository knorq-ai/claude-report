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

  it("loads project config that overrides user config", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ slack: { botToken: "xoxb-user", channel: "C-user" } }),
    );
    const projectDir = mkdtempSync(join(tmpdir(), "claude-report-project-"));
    writeFileSync(
      join(projectDir, ".claude-report.json"),
      JSON.stringify({ slack: { channel: "C-project" } }),
    );
    const config = loadConfig(projectDir);
    expect(config.slack.botToken).toBe("xoxb-user");
    expect(config.slack.channel).toBe("C-project");
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
});
