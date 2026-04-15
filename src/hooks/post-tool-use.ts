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
  sendWelcomeIfNeeded,
} from "../core/index.js";
import type { UpdateType, UpdateMetadata } from "../core/index.js";

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
  tool_response?: string;
  /** Current working directory of the Claude Code session */
  cwd?: string;
  session_id?: string;
}

/** Get tool output from hook input — handles both field names */
function getToolOutput(input: HookInput): string {
  return input.tool_output || input.tool_response || "";
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
  // 1. Git push
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

  // 2. Git commit
  if (/\bgit\s+commit\b/.test(command) && !/--dry-run/.test(command)) {
    const msgMatch = output.match(/\]\s+(.+)/);
    if (msgMatch) {
      const commitMsg = msgMatch[1].trim().slice(0, 100);
      const branchMatch = output.match(/^\[([^\s\]]+)/);
      const branch = branchMatch ? branchMatch[1] : undefined;
      return {
        type: "status",
        summary: `Committed: ${commitMsg}`,
        metadata: branch ? { branch } : undefined,
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

  // 4. Test failures — require exit code as primary signal to avoid false positives
  if (isTestCommand(command)) {
    const hasExitError = /Exit code [1-9]|exit code [1-9]|exited with (?:code )?[1-9]/i.test(output);
    const hasFailCount = /(\d+)\s+(?:failed|failing)/i.test(output);
    // Only report if exit code indicates failure, or if there's an explicit failure count
    // (avoids false positives from words like "error" in passing test output)
    if (hasExitError || hasFailCount) {
      const failCount = output.match(/(\d+)\s+(?:failed|failing)/i);
      const summary = failCount
        ? `Tests failing: ${failCount[1]} failures`
        : "Tests failing";
      return {
        type: "blocker",
        summary,
      };
    }
  }

  return null;
}

export function detectTaskEvent(input: Record<string, any>, output: string): DetectedEvent | null {
  // TaskUpdate with status "completed"
  if (input.status === "completed" && input.taskId) {
    const parsed = parseTaskOutput(output);
    const subject = input.subject || parsed.subject || `#${input.taskId}`;
    return {
      type: "completion",
      summary: `Task completed: ${subject}`,
      details: parsed.description,
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
  const cmdMatch = command.match(/\bgit\s+push\s+\S+\s+(\S+)/);
  if (cmdMatch) {
    const ref = cmdMatch[1];
    return ref.includes(":") ? ref.split(":").pop()! : ref;
  }

  const outMatch = output.match(
    /(?:\[new branch\]|\w+\.\.\w+)\s+\S+\s+->\s+(\S+)/,
  );
  if (outMatch) return outMatch[1];

  const branchQuote = output.match(/branch\s+'([^']+)'/);
  if (branchQuote) return branchQuote[1];

  return "unknown";
}

function isTestCommand(command: string): boolean {
  return /\b(npm\s+test|npx\s+vitest|npx\s+jest|pytest|go\s+test|cargo\s+test|make\s+test|yarn\s+test|pnpm\s+test)\b/.test(command);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  const input: HookInput = JSON.parse(raw);

  // Detect event based on tool type
  const output = getToolOutput(input);
  let event: DetectedEvent | null = null;

  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command || "";
    event = detectBashEvent(command, output);
  } else if (input.tool_name === "TaskUpdate") {
    event = detectTaskEvent(input.tool_input, output);
  }

  if (!event) return;

  // Use cwd from hook input (tracks cd), fall back to process.cwd()
  const projectDir = input.cwd || process.cwd();
  const config = loadConfig(projectDir);

  if (!config.notifications.enabled) return;
  if (isProjectDisabled(projectDir)) return;
  if (!config.slack.botToken || !config.slack.channel) return;

  await sendWelcomeIfNeeded(config);

  const project = resolveProjectName(projectDir);
  const userId = resolveUserId(config);
  const userName = config.user.name || "Unknown";

  // Single daily thread per user (not per project)
  const session = getOrCreateSession(userId, "activity-log");

  const contentFilter = new ContentFilter();

  // Build compact log line: icon + project + summary
  const ICONS: Record<string, string> = {
    push: "\u{1f680}",       // rocket
    status: "\u{1f4dd}",     // memo
    completion: "\u{2705}",  // check
    blocker: "\u{1f6d1}",    // stop
    pivot: "\u{1f504}",      // arrows
  };
  const icon = ICONS[event.type] || "\u{1f535}";
  let logText = `\`${project}\` ${icon} ${event.summary}`;
  if (event.details) {
    logText += `\n  ${event.details}`;
  }

  // Sanitize
  const sanitized = contentFilter.filter({
    type: event.type,
    summary: logText,
    timestamp: new Date(),
    userId,
    sessionId: session.sessionId,
    project,
  });
  logText = sanitized.summary;

  try {
    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(config.slack.botToken, { timeout: 5000 });

    // Create daily parent if no threadId yet
    if (!session.threadId) {
      const today = localDateStr();
      const parent = await client.chat.postMessage({
        channel: config.slack.channel,
        text: `\u{1f4cb} ${userName} — ${today}`,
        blocks: [{
          type: "section",
          text: { type: "mrkdwn", text: `\u{1f4cb} *${userName}* — Activity Log (${today})` },
        }] as any,
      });
      if (parent.ts) {
        updateSessionForProject(userId, "activity-log", {
          threadId: parent.ts,
          lastPostAt: new Date().toISOString(),
          postCount: 1,
          dailyPostCount: 1,
          dailyPostDate: today,
        });
        session.threadId = parent.ts;
      }
    }

    // Post log entry as thread reply
    if (session.threadId) {
      await client.chat.postMessage({
        channel: config.slack.channel,
        thread_ts: session.threadId,
        text: logText,
      });

      updateSessionForProject(userId, "activity-log", {
        lastPostAt: new Date().toISOString(),
        postCount: session.postCount + 1,
      });
    }
  } catch (err) {
    console.error(`[claude-report] log failed: ${err instanceof Error ? err.message : err}`);
  }
}

main().catch((err) => {
  process.stderr.write(`[claude-report] hook error: ${err instanceof Error ? err.message : err}\n`);
}).finally(() => process.exit(0));
