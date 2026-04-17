/**
 * Claude Code hook: PostToolUse
 *
 * Deterministic event detection — fires on Bash and TaskUpdate tool calls.
 * Detects: git push, git commit, gh pr create, test failures, task completion.
 */

import {
  loadConfig,
  isProjectDisabled,
  getOrCreateSession,
  updateSessionForProject,
  resolveProjectName,
  resolveUserId,
  ContentFilter,
  RateLimiter,
  sendWelcomeIfNeeded,
  escapeSlackMrkdwn,
  getLogDir,
  withFileLock,
} from "../core/index.js";
import type { UpdateType, UpdateMetadata } from "../core/index.js";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Post to Slack using raw fetch — no external dependencies needed */
async function slackPost(token: string, body: Record<string, unknown>): Promise<{ ok: boolean; ts?: string }> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return res.json() as Promise<{ ok: boolean; ts?: string }>;
}

/** Format today's date in local timezone as YYYY-MM-DD */
function localDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

interface HookInput {
  tool_name: string;
  tool_input: Record<string, any>;
  tool_output?: string;
  /** Claude Code passes tool_response as {stdout, stderr, interrupted, ...} for Bash */
  tool_response?: string | { stdout?: string; stderr?: string; [key: string]: unknown };
  /** Current working directory of the Claude Code session */
  cwd?: string;
  session_id?: string;
}

/**
 * Cap on tool output size before regex scanning. A crafted ~1MB stdout full of
 * repeating `eyJ....` fragments can cause catastrophic backtracking in our
 * JWT / key=value patterns. 32KB is plenty for recognizing git push / commit /
 * PR / test-failure signals, all of which appear near the start of the output.
 */
const MAX_OUTPUT_SCAN_BYTES = 32 * 1024;

/** Get tool output from hook input — handles both field names and structured responses. */
export function getToolOutput(input: HookInput): string {
  const raw = input.tool_output || input.tool_response || "";
  const merged = mergeRaw(raw);
  // Cap length to bound regex work. Take from the START of the output since
  // git/test signals appear early; the tail is usually diff or command output
  // that we don't need for event detection.
  return merged.length > MAX_OUTPUT_SCAN_BYTES
    ? merged.slice(0, MAX_OUTPUT_SCAN_BYTES)
    : merged;
}

function mergeRaw(raw: string | object | null | undefined): string {
  if (typeof raw === "string") return raw;
  // Claude Code passes tool_response as {stdout, stderr, ...} for Bash.
  // Concatenate stdout and stderr defensively (git push writes progress to stderr).
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const stdout = typeof obj.stdout === "string" ? obj.stdout : "";
    const stderr = typeof obj.stderr === "string" ? obj.stderr : "";
    return stdout && stderr ? `${stdout}\n${stderr}` : stdout || stderr;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Event detection: returns a status update or null
// ---------------------------------------------------------------------------

export interface DetectedEvent {
  type: UpdateType;
  summary: string;
  details?: string;
  metadata?: UpdateMetadata;
}

export function detectBashEvent(command: string, output: string): DetectedEvent | null {
  // 1. Git push — prefer the "->" line from output as the source of truth.
  //    Command-line parsing is fragile: `git push -u origin HEAD`,
  //    `--force-with-lease`, multi-refspec pushes all mis-extract.
  if (/\bgit\s+push\b/.test(command) && !/--dry-run/.test(command)) {
    if (/^To\s+/m.test(output)) {
      const branch = extractBranch(command, output);
      return {
        type: "push",
        summary: `Pushed to ${branch}`,
        metadata: { branch },
      };
    }
    return null; // Push failed
  }

  // 2. Git commit — anchor match to start-of-line to avoid matching ']' in
  //    the middle of prior output (e.g., `git commit --amend` showing old commit).
  if (/\bgit\s+commit\b/.test(command) && !/--dry-run/.test(command)) {
    const commitMatches = [...output.matchAll(/^\[([^\s\]]+)[^\]]*\]\s+(.+)$/gm)];
    if (commitMatches.length > 0) {
      // Take the LAST match — for --amend, this is the new commit
      const last = commitMatches[commitMatches.length - 1];
      const branch = last[1];
      const commitMsg = last[2].trim().slice(0, 100);
      return {
        type: "status",
        summary: `Committed: ${commitMsg}`,
        metadata: { branch },
      };
    }
    return null;
  }

  // 3. gh pr create
  if (/\bgh\s+pr\s+create\b/.test(command)) {
    // gh pr create outputs the PR URL on success
    const urlMatch = output.match(/(https:\/\/github\.com\/\S+\/pull\/\d+)/);
    if (urlMatch) {
      return {
        type: "completion",
        summary: `PR created: ${urlMatch[1]}`,
        metadata: { prUrl: urlMatch[1] },
      };
    }
    return null;
  }

  // 4. Test failures — require a positive failure signal to avoid false positives
  //    from words like "error" or "0 failed" in passing output.
  if (isTestCommand(command)) {
    const hasExitError = /Exit code [1-9]|exit code [1-9]|exited with (?:code )?[1-9]/i.test(output);
    const failCountMatch = output.match(/(\d+)\s+(?:failed|failing)/i);
    const failCount = failCountMatch ? Number.parseInt(failCountMatch[1], 10) : 0;
    // Only report when exit code indicates failure OR an explicit failure count > 0
    if (hasExitError || failCount > 0) {
      const summary = failCount > 0
        ? `Tests failing: ${failCount} failure${failCount === 1 ? "" : "s"}`
        : "Tests failing";
      return {
        type: "blocker",
        summary,
      };
    }
  }

  return null;
}

export function detectTaskEvent(
  input: Record<string, any>,
  output: string,
  rawResponse?: unknown,
): DetectedEvent | null {
  // TaskUpdate with status "completed"
  if (input.status === "completed" && input.taskId) {
    const parsed = parseTaskOutput(output);
    // Claude Code's tool_response for TaskUpdate is a structured object
    // containing the task details (subject, description, etc.)
    const resp = (typeof rawResponse === "object" && rawResponse !== null)
      ? rawResponse as Record<string, unknown>
      : undefined;
    const subject = input.subject
      || parsed.subject
      || (typeof resp?.subject === "string" ? resp.subject : undefined)
      || `#${input.taskId}`;
    const details = parsed.description
      || (typeof resp?.description === "string" ? resp.description : undefined);
    return {
      type: "completion",
      summary: `Task completed: ${subject}`,
      details,
    };
  }
  return null;
}

/** Extract task subject and description from tool_output text */
export function parseTaskOutput(output: string): { subject?: string; description?: string } {
  if (!output) return {};
  // Try JSON parse first (structured output)
  try {
    const data = JSON.parse(output);
    return {
      subject: data.subject || undefined,
      description: data.description || undefined,
    };
  } catch {
    // Fall back to text parsing
  }
  const subject = output.match(/subject[:\s]+"([^"]+)"/i)?.[1]
    || output.match(/subject[:\s]+(.+)/im)?.[1]?.trim();
  const description = output.match(/description[:\s]+"([^"]+)"/i)?.[1]
    || output.match(/description[:\s]+(.+)/im)?.[1]?.trim();
  return { subject: subject || undefined, description: description || undefined };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractBranch(command: string, output: string): string {
  // Prefer output — the "X -> Y" line unambiguously names the destination branch.
  // Command-line parsing breaks on: `git push -u origin HEAD`, `--force-with-lease`,
  // multi-refspec pushes, and flags placed after the remote.
  const outMatch = output.match(
    /(?:\[new branch\]|\w+\.\.\w+|\*)\s+\S+\s+->\s+(\S+)/m,
  );
  if (outMatch) return outMatch[1];

  const branchQuote = output.match(/branch\s+'([^']+)'/);
  if (branchQuote) return branchQuote[1];

  // Fallback to command parsing — strip flags so `-u origin HEAD` doesn't confuse us.
  const tokens = command.split(/\s+/).filter((t) => !t.startsWith("-"));
  const pushIdx = tokens.indexOf("push");
  if (pushIdx >= 0 && tokens.length > pushIdx + 2) {
    const refspec = tokens[pushIdx + 2];
    // HEAD is a symbolic ref — don't use as branch name
    if (refspec && refspec !== "HEAD") {
      return refspec.includes(":") ? refspec.split(":").pop()! : refspec;
    }
  }

  return "unknown";
}

function isTestCommand(command: string): boolean {
  return /\b(npm\s+test|npx\s+vitest|npx\s+jest|pytest|go\s+test|cargo\s+test|make\s+test|yarn\s+test|pnpm\s+test)\b/.test(command);
}

const EVENT_ICONS: Record<string, string> = {
  push: "\u{1f680}",       // rocket
  status: "\u{1f4dd}",     // memo
  completion: "\u{2705}",  // check
  blocker: "\u{1f6d1}",    // stop
  pivot: "\u{1f504}",      // arrows
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Read stdin with a hard timeout — Claude Code should always close stdin promptly,
 * but if it doesn't we must not block the user's tool loop indefinitely. */
async function readStdinWithTimeout(timeoutMs: number): Promise<string> {
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => {
    // Detach without destroying (destroy would emit an error); just stop reading
    process.stdin.pause();
  }, timeoutMs);
  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  const STDIN_TIMEOUT_MS = 2000;
  const raw = await readStdinWithTimeout(STDIN_TIMEOUT_MS);
  if (!raw) return; // timed out with no data — silently exit
  let input: HookInput;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stderr.write(`[claude-report] invalid hook input (${raw.length} bytes)\n`);
    return;
  }
  if (!input.tool_name) return;

  // Detect event based on tool type
  const output = getToolOutput(input);
  let event: DetectedEvent | null = null;

  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command || "";
    event = detectBashEvent(command, output);
  } else if (input.tool_name === "TaskUpdate") {
    event = detectTaskEvent(input.tool_input, output, input.tool_response);
  }

  if (!event) return;

  // Use cwd from hook input (tracks cd), fall back to process.cwd()
  const projectDir = input.cwd || process.cwd();
  const config = loadConfig(projectDir);

  // Global disable / project opt-out
  if (!config.notifications.enabled) return;
  if (isProjectDisabled(projectDir)) return;

  // Per-event-type toggles — respect user preferences set in config
  if (event.type === "push" && config.notifications.onGitPush === false) return;
  if (event.type === "blocker" && config.notifications.onBlocker === false) return;
  if (event.type === "completion" && config.notifications.onCompletion === false) return;

  const project = resolveProjectName(projectDir);
  const userId = resolveUserId(config);
  const userName = config.user.name || "Unknown";

  // Single daily thread per user (not per project)
  const session = getOrCreateSession(userId, "activity-log");

  // Mute check — honor session.muted even before hitting the network
  if (session.muted) return;

  const contentFilter = new ContentFilter();

  // Build the StatusUpdate for the RateLimiter first. We use a shorter summary
  // (just the event summary, not the formatted line) so dedup works across
  // projects — two "Pushed to main" events from different projects should dedup.
  const update = {
    type: event.type,
    summary: event.summary,
    details: event.details,
    timestamp: new Date(),
    userId,
    sessionId: session.sessionId,
    project,
    metadata: event.metadata,
  };
  const filtered = contentFilter.filter(update);

  // Rate limiter — same gates as the MCP path (mute, session/daily caps,
  // minIntervalMs, cross-project dedup).
  const rateLimiter = new RateLimiter(config.rateLimit);
  const rate = rateLimiter.shouldPost(filtered, session);
  if (!rate.allowed) {
    // Silent — rate limiting is an expected outcome, not an error.
    return;
  }

  // Build the Slack line. Everything user-controlled goes through
  // escapeSlackMrkdwn to neutralize <!channel>, <@UID>, @channel, *_~` triggers.
  const icon = EVENT_ICONS[event.type] || "\u{1f535}";
  const safeProject = escapeSlackMrkdwn(project).replace(/`/g, "'"); // goes inside code span
  const safeSummary = escapeSlackMrkdwn(filtered.summary);
  let logText = `\`${safeProject}\` ${icon} ${safeSummary}`;
  if (filtered.details) {
    logText += `\n  ${escapeSlackMrkdwn(filtered.details)}`;
  }

  // Dry-run: log to disk, never hit Slack. Still update session state so dedup
  // works consistently (switching dryRun on/off shouldn't suddenly allow dupes).
  if (config.notifications.dryRun) {
    try {
      const logDir = getLogDir();
      await mkdir(logDir, { recursive: true });
      await appendFile(
        join(logDir, "dry-run.log"),
        `[${new Date().toISOString()}] ${logText}\n`,
        "utf-8",
      );
    } catch (err) {
      process.stderr.write(`[claude-report] dry-run write failed: ${err instanceof Error ? err.message : err}\n`);
    }
    rateLimiter.recordPost(filtered);
    const today = localDateStr();
    updateSessionForProject(userId, "activity-log", {
      lastPostAt: new Date().toISOString(),
      lastPostSummary: filtered.summary,
      postCount: session.postCount + 1,
      dailyPostCount: session.dailyPostDate === today
        ? session.dailyPostCount + 1
        : 1,
      dailyPostDate: today,
    });
    return;
  }

  // Real post — needs token + channel.
  if (!config.slack.botToken || !config.slack.channel) return;

  await sendWelcomeIfNeeded(config);

  try {
    const today = localDateStr();

    // Acquire the session file lock for the parent-creation + post sequence.
    // This prevents two concurrent hooks from both creating parent messages
    // (split-brain: one parent becomes orphaned).
    const threadId = await acquireThreadId(
      userId,
      session.threadId,
      config.slack.botToken,
      config.slack.channel,
      escapeSlackMrkdwn(userName),
      today,
    );
    if (!threadId) return;

    // Post reply (outside the session lock — Slack API call is slow).
    const reply = await slackPost(config.slack.botToken, {
      channel: config.slack.channel,
      thread_ts: threadId,
      text: logText,
    });

    if (!reply.ok) {
      process.stderr.write(`[claude-report] reply failed: ${JSON.stringify(reply).slice(0, 200)}\n`);
      return;
    }

    // Success: record for rate-limiter dedup and update session counters.
    // lastPostSummary is persisted so the next hook subprocess can also dedup
    // (in-memory dedup cache is useless in short-lived hook processes).
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
  } catch (err) {
    process.stderr.write(`[claude-report] log failed: ${err instanceof Error ? err.message : err}\n`);
  }
}

/**
 * Claim-or-read the daily parent threadId. Prevents split-brain where two
 * concurrent hooks both POST parent messages.
 *
 * Algorithm: under the session lock, check for existing threadId:
 *   - Non-null and not a claim marker → reuse
 *   - Claim marker with LIVE owner and fresh → wait and re-read
 *   - Claim marker with DEAD owner or STALE (>60s) → steal and claim fresh
 *   - Null → we claim by writing a PID+timestamp marker, release the lock,
 *     POST, then commit the real threadId under lock again
 *
 * Claim markers encode `__claiming__:<pid>:<unix-ms>` so a crashed claimant
 * (SIGKILL mid-hook) doesn't wedge posting until midnight. Any subsequent
 * hook that sees a stuck claim with a dead PID or >60s timestamp steals it.
 *
 * The lock is held only for brief reads/writes — never across the Slack POST —
 * so contention is low.
 */
const CLAIM_PREFIX = "__claiming__";
const CLAIM_STALE_MS = 60_000;

function makeClaim(): string {
  return `${CLAIM_PREFIX}:${process.pid}:${Date.now()}`;
}

/**
 * Parse a claim marker. Returns null if the string is not a claim marker or is
 * malformed. Returns `{stale: true}` if the owner is dead or the claim is
 * older than CLAIM_STALE_MS — callers should treat this as "claim is free".
 */
function parseClaim(threadId: string | null): { stale: boolean } | null {
  if (!threadId || !threadId.startsWith(CLAIM_PREFIX)) return null;
  const parts = threadId.split(":");
  if (parts.length !== 3) return { stale: true }; // malformed — treat as stale
  const pid = Number.parseInt(parts[1], 10);
  const ts = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(pid) || !Number.isFinite(ts)) return { stale: true };
  const ageMs = Date.now() - ts;
  // Negative age = future-dated timestamp (clock skew or corrupt marker).
  // Treat as stale to prevent a garbage marker from wedging posts indefinitely.
  if (ageMs < 0 || ageMs > CLAIM_STALE_MS) return { stale: true };
  // Check if owner is alive. In dead-pid case, treat as stale.
  try {
    process.kill(pid, 0);
    return { stale: false };
  } catch (err: any) {
    if (err?.code === "ESRCH") return { stale: true }; // dead
    return { stale: false }; // EPERM — owned by another user/process; assume alive
  }
}

async function acquireThreadId(
  userId: string,
  existingThreadId: string | null,
  botToken: string,
  channel: string,
  safeUserName: string,
  today: string,
): Promise<string | null> {
  if (existingThreadId && parseClaim(existingThreadId) === null) return existingThreadId;

  type State = "reuse" | "claimed" | "wait";
  const myClaim = makeClaim();

  const claim: { state: State; existing?: string } = withFileLock(sessionFilePathFor(userId), () => {
    const cur = readSessionJson(userId);
    if (!cur) return { state: "claimed" as State };

    const claimInfo = parseClaim(cur.threadId);
    if (cur.threadId && claimInfo === null) {
      // Real threadId — use it
      return { state: "reuse" as State, existing: cur.threadId };
    }
    if (claimInfo && !claimInfo.stale) {
      // Another live hook is posting the parent; wait for it
      return { state: "wait" as State };
    }
    // Either no threadId, or a stale/dead claim — claim the slot.
    updateSessionForProject(userId, "activity-log", { threadId: myClaim });
    return { state: "claimed" as State };
  });

  if (claim.state === "reuse") return claim.existing!;

  if (claim.state === "wait") {
    // Poll briefly for the resolved threadId; steal on stale mid-wait.
    const WAIT_POLL_MS = 150;
    const WAIT_MAX_ATTEMPTS = 20; // ~3 seconds
    for (let i = 0; i < WAIT_MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
      const cur = readSessionJson(userId);
      if (!cur) continue;
      const info = parseClaim(cur.threadId);
      if (cur.threadId && info === null) return cur.threadId; // resolved
      if (info && info.stale) {
        // Claimant died or stalled — try to steal
        const stolen = withFileLock(sessionFilePathFor(userId), () => {
          const latest = readSessionJson(userId);
          const latestInfo = parseClaim(latest?.threadId ?? null);
          if (latestInfo && latestInfo.stale) {
            updateSessionForProject(userId, "activity-log", { threadId: myClaim });
            return true;
          }
          return false;
        });
        if (stolen) break; // fall through to POST parent
        // Someone else stole first; continue polling
      }
    }
    // Re-read: are we the claimant now?
    const cur = readSessionJson(userId);
    if (cur?.threadId !== myClaim) {
      // Either resolved by someone else, or still stuck — return what we see
      const info = parseClaim(cur?.threadId ?? null);
      if (cur?.threadId && info === null) return cur.threadId;
      return null; // give up for this invocation
    }
    // We stole — fall through to the POST path below
  }

  // We claimed — POST the parent, then commit the real threadId.
  try {
    const parent = await slackPost(botToken, {
      channel,
      text: `\u{1f4cb} ${safeUserName} — ${today}`,
      blocks: [{
        type: "section",
        text: {
          type: "mrkdwn",
          text: `\u{1f4cb} *${safeUserName}* — Activity Log (${today})`,
        },
      }],
    });
    if (!parent.ts) {
      releaseClaim(userId, myClaim);
      process.stderr.write(`[claude-report] parent post returned no ts\n`);
      return null;
    }
    updateSessionForProject(userId, "activity-log", { threadId: parent.ts });
    return parent.ts;
  } catch (err) {
    releaseClaim(userId, myClaim);
    process.stderr.write(`[claude-report] parent post failed: ${err instanceof Error ? err.message : err}\n`);
    return null;
  }
}

/**
 * Release OUR claim so the next hook can retry. Only clears if the current
 * threadId is still our specific claim marker — otherwise someone else may
 * have legitimately taken over.
 */
function releaseClaim(userId: string, myClaim: string): void {
  try {
    withFileLock(sessionFilePathFor(userId), () => {
      const cur = readSessionJson(userId);
      if (cur?.threadId === myClaim) {
        updateSessionForProject(userId, "activity-log", { threadId: null });
      }
    });
  } catch { /* best-effort */ }
}

/** Path to the activity-log session file for a user. Mirrors session.ts. */
function sessionFilePathFor(userId: string): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const { getStateDir } = require("../core/index.js");
  const hash = createHash("sha256")
    .update(`${userId}:activity-log`)
    .digest("hex")
    .slice(0, 12);
  return join(getStateDir(), `session-${hash}.json`);
}

function readSessionJson(userId: string): { threadId: string | null } | null {
  const fs = require("node:fs") as typeof import("node:fs");
  const filePath = sessionFilePathFor(userId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

main().catch((err) => {
  process.stderr.write(`[claude-report] hook error: ${err instanceof Error ? err.message : err}\n`);
}).finally(() => process.exit(0));
