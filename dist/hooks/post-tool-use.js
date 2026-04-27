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
  return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
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

// src/core/poster.ts
var { WebClient, retryPolicies } = slackPkg;

// src/core/fetcher.ts
import slackPkg2 from "@slack/web-api";
var { WebClient: WebClient2, retryPolicies: retryPolicies2 } = slackPkg2;

// src/core/store.ts
import { existsSync as existsSync3, readFileSync as readFileSync4, mkdirSync as mkdirSync3 } from "fs";
import { join as join5 } from "path";

// src/core/keychain.ts
import { execFileSync as execFileSync3 } from "child_process";
import { platform } from "os";

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
var MAX_TRANSCRIPT_BYTES = 200 * 1024 * 1024;

// src/core/usage-stats-codex.ts
import { createReadStream, existsSync as existsSync5, statSync as statSync3 } from "fs";
import { readdir } from "fs/promises";
import { createInterface } from "readline";
import { join as join8 } from "path";
import { homedir as homedir3 } from "os";

// src/core/registry.ts
import { existsSync as existsSync6, readFileSync as readFileSync6, mkdirSync as mkdirSync4 } from "fs";
import { execFileSync as execFileSync4 } from "child_process";
import { join as join9 } from "path";

// src/hooks/post-tool-use.ts
import { appendFile as appendFile2, mkdir as mkdir2 } from "fs/promises";
import { join as join10 } from "path";
import { existsSync as existsSync7, readFileSync as readFileSync7, writeFileSync as writeFileSync2 } from "fs";
import { createHash as createHash3 } from "crypto";
async function slackPost(token, body) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5e3)
  });
  return res.json();
}
function localDateStr() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
var MAX_OUTPUT_SCAN_BYTES = 32 * 1024;
function getToolOutput(input) {
  const raw = input.tool_output || input.tool_response || "";
  const merged = mergeRaw(raw);
  return merged.length > MAX_OUTPUT_SCAN_BYTES ? merged.slice(0, MAX_OUTPUT_SCAN_BYTES) : merged;
}
function mergeRaw(raw) {
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw !== null) {
    const obj = raw;
    const stdout = typeof obj.stdout === "string" ? obj.stdout : "";
    const stderr = typeof obj.stderr === "string" ? obj.stderr : "";
    return stdout && stderr ? `${stdout}
${stderr}` : stdout || stderr;
  }
  return "";
}
function detectBashEvent(command, output) {
  if (/\bgit\s+push\b/.test(command) && !/--dry-run/.test(command)) {
    if (/^To\s+/m.test(output)) {
      const branch = extractBranch(command, output);
      return {
        type: "push",
        summary: `Pushed to ${branch}`,
        metadata: { branch }
      };
    }
    return null;
  }
  if (/\bgit\s+commit\b/.test(command) && !/--dry-run/.test(command)) {
    const commitMatches = [...output.matchAll(/^\[([^\s\]]+)[^\]]*\]\s+(.+)$/gm)];
    if (commitMatches.length > 0) {
      const last = commitMatches[commitMatches.length - 1];
      const branch = last[1];
      const commitMsg = last[2].trim().slice(0, 100);
      return {
        type: "status",
        summary: `Committed: ${commitMsg}`,
        metadata: { branch }
      };
    }
    return null;
  }
  if (/\bgh\s+pr\s+create\b/.test(command)) {
    const urlMatch = output.match(/(https:\/\/github\.com\/\S+\/pull\/\d+)/);
    if (urlMatch) {
      return {
        type: "completion",
        summary: `PR created: ${urlMatch[1]}`,
        metadata: { prUrl: urlMatch[1] }
      };
    }
    return null;
  }
  if (isTestCommand(command)) {
    const hasExitError = /Exit code [1-9]|exit code [1-9]|exited with (?:code )?[1-9]/i.test(output);
    const failCountMatch = output.match(/(\d+)\s+(?:failed|failing)/i);
    const failCount = failCountMatch ? Number.parseInt(failCountMatch[1], 10) : 0;
    if (hasExitError || failCount > 0) {
      const summary = failCount > 0 ? `Tests failing: ${failCount} failure${failCount === 1 ? "" : "s"}` : "Tests failing";
      return {
        type: "blocker",
        summary
      };
    }
  }
  return null;
}
function detectTaskEvent(input, output, rawResponse, taskSubjectLookup) {
  if (input.status === "completed" && input.taskId) {
    const parsed = parseTaskOutput(output);
    const resp = typeof rawResponse === "object" && rawResponse !== null ? rawResponse : void 0;
    const subject = input.subject || parsed.subject || (typeof resp?.subject === "string" ? resp.subject : void 0) || taskSubjectLookup?.(String(input.taskId)) || `#${input.taskId}`;
    const details = parsed.description || (typeof resp?.description === "string" ? resp.description : void 0);
    return {
      type: "completion",
      summary: `Task completed: ${subject}`,
      details
    };
  }
  return null;
}
function parseTaskOutput(output) {
  if (!output) return {};
  try {
    const data = JSON.parse(output);
    return {
      subject: data.subject || void 0,
      description: data.description || void 0
    };
  } catch {
  }
  const subject = output.match(/subject[:\s]+"([^"]+)"/i)?.[1] || output.match(/subject[:\s]+(.+)/im)?.[1]?.trim();
  const description = output.match(/description[:\s]+"([^"]+)"/i)?.[1] || output.match(/description[:\s]+(.+)/im)?.[1]?.trim();
  return { subject: subject || void 0, description: description || void 0 };
}
function extractBranch(command, output) {
  const outMatch = output.match(
    /(?:\[new branch\]|\w+\.\.\w+|\*)\s+\S+\s+->\s+(\S+)/m
  );
  if (outMatch) return outMatch[1];
  const branchQuote = output.match(/branch\s+'([^']+)'/);
  if (branchQuote) return branchQuote[1];
  const tokens = command.split(/\s+/).filter((t) => !t.startsWith("-"));
  const pushIdx = tokens.indexOf("push");
  if (pushIdx >= 0 && tokens.length > pushIdx + 2) {
    const refspec = tokens[pushIdx + 2];
    if (refspec && refspec !== "HEAD") {
      return refspec.includes(":") ? refspec.split(":").pop() : refspec;
    }
  }
  return "unknown";
}
function isTestCommand(command) {
  return /\b(npm\s+test|npx\s+vitest|npx\s+jest|pytest|go\s+test|cargo\s+test|make\s+test|yarn\s+test|pnpm\s+test)\b/.test(command);
}
var EVENT_ICONS = {
  push: "\u{1F680}",
  // rocket
  status: "\u{1F4DD}",
  // memo
  completion: "\u2705",
  // check
  blocker: "\u{1F6D1}",
  // stop
  pivot: "\u{1F504}"
  // arrows
};
var TASK_CACHE_MAX_ENTRIES = 200;
function taskCachePath() {
  return join10(getStateDir(), "task-subjects.json");
}
function readTaskCache() {
  const path = taskCachePath();
  if (!existsSync7(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync7(path, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
function writeTaskCache(cache) {
  const path = taskCachePath();
  try {
    withFileLock(path, () => {
      const keys = Object.keys(cache);
      if (keys.length > TASK_CACHE_MAX_ENTRIES) {
        const trimmed = {};
        for (const k of keys.slice(-TASK_CACHE_MAX_ENTRIES)) trimmed[k] = cache[k];
        cache = trimmed;
      }
      const path2 = taskCachePath();
      writeFileSync2(path2, JSON.stringify(cache, null, 2), "utf-8");
    });
  } catch {
  }
}
function lookupTaskSubject(taskId) {
  return readTaskCache()[taskId];
}
function cacheTaskSubject(taskId, subject) {
  const cache = readTaskCache();
  cache[taskId] = subject;
  writeTaskCache(cache);
}
function extractTaskCreateSubject(toolInput, rawResponse, outputText) {
  if (typeof rawResponse === "object" && rawResponse !== null) {
    const resp = rawResponse;
    if (resp.task && typeof resp.task === "object") {
      const t = resp.task;
      if (typeof t.id === "string" && typeof t.subject === "string") {
        return { taskId: t.id, subject: t.subject };
      }
    }
    if (typeof resp.subject === "string" && typeof resp.taskId === "string") {
      return { taskId: resp.taskId, subject: resp.subject };
    }
  }
  const textMatch = outputText.match(/Task\s+#(\S+)\s+created\s+successfully:\s*(.+)$/m);
  if (textMatch) {
    return { taskId: textMatch[1], subject: textMatch[2].trim() };
  }
  if (typeof toolInput?.subject === "string" && toolInput.taskId) {
    return { taskId: String(toolInput.taskId), subject: toolInput.subject };
  }
  return null;
}
async function readStdinWithTimeout(timeoutMs) {
  const chunks = [];
  const timer = setTimeout(() => {
    process.stdin.pause();
  }, timeoutMs);
  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
async function main() {
  const STDIN_TIMEOUT_MS = 2e3;
  const raw = await readStdinWithTimeout(STDIN_TIMEOUT_MS);
  if (!raw) return;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stderr.write(`[claude-report] invalid hook input (${raw.length} bytes)
`);
    return;
  }
  if (!input.tool_name) return;
  const output = getToolOutput(input);
  let event = null;
  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command || "";
    event = detectBashEvent(command, output);
  } else if (input.tool_name === "TaskCreate") {
    const extracted = extractTaskCreateSubject(input.tool_input || {}, input.tool_response, output);
    if (extracted) {
      cacheTaskSubject(extracted.taskId, extracted.subject);
    }
    return;
  } else if (input.tool_name === "TaskUpdate") {
    event = detectTaskEvent(
      input.tool_input,
      output,
      input.tool_response,
      lookupTaskSubject
    );
  }
  if (!event) return;
  const projectDir = input.cwd || process.cwd();
  const config = loadConfig(projectDir);
  if (!config.notifications.enabled) return;
  if (isProjectDisabled(projectDir)) return;
  if (event.type === "push" && config.notifications.onGitPush === false) return;
  if (event.type === "blocker" && config.notifications.onBlocker === false) return;
  if (event.type === "completion" && config.notifications.onCompletion === false) return;
  const project = resolveProjectName(projectDir);
  const userId = resolveUserId(config);
  const userName = config.user.name || "Unknown";
  const session = getOrCreateSession(userId, "activity-log");
  if (session.muted) return;
  const contentFilter = new ContentFilter();
  const update = {
    type: event.type,
    summary: event.summary,
    details: event.details,
    timestamp: /* @__PURE__ */ new Date(),
    userId,
    sessionId: session.sessionId,
    project,
    metadata: event.metadata
  };
  const filtered = contentFilter.filter(update);
  const rateLimiter = new RateLimiter(config.rateLimit);
  const rate = rateLimiter.shouldPost(filtered, session);
  if (!rate.allowed) {
    return;
  }
  const icon = EVENT_ICONS[event.type] || "\u{1F535}";
  const safeProject = escapeSlackMrkdwn(project).replace(/`/g, "'");
  const safeSummary = escapeSlackMrkdwn(filtered.summary);
  let logText = `\`${safeProject}\` ${icon} ${safeSummary}`;
  if (filtered.details) {
    logText += `
  ${escapeSlackMrkdwn(filtered.details)}`;
  }
  if (config.notifications.dryRun) {
    try {
      const logDir = getLogDir();
      await mkdir2(logDir, { recursive: true });
      await appendFile2(
        join10(logDir, "dry-run.log"),
        `[${(/* @__PURE__ */ new Date()).toISOString()}] ${logText}
`,
        "utf-8"
      );
    } catch (err) {
      process.stderr.write(`[claude-report] dry-run write failed: ${err instanceof Error ? err.message : err}
`);
    }
    rateLimiter.recordPost(filtered);
    const today = localDateStr();
    updateSessionForProject(userId, "activity-log", {
      lastPostAt: (/* @__PURE__ */ new Date()).toISOString(),
      lastPostSummary: filtered.summary,
      postCount: session.postCount + 1,
      dailyPostCount: session.dailyPostDate === today ? session.dailyPostCount + 1 : 1,
      dailyPostDate: today
    });
    return;
  }
  if (!config.slack.botToken || !config.slack.channel) return;
  await sendWelcomeIfNeeded(config);
  try {
    const today = localDateStr();
    const threadId = await acquireThreadId(
      userId,
      session.threadId,
      config.slack.botToken,
      config.slack.channel,
      escapeSlackMrkdwn(userName),
      today
    );
    if (!threadId) return;
    const reply = await slackPost(config.slack.botToken, {
      channel: config.slack.channel,
      thread_ts: threadId,
      text: logText
    });
    if (!reply.ok) {
      process.stderr.write(`[claude-report] reply failed: ${JSON.stringify(reply).slice(0, 200)}
`);
      return;
    }
    rateLimiter.recordPost(filtered);
    updateSessionForProject(userId, "activity-log", {
      lastPostAt: (/* @__PURE__ */ new Date()).toISOString(),
      lastPostSummary: filtered.summary,
      postCount: session.postCount + 1,
      dailyPostCount: session.dailyPostDate === today ? session.dailyPostCount + 1 : 1,
      dailyPostDate: today
    });
  } catch (err) {
    process.stderr.write(`[claude-report] log failed: ${err instanceof Error ? err.message : err}
`);
  }
}
var CLAIM_PREFIX = "__claiming__";
var CLAIM_STALE_MS = 6e4;
function makeClaim() {
  return `${CLAIM_PREFIX}:${process.pid}:${Date.now()}`;
}
function parseClaim(threadId) {
  if (!threadId || !threadId.startsWith(CLAIM_PREFIX)) return null;
  const parts = threadId.split(":");
  if (parts.length !== 3) return { stale: true };
  const pid = Number.parseInt(parts[1], 10);
  const ts = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(pid) || !Number.isFinite(ts)) return { stale: true };
  const ageMs = Date.now() - ts;
  if (ageMs < 0 || ageMs > CLAIM_STALE_MS) return { stale: true };
  try {
    process.kill(pid, 0);
    return { stale: false };
  } catch (err) {
    if (err?.code === "ESRCH") return { stale: true };
    return { stale: false };
  }
}
async function acquireThreadId(userId, existingThreadId, botToken, channel, safeUserName, today) {
  if (existingThreadId && parseClaim(existingThreadId) === null) return existingThreadId;
  const myClaim = makeClaim();
  const claim = withFileLock(sessionFilePathFor(userId), () => {
    const cur = readSessionJson(userId);
    if (!cur) return { state: "claimed" };
    const claimInfo = parseClaim(cur.threadId);
    if (cur.threadId && claimInfo === null) {
      return { state: "reuse", existing: cur.threadId };
    }
    if (claimInfo && !claimInfo.stale) {
      return { state: "wait" };
    }
    writeSessionFieldsInLock(userId, { threadId: myClaim });
    return { state: "claimed" };
  });
  if (claim.state === "reuse") return claim.existing;
  if (claim.state === "wait") {
    const WAIT_POLL_MS = 150;
    const WAIT_MAX_ATTEMPTS = 20;
    for (let i = 0; i < WAIT_MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
      const cur2 = readSessionJson(userId);
      if (!cur2) continue;
      const info = parseClaim(cur2.threadId);
      if (cur2.threadId && info === null) return cur2.threadId;
      if (info && info.stale) {
        const stolen = withFileLock(sessionFilePathFor(userId), () => {
          const latest = readSessionJson(userId);
          const latestInfo = parseClaim(latest?.threadId ?? null);
          if (latestInfo && latestInfo.stale) {
            writeSessionFieldsInLock(userId, { threadId: myClaim });
            return true;
          }
          return false;
        });
        if (stolen) break;
      }
    }
    const cur = readSessionJson(userId);
    if (cur?.threadId !== myClaim) {
      const info = parseClaim(cur?.threadId ?? null);
      if (cur?.threadId && info === null) return cur.threadId;
      return null;
    }
  }
  try {
    const parent = await slackPost(botToken, {
      channel,
      text: `\u{1F4CB} ${safeUserName} \u2014 ${today}`,
      blocks: [{
        type: "section",
        text: {
          type: "mrkdwn",
          text: `\u{1F4CB} *${safeUserName}* \u2014 Activity Log (${today})`
        }
      }]
    });
    if (!parent.ts) {
      releaseClaim(userId, myClaim);
      process.stderr.write(`[claude-report] parent post returned no ts
`);
      return null;
    }
    updateSessionForProject(userId, "activity-log", { threadId: parent.ts });
    return parent.ts;
  } catch (err) {
    releaseClaim(userId, myClaim);
    process.stderr.write(`[claude-report] parent post failed: ${err instanceof Error ? err.message : err}
`);
    return null;
  }
}
function releaseClaim(userId, myClaim) {
  try {
    withFileLock(sessionFilePathFor(userId), () => {
      const cur = readSessionJson(userId);
      if (cur?.threadId === myClaim) {
        writeSessionFieldsInLock(userId, { threadId: null });
      }
    });
  } catch {
  }
}
function writeSessionFieldsInLock(userId, updates) {
  const path = sessionFilePathFor(userId);
  if (!existsSync7(path)) return;
  try {
    const session = JSON.parse(readFileSync7(path, "utf-8"));
    Object.assign(session, updates, { lastActiveAt: (/* @__PURE__ */ new Date()).toISOString() });
    atomicWriteJson(path, session);
  } catch {
  }
}
function sessionFilePathFor(userId) {
  const hash = createHash3("sha256").update(`${userId}:activity-log`).digest("hex").slice(0, 12);
  return join10(getStateDir(), `session-${hash}.json`);
}
function readSessionJson(userId) {
  const filePath = sessionFilePathFor(userId);
  if (!existsSync7(filePath)) return null;
  try {
    return JSON.parse(readFileSync7(filePath, "utf-8"));
  } catch {
    return null;
  }
}
main().catch((err) => {
  process.stderr.write(`[claude-report] hook error: ${err instanceof Error ? err.message : err}
`);
}).finally(() => process.exit(0));
export {
  detectBashEvent,
  detectTaskEvent,
  getToolOutput,
  parseTaskOutput
};
//# sourceMappingURL=post-tool-use.js.map