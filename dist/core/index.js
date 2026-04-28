// src/core/config.ts
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { z } from "zod";
var PartialConfigSchema = z.object({
  slack: z.object({
    botToken: z.string().optional(),
    channel: z.string().optional(),
    mentionOnBlocker: z.string().optional()
  }).partial().optional(),
  relay: z.object({
    url: z.string().url(),
    teamId: z.string()
  }).optional(),
  notifications: z.object({
    enabled: z.boolean().optional(),
    onGitPush: z.boolean().optional(),
    onBlocker: z.boolean().optional(),
    onCompletion: z.boolean().optional(),
    verbosity: z.enum(["minimal", "normal", "verbose"]).optional(),
    dryRun: z.boolean().optional()
  }).partial().optional(),
  rateLimit: z.object({
    minIntervalMs: z.number().int().nonnegative(),
    maxPerSession: z.number().int().nonnegative(),
    maxPerDay: z.number().int().nonnegative(),
    deduplicationWindowMs: z.number().int().nonnegative(),
    bypassTypes: z.array(z.string())
  }).partial().optional(),
  user: z.object({
    name: z.string().optional(),
    slackUserId: z.string().optional()
  }).partial().optional()
}).strict();
var DEFAULT_CONFIG = {
  slack: {
    botToken: "",
    channel: ""
  },
  notifications: {
    enabled: true,
    onGitPush: true,
    onBlocker: true,
    onCompletion: true,
    verbosity: "normal",
    dryRun: false
  },
  rateLimit: {
    minIntervalMs: 6e5,
    maxPerSession: 10,
    maxPerDay: 30,
    deduplicationWindowMs: 9e5,
    // 15 min — must be > minIntervalMs for dedup to be reachable
    bypassTypes: ["blocker", "completion"]
  },
  user: {
    name: "",
    slackUserId: ""
  }
};
function getDataDir() {
  if (process.env.CLAUDE_REPORT_DATA_DIR) return process.env.CLAUDE_REPORT_DATA_DIR;
  const userDir = join(homedir(), ".claude-report");
  if (existsSync(join(userDir, "config.json"))) return userDir;
  return process.env.CLAUDE_PLUGIN_DATA || userDir;
}
function getStateDir() {
  const explicit = process.env.CLAUDE_REPORT_DATA_DIR;
  if (explicit) return join(explicit, "state");
  return join(homedir(), ".claude-report", "state");
}
function getLogDir() {
  return join(getDataDir(), "logs");
}
function getConfigDir() {
  return getDataDir();
}
function isProjectDisabled(projectDir) {
  if (process.env.CLAUDE_REPORT_DISABLED === "1") return true;
  const ignoreFile = join(projectDir, ".claude-report.ignore");
  return existsSync(ignoreFile);
}
function loadConfig(projectDir) {
  const config = structuredClone(DEFAULT_CONFIG);
  const userConfigPath = join(getConfigDir(), "config.json");
  loadAndMerge(config, userConfigPath, "user");
  if (projectDir) {
    const projectConfigPath = join(projectDir, ".claude-report.json");
    loadAndMerge(config, projectConfigPath, "project");
  }
  const botToken = process.env.CLAUDE_REPORT_SLACK_BOT_TOKEN || process.env.CLAUDE_PLUGIN_OPTION_slack_bot_token || "";
  const channel = process.env.CLAUDE_REPORT_SLACK_CHANNEL || process.env.CLAUDE_PLUGIN_OPTION_slack_channel || "";
  if (botToken) config.slack.botToken = botToken;
  if (channel) config.slack.channel = channel;
  const displayName = process.env.CLAUDE_REPORT_USER_NAME || process.env.CLAUDE_PLUGIN_OPTION_display_name || "";
  if (displayName) {
    config.user.name = displayName;
  } else if (!config.user.name) {
    config.user.name = getGitUserName();
  }
  if (!config.user.slackUserId) {
    config.user.slackUserId = process.env.CLAUDE_REPORT_SLACK_USER_ID || deriveUserId();
  }
  if (process.env.CLAUDE_REPORT_RELAY_URL) {
    config.relay = {
      url: process.env.CLAUDE_REPORT_RELAY_URL,
      teamId: process.env.CLAUDE_REPORT_TEAM_ID || ""
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
function resolveUserId(config) {
  return config.user.slackUserId || config.user.name || "unknown";
}
function getGitUserName() {
  try {
    return execFileSync("git", ["config", "user.name"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch {
    return homedir().split("/").pop() || "unknown";
  }
}
function deriveUserId() {
  try {
    const email = execFileSync("git", ["config", "user.email"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    if (email) {
      return createHash("sha256").update(email).digest("hex").slice(0, 12);
    }
  } catch {
  }
  const name = getGitUserName();
  return createHash("sha256").update(`${name}:${homedir()}`).digest("hex").slice(0, 12);
}
function loadAndMerge(target, filePath, source) {
  if (!existsSync(filePath)) return;
  let raw;
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
  let data = result.data;
  if (source === "project") {
    data = sanitizeProjectConfig(data, filePath);
  }
  deepMerge(
    target,
    data
  );
}
function sanitizeProjectConfig(data, filePath) {
  const stripped = [];
  const safe = {};
  const FORBIDDEN_NOTIF_KEYS = /* @__PURE__ */ new Set(["enabled", "dryRun", "onBlocker", "onCompletion"]);
  for (const [key, value] of Object.entries(data)) {
    if (key === "notifications" && value && typeof value === "object") {
      const notif = value;
      const safeNotif = {};
      for (const [nk, nv] of Object.entries(notif)) {
        if (FORBIDDEN_NOTIF_KEYS.has(nk)) {
          stripped.push(`notifications.${nk}`);
        } else {
          safeNotif[nk] = nv;
        }
      }
      if (Object.keys(safeNotif).length > 0) safe.notifications = safeNotif;
    } else if (key === "rateLimit" && value && typeof value === "object") {
      safe.rateLimit = clampRateLimit(value);
    } else {
      stripped.push(key);
    }
  }
  if (stripped.length > 0) {
    console.error(
      `[claude-report] Ignoring unsafe project-config fields (${stripped.join(", ")}) at ${filePath}.`
    );
  }
  return safe;
}
function clampRateLimit(raw) {
  const clamp = (v, min, max) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return void 0;
    return Math.min(Math.max(v, min), max);
  };
  const out = {};
  const minIntervalMs = clamp(raw.minIntervalMs, 6e4, 864e5);
  const maxPerSession = clamp(raw.maxPerSession, 1, 100);
  const maxPerDay = clamp(raw.maxPerDay, 1, 500);
  const deduplicationWindowMs = clamp(raw.deduplicationWindowMs, 6e4, 864e5);
  if (minIntervalMs !== void 0) out.minIntervalMs = minIntervalMs;
  if (maxPerSession !== void 0) out.maxPerSession = maxPerSession;
  if (maxPerDay !== void 0) out.maxPerDay = maxPerDay;
  if (deduplicationWindowMs !== void 0) out.deduplicationWindowMs = deduplicationWindowMs;
  if (raw.bypassTypes !== void 0) {
  }
  return out;
}
var FORBIDDEN_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const srcVal = source[key];
    const tgtVal = target[key];
    if (srcVal && typeof srcVal === "object" && !Array.isArray(srcVal) && tgtVal && typeof tgtVal === "object" && !Array.isArray(tgtVal)) {
      deepMerge(
        tgtVal,
        srcVal
      );
    } else {
      target[key] = srcVal;
    }
  }
}

// src/core/session.ts
import { randomUUID as randomUUID2, createHash as createHash2 } from "crypto";
import { existsSync as existsSync2, readFileSync as readFileSync3, mkdirSync as mkdirSync2, readdirSync } from "fs";
import { execFileSync as execFileSync2 } from "child_process";
import { join as join3, basename } from "path";

// src/core/fs-utils.ts
import {
  writeFileSync,
  readFileSync as readFileSync2,
  renameSync,
  unlinkSync,
  mkdirSync,
  rmdirSync,
  statSync
} from "fs";
import { dirname, join as join2 } from "path";
import { randomUUID } from "crypto";
function atomicWriteJson(filePath, data) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join2(dir, `.tmp-${randomUUID()}.json`);
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
    }
    throw err;
  }
}
var LOCK_RETRY_MS = 10;
var LOCK_MAX_RETRIES = 30;
var LOCK_STALE_MS = 3e4;
var LOCK_MAX_AGE_MS = 6e4;
function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}
var LockTimeoutError = class extends Error {
  constructor(filePath) {
    super(`lock timeout: ${filePath}`);
    this.name = "LockTimeoutError";
  }
};
function withFileLock(filePath, fn) {
  const lockDir = `${filePath}.lock`;
  const ownerFile = join2(lockDir, "owner");
  let acquired = false;
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      mkdirSync(lockDir);
      try {
        writeFileSync(ownerFile, String(process.pid), "utf-8");
      } catch {
      }
      acquired = true;
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const now = Date.now();
      let shouldSteal = false;
      try {
        const st = statSync(lockDir);
        const age = now - st.mtimeMs;
        let ownerDead = false;
        try {
          const pidRaw = readFileSync2(ownerFile, "utf-8").trim();
          const pid = Number.parseInt(pidRaw, 10);
          if (pid && !isProcessAlive(pid)) ownerDead = true;
        } catch {
        }
        if (ownerDead && age > LOCK_STALE_MS || age > LOCK_MAX_AGE_MS) {
          shouldSteal = true;
        }
      } catch {
      }
      if (shouldSteal) {
        try {
          unlinkSync(ownerFile);
        } catch {
        }
        try {
          rmdirSync(lockDir);
        } catch {
        }
        continue;
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  if (!acquired) {
    throw new LockTimeoutError(filePath);
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(ownerFile);
    } catch {
    }
    try {
      rmdirSync(lockDir);
    } catch {
    }
  }
}

// src/core/session.ts
var STALE_THRESHOLD_MS = 30 * 60 * 1e3;
function resolveProjectName(projectDir) {
  const pkgPath = join3(projectDir, "package.json");
  if (existsSync2(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync3(pkgPath, "utf-8"));
      if (pkg.name && typeof pkg.name === "string") {
        return pkg.name;
      }
    } catch {
    }
  }
  try {
    const remote = execFileSync2("git", ["remote", "get-url", "origin"], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 500,
      // prevent hung git from blocking the hook
      killSignal: "SIGKILL"
    }).trim();
    if (remote) {
      const name = basename(remote).replace(/\.git$/, "");
      if (name) return name;
    }
  } catch {
  }
  return basename(projectDir);
}
function todayStr() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function projectKey(userId, project) {
  const hash = createHash2("sha256").update(`${userId}:${project}`).digest("hex").slice(0, 12);
  return hash;
}
function sessionFilePath(userId, project) {
  return join3(getStateDir(), `session-${projectKey(userId, project)}.json`);
}
function getOrCreateSession(userId, project) {
  const stateDir = getStateDir();
  mkdirSync2(stateDir, { recursive: true });
  const sessionFile = sessionFilePath(userId, project);
  return withFileLock(sessionFile, () => {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const today = todayStr();
    if (existsSync2(sessionFile)) {
      try {
        const existing = JSON.parse(
          readFileSync3(sessionFile, "utf-8")
        );
        const lastActive = new Date(existing.lastActiveAt).getTime();
        if (Date.now() - lastActive < STALE_THRESHOLD_MS) {
          if (existing.dailyPostDate !== today) {
            existing.dailyPostCount = 0;
            existing.dailyPostDate = today;
            existing.threadId = null;
          }
          existing.lastActiveAt = now;
          atomicWriteJson(sessionFile, existing);
          return existing;
        }
        if (existing.dailyPostDate === today) {
          const refreshed = createSession(userId, project);
          refreshed.threadId = existing.threadId;
          refreshed.dailyPostCount = existing.dailyPostCount;
          atomicWriteJson(sessionFile, refreshed);
          return refreshed;
        }
      } catch {
      }
    }
    const session = createSession(userId, project);
    atomicWriteJson(sessionFile, session);
    return session;
  });
}
function createSession(userId, project) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return {
    sessionId: randomUUID2(),
    userId,
    project,
    threadId: null,
    startedAt: now,
    lastPostAt: null,
    lastActiveAt: now,
    postCount: 0,
    dailyPostCount: 0,
    dailyPostDate: todayStr(),
    muted: false
  };
}
function updateSessionForProject(userId, project, updates) {
  const sessionFile = sessionFilePath(userId, project);
  if (!existsSync2(sessionFile)) return null;
  return withFileLock(sessionFile, () => {
    try {
      const session = JSON.parse(
        readFileSync3(sessionFile, "utf-8")
      );
      Object.assign(session, updates, {
        lastActiveAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      atomicWriteJson(sessionFile, session);
      return session;
    } catch {
      return null;
    }
  });
}
function updateSession(updates) {
  const stateDir = getStateDir();
  if (!existsSync2(stateDir)) return null;
  try {
    const files = readdirSync(stateDir).filter((f) => f.startsWith("session-") && f.endsWith(".json"));
    let latest = null;
    let latestFile = null;
    for (const file of files) {
      try {
        const s = JSON.parse(
          readFileSync3(join3(stateDir, file), "utf-8")
        );
        if (!latest || s.lastActiveAt > latest.lastActiveAt) {
          latest = s;
          latestFile = file;
        }
      } catch {
        continue;
      }
    }
    if (latest && latestFile) {
      const latestPath = join3(stateDir, latestFile);
      return withFileLock(latestPath, () => {
        const current = JSON.parse(readFileSync3(latestPath, "utf-8"));
        Object.assign(current, updates, {
          lastActiveAt: (/* @__PURE__ */ new Date()).toISOString()
        });
        atomicWriteJson(latestPath, current);
        return current;
      });
    }
  } catch (err) {
    if (process.env.CLAUDE_REPORT_DEBUG) {
      process.stderr.write(`[claude-report] updateSession: ${err instanceof Error ? err.message : err}
`);
    }
  }
  return null;
}
function readSessionForProject(userId, project) {
  const sessionFile = sessionFilePath(userId, project);
  if (!existsSync2(sessionFile)) return null;
  try {
    return JSON.parse(readFileSync3(sessionFile, "utf-8"));
  } catch {
    return null;
  }
}
function readCurrentSession() {
  const stateDir = getStateDir();
  if (!existsSync2(stateDir)) return null;
  try {
    const files = readdirSync(stateDir).filter((f) => f.startsWith("session-") && f.endsWith(".json"));
    let latest = null;
    for (const file of files) {
      try {
        const s = JSON.parse(
          readFileSync3(join3(stateDir, file), "utf-8")
        );
        if (!latest || s.lastActiveAt > latest.lastActiveAt) {
          latest = s;
        }
      } catch {
        continue;
      }
    }
    return latest;
  } catch {
    return null;
  }
}

// src/core/rate-limiter.ts
var MAX_DEDUP_ENTRIES = 100;
var RateLimiter = class {
  constructor(config) {
    this.config = config;
  }
  config;
  /** userId → last summary + timestamp. In-memory, bounded. Only useful in MCP server. */
  lastPostByUser = /* @__PURE__ */ new Map();
  shouldPost(update, session) {
    if (session.muted) {
      return { allowed: false, reason: "Session is muted" };
    }
    const isBypass = this.config.bypassTypes.includes(update.type);
    if (!isBypass) {
      if (session.postCount >= this.config.maxPerSession) {
        return {
          allowed: false,
          reason: `Session cap reached (${this.config.maxPerSession} posts)`
        };
      }
      if (session.dailyPostCount >= this.config.maxPerDay) {
        return {
          allowed: false,
          reason: `Daily cap reached (${this.config.maxPerDay} posts)`
        };
      }
      if (session.lastPostAt) {
        const elapsed = Date.now() - new Date(session.lastPostAt).getTime();
        if (elapsed < this.config.minIntervalMs) {
          const waitSec = Math.ceil(
            (this.config.minIntervalMs - elapsed) / 1e3
          );
          return {
            allowed: false,
            reason: `Rate limited: wait ${waitSec}s before next update`
          };
        }
      }
    }
    const userKey = update.userId || "unknown";
    const memory = this.lastPostByUser.get(userKey);
    let lastSummary = null;
    let lastTime = null;
    if (memory) {
      lastSummary = memory.summary;
      lastTime = memory.time;
    } else if (session.lastPostSummary && session.lastPostAt) {
      lastSummary = session.lastPostSummary;
      lastTime = new Date(session.lastPostAt).getTime();
    }
    if (lastSummary !== null && lastTime !== null) {
      const elapsed = Date.now() - lastTime;
      if (elapsed < this.config.deduplicationWindowMs) {
        const similarity = tokenSimilarity(lastSummary, update.summary);
        if (similarity > 0.8) {
          return {
            allowed: false,
            reason: "Duplicate: too similar to recent post"
          };
        }
      }
    }
    return { allowed: true };
  }
  /** Record that a post was made (call after successful post). */
  recordPost(update) {
    const userKey = update.userId || "unknown";
    if (!this.lastPostByUser.has(userKey) && this.lastPostByUser.size >= MAX_DEDUP_ENTRIES) {
      const firstKey = this.lastPostByUser.keys().next().value;
      if (firstKey !== void 0) this.lastPostByUser.delete(firstKey);
    }
    this.lastPostByUser.set(userKey, {
      time: Date.now(),
      summary: update.summary
    });
  }
};
function tokenSimilarity(a, b) {
  const tokenize = (s) => new Set(
    s.toLowerCase().split(/[\s,.;:!?()[\]{}<>"'`]+/).filter(Boolean)
  );
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return intersection / union;
}

// src/core/content-filter.ts
var MAX_SUMMARY_LENGTH = 150;
var MAX_DETAILS_LENGTH = 500;
var SECRET_PATTERNS = [
  // AWS access key id
  { source: "AKIA[0-9A-Z]{16}", flags: "gi" },
  // AWS secret (40-char base64). Require at least one non-hex character
  // to avoid matching 40-char git SHAs.
  { source: "(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]*[G-Zg-z/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])", flags: "g" },
  // Slack
  { source: "xox[baprs]-[0-9A-Za-z-]{10,}", flags: "gi" },
  // GitHub
  { source: "ghp_[A-Za-z0-9]{36,}", flags: "gi" },
  { source: "github_pat_[A-Za-z0-9_]{20,}", flags: "gi" },
  { source: "gh[ousr]_[A-Za-z0-9]{20,}", flags: "gi" },
  // LLM providers
  { source: "sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}", flags: "gi" },
  { source: "AIza[0-9A-Za-z_-]{35}", flags: "gi" },
  // Stripe
  { source: "sk_(?:live|test)_[A-Za-z0-9]{20,}", flags: "gi" },
  { source: "rk_(?:live|test)_[A-Za-z0-9]{20,}", flags: "gi" },
  // NPM
  { source: "npm_[A-Za-z0-9]{36,}", flags: "gi" },
  // JWT — 2-part or 3-part; bounded {10,2048} per segment prevents backtracking.
  { source: "eyJ[A-Za-z0-9_-]{10,2048}\\.[A-Za-z0-9_-]{10,2048}(?:\\.[A-Za-z0-9_-]{10,2048})?", flags: "gi" },
  // Private keys — three tiers to handle malformed/truncated PEMs.
  { source: "-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[\\s\\S]{0,8192}?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----", flags: "gi" },
  { source: "-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[\\s\\S]{0,8192}?-----END [A-Z0-9 ]+-----", flags: "gi" },
  { source: "-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----(?:[ \\t]*\\n[A-Za-z0-9+/=\\s]{0,8192})?", flags: "gi" },
  // Azure / cloud connection strings
  { source: `DefaultEndpointsProtocol=[^\\s"']+AccountKey=[^\\s"';]+`, flags: "gi" },
  // URL basic-auth — redact entire URL (host/path reveals internal infra)
  { source: `[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/[^:/?#\\s"']+:[^@/?#\\s"']+@[^\\s"'<>]+`, flags: "gi" },
  // Bearer tokens in Authorization headers
  { source: "bearer\\s+[A-Za-z0-9_\\-\\.=+/]{16,}", flags: "gi" },
  // Named key=value secrets. Handles:
  //   - bare: `password=hunter2`
  //   - JSON-like: `"password": "hunter2"` (optional `"`/`'` before separator)
  //   - YAML-like: `password: hunter2`
  // Separator accepts Unicode fullwidth via pre-scan NFKC normalization.
  // Fullwidth colon U+FF1A is also normalized to ASCII `:` by NFKC.
  { source: `(?:password|passwd|pwd|pw|secret|token|credentials|api[_-]?key|auth[_-]?token|access[_-]?token|access[_-]?key|refresh[_-]?token|client[_-]?secret|session[_-]?key|private[_-]?key)["']?\\s*[=:]\\s*["']?[^\\s"'{}<>,;]+`, flags: "gi" },
  // Base64-wrapped secrets: 48+ chars of base64 alphabet that must include
  // at least one `+`/`/` (standard base64) OR end with `=` padding — these
  // are strong signals of binary base64, not incidental text like "yyyy...".
  // Still avoids eating plain long words/repeated chars.
  { source: "(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/]*[+/]|[A-Za-z0-9+/]{48,}=)[A-Za-z0-9+/]{48,}={0,2}(?![A-Za-z0-9+/=])", flags: "g" },
  // Long hex strings last (avoids eating git SHAs which are ≤40 hex)
  { source: "(?<![a-f0-9])[a-f0-9]{64,}(?![a-f0-9])", flags: "gi" }
];
var INVISIBLE_CHARS_RE = /[\u200B-\u200D\u2060\u00AD\uFEFF\u180E\u034F]/g;
var HOMOGLYPH_MAP = {
  // Cyrillic uppercase → Latin (visually identical)
  "\u0410": "A",
  "\u0412": "B",
  "\u0415": "E",
  "\u041D": "H",
  "\u041A": "K",
  "\u041C": "M",
  "\u041E": "O",
  "\u0420": "P",
  "\u0421": "C",
  "\u0422": "T",
  "\u0425": "X",
  "\u0406": "I",
  "\u0408": "J",
  "\u0405": "S",
  "\u04AE": "Y",
  "\u0492": "F",
  "\u0500": "D",
  "\u051A": "Q",
  // Cyrillic lowercase → Latin
  "\u0430": "a",
  "\u0435": "e",
  "\u043E": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0445": "x",
  "\u0443": "y",
  "\u0456": "i",
  "\u0458": "j",
  "\u0455": "s",
  "\u04BB": "h",
  // Greek uppercase → Latin lookalikes
  "\u0391": "A",
  "\u0392": "B",
  "\u0395": "E",
  "\u0396": "Z",
  "\u0397": "H",
  "\u0399": "I",
  "\u039A": "K",
  "\u039C": "M",
  "\u039D": "N",
  "\u039F": "O",
  "\u03A1": "P",
  "\u03A4": "T",
  "\u03A5": "Y",
  "\u03A7": "X",
  // Greek lowercase
  "\u03B1": "a",
  "\u03BF": "o",
  "\u03C1": "p"
};
var HOMOGLYPH_RE = new RegExp(
  `[${Object.keys(HOMOGLYPH_MAP).join("")}]`,
  "gu"
);
function normalizeForScan(text) {
  return text.normalize("NFKC").replace(HOMOGLYPH_RE, (c) => HOMOGLYPH_MAP[c] || c).replace(INVISIBLE_CHARS_RE, "");
}
function compilePatterns() {
  return SECRET_PATTERNS.map((p) => new RegExp(p.source, p.flags));
}
var PATH_PATTERNS = [
  /(?:\/(?:Users|home|root|var|etc|tmp|opt|mnt|data|workspace|private\/var)\/\S+)/g,
  /(?:[A-Za-z]:\\(?:Users|Windows|ProgramData)\\[^\s"']+)/g
];
var ContentFilter = class {
  filter(update) {
    const filtered = { ...update };
    filtered.summary = truncate(filtered.summary, MAX_SUMMARY_LENGTH);
    if (filtered.details) {
      filtered.details = truncate(filtered.details, MAX_DETAILS_LENGTH);
    }
    filtered.summary = stripSecrets(normalizeForScan(filtered.summary));
    if (filtered.details) {
      filtered.details = stripSecrets(normalizeForScan(filtered.details));
    }
    filtered.summary = sanitizePaths(filtered.summary);
    if (filtered.details) {
      filtered.details = sanitizePaths(filtered.details);
    }
    return filtered;
  }
  /**
   * Check if text appears to contain secrets. Normalizes before scanning so
   * obfuscated variants (fullwidth, ZWSP) are detected.
   */
  containsSecrets(text) {
    const normalized = normalizeForScan(text);
    return compilePatterns().some((pattern) => pattern.test(normalized));
  }
};
function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  const suffix = "...";
  const sliceLen = Math.max(0, maxLength - suffix.length);
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return chars.slice(0, sliceLen).join("") + suffix;
}
function stripSecrets(text) {
  let result = text;
  for (const pattern of compilePatterns()) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}
function sanitizePaths(text) {
  let result = text;
  for (const pattern of PATH_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const sep = match.includes("\\") ? "\\" : "/";
      const parts = match.split(/[\\/]/).filter(Boolean);
      if (parts.length <= 2) return match;
      return "..." + sep + parts.slice(-2).join(sep);
    });
  }
  return result;
}

// src/core/poster.ts
import slackPkg from "@slack/web-api";
import { appendFile, mkdir } from "fs/promises";
import { join as join4 } from "path";

// src/core/formatter.ts
function escapeSlackMrkdwn(text) {
  let escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  escaped = escaped.replace(/@(channel|here|everyone)\b/gi, "@\u200B$1");
  escaped = escaped.replace(/([*_~`])/g, "\u200B$1");
  return escaped;
}
var TYPE_INDICATORS = {
  status: "\u{1F535}",
  // blue circle
  blocker: "\u{1F534}",
  // red circle
  completion: "\u{1F7E2}",
  // green circle
  pivot: "\u{1F7E1}",
  // yellow circle
  push: "\u{1F7E2}"
  // green circle
};
var TYPE_LABELS = {
  status: "Status",
  blocker: "Blocker",
  completion: "Completed",
  pivot: "Pivot",
  push: "Pushed"
};
function formatSlackBlocks(update, userName) {
  const indicator = TYPE_INDICATORS[update.type] || "\u{1F535}";
  const label = TYPE_LABELS[update.type] || "Update";
  const time = new Date(update.timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const blocks = [];
  let text = `${indicator} *${label}:* ${escapeSlackMrkdwn(update.summary)}`;
  if (update.details) {
    text += `
${escapeSlackMrkdwn(update.details)}`;
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text }
  });
  const contextElements = [];
  if (update.metadata?.branch) {
    const safeBranch = update.metadata.branch.replace(/`/g, "'");
    contextElements.push(`\u{1F33F} \`${safeBranch}\``);
  }
  if (update.metadata?.filesChanged !== void 0) {
    contextElements.push(
      `${update.metadata.filesChanged} file${update.metadata.filesChanged === 1 ? "" : "s"} changed`
    );
  }
  contextElements.push(`\u{1F553} ${time}`);
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: contextElements.join("  \xB7  ") }]
  });
  return blocks;
}
function formatDailyParent(userName, project, date) {
  const safeName = escapeSlackMrkdwn(userName);
  const safeProject = escapeSlackMrkdwn(project);
  const text = `\u{1F4CB} ${safeName} \u2014 ${date}
${safeProject}`;
  return {
    text,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `\u{1F4CB} *${safeName}* \u2014 ${date}
\`${safeProject}\`` }
      }
    ]
  };
}
function formatPlainText(update, userName) {
  const indicator = TYPE_INDICATORS[update.type] || "?";
  const label = TYPE_LABELS[update.type] || "Update";
  const time = new Date(update.timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  let text = `${indicator} [${label}] ${update.summary}`;
  if (update.details) {
    text += `
   ${update.details}`;
  }
  if (update.metadata?.branch) {
    text += `
   branch: ${update.metadata.branch}`;
  }
  text += `  (${time}, ${userName})`;
  return text;
}

// src/core/poster.ts
var { WebClient, retryPolicies } = slackPkg;
var RELAY_TIMEOUT_MS = 5e3;
var RELAY_MAX_ATTEMPTS = 3;
var RETRYABLE_STATUSES = /* @__PURE__ */ new Set([408, 425, 429, 500, 502, 503, 504]);
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var RelayPoster = class {
  constructor(relayUrl, apiKey, userName) {
    this.relayUrl = relayUrl;
    this.apiKey = apiKey;
    this.userName = userName;
  }
  relayUrl;
  apiKey;
  userName;
  async postUpdate(update, threadId) {
    const body = JSON.stringify({
      update: {
        ...update,
        timestamp: update.timestamp.toISOString()
      },
      threadId: threadId || void 0,
      userName: this.userName
    });
    let lastErr;
    for (let attempt = 0; attempt < RELAY_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(`${this.relayUrl}/post`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body,
          signal: AbortSignal.timeout(RELAY_TIMEOUT_MS)
        });
        if (response.ok) {
          const result = await response.json();
          if (!result.threadId || typeof result.threadId !== "string") {
            throw new Error("Relay returned invalid response: missing threadId");
          }
          if (result.permalink && !/^https:\/\//.test(result.permalink)) {
            throw new Error("Relay returned invalid permalink scheme");
          }
          return {
            threadId: result.threadId,
            channel: typeof result.channel === "string" ? result.channel : "",
            permalink: typeof result.permalink === "string" ? result.permalink : ""
          };
        }
        if (!RETRYABLE_STATUSES.has(response.status)) {
          const text = await response.text().catch(() => "");
          throw new Error(`Relay error ${response.status}: ${text.slice(0, 200)}`);
        }
        const retryAfter = response.headers.get("retry-after");
        const waitMs = computeBackoff(attempt, retryAfter);
        lastErr = new Error(`Relay ${response.status} (attempt ${attempt + 1})`);
        if (attempt < RELAY_MAX_ATTEMPTS - 1) await sleep(waitMs);
      } catch (err) {
        lastErr = err;
        if (attempt < RELAY_MAX_ATTEMPTS - 1) {
          await sleep(computeBackoff(attempt, null));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
};
function computeBackoff(attempt, retryAfter) {
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1e3, 1e4);
  }
  const base = 250 * 2 ** attempt;
  return base + Math.floor(Math.random() * base);
}
var DirectSlackPoster = class {
  constructor(botToken, channel, userName) {
    this.botToken = botToken;
    this.channel = channel;
    this.userName = userName;
    this.client = new WebClient(botToken, {
      timeout: RELAY_TIMEOUT_MS,
      retryConfig: retryPolicies.fiveRetriesInFiveMinutes
    });
  }
  botToken;
  channel;
  userName;
  client;
  async postUpdate(update, threadId) {
    if (!threadId) {
      const parent = formatDailyParent(
        this.userName,
        update.project,
        (/* @__PURE__ */ new Date()).toISOString().slice(0, 10)
      );
      const parentResult = await this.client.chat.postMessage({
        channel: this.channel,
        text: parent.text,
        blocks: parent.blocks
      });
      if (!parentResult.ts) {
        throw new Error("Slack did not return a message timestamp for the parent post");
      }
      threadId = parentResult.ts;
    }
    const blocks = formatSlackBlocks(update, this.userName);
    const result = await this.client.chat.postMessage({
      channel: this.channel,
      thread_ts: threadId,
      text: update.summary,
      blocks
    });
    return {
      threadId,
      channel: this.channel,
      permalink: result.ts ? `https://slack.com/archives/${this.channel}/p${result.ts.replace(".", "")}` : ""
    };
  }
};
var DryRunPoster = class {
  logPath;
  userName;
  logDirReady;
  constructor(userName, logDir) {
    const dir = logDir || getLogDir();
    this.logPath = join4(dir, "dry-run.log");
    this.userName = userName;
    this.logDirReady = mkdir(dir, { recursive: true }).then(() => void 0);
  }
  async postUpdate(update, threadId) {
    await this.logDirReady;
    const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${formatPlainText(update, this.userName)}
`;
    await appendFile(this.logPath, line, "utf-8");
    const fakeThreadId = threadId || `dry-run-${Date.now()}`;
    return {
      threadId: fakeThreadId,
      channel: "dry-run",
      permalink: `file://${this.logPath}`
    };
  }
};

// src/core/fetcher.ts
import slackPkg2 from "@slack/web-api";
var { WebClient: WebClient2, retryPolicies: retryPolicies2 } = slackPkg2;
var FETCH_TIMEOUT_MS = 5e3;
var FetchAuthError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "FetchAuthError";
  }
};
var FetchTransientError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "FetchTransientError";
  }
};
var RelayFetcher = class {
  constructor(relayUrl, apiKey) {
    this.relayUrl = relayUrl;
    this.apiKey = apiKey;
  }
  relayUrl;
  apiKey;
  async fetchReplies(threadId, since) {
    const params = new URLSearchParams({ threadId });
    if (since) {
      params.set("since", since.toISOString());
    }
    const response = await fetch(
      `${this.relayUrl}/replies?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      }
    );
    if (response.status === 404) return [];
    if (response.status === 401 || response.status === 403) {
      throw new FetchAuthError(`Relay auth failed: ${response.status}`);
    }
    if (!response.ok) {
      throw new FetchTransientError(`Relay error ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) return [];
    return data.filter((r) => r && typeof r.text === "string" && typeof r.author === "string").map((r) => ({
      author: r.author,
      text: r.text,
      timestamp: safeDate(r.timestamp)
    }));
  }
};
function safeDate(value) {
  if (typeof value !== "string") return /* @__PURE__ */ new Date(0);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? /* @__PURE__ */ new Date(0) : d;
}
var DirectSlackFetcher = class {
  client;
  channel;
  constructor(botToken, channel) {
    this.client = new WebClient2(botToken, {
      timeout: FETCH_TIMEOUT_MS,
      retryConfig: retryPolicies2.fiveRetriesInFiveMinutes
    });
    this.channel = channel;
  }
  async fetchReplies(threadId, since) {
    const channel = this.channel;
    const oldest = since ? (since.getTime() / 1e3).toFixed(6) : void 0;
    const result = await this.client.conversations.replies({
      channel,
      ts: threadId,
      limit: 50,
      ...oldest ? { oldest } : {}
    });
    if (!result.messages || result.messages.length <= 1) return [];
    return result.messages.slice(1).map((msg) => ({
      author: msg.user || "unknown",
      text: msg.text || "",
      timestamp: slackTsToDate(msg.ts)
    }));
  }
};
function slackTsToDate(ts) {
  if (!ts) return /* @__PURE__ */ new Date(0);
  const num = Number(ts);
  if (!Number.isFinite(num)) return /* @__PURE__ */ new Date(0);
  return new Date(num * 1e3);
}

// src/core/store.ts
import { existsSync as existsSync3, readFileSync as readFileSync4, mkdirSync as mkdirSync3 } from "fs";
import { join as join5 } from "path";
var SCHEMA_VERSION = 1;
var MAX_UPDATES_KEPT = 500;
var JsonFileStore = class {
  stateDir;
  constructor(stateDir) {
    this.stateDir = stateDir || getStateDir();
    mkdirSync3(this.stateDir, { recursive: true });
  }
  // --- Sessions ---
  async saveSession(session) {
    const file = this.path("sessions.json");
    this.mutate(file, {}, (sessions) => {
      sessions[sessionKey(session.userId, session.project)] = session;
      return sessions;
    });
  }
  async getActiveSession(userId, project) {
    const file = this.path("sessions.json");
    const sessions = this.readFile(file, {});
    return sessions[sessionKey(userId, project)] || null;
  }
  async updateSession(sessionId, updates) {
    const file = this.path("sessions.json");
    this.mutate(file, {}, (sessions) => {
      for (const key of Object.keys(sessions)) {
        if (sessions[key].sessionId === sessionId) {
          Object.assign(sessions[key], updates);
          break;
        }
      }
      return sessions;
    });
  }
  // --- Updates ---
  async saveUpdate(update) {
    const file = this.path("updates.json");
    this.mutate(file, [], (updates) => {
      updates.push(update);
      if (updates.length > MAX_UPDATES_KEPT) {
        updates.splice(0, updates.length - MAX_UPDATES_KEPT);
      }
      return updates;
    });
  }
  async getRecentUpdates(sessionId, limit = 10) {
    const file = this.path("updates.json");
    const updates = this.readFile(file, []);
    return updates.filter((u) => u.sessionId === sessionId).slice(-limit);
  }
  // --- Reply watermarks ---
  async getLastSeenReplyTimestamp(threadId) {
    const file = this.path("reply-watermarks.json");
    const watermarks = this.readFile(file, {});
    const ts = watermarks[threadId];
    return ts ? new Date(ts) : null;
  }
  async setLastSeenReplyTimestamp(threadId, ts) {
    const file = this.path("reply-watermarks.json");
    this.mutate(file, {}, (watermarks) => {
      watermarks[threadId] = ts.toISOString();
      return watermarks;
    });
  }
  // --- Helpers ---
  path(filename) {
    return join5(this.stateDir, filename);
  }
  /** Read-modify-write under a file lock. */
  mutate(filePath, defaultValue, fn) {
    try {
      withFileLock(filePath, () => {
        const current = this.readFile(filePath, defaultValue);
        const next = fn(current);
        this.writeFile(filePath, next);
      });
    } catch (err) {
      if (err instanceof LockTimeoutError) {
        process.stderr.write(`[claude-report] ${err.message}; skipping write
`);
        return;
      }
      throw err;
    }
  }
  readFile(filePath, defaultValue) {
    if (!existsSync3(filePath)) return defaultValue;
    try {
      const raw = JSON.parse(readFileSync4(filePath, "utf-8"));
      if (raw.schemaVersion !== SCHEMA_VERSION) return defaultValue;
      return raw.data;
    } catch {
      return defaultValue;
    }
  }
  writeFile(filePath, data) {
    const wrapped = { schemaVersion: SCHEMA_VERSION, data };
    atomicWriteJson(filePath, wrapped);
  }
};
function sessionKey(userId, project) {
  return `${userId}:${project}`;
}

// src/core/keychain.ts
import { execFileSync as execFileSync3 } from "child_process";
import { platform } from "os";
var SERVICE = "claude-report";
function getSecret(account) {
  const envKey = `CLAUDE_REPORT_${account.toUpperCase().replace(/-/g, "_")}`;
  if (process.env[envKey]) {
    return process.env[envKey];
  }
  const os = platform();
  try {
    if (os === "darwin") {
      const result = execFileSync3(
        "security",
        ["find-generic-password", "-s", SERVICE, "-a", account, "-w"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      return result.trim() || null;
    }
    if (os === "linux") {
      const result = execFileSync3(
        "secret-tool",
        ["lookup", "service", SERVICE, "account", account],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      return result.trim() || null;
    }
  } catch {
  }
  return null;
}
function setSecret(account, value) {
  const os = platform();
  try {
    if (os === "darwin") {
      try {
        execFileSync3(
          "security",
          ["delete-generic-password", "-s", SERVICE, "-a", account],
          { stdio: ["pipe", "pipe", "pipe"] }
        );
      } catch {
      }
      execFileSync3(
        "security",
        ["add-generic-password", "-s", SERVICE, "-a", account, "-U", "-w", value],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      return true;
    }
    if (os === "linux") {
      execFileSync3(
        "secret-tool",
        [
          "store",
          `--label=claude-report ${account}`,
          "service",
          SERVICE,
          "account",
          account
        ],
        { input: value, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      return true;
    }
  } catch {
  }
  return false;
}
function deleteSecret(account) {
  const os = platform();
  try {
    if (os === "darwin") {
      execFileSync3(
        "security",
        ["delete-generic-password", "-s", SERVICE, "-a", account],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      return true;
    }
    if (os === "linux") {
      execFileSync3(
        "secret-tool",
        ["clear", "service", SERVICE, "account", account],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      return true;
    }
  } catch {
  }
  return false;
}

// src/core/welcome.ts
import { existsSync as existsSync4 } from "fs";
import { join as join6 } from "path";
import slackPkg3 from "@slack/web-api";
var { WebClient: WebClient3 } = slackPkg3;
var MARKER_FILE = "welcome-sent.json";
async function sendWelcomeIfNeeded(config) {
  const markerPath = join6(getDataDir(), MARKER_FILE);
  if (existsSync4(markerPath)) return;
  if (!config.slack.botToken || !config.slack.channel) return;
  let claim;
  try {
    claim = withFileLock(markerPath, () => {
      if (existsSync4(markerPath)) return "already_sent";
      atomicWriteJson(markerPath, { sentAt: null, userName: null, pending: true });
      return "claimed";
    });
  } catch (err) {
    if (err instanceof LockTimeoutError) return;
    throw err;
  }
  if (claim === "already_sent") return;
  const userName = config.user.name || "Someone";
  const safeName = escapeSlackMrkdwn(userName);
  const client = new WebClient3(config.slack.botToken, { timeout: 5e3 });
  try {
    await client.chat.postMessage({
      channel: config.slack.channel,
      text: `\u{1F44B} ${safeName} started using claude-report`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `\u{1F44B} *${safeName}* started using claude-report`
          }
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "Dev status updates will appear in this channel automatically."
            }
          ]
        }
      ]
    });
    atomicWriteJson(markerPath, {
      sentAt: (/* @__PURE__ */ new Date()).toISOString(),
      userName
    });
  } catch (err) {
    try {
      const { unlinkSync: unlinkSync2 } = await import("fs");
      unlinkSync2(markerPath);
    } catch {
    }
    console.error(
      `[claude-report] welcome message failed: ${err instanceof Error ? err.message : err}`
    );
  }
}

// src/core/usage-stats.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync5, statSync as statSync2, openSync, readSync, closeSync } from "fs";
import { join as join7 } from "path";
import { homedir as homedir2 } from "os";
var PRICING = {
  "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }
};
var DEFAULT_PRICING = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
function getProjectsDir() {
  return join7(homedir2(), ".claude", "projects");
}
function getDailyUsage(date) {
  const projectsDir = getProjectsDir();
  const sessions = [];
  let dirs;
  try {
    dirs = readdirSync2(projectsDir);
  } catch {
    return emptyUsage(date);
  }
  for (const dir of dirs) {
    const dirPath = join7(projectsDir, dir);
    try {
      if (!statSync2(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const dirSessions = [];
    const canonicalNames = /* @__PURE__ */ new Set();
    let files;
    try {
      files = readdirSync2(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = join7(dirPath, file);
      try {
        const stat = statSync2(filePath);
        const fileDate = localDateString(stat.mtime);
        if (fileDate < date && fileDate < prevDate(date)) continue;
        const cwd = extractCwdFromTranscript(filePath);
        if (cwd) canonicalNames.add(projectNameFromPath(cwd));
        const project = cwd ? projectNameFromPath(cwd) : dir;
        const usage = parseTranscript(filePath, date, project);
        if (usage && usage.assistantTurns > 0) {
          if (cwd) usage.cwd = cwd;
          dirSessions.push(usage);
        }
      } catch {
        continue;
      }
    }
    if (canonicalNames.size === 1) {
      const canonical = canonicalNames.values().next().value;
      for (const s of dirSessions) {
        if (s.project === dir) s.project = canonical;
      }
    }
    sessions.push(...dirSessions);
  }
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    userMessages: 0,
    assistantTurns: 0,
    sessionCount: sessions.length
  };
  let estimatedCostUsd = 0;
  for (const s of sessions) {
    totals.inputTokens += s.inputTokens;
    totals.outputTokens += s.outputTokens;
    totals.cacheReadTokens += s.cacheReadTokens;
    totals.cacheWriteTokens += s.cacheWriteTokens;
    totals.userMessages += s.userMessages;
    totals.assistantTurns += s.assistantTurns;
    if (s.source === "codex") continue;
    const pricing = findPricing(s.model);
    estimatedCostUsd += s.inputTokens / 1e6 * pricing.input + s.outputTokens / 1e6 * pricing.output + s.cacheReadTokens / 1e6 * pricing.cacheRead + s.cacheWriteTokens / 1e6 * pricing.cacheWrite;
  }
  const activities = sessions.flatMap((s) => s.activities).sort((a, b) => a.time.localeCompare(b.time));
  return { date, sessions, totals, estimatedCostUsd, activities };
}
var MAX_TRANSCRIPT_BYTES = 200 * 1024 * 1024;
function parseTranscript(filePath, date, project) {
  let content;
  try {
    const st = statSync2(filePath);
    if (st.size > MAX_TRANSCRIPT_BYTES) {
      process.stderr.write(`[claude-report] skipping oversized transcript: ${filePath} (${Math.round(st.size / 1048576)}MB)
`);
      return null;
    }
    content = readFileSync5(filePath, "utf-8");
  } catch {
    return null;
  }
  const lines = content.trim().split("\n");
  const sessionId = filePath.split("/").pop()?.replace(".jsonl", "") || "unknown";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let userMessages = 0;
  let assistantTurns = 0;
  let model = "unknown";
  let startedAt = "";
  let lastActiveAt = "";
  const activities = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = entry.timestamp;
    const entryDate = ts ? localDateString(new Date(ts)) : null;
    const timeStr = ts ? new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
    if (entry.type === "user" && entryDate === date) {
      if (entry.isMeta === true || entry.isCompactSummary === true) continue;
      const msgContent = entry.message?.content;
      const isToolResult = Array.isArray(msgContent) && msgContent.some((c) => c.type === "tool_result");
      if (!isToolResult) {
        userMessages++;
        if (!startedAt) startedAt = ts;
        lastActiveAt = ts;
        const promptText = extractUserPromptText(msgContent);
        if (promptText && activities.filter((a) => a.type === "prompt").length < 10) {
          activities.push({ type: "prompt", text: promptText, time: ts });
        }
      }
      continue;
    }
    if (entry.type === "assistant" && entryDate === date) {
      const msgContent = entry.message?.content;
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block.type === "tool_use" && block.name === "Bash") {
            const cmd = block.input?.command || "";
            extractBashActivities(cmd, activities, ts);
          }
          if (block.type === "tool_use" && (block.name === "Edit" || block.name === "Write")) {
            const filePath2 = block.input?.file_path || block.input?.path || "";
            if (filePath2) {
              activities.push({ type: "edit", text: filePath2, time: ts });
            }
          }
        }
      }
    }
    if (entry.type !== "assistant" || !entry.message?.usage) continue;
    if (entryDate !== date) continue;
    if (!startedAt) startedAt = ts;
    lastActiveAt = ts;
    const usage = entry.message.usage;
    inputTokens += usage.input_tokens || 0;
    outputTokens += usage.output_tokens || 0;
    cacheReadTokens += usage.cache_read_input_tokens || 0;
    cacheWriteTokens += usage.cache_creation_input_tokens || 0;
    assistantTurns++;
    if (entry.message.model) {
      model = entry.message.model;
    }
  }
  if (assistantTurns === 0) return null;
  return {
    sessionId: sessionId.slice(0, 8),
    project,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    userMessages,
    assistantTurns,
    startedAt,
    lastActiveAt,
    activities
  };
}
function extractUserPromptText(content) {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const textPart = content.find((c) => c.type === "text");
    text = textPart?.text || "";
  }
  if (!text) return null;
  const firstLine = text.split("\n")[0].trim();
  if (!firstLine || firstLine.length < 5) return null;
  if (firstLine.startsWith("<") || firstLine.startsWith("{")) return null;
  return firstLine.slice(0, 120);
}
function extractBashActivities(cmd, activities, ts) {
  if (/git\s+commit/.test(cmd) && /-m/.test(cmd)) {
    let msg = "";
    const heredocMatch = cmd.match(/cat\s+<<'?EOF'?\n([\s\S]*?)\nEOF/);
    if (heredocMatch) {
      const lines = heredocMatch[1].trim().split("\n");
      msg = lines[0];
      if (lines.length > 1 && lines[1].trim()) {
        msg += " \u2014 " + lines[1].trim();
      }
    } else {
      const simpleMatch = cmd.match(/-m\s+['"](.+?)['"]/);
      if (simpleMatch) msg = simpleMatch[1];
    }
    msg = msg.slice(0, 150);
    if (msg) activities.push({ type: "commit", text: msg, time: ts });
    return;
  }
  if (/\bgit\s+push\b/.test(cmd) && !/--dry-run/.test(cmd)) {
    const branchMatch = cmd.match(/git\s+push\s+\S+\s+(\S+)/);
    const branch = branchMatch ? branchMatch[1] : "branch";
    activities.push({ type: "push", text: `Pushed to ${branch}`, time: ts });
    return;
  }
  if (/\bgh\s+pr\s+create\b/.test(cmd)) {
    const titleMatch = cmd.match(/--title\s+['"](.+?)['"]/);
    const title = titleMatch ? titleMatch[1] : "new PR";
    activities.push({ type: "pr", text: `PR: ${title}`, time: ts });
    return;
  }
  if (/\b(npm\s+test|npx\s+vitest|npx\s+jest|pytest|cargo\s+test|go\s+test)\b/.test(cmd)) {
    activities.push({ type: "test", text: "Ran tests", time: ts });
  }
}
function extractCwdFromTranscript(filePath) {
  const CWD_SCAN_BYTES = 8 * 1024;
  let fd = null;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(CWD_SCAN_BYTES);
    const bytesRead = readSync(fd, buf, 0, CWD_SCAN_BYTES, 0);
    const text = buf.slice(0, bytesRead).toString("utf-8");
    const lines = text.split("\n");
    const completeLines = lines.slice(0, -1);
    for (const line of completeLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.cwd && typeof entry.cwd === "string") return entry.cwd;
      } catch {
        continue;
      }
    }
  } catch {
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
  return null;
}
function localDateString(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function projectNameFromPath(cwd) {
  const home = homedir2();
  const relative = cwd.startsWith(home) ? cwd.slice(home.length + 1) : cwd;
  const segments = relative.split("/").filter(Boolean);
  if (segments.length <= 2) return segments.join("/") || cwd;
  return segments.slice(-2).join("/");
}
function prevDate(date) {
  const [y, m, d] = date.split("-").map((s) => Number.parseInt(s, 10));
  if (!y || !m || !d) return date;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return localDateString(dt);
}
function mergeDailyUsages(a, b) {
  const merged = {
    date: a.date,
    sessions: [...a.sessions, ...b.sessions],
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      userMessages: 0,
      assistantTurns: 0,
      sessionCount: 0
    },
    estimatedCostUsd: 0,
    activities: [...a.activities, ...b.activities].sort(
      (x, y) => x.time.localeCompare(y.time)
    ),
    codexQuota: b.codexQuota ?? a.codexQuota
  };
  recomputeUsageTotals(merged);
  return merged;
}
function recomputeUsageTotals(usage) {
  const t = usage.totals;
  t.inputTokens = 0;
  t.outputTokens = 0;
  t.cacheReadTokens = 0;
  t.cacheWriteTokens = 0;
  t.userMessages = 0;
  t.assistantTurns = 0;
  t.sessionCount = usage.sessions.length;
  let cost = 0;
  for (const s of usage.sessions) {
    t.inputTokens += s.inputTokens;
    t.outputTokens += s.outputTokens;
    t.cacheReadTokens += s.cacheReadTokens;
    t.cacheWriteTokens += s.cacheWriteTokens;
    t.userMessages += s.userMessages;
    t.assistantTurns += s.assistantTurns;
    if (s.source === "codex") continue;
    const p = findPricing(s.model);
    cost += s.inputTokens / 1e6 * p.input + s.outputTokens / 1e6 * p.output + s.cacheReadTokens / 1e6 * p.cacheRead + s.cacheWriteTokens / 1e6 * p.cacheWrite;
  }
  usage.estimatedCostUsd = cost;
}
function findPricing(model) {
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.includes(key)) return pricing;
  }
  return DEFAULT_PRICING;
}
function emptyUsage(date) {
  return {
    date,
    sessions: [],
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, userMessages: 0, assistantTurns: 0, sessionCount: 0 },
    estimatedCostUsd: 0,
    activities: []
  };
}
function formatUsageSlackBlocks(usage, userName) {
  const { totals, estimatedCostUsd, sessions } = usage;
  const totalTokens = totals.inputTokens + totals.outputTokens;
  const safeName = escapeSlackMrkdwn(userName);
  const text = `\u{1F4CA} ${safeName} \u2014 Usage ${usage.date}: ${formatTokenCount(totalTokens)} tokens, ~$${estimatedCostUsd.toFixed(2)}`;
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\u{1F4CA} *${safeName}* \u2014 Usage Summary (${usage.date})`
      }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Sessions:* ${totals.sessionCount}` },
        { type: "mrkdwn", text: `*Prompts:* ${totals.userMessages}` },
        { type: "mrkdwn", text: `*Claude turns:* ${totals.assistantTurns}` },
        { type: "mrkdwn", text: `*Input:* ${formatTokenCount(totals.inputTokens)}` },
        { type: "mrkdwn", text: `*Output:* ${formatTokenCount(totals.outputTokens)}` },
        { type: "mrkdwn", text: `*Est. cost:* $${estimatedCostUsd.toFixed(2)}` }
      ]
    }
  ];
  if (sessions.length > 1) {
    const byProject = /* @__PURE__ */ new Map();
    for (const s of sessions) {
      const existing = byProject.get(s.project) || { tokens: 0, prompts: 0, turns: 0 };
      existing.tokens += s.inputTokens + s.outputTokens;
      existing.prompts += s.userMessages;
      existing.turns += s.assistantTurns;
      byProject.set(s.project, existing);
    }
    const projectLines = [...byProject.entries()].sort((a, b) => b[1].tokens - a[1].tokens).map(([p, v]) => `\`${p}\` \u2014 ${v.prompts} prompts, ${formatTokenCount(v.tokens)} tokens`).join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*By project:*
${projectLines}` }
    });
  }
  return { text, blocks };
}
function formatTokenCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
var BULLETS_PER_PROJECT_MAX = 10;
var BULLET_CHARS_MAX = 200;
var PROJECT_NAME_CHARS_MAX = 100;
var SECTION_CHARS_MAX = 2900;
function buildProjectBlocks(byProject, summaries) {
  const sanitizeProjectName = (p) => p.replace(/[`\n\r\t]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, PROJECT_NAME_CHARS_MAX);
  const capBullet = (b) => {
    const trimmed = b.trim();
    if (trimmed.length <= BULLET_CHARS_MAX) return trimmed;
    return trimmed.slice(0, BULLET_CHARS_MAX - 1) + "\u2026";
  };
  const blocks = [];
  const sorted = [...byProject.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
  for (const [p, v] of sorted) {
    const name = sanitizeProjectName(p);
    const header = `\u2022 \`${name}\` \u2014 ${v.prompts} prompts, ${formatTokenCount(v.tokens)} tokens`;
    const rawBullets = Array.isArray(summaries[p]) ? summaries[p] : [];
    const bullets = rawBullets.filter((b) => typeof b === "string" && b.trim().length > 0).slice(0, BULLETS_PER_PROJECT_MAX).map((b) => `    \u2022 ${escapeSlackMrkdwn(capBullet(b))}`);
    let text = bullets.length === 0 ? header : `${header}
${bullets.join("\n")}`;
    if (text.length > SECTION_CHARS_MAX) {
      text = text.slice(0, SECTION_CHARS_MAX - 1) + "\u2026";
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text }
    });
  }
  return blocks;
}
function getProjectSnippets(usage) {
  const byProject = /* @__PURE__ */ new Map();
  for (const s of usage.sessions) {
    const existing = byProject.get(s.project) || {
      prompts: [],
      commits: [],
      pushes: [],
      prs: [],
      files: /* @__PURE__ */ new Set()
    };
    for (const a of s.activities) {
      if (a.type === "prompt" && existing.prompts.length < 5) {
        existing.prompts.push(a.text);
      } else if (a.type === "commit" && existing.commits.length < 8) {
        existing.commits.push(a.text);
      } else if (a.type === "push" && existing.pushes.length < 3) {
        existing.pushes.push(a.text);
      } else if (a.type === "pr" && existing.prs.length < 3) {
        existing.prs.push(a.text);
      } else if (a.type === "edit") {
        const parts = a.text.split("/");
        const short = parts.length > 3 ? parts.slice(-3).join("/") : a.text;
        existing.files.add(short);
      }
    }
    byProject.set(s.project, existing);
  }
  const sections = [];
  for (const [project, data] of byProject) {
    const lines = [`## ${project}`];
    if (data.commits.length > 0) {
      lines.push("Commits:");
      for (const c of data.commits) lines.push(`  - ${c}`);
    }
    if (data.prs.length > 0) lines.push(`PRs: ${data.prs.join("; ")}`);
    if (data.files.size > 0) {
      const fileList = [...data.files].slice(0, 15);
      lines.push(`Files changed (${data.files.size}): ${fileList.join(", ")}`);
    }
    if (data.prompts.length > 0) {
      lines.push("Key user requests:");
      for (const p of data.prompts) lines.push(`  - ${p}`);
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

// src/core/usage-stats-codex.ts
import { createReadStream, existsSync as existsSync5, statSync as statSync3 } from "fs";
import { readdir } from "fs/promises";
import { createInterface } from "readline";
import { join as join8 } from "path";
import { homedir as homedir3 } from "os";
function getCodexSessionsRoot() {
  return join8(homedir3(), ".codex", "sessions");
}
async function collectCodexSessionFiles(root, date) {
  const cutoff = prevDate2(date);
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join8(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        try {
          const st = statSync3(p);
          if (localDateString2(st.mtime) >= cutoff) out.push(p);
        } catch {
        }
      }
    }
  }
  await walk(root);
  return out;
}
async function getCodexDailyUsage(date) {
  const root = getCodexSessionsRoot();
  if (!existsSync5(root)) return emptyUsage2(date);
  const files = await collectCodexSessionFiles(root, date);
  const sessions = [];
  let latestQuota = null;
  for (const file of files) {
    const result = await parseCodexSession(file, date);
    if (result.usage) sessions.push(result.usage);
    if (result.quota && (!latestQuota || result.quota.capturedAt > latestQuota.capturedAt)) {
      latestQuota = result.quota;
    }
  }
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    userMessages: 0,
    assistantTurns: 0,
    sessionCount: sessions.length
  };
  for (const s of sessions) {
    totals.inputTokens += s.inputTokens;
    totals.outputTokens += s.outputTokens;
    totals.cacheReadTokens += s.cacheReadTokens;
    totals.cacheWriteTokens += s.cacheWriteTokens;
    totals.userMessages += s.userMessages;
    totals.assistantTurns += s.assistantTurns;
  }
  const activities = sessions.flatMap((s) => s.activities).sort((a, b) => a.time.localeCompare(b.time));
  return {
    date,
    sessions,
    totals,
    estimatedCostUsd: 0,
    activities,
    codexQuota: latestQuota ?? void 0
  };
}
async function parseCodexSession(filePath, date) {
  const sessionId = filePath.split("/").pop()?.replace(".jsonl", "") || "unknown";
  let cwd;
  let model = "codex";
  let cliVersion = "";
  let startedAt = "";
  let lastActiveAt = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let userMessages = 0;
  let assistantTurns = 0;
  const activities = [];
  let prevTotal = 0;
  let prevInput = 0;
  let prevOutput = 0;
  let prevCacheRead = 0;
  let latestQuota = null;
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = entry.timestamp;
      const entryDate = ts ? localDateString2(new Date(ts)) : null;
      if (entry.type === "session_meta" && entry.payload) {
        if (!cwd && typeof entry.payload.cwd === "string") cwd = entry.payload.cwd;
        if (typeof entry.payload.model_provider === "string") {
          model = entry.payload.model_provider;
        }
        if (typeof entry.payload.cli_version === "string") {
          cliVersion = entry.payload.cli_version;
        }
        continue;
      }
      if (entry.type === "turn_context" && entry.payload) {
        if (typeof entry.payload.cwd === "string") cwd = entry.payload.cwd;
        if (typeof entry.payload.model === "string") model = entry.payload.model;
        continue;
      }
      if (entryDate !== date) continue;
      if (entry.type === "event_msg" && entry.payload) {
        const sub = entry.payload.type;
        if (sub === "user_message") {
          userMessages++;
          if (!startedAt) startedAt = ts || "";
          lastActiveAt = ts || lastActiveAt;
          const text = typeof entry.payload.message === "string" ? entry.payload.message : "";
          const promptText = sanitizePromptLine(text);
          if (promptText && activities.filter((a) => a.type === "prompt").length < 10) {
            activities.push({ type: "prompt", text: promptText, time: ts || "" });
          }
          continue;
        }
        if (sub === "exec_command_end") {
          const cmdArr = entry.payload.command;
          const cmdText = Array.isArray(cmdArr) ? cmdArr.join(" ") : "";
          if (cmdText) extractBashActivities2(cmdText, activities, ts || "");
          lastActiveAt = ts || lastActiveAt;
          continue;
        }
        if (sub === "patch_apply_end") {
          const files = extractPatchFiles(entry.payload);
          for (const f of files) {
            activities.push({ type: "edit", text: f, time: ts || "" });
          }
          lastActiveAt = ts || lastActiveAt;
          continue;
        }
        if (sub === "task_complete") {
          assistantTurns++;
          lastActiveAt = ts || lastActiveAt;
          continue;
        }
        if (sub === "token_count") {
          const info = entry.payload.info;
          if (info && typeof info.total_token_usage === "object" && info.total_token_usage) {
            const t = info.total_token_usage;
            const totalNow = numField(t.total_tokens);
            const inputNow = numField(t.input_tokens);
            const outputNow = numField(t.output_tokens);
            const cachedNow = numField(t.cached_input_tokens);
            if (totalNow > prevTotal) {
              inputTokens += Math.max(0, inputNow - prevInput);
              outputTokens += Math.max(0, outputNow - prevOutput);
              cacheReadTokens += Math.max(0, cachedNow - prevCacheRead);
              prevTotal = totalNow;
              prevInput = inputNow;
              prevOutput = outputNow;
              prevCacheRead = cachedNow;
              if (!startedAt) startedAt = ts || "";
              lastActiveAt = ts || lastActiveAt;
            }
          }
          const rl2 = entry.payload.rate_limits;
          if (rl2 && ts) {
            const snapshot = {
              planType: typeof rl2.plan_type === "string" ? rl2.plan_type : "unknown",
              primaryPct: pctField(rl2.primary?.used_percent),
              secondaryPct: pctField(rl2.secondary?.used_percent),
              capturedAt: ts
            };
            if (!latestQuota || snapshot.capturedAt > latestQuota.capturedAt) {
              latestQuota = snapshot;
            }
          }
          continue;
        }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (assistantTurns === 0 && userMessages === 0 && inputTokens === 0 && outputTokens === 0) {
    return { usage: null, quota: latestQuota };
  }
  const project = cwd ? projectNameFromPath2(cwd) : "codex/unknown";
  return {
    usage: {
      sessionId: sessionId.slice(-12),
      // Codex IDs are long; tail is more recognizable
      project,
      cwd,
      model: cliVersion ? `codex/${cliVersion}` : "codex",
      source: "codex",
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      // Codex telemetry doesn't expose cache-creation
      userMessages,
      assistantTurns,
      startedAt,
      lastActiveAt,
      activities
    },
    quota: latestQuota
  };
}
function numField(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function pctField(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function sanitizePromptLine(text) {
  if (!text) return null;
  const firstLine = text.split("\n")[0].trim();
  if (!firstLine || firstLine.length < 5) return null;
  if (firstLine.startsWith("<") || firstLine.startsWith("{")) return null;
  return firstLine.slice(0, 120);
}
function extractPatchFiles(payload) {
  const out = /* @__PURE__ */ new Set();
  const candidates = [];
  if (Array.isArray(payload?.changes)) candidates.push(...payload.changes);
  if (Array.isArray(payload?.files)) candidates.push(...payload.files);
  if (Array.isArray(payload?.patches)) candidates.push(...payload.patches);
  for (const c of candidates) {
    if (typeof c === "string") out.add(c);
    else if (typeof c?.path === "string") out.add(c.path);
    else if (typeof c?.file === "string") out.add(c.file);
  }
  return [...out];
}
function extractBashActivities2(cmd, activities, ts) {
  if (/git\s+commit/.test(cmd) && /-m/.test(cmd)) {
    let msg = "";
    const heredoc = cmd.match(/cat\s+<<'?EOF'?\n([\s\S]*?)\nEOF/);
    if (heredoc) {
      const lines = heredoc[1].trim().split("\n");
      msg = lines[0];
      if (lines.length > 1 && lines[1].trim()) msg += " \u2014 " + lines[1].trim();
    } else {
      const simple = cmd.match(/-m\s+['"](.+?)['"]/);
      if (simple) msg = simple[1];
    }
    msg = msg.slice(0, 150);
    if (msg) activities.push({ type: "commit", text: msg, time: ts });
    return;
  }
  if (/\bgit\s+push\b/.test(cmd) && !/--dry-run/.test(cmd)) {
    const m = cmd.match(/git\s+push\s+\S+\s+(\S+)/);
    activities.push({ type: "push", text: `Pushed to ${m ? m[1] : "branch"}`, time: ts });
    return;
  }
  if (/\bgh\s+pr\s+create\b/.test(cmd)) {
    const m = cmd.match(/--title\s+['"](.+?)['"]/);
    activities.push({ type: "pr", text: `PR: ${m ? m[1] : "new PR"}`, time: ts });
    return;
  }
  if (/\b(npm\s+test|npx\s+vitest|npx\s+jest|pytest|cargo\s+test|go\s+test)\b/.test(cmd)) {
    activities.push({ type: "test", text: "Ran tests", time: ts });
  }
}
function localDateString2(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function prevDate2(date) {
  const [y, m, d] = date.split("-").map((s) => Number.parseInt(s, 10));
  if (!y || !m || !d) return date;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return localDateString2(dt);
}
function projectNameFromPath2(cwd) {
  const home = homedir3();
  const relative = cwd.startsWith(home) ? cwd.slice(home.length + 1) : cwd;
  const segments = relative.split("/").filter(Boolean);
  if (segments.length <= 2) return segments.join("/") || cwd;
  return segments.slice(-2).join("/");
}
function emptyUsage2(date) {
  return {
    date,
    sessions: [],
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      userMessages: 0,
      assistantTurns: 0,
      sessionCount: 0
    },
    estimatedCostUsd: 0,
    activities: []
  };
}

// src/core/registry.ts
import { existsSync as existsSync6, readFileSync as readFileSync6, mkdirSync as mkdirSync4 } from "fs";
import { execFileSync as execFileSync4 } from "child_process";
import { join as join9 } from "path";
function registryPath() {
  return join9(getConfigDir(), "registry.json");
}
function loadRegistry() {
  const file = registryPath();
  if (!existsSync6(file)) return { enabledUsers: [] };
  try {
    return JSON.parse(readFileSync6(file, "utf-8"));
  } catch {
    return { enabledUsers: [] };
  }
}
function saveRegistry(registry) {
  const dir = getConfigDir();
  mkdirSync4(dir, { recursive: true });
  atomicWriteJson(registryPath(), registry);
}
function getGitUser() {
  try {
    return execFileSync4("git", ["config", "user.name"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim() || null;
  } catch {
    return null;
  }
}
function getGitEmail() {
  try {
    return execFileSync4("git", ["config", "user.email"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim() || null;
  } catch {
    return null;
  }
}
function isUserEnabled(projectDir) {
  const registry = loadRegistry();
  if (registry.enabledUsers.length === 0) return true;
  const name = getGitUser();
  const email = getGitEmail();
  return registry.enabledUsers.some((entry) => {
    const lower = entry.toLowerCase();
    return name && name.toLowerCase() === lower || email && email.toLowerCase() === lower;
  });
}
function enableUser(identifier) {
  const registry = loadRegistry();
  const lower = identifier.toLowerCase();
  const exists = registry.enabledUsers.some((u) => u.toLowerCase() === lower);
  if (exists) {
    return { added: false, user: identifier };
  }
  registry.enabledUsers.push(identifier);
  saveRegistry(registry);
  return { added: true, user: identifier };
}
function disableUser(identifier) {
  const registry = loadRegistry();
  const lower = identifier.toLowerCase();
  const idx = registry.enabledUsers.findIndex((u) => u.toLowerCase() === lower);
  if (idx === -1) {
    return { removed: false, user: identifier };
  }
  registry.enabledUsers.splice(idx, 1);
  saveRegistry(registry);
  return { removed: true, user: identifier };
}
function listEnabledUsers() {
  return loadRegistry().enabledUsers;
}

// src/core/index.ts
function createPoster(config, projectDir) {
  if (!config.notifications.enabled) return null;
  if (projectDir && isProjectDisabled(projectDir)) return null;
  if (!isUserEnabled(projectDir)) return null;
  if (config.notifications.dryRun) {
    return new DryRunPoster(config.user.name);
  }
  if (config.relay?.url) {
    const apiKey = getSecret("api-key");
    if (!apiKey) return null;
    return new RelayPoster(config.relay.url, apiKey, config.user.name);
  }
  if (config.slack.botToken && config.slack.channel) {
    return new DirectSlackPoster(
      config.slack.botToken,
      config.slack.channel,
      config.user.name
    );
  }
  return null;
}
function createFetcher(config) {
  if (!config.notifications.enabled) return null;
  if (config.relay?.url) {
    const apiKey = getSecret("api-key");
    if (!apiKey) return null;
    return new RelayFetcher(config.relay.url, apiKey);
  }
  if (config.slack.botToken && config.slack.channel) {
    return new DirectSlackFetcher(config.slack.botToken, config.slack.channel);
  }
  return null;
}
export {
  ContentFilter,
  DirectSlackFetcher,
  DirectSlackPoster,
  DryRunPoster,
  JsonFileStore,
  RateLimiter,
  RelayFetcher,
  RelayPoster,
  atomicWriteJson,
  buildProjectBlocks,
  createFetcher,
  createPoster,
  deleteSecret,
  disableUser,
  enableUser,
  escapeSlackMrkdwn,
  formatDailyParent,
  formatPlainText,
  formatSlackBlocks,
  formatUsageSlackBlocks,
  getCodexDailyUsage,
  getConfigDir,
  getDailyUsage,
  getGitEmail,
  getGitUser,
  getLogDir,
  getOrCreateSession,
  getProjectSnippets,
  getSecret,
  getStateDir,
  isProjectDisabled,
  isUserEnabled,
  listEnabledUsers,
  loadConfig,
  mergeDailyUsages,
  readCurrentSession,
  readSessionForProject,
  recomputeUsageTotals,
  resolveProjectName,
  resolveUserId,
  sendWelcomeIfNeeded,
  setSecret,
  tokenSimilarity,
  updateSession,
  updateSessionForProject,
  withFileLock
};
//# sourceMappingURL=index.js.map