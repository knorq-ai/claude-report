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
  getStateDir,
  withFileLock,
} from "../core/index.js";
import {
  slackPost,
  localDateStr,
  acquireThreadId,
  ACTIVITY_EVENT_ICONS,
} from "../core/activity-thread.js";
import type { UpdateType, UpdateMetadata } from "../core/index.js";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
// Event detection
// ---------------------------------------------------------------------------
// Bash event detection moved to src/core/bash-event-detector.ts so the Codex
// watcher daemon can import it without pulling in this file's hook entry-point
// (which reads stdin + process.exit's, fatal for a long-lived process).

import { detectBashEvent } from "../core/bash-event-detector.js";
import type { DetectedEvent } from "../core/bash-event-detector.js";
export { detectBashEvent };
export type { DetectedEvent };

export function detectTaskEvent(
  input: Record<string, any>,
  output: string,
  rawResponse?: unknown,
  taskSubjectLookup?: (taskId: string) => string | undefined,
): DetectedEvent | null {
  // TaskUpdate with status "completed"
  if (input.status === "completed" && input.taskId) {
    const parsed = parseTaskOutput(output);
    // Claude Code's tool_response for TaskUpdate does NOT include the subject
    // (it only carries {success, taskId, updatedFields, statusChange}).
    // Subject must come from: input (rare — Claude usually updates status
    // without the full subject), a prior TaskCreate/TaskUpdate cached by the
    // hook, or parsed from output. Falls back to `#${taskId}`.
    const resp = (typeof rawResponse === "object" && rawResponse !== null)
      ? rawResponse as Record<string, unknown>
      : undefined;
    const subject = input.subject
      || parsed.subject
      || (typeof resp?.subject === "string" ? resp.subject : undefined)
      || (taskSubjectLookup?.(String(input.taskId)))
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

const EVENT_ICONS = ACTIVITY_EVENT_ICONS;

// ---------------------------------------------------------------------------
// Task subject cache — maps taskId → subject so TaskUpdate can report the
// task's human-readable name (TaskUpdate response contains only {taskId,
// status}, never the subject).
// ---------------------------------------------------------------------------

const TASK_CACHE_MAX_ENTRIES = 200;

function taskCachePath(): string {
  return join(getStateDir(), "task-subjects.json");
}

function readTaskCache(): Record<string, string> {
  const path = taskCachePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeTaskCache(cache: Record<string, string>): void {
  const path = taskCachePath();
  try {
    withFileLock(path, () => {
      // Bound cache size — drop oldest entries if exceeded (simple FIFO via
      // insertion order; V8 preserves insertion order for string keys).
      const keys = Object.keys(cache);
      if (keys.length > TASK_CACHE_MAX_ENTRIES) {
        const trimmed: Record<string, string> = {};
        for (const k of keys.slice(-TASK_CACHE_MAX_ENTRIES)) trimmed[k] = cache[k];
        cache = trimmed;
      }
      const path2 = taskCachePath(); // re-compute inside lock
      writeFileSync(path2, JSON.stringify(cache, null, 2), "utf-8");
    });
  } catch {
    // best-effort — if the cache can't be written, we'll fall back to #N
  }
}

/** Look up the subject for a task ID (returns undefined if not cached). */
function lookupTaskSubject(taskId: string): string | undefined {
  return readTaskCache()[taskId];
}

/** Record a task's subject for future TaskUpdate events. */
function cacheTaskSubject(taskId: string, subject: string): void {
  const cache = readTaskCache();
  cache[taskId] = subject;
  writeTaskCache(cache);
}

/**
 * Extract the task subject from a TaskCreate tool response.
 * The response can be either:
 *   - structured: {task: {id, subject}}  (toolUseResult shape)
 *   - string: "Task #N created successfully: <subject>"  (tool_result content)
 *   - {stdout: "Task #N created successfully: <subject>"}  (Bash-shaped wrapper)
 */
function extractTaskCreateSubject(
  toolInput: Record<string, any>,
  rawResponse: unknown,
  outputText: string,
): { taskId: string; subject: string } | null {
  // 1. Structured response (best signal)
  if (typeof rawResponse === "object" && rawResponse !== null) {
    const resp = rawResponse as Record<string, unknown>;
    if (resp.task && typeof resp.task === "object") {
      const t = resp.task as Record<string, unknown>;
      if (typeof t.id === "string" && typeof t.subject === "string") {
        return { taskId: t.id, subject: t.subject };
      }
    }
    if (typeof resp.subject === "string" && typeof resp.taskId === "string") {
      return { taskId: resp.taskId, subject: resp.subject };
    }
  }
  // 2. Text response: "Task #N created successfully: <subject>"
  const textMatch = outputText.match(/Task\s+#(\S+)\s+created\s+successfully:\s*(.+)$/m);
  if (textMatch) {
    return { taskId: textMatch[1], subject: textMatch[2].trim() };
  }
  // 3. Fall back to tool_input if it carries the subject (TaskCreate usually does)
  if (typeof toolInput?.subject === "string" && toolInput.taskId) {
    return { taskId: String(toolInput.taskId), subject: toolInput.subject };
  }
  return null;
}

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
  } else if (input.tool_name === "TaskCreate") {
    // TaskCreate doesn't trigger a Slack event, but we DO cache the subject
    // so that when TaskUpdate status=completed fires later, we can report
    // the real subject instead of just the task ID.
    const extracted = extractTaskCreateSubject(input.tool_input || {}, input.tool_response, output);
    if (extracted) {
      cacheTaskSubject(extracted.taskId, extracted.subject);
    }
    return; // no Slack event for TaskCreate itself
  } else if (input.tool_name === "TaskUpdate") {
    event = detectTaskEvent(
      input.tool_input,
      output,
      input.tool_response,
      lookupTaskSubject,
    );
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

main().catch((err) => {
  process.stderr.write(`[claude-report] hook error: ${err instanceof Error ? err.message : err}\n`);
}).finally(() => process.exit(0));
