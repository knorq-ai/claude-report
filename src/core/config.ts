import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";

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

/**
 * Partial Config schema for user-supplied JSON files. All fields optional —
 * deepMerge fills in missing fields from DEFAULT_CONFIG. Rejects malformed
 * types (e.g., `minIntervalMs: "hello"`) rather than silently poisoning runtime.
 */
const PartialConfigSchema = z.object({
  slack: z.object({
    botToken: z.string().optional(),
    channel: z.string().optional(),
    mentionOnBlocker: z.string().optional(),
  }).partial().optional(),
  relay: z.object({
    url: z.string().url(),
    teamId: z.string(),
  }).optional(),
  notifications: z.object({
    enabled: z.boolean().optional(),
    onGitPush: z.boolean().optional(),
    onBlocker: z.boolean().optional(),
    onCompletion: z.boolean().optional(),
    verbosity: z.enum(["minimal", "normal", "verbose"]).optional(),
    dryRun: z.boolean().optional(),
  }).partial().optional(),
  rateLimit: z.object({
    minIntervalMs: z.number().int().nonnegative(),
    maxPerSession: z.number().int().nonnegative(),
    maxPerDay: z.number().int().nonnegative(),
    deduplicationWindowMs: z.number().int().nonnegative(),
    bypassTypes: z.array(z.string()),
  }).partial().optional(),
  user: z.object({
    name: z.string().optional(),
    slackUserId: z.string().optional(),
  }).partial().optional(),
}).strict();

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
 * NOTE: State (sessions) intentionally diverges — see getStateDir().
 */
export function getDataDir(): string {
  return process.env.CLAUDE_REPORT_DATA_DIR
    || process.env.CLAUDE_PLUGIN_DATA
    || join(homedir(), ".claude-report");
}

/**
 * State directory (sessions, watermarks).
 * Always uses ~/.claude-report/state/ regardless of CLAUDE_PLUGIN_DATA,
 * because sessions map to Slack threads which are user-scoped shared state.
 * Using the plugin data dir would create duplicate daily threads when the
 * hook runs from different contexts (plugin vs settings.json vs CLI).
 */
export function getStateDir(): string {
  const explicit = process.env.CLAUDE_REPORT_DATA_DIR;
  if (explicit) return join(explicit, "state");
  return join(homedir(), ".claude-report", "state");
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

  // Layer 1: User-level config file (standalone CLI mode) — trusted
  const userConfigPath = join(getConfigDir(), "config.json");
  loadAndMerge(config, userConfigPath, "user");

  // Layer 2: Project-level config — UNTRUSTED. A malicious repo could ship a
  // .claude-report.json that redirects posts or hijacks threads. Credentials
  // and user identity are stripped before merge.
  if (projectDir) {
    const projectConfigPath = join(projectDir, ".claude-report.json");
    loadAndMerge(config, projectConfigPath, "project");
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

/**
 * Load a JSON config file, validate via zod schema, and deepMerge into target.
 *
 * @param source  "user" = per-user config (trusted); "project" = project-level
 *                config (untrusted — a malicious repo could ship a .claude-report.json).
 *                Project-level configs cannot set user identity fields or relay
 *                credentials, which would otherwise enable thread hijacking.
 */
function loadAndMerge(
  target: Config,
  filePath: string,
  source: "user" | "project",
): void {
  if (!existsSync(filePath)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error(`[claude-report] Failed to parse ${filePath}: ${err instanceof Error ? err.message : err}`);
    return;
  }
  const result = PartialConfigSchema.safeParse(raw);
  if (!result.success) {
    console.error(`[claude-report] Invalid config at ${filePath}: ${result.error.message}`);
    return;
  }

  let data = result.data as Record<string, unknown>;
  if (source === "project") {
    // Project-level config is UNTRUSTED (a malicious repo can ship it).
    // Strip ALL fields that could redirect posts, exfiltrate data, or hijack
    // identity. `slack.channel` looks like a "routing hint" but a hostile repo
    // can point posts at the attacker's channel and silently exfiltrate dev
    // activity — so even the channel is not allowed at project scope.
    //
    // Whitelist approach: project config can ONLY influence notification
    // toggles and rate-limit tuning. Everything else is ignored with a log.
    const ALLOWED_PROJECT_KEYS = new Set(["notifications", "rateLimit"]);
    const stripped: string[] = [];
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (ALLOWED_PROJECT_KEYS.has(key)) {
        safe[key] = value;
      } else {
        stripped.push(key);
      }
    }
    if (stripped.length > 0) {
      console.error(
        `[claude-report] Ignoring project-config fields (${stripped.join(", ")}) at ${filePath} — only notifications/rateLimit are honored at project scope.`,
      );
    }
    data = safe;
  }

  deepMerge(
    target as unknown as Record<string, unknown>,
    data,
  );
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const key of Object.keys(source)) {
    // Prototype pollution guard: reject dangerous keys at every depth.
    if (FORBIDDEN_KEYS.has(key)) continue;
    // Only merge own properties (defense in depth; Object.keys already filters inherited).
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;

    const srcVal = source[key];
    const tgtVal = target[key];

    if (
      srcVal &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      target[key] = srcVal;
    }
  }
}
