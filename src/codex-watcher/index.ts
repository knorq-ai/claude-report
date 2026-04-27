/**
 * Codex watcher daemon — long-lived process that tails Codex CLI session
 * JSONL files and posts real-time activity-log events (git push / commit /
 * PR / test failure) to the same Slack daily thread that the Claude Code
 * PostToolUse hook already writes to. Run via launchd with KeepAlive=true.
 *
 * Why a daemon and not a hook: Codex doesn't expose Claude-Code-style
 * external hooks, and the active session file isn't named — sessions can
 * span midnight, resumed sessions append to their original file (potentially
 * in an older date directory), and multiple sessions can run concurrently.
 * Per the Codex agent's own scoping review, the only robust read-only
 * approach is to recursively walk ~/.codex/sessions/** and tail every file
 * that has grown since we last looked.
 */

import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, existsSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  loadConfig,
  isProjectDisabled,
  getOrCreateSession,
  updateSessionForProject,
  resolveProjectName,
  resolveUserId,
  ContentFilter,
  RateLimiter,
  escapeSlackMrkdwn,
  getStateDir,
  atomicWriteJson,
} from "../core/index.js";
import {
  slackPost,
  localDateStr,
  acquireThreadId,
  ACTIVITY_EVENT_ICONS,
} from "../core/activity-thread.js";
import { detectBashEvent } from "../core/bash-event-detector.js";
import type { UpdateType, UpdateMetadata } from "../core/index.js";

interface FileWatermark {
  /** Byte offset in the file we have read up to. */
  bytesRead: number;
  /** ISO timestamp of last successful read. Used for log rotation pruning. */
  lastSeenAt: string;
  /**
   * Trailing partial line as base64-encoded raw bytes (NOT a decoded string).
   * Storing bytes instead of UTF-8 decoded text avoids replacement-character
   * corruption when a multi-byte codepoint spans two reads — e.g. an emoji in
   * a commit message split mid-byte would otherwise produce a `\uFFFD` that
   * makes the JSON.parse silently fail and the event get dropped.
   */
  partialBase64: string;
}

/** Cap one read at 4 MB. Codex `compacted` events can be very large; reading
 * 50+ MB in a single tick blocks the loop and risks OOM. When the unread
 * delta exceeds this, we read the cap, advance to the last newline within
 * it, and pick up the rest next tick. */
const MAX_READ_BYTES_PER_TICK = 4 * 1024 * 1024;

/** Run the stale-watermark prune every N ticks (~5 min at 2s tick). */
const PRUNE_EVERY_N_TICKS = 150;

interface WatermarkStore {
  files: Record<string, FileWatermark>;
}

/** Watermark file lives next to the activity-log session state. */
function watermarkPath(): string {
  return join(getStateDir(), "codex-watermarks.json");
}

function loadWatermarks(): WatermarkStore {
  const path = watermarkPath();
  if (!existsSync(path)) return { files: {} };
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (data && typeof data === "object" && data.files && typeof data.files === "object") {
      // Migrate legacy `partialLine: string` entries (pre-base64 schema) so
      // an in-flight partial JSONL line isn't dropped on upgrade.
      for (const wm of Object.values(data.files as Record<string, any>)) {
        if (wm && typeof wm === "object" && typeof wm.partialLine === "string" && !wm.partialBase64) {
          wm.partialBase64 = Buffer.from(wm.partialLine, "utf-8").toString("base64");
          delete wm.partialLine;
        }
        if (wm && typeof wm === "object" && typeof wm.partialBase64 !== "string") {
          wm.partialBase64 = "";
        }
      }
      return data as WatermarkStore;
    }
  } catch { /* corrupt — start fresh */ }
  return { files: {} };
}

function saveWatermarks(store: WatermarkStore): void {
  const path = watermarkPath();
  try {
    mkdirSync(getStateDir(), { recursive: true });
    atomicWriteJson(path, store);
  } catch (err) {
    process.stderr.write(`[codex-watcher] watermark write failed: ${err instanceof Error ? err.message : err}\n`);
  }
}

function getCodexSessionsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

/** Recursively collect rollout-*.jsonl paths under root. */
async function collectSessionFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        out.push(p);
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Read [from, from+len) from the file in one syscall. Returns the raw bytes
 * (NOT decoded) so the caller can preserve any multi-byte tail across ticks
 * without UTF-8 replacement-char corruption.
 */
function readBytesFrom(file: string, from: number, len: number): Buffer {
  if (len <= 0) return Buffer.alloc(0);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, from);
    return n === len ? buf : buf.subarray(0, n);
  } finally {
    try { closeSync(fd); } catch { /* */ }
  }
}

interface DetectedEvent {
  type: UpdateType;
  summary: string;
  details?: string;
  metadata?: UpdateMetadata;
}

interface EventContext {
  cwd: string | undefined;
  ts: string | undefined;
  /** Codex session UUID — useful for de-duping if the same line is re-read. */
  sessionId: string;
}

/**
 * Translate one parsed JSONL entry into a DetectedEvent (or null). Pure
 * function — no I/O, easy to unit-test.
 */
export function eventFromCodexLine(entry: any): { event: DetectedEvent; ctx: EventContext } | null {
  if (entry?.type !== "event_msg" || !entry.payload) return null;
  const sub = entry.payload.type;
  const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;

  if (sub === "exec_command_end") {
    const cmd = Array.isArray(entry.payload.command) ? entry.payload.command.join(" ") : "";
    const output = typeof entry.payload.aggregated_output === "string"
      ? entry.payload.aggregated_output
      : `${entry.payload.stdout ?? ""}\n${entry.payload.stderr ?? ""}`;
    if (!cmd) return null;
    const event = detectBashEvent(cmd, output);
    if (!event) return null;
    return {
      event,
      ctx: {
        cwd: typeof entry.payload.cwd === "string" ? entry.payload.cwd : undefined,
        ts,
        sessionId: typeof entry.payload.turn_id === "string" ? entry.payload.turn_id : "",
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

async function postEventToSlack(
  detected: DetectedEvent,
  ctx: EventContext,
): Promise<void> {
  // We resolve config per-event because the watcher is long-lived — if the
  // user updates ~/.claude-report/config.json, we want to pick up the change
  // without restarting. The cost is one JSON parse per event, which is cheap.
  const config = loadConfig(ctx.cwd);
  if (!config.notifications.enabled) return;
  if (ctx.cwd && isProjectDisabled(ctx.cwd)) return;
  if (detected.type === "push" && config.notifications.onGitPush === false) return;
  if (detected.type === "blocker" && config.notifications.onBlocker === false) return;
  if (detected.type === "completion" && config.notifications.onCompletion === false) return;
  if (!config.slack.botToken || !config.slack.channel) return;

  const project = ctx.cwd ? resolveProjectName(ctx.cwd) : "codex/unknown";
  const userId = resolveUserId(config);
  const userName = config.user.name || "Unknown";

  const session = getOrCreateSession(userId, "activity-log");
  if (session.muted) return;

  const filter = new ContentFilter();
  const update = {
    type: detected.type,
    summary: detected.summary,
    details: detected.details,
    timestamp: new Date(),
    userId,
    sessionId: session.sessionId,
    project,
    metadata: detected.metadata,
  };
  const filtered = filter.filter(update);

  const rateLimiter = new RateLimiter(config.rateLimit);
  const rate = rateLimiter.shouldPost(filtered, session);
  if (!rate.allowed) return;

  // NOTE on cross-process dedup: the Claude Code hook can also post a "Pushed
  // to main" event for the same git push (a session that runs both CLIs at
  // once will see it from both directions). Dedup here uses the persisted
  // session.lastPostSummary, but two processes can pass this gate
  // simultaneously and double-post. Acceptable: the worst case is one extra
  // line in the activity-log thread; single-source posts are far more common.

  const today = localDateStr();
  const threadId = await acquireThreadId(
    userId,
    session.threadId,
    config.slack.botToken,
    config.slack.channel,
    escapeSlackMrkdwn(userName),
    today,
  );
  if (!threadId) return;

  // Format: "🤖 `project` 🚀 Pushed to main" — the 🤖 prefix marks Codex-sourced
  // events so a reader can tell at a glance which CLI did the work.
  const icon = ACTIVITY_EVENT_ICONS[detected.type] || "\u{1f535}";
  const safeProject = escapeSlackMrkdwn(project).replace(/`/g, "'");
  const safeSummary = escapeSlackMrkdwn(filtered.summary);
  let logText = `\u{1f916} \`${safeProject}\` ${icon} ${safeSummary}`;
  if (filtered.details) logText += `\n  ${escapeSlackMrkdwn(filtered.details)}`;

  const reply = await slackPost(config.slack.botToken, {
    channel: config.slack.channel,
    thread_ts: threadId,
    text: logText,
  });
  if (!reply.ok) {
    process.stderr.write(`[codex-watcher] reply failed: ${JSON.stringify(reply).slice(0, 200)}\n`);
    return;
  }

  rateLimiter.recordPost(filtered);
  updateSessionForProject(userId, "activity-log", {
    lastPostAt: new Date().toISOString(),
    lastPostSummary: filtered.summary,
    postCount: session.postCount + 1,
    dailyPostCount: session.dailyPostDate === today
      ? session.dailyPostCount + 1
      : 1,
    dailyPostDate: today,
  });
}

// ---------------------------------------------------------------------------
// Tick loop
// ---------------------------------------------------------------------------

/**
 * Process one file: read past the watermark, parse new JSONL lines, dispatch
 * detected events. Returns the new watermark for caller to persist.
 */
async function processFile(
  file: string,
  prev: FileWatermark | undefined,
): Promise<FileWatermark> {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    // File vanished — return existing watermark unchanged so caller can
    // garbage-collect after a few ticks.
    return prev ?? { bytesRead: 0, lastSeenAt: new Date().toISOString(), partialBase64: "" };
  }

  // First time we've seen this file: skip historical contents. The watcher
  // is forward-looking — replaying a session that's already been logged
  // (e.g., the Claude Code hook already covered it) would spam Slack.
  if (!prev) {
    return {
      bytesRead: size,
      lastSeenAt: new Date().toISOString(),
      partialBase64: "",
    };
  }

  // File shrank → likely a truncate or rotation. Read from byte 0 so we
  // don't lose freshly-written content. Reset partial buffer because any
  // bytes carried over from the previous file are no longer meaningful.
  if (size < prev.bytesRead) {
    prev = { bytesRead: 0, lastSeenAt: prev.lastSeenAt, partialBase64: "" };
  }

  if (size === prev.bytesRead && !prev.partialBase64) {
    return prev;
  }

  const remaining = size - prev.bytesRead;
  const readLen = Math.min(remaining, MAX_READ_BYTES_PER_TICK);
  const newBytes = readBytesFrom(file, prev.bytesRead, readLen);
  const partialBuf = prev.partialBase64
    ? Buffer.from(prev.partialBase64, "base64")
    : Buffer.alloc(0);
  const combined = Buffer.concat([partialBuf, newBytes]);

  // Find the last newline; everything before it is complete lines, everything
  // after is the new partial (carried into the next tick as raw bytes so a
  // multi-byte codepoint at the boundary survives).
  const lastNl = combined.lastIndexOf(0x0a);
  let advancedBytes = readLen;
  let nextPartial: Buffer;
  let completePart: Buffer;
  if (lastNl === -1) {
    completePart = Buffer.alloc(0);
    nextPartial = combined;
  } else {
    completePart = combined.subarray(0, lastNl);
    nextPartial = combined.subarray(lastNl + 1);
  }

  // Cap-induced split safety: if we hit MAX_READ_BYTES_PER_TICK and there's
  // no newline in the read window AT ALL, the file has a single line larger
  // than the cap. Drop the partial buffer and skip past the cap to avoid
  // re-reading the same enormous prefix forever. The event in question
  // (likely a `compacted` snapshot we don't act on) is sacrificed.
  if (lastNl === -1 && remaining > MAX_READ_BYTES_PER_TICK) {
    nextPartial = Buffer.alloc(0);
  }

  if (completePart.length > 0) {
    const text = completePart.toString("utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const detected = eventFromCodexLine(entry);
      if (detected) {
        try {
          await postEventToSlack(detected.event, detected.ctx);
        } catch (err) {
          process.stderr.write(`[codex-watcher] post error: ${err instanceof Error ? err.message : err}\n`);
        }
      }
    }
  }

  return {
    bytesRead: prev.bytesRead + advancedBytes,
    lastSeenAt: new Date().toISOString(),
    partialBase64: nextPartial.length > 0 ? nextPartial.toString("base64") : "",
  };
}

/**
 * Drop watermarks for files we haven't seen in N days — keeps the state
 * file from growing unboundedly as Codex creates new daily session dirs.
 */
function pruneStaleWatermarks(store: WatermarkStore, maxAgeDays = 14): void {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const [path, wm] of Object.entries(store.files)) {
    const t = new Date(wm.lastSeenAt).getTime();
    if (Number.isFinite(t) && t < cutoff) delete store.files[path];
  }
}

async function tick(store: WatermarkStore): Promise<void> {
  const root = getCodexSessionsRoot();
  if (!existsSync(root)) return;

  const files = await collectSessionFiles(root);
  for (const file of files) {
    const next = await processFile(file, store.files[file]);
    store.files[file] = next;
  }
}

const TICK_INTERVAL_MS = 2000;

export async function run(): Promise<void> {
  process.stderr.write(`[codex-watcher] starting (pid ${process.pid})\n`);
  const store = loadWatermarks();
  pruneStaleWatermarks(store);

  let stopRequested = false;
  const shutdown = (sig: string) => {
    process.stderr.write(`[codex-watcher] ${sig} received, shutting down\n`);
    stopRequested = true;
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  let tickN = 0;
  while (!stopRequested) {
    try {
      await tick(store);
      // Prune stale watermarks periodically so the on-disk state file doesn't
      // grow forever as Codex creates new YYYY/MM/DD session dirs.
      if (++tickN % PRUNE_EVERY_N_TICKS === 0) pruneStaleWatermarks(store);
      saveWatermarks(store);
    } catch (err) {
      process.stderr.write(`[codex-watcher] tick error: ${err instanceof Error ? err.stack : err}\n`);
    }
    await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
  }
  saveWatermarks(store);
  process.stderr.write(`[codex-watcher] stopped\n`);
}

// Run when invoked as the main script (not when imported by tests).
import { fileURLToPath } from "node:url";
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    process.stderr.write(`[codex-watcher] fatal: ${err instanceof Error ? err.stack : err}\n`);
    process.exit(1);
  });
}
