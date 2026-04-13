/**
 * Claude Code hook: PostToolUse
 *
 * Deterministic event detection — fires on Bash and TaskUpdate tool calls.
 * Detects: git push, git commit, gh pr create, test failures, task completion.
 */

import {
  loadConfig,
  isProjectDisabled,
  createPoster,
  getOrCreateSession,
  updateSessionForProject,
  resolveProjectName,
  RateLimiter,
} from "../core/index.js";
import type { StatusUpdate, UpdateType } from "../core/index.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

interface HookInput {
  tool_name: string;
  tool_input: Record<string, any>;
  tool_output: string;
}

// ---------------------------------------------------------------------------
// Event detection: returns a status update or null
// ---------------------------------------------------------------------------

interface DetectedEvent {
  type: UpdateType;
  summary: string;
  details?: string;
  metadata?: Record<string, string>;
}

function detectBashEvent(command: string, output: string): DetectedEvent | null {
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

  // 4. Test failures — common test runners with non-zero exit
  if (isTestCommand(command)) {
    // Check for failure indicators in output
    const hasFail =
      /FAIL|failed|failing|error|Error/i.test(output) &&
      !/\b0 fail/i.test(output) &&
      !/\ball (?:tests? )?passed/i.test(output);
    // Also check exit code hint (Claude Code includes exit info in output)
    const hasExitError = /Exit code [1-9]|exit code [1-9]|exited with/i.test(output);
    if (hasFail || hasExitError) {
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

function detectTaskEvent(input: Record<string, any>): DetectedEvent | null {
  // TaskUpdate with status "completed"
  if (input.status === "completed" && input.taskId) {
    return {
      type: "completion",
      summary: `Task completed: ${input.subject || `#${input.taskId}`}`,
    };
  }
  return null;
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
  let event: DetectedEvent | null = null;

  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command || "";
    event = detectBashEvent(command, input.tool_output || "");
  } else if (input.tool_name === "TaskUpdate") {
    event = detectTaskEvent(input.tool_input);
  }

  if (!event) return;

  // Load config and check guards
  const projectDir = process.cwd();
  const config = loadConfig(projectDir);

  if (!config.notifications.enabled) return;
  if (isProjectDisabled(projectDir)) return;

  // Skip git push if onGitPush is false
  if (event.type === "push" && !config.notifications.onGitPush) return;

  const poster = createPoster(config, projectDir);
  if (!poster) return;

  const project = resolveProjectName(projectDir);
  const userId = config.user.slackUserId || config.user.name || "unknown";
  const session = getOrCreateSession(userId, project);

  const rateLimiter = new RateLimiter(config.rateLimit);
  const update: StatusUpdate = {
    type: event.type,
    summary: event.summary,
    details: event.details,
    metadata: event.metadata as any,
    timestamp: new Date(),
    userId,
    sessionId: session.sessionId,
    project,
  };

  const rateResult = rateLimiter.shouldPost(update, session);
  if (!rateResult.allowed) return;

  try {
    const result = await poster.postUpdate(update, session.threadId);

    const today = new Date().toISOString().slice(0, 10);
    const dailyPostCount =
      session.dailyPostDate === today ? session.dailyPostCount + 1 : 1;

    updateSessionForProject(userId, project, {
      threadId: result.threadId,
      lastPostAt: new Date().toISOString(),
      postCount: session.postCount + 1,
      dailyPostCount,
      dailyPostDate: today,
    });
  } catch (err) {
    console.error(`[claude-report] post failed: ${err instanceof Error ? err.message : err}`);
  }
}

main().catch(() => {}).finally(() => process.exit(0));
