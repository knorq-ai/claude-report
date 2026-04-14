import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export interface RateLimitConfig {
  minIntervalMs: number;
  maxPerSession: number;
  maxPerDay: number;
  deduplicationWindowMs: number;
  bypassTypes: string[];
}

export interface Config {
  slack: {
    botToken: string;
    channel: string;
    mentionOnBlocker?: string;
  };
  relay?: {
    url: string;
    teamId: string;
  };
  notifications: {
    enabled: boolean;
    onGitPush: boolean;
    onBlocker: boolean;
    onCompletion: boolean;
    verbosity: "minimal" | "normal" | "verbose";
    dryRun: boolean;
  };
  rateLimit: RateLimitConfig;
  user: {
    name: string;
    slackUserId: string;
  };
}

const DEFAULT_CONFIG: Config = {
  slack: {
    botToken: "",
    channel: "",
  },
  notifications: {
    enabled: true,
    onGitPush: true,
    onBlocker: true,
    onCompletion: true,
    verbosity: "normal",
    dryRun: false,
  },
  rateLimit: {
    minIntervalMs: 600_000,
    maxPerSession: 10,
    maxPerDay: 30,
    deduplicationWindowMs: 900_000, // 15 min — must be > minIntervalMs for dedup to be reachable
    bypassTypes: ["blocker", "completion"],
  },
  user: {
    name: "",
    slackUserId: "",
  },
};

/**
 * Data directory — uses CLAUDE_PLUGIN_DATA if running as a plugin,
 * falls back to ~/.claude-report for standalone CLI usage.
 */
export function getDataDir(): string {
  return process.env.CLAUDE_REPORT_DATA_DIR
    || process.env.CLAUDE_PLUGIN_DATA
    || join(homedir(), ".claude-report");
}

/** State directory (sessions, watermarks) */
export function getStateDir(): string {
  return join(getDataDir(), "state");
}

/** Log directory */
export function getLogDir(): string {
  return join(getDataDir(), "logs");
}

/** Config directory (same as data dir — separate function for future divergence) */
export function getConfigDir(): string {
  return getDataDir();
}

/** Check if reporting is disabled for a project */
export function isProjectDisabled(projectDir: string): boolean {
  if (process.env.CLAUDE_REPORT_DISABLED === "1") return true;
  const ignoreFile = join(projectDir, ".claude-report.ignore");
  return existsSync(ignoreFile);
}

/**
 * Load config. Resolution order:
 * 1. Plugin env vars (CLAUDE_PLUGIN_OPTION_* / CLAUDE_REPORT_*)
 * 2. Project-level .claude-report.json
 * 3. User-level config.json in data dir
 * 4. Defaults
 */
export function loadConfig(projectDir?: string): Config {
  const config = structuredClone(DEFAULT_CONFIG);

  // Layer 1: User-level config file (standalone CLI mode)
  const userConfigPath = join(getConfigDir(), "config.json");
  if (existsSync(userConfigPath)) {
    try {
      const userConfig = JSON.parse(readFileSync(userConfigPath, "utf-8"));
      deepMerge(config, userConfig);
    } catch (err) {
      console.error(`[claude-report] Failed to parse ${userConfigPath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Layer 2: Project-level config
  if (projectDir) {
    const projectConfigPath = join(projectDir, ".claude-report.json");
    if (existsSync(projectConfigPath)) {
      try {
        const projectConfig = JSON.parse(
          readFileSync(projectConfigPath, "utf-8"),
        );
        deepMerge(config, projectConfig);
      } catch (err) {
        console.error(`[claude-report] Failed to parse ${projectConfigPath}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Layer 3: Environment variables — plugin userConfig + direct env vars (highest priority)
  const botToken =
    process.env.CLAUDE_REPORT_SLACK_BOT_TOKEN ||
    process.env.CLAUDE_PLUGIN_OPTION_slack_bot_token ||
    "";
  const channel =
    process.env.CLAUDE_REPORT_SLACK_CHANNEL ||
    process.env.CLAUDE_PLUGIN_OPTION_slack_channel ||
    "";

  if (botToken) config.slack.botToken = botToken;
  if (channel) config.slack.channel = channel;

  // User name: plugin prompt → env var → git → fallback
  const displayName =
    process.env.CLAUDE_REPORT_USER_NAME ||
    process.env.CLAUDE_PLUGIN_OPTION_display_name ||
    "";
  if (displayName) {
    config.user.name = displayName;
  } else if (!config.user.name) {
    config.user.name = getGitUserName();
  }
  if (!config.user.slackUserId) {
    config.user.slackUserId =
      process.env.CLAUDE_REPORT_SLACK_USER_ID || deriveUserId();
  }

  if (process.env.CLAUDE_REPORT_RELAY_URL) {
    config.relay = {
      url: process.env.CLAUDE_REPORT_RELAY_URL,
      teamId: process.env.CLAUDE_REPORT_TEAM_ID || "",
    };
  }

  if (process.env.CLAUDE_REPORT_DRY_RUN === "1") {
    config.notifications.dryRun = true;
  }
  if (process.env.CLAUDE_REPORT_DISABLED === "1") {
    config.notifications.enabled = false;
  }

  return config;
}

/** Resolve userId from config with consistent fallback chain */
export function resolveUserId(config: Config): string {
  return config.user.slackUserId || config.user.name || "unknown";
}

/** Auto-detect user name from git config */
function getGitUserName(): string {
  try {
    return execFileSync("git", ["config", "user.name"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return homedir().split("/").pop() || "unknown";
  }
}

/** Derive a stable user ID from git config (used as session key) */
function deriveUserId(): string {
  try {
    const email = execFileSync("git", ["config", "user.email"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (email) {
      return createHash("sha256").update(email).digest("hex").slice(0, 12);
    }
  } catch {
    // no git
  }
  // Fallback: hash the username + homedir
  const name = getGitUserName();
  return createHash("sha256")
    .update(`${name}:${homedir()}`)
    .digest("hex")
    .slice(0, 12);
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): void {
  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object"
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}
