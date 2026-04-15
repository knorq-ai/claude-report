/**
 * Parse Claude Code transcript JSONL files to aggregate token usage.
 * Transcripts live at ~/.claude/projects/{project-slug}/{session-id}.jsonl
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { escapeSlackMrkdwn } from "./formatter.js";

export interface Activity {
  type: "prompt" | "commit" | "push" | "pr" | "test" | "edit";
  text: string;
  time: string;
}

export interface SessionUsage {
  sessionId: string;
  project: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Number of user prompts sent */
  userMessages: number;
  /** Number of assistant responses (includes tool calls) */
  assistantTurns: number;
  startedAt: string;
  lastActiveAt: string;
  /** Key activities extracted from the session */
  activities: Activity[];
}

export interface DailyUsage {
  date: string;
  sessions: SessionUsage[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    userMessages: number;
    assistantTurns: number;
    sessionCount: number;
  };
  estimatedCostUsd: number;
  /** Aggregated key activities across all sessions */
  activities: Activity[];
}

// Approximate pricing (public rates, may change)
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-4-6":   { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-6": { input: 3,  output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5":  { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};
const DEFAULT_PRICING = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function getProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/**
 * Scan all transcript files and aggregate usage for a given date.
 */
export function getDailyUsage(date: string): DailyUsage {
  const projectsDir = getProjectsDir();
  const sessions: SessionUsage[] = [];

  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return emptyUsage(date);
  }

  for (const dir of dirs) {
    const dirPath = join(projectsDir, dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch { continue; }

    // Project name will be derived per-transcript from the cwd field
    const fallbackProject = dir;

    let files: string[];
    try {
      files = readdirSync(dirPath).filter(f => f.endsWith(".jsonl"));
    } catch { continue; }

    for (const file of files) {
      const filePath = join(dirPath, file);
      try {
        const stat = statSync(filePath);
        const fileDate = localDateString(stat.mtime);

        // Only process files modified on the target date (or within 1 day for spanning sessions)
        if (fileDate < date && fileDate < prevDate(date)) continue;

        const cwd = extractCwdFromTranscript(filePath);
        const project = cwd ? projectNameFromPath(cwd) : fallbackProject;
        const usage = parseTranscript(filePath, date, project);
        if (usage && usage.assistantTurns > 0) {
          sessions.push(usage);
        }
      } catch { continue; }
    }
  }

  // Aggregate totals
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    userMessages: 0,
    assistantTurns: 0,
    sessionCount: sessions.length,
  };

  let estimatedCostUsd = 0;

  for (const s of sessions) {
    totals.inputTokens += s.inputTokens;
    totals.outputTokens += s.outputTokens;
    totals.cacheReadTokens += s.cacheReadTokens;
    totals.cacheWriteTokens += s.cacheWriteTokens;
    totals.userMessages += s.userMessages;
    totals.assistantTurns += s.assistantTurns;

    const pricing = findPricing(s.model);
    estimatedCostUsd +=
      (s.inputTokens / 1_000_000) * pricing.input +
      (s.outputTokens / 1_000_000) * pricing.output +
      (s.cacheReadTokens / 1_000_000) * pricing.cacheRead +
      (s.cacheWriteTokens / 1_000_000) * pricing.cacheWrite;
  }

  // Aggregate activities across all sessions, sorted by time
  const activities = sessions
    .flatMap(s => s.activities)
    .sort((a, b) => a.time.localeCompare(b.time));

  return { date, sessions, totals, estimatedCostUsd, activities };
}

function parseTranscript(filePath: string, date: string, project: string): SessionUsage | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch { return null; }

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
  const activities: Activity[] = [];

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch { continue; }

    // Filter by date using the entry timestamp (local timezone, not UTC)
    const ts = entry.timestamp;
    const entryDate = ts ? localDateString(new Date(ts)) : null;
    const timeStr = ts ? new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) : "";

    // Count real user prompts (exclude tool_result messages which the API sends as role:user)
    if (entry.type === "user" && entryDate === date) {
      const msgContent = entry.message?.content;
      const isToolResult = Array.isArray(msgContent) && msgContent.some((c: any) => c.type === "tool_result");
      if (!isToolResult) {
        userMessages++;
        if (!startedAt) startedAt = ts;
        lastActiveAt = ts;
        // Extract first line of user prompt as activity
        const promptText = extractUserPromptText(msgContent);
        if (promptText && activities.filter(a => a.type === "prompt").length < 10) {
          activities.push({ type: "prompt", text: promptText, time: ts });
        }
      }
      continue;
    }

    // Check assistant tool_use for Bash commands and file edits
    if (entry.type === "assistant" && entryDate === date) {
      const msgContent = entry.message?.content;
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block.type === "tool_use" && block.name === "Bash") {
            const cmd = block.input?.command || "";
            extractBashActivities(cmd, activities, ts);
          }
          // Track edited/written files
          if (block.type === "tool_use" && (block.name === "Edit" || block.name === "Write")) {
            const filePath = block.input?.file_path || block.input?.path || "";
            if (filePath) {
              activities.push({ type: "edit", text: filePath, time: ts });
            }
          }
        }
      }
    }

    // Count assistant messages with usage data
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
    activities,
  };
}

/** Extract first line of a user prompt as readable text */
function extractUserPromptText(content: any): string | null {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const textPart = content.find((c: any) => c.type === "text");
    text = textPart?.text || "";
  }
  if (!text) return null;
  // Take first line, strip leading slash commands/whitespace, truncate
  const firstLine = text.split("\n")[0].trim();
  if (!firstLine || firstLine.length < 5) return null;
  // Skip system-injected messages
  if (firstLine.startsWith("<") || firstLine.startsWith("{")) return null;
  return firstLine.slice(0, 120);
}

/** Extract key activities from bash commands */
function extractBashActivities(cmd: string, activities: Activity[], ts: string): void {
  // Git commit — handle heredoc pattern: git commit -m "$(cat <<'EOF'\n...\nEOF\n)"
  if (/git\s+commit/.test(cmd) && /-m/.test(cmd)) {
    let msg = "";
    // Heredoc pattern (most common with Claude Code)
    const heredocMatch = cmd.match(/cat\s+<<'?EOF'?\n([\s\S]*?)\nEOF/);
    if (heredocMatch) {
      // Take first 2 lines of the commit message (title + first detail line)
      const lines = heredocMatch[1].trim().split("\n");
      msg = lines[0];
      if (lines.length > 1 && lines[1].trim()) {
        msg += " — " + lines[1].trim();
      }
    } else {
      // Simple -m 'message' or -m "message"
      const simpleMatch = cmd.match(/-m\s+['"](.+?)['"]/);
      if (simpleMatch) msg = simpleMatch[1];
    }
    msg = msg.slice(0, 150);
    if (msg) activities.push({ type: "commit", text: msg, time: ts });
    return;
  }

  // Git push
  if (/\bgit\s+push\b/.test(cmd) && !/--dry-run/.test(cmd)) {
    const branchMatch = cmd.match(/git\s+push\s+\S+\s+(\S+)/);
    const branch = branchMatch ? branchMatch[1] : "branch";
    activities.push({ type: "push", text: `Pushed to ${branch}`, time: ts });
    return;
  }

  // PR create
  if (/\bgh\s+pr\s+create\b/.test(cmd)) {
    const titleMatch = cmd.match(/--title\s+['"](.+?)['"]/);
    const title = titleMatch ? titleMatch[1] : "new PR";
    activities.push({ type: "pr", text: `PR: ${title}`, time: ts });
    return;
  }

  // Test runs
  if (/\b(npm\s+test|npx\s+vitest|npx\s+jest|pytest|cargo\s+test|go\s+test)\b/.test(cmd)) {
    activities.push({ type: "test", text: "Ran tests", time: ts });
  }
}

/** Extract the real cwd from the first user/assistant entry in a transcript */
function extractCwdFromTranscript(filePath: string): string | null {
  try {
    const fd = readFileSync(filePath, "utf-8");
    // Only scan first 50 lines for performance
    const lines = fd.split("\n", 50);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.cwd && typeof entry.cwd === "string") return entry.cwd;
      } catch { continue; }
    }
  } catch { /* ignore */ }
  return null;
}

/** Format a Date as YYYY-MM-DD in the local timezone */
function localDateString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Derive a readable project name from an absolute path */
function projectNameFromPath(cwd: string): string {
  const home = homedir();
  const relative = cwd.startsWith(home) ? cwd.slice(home.length + 1) : cwd;
  const segments = relative.split("/").filter(Boolean);
  if (segments.length <= 2) return segments.join("/") || cwd;
  return segments.slice(-2).join("/");
}

function prevDate(date: string): string {
  const d = new Date(date);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function findPricing(model: string) {
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.includes(key)) return pricing;
  }
  return DEFAULT_PRICING;
}

function emptyUsage(date: string): DailyUsage {
  return {
    date,
    sessions: [],
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, userMessages: 0, assistantTurns: 0, sessionCount: 0 },
    estimatedCostUsd: 0,
    activities: [],
  };
}

/**
 * Format daily usage as Slack blocks.
 */
export function formatUsageSlackBlocks(usage: DailyUsage, userName: string): { text: string; blocks: object[] } {
  const { totals, estimatedCostUsd, sessions } = usage;
  const totalTokens = totals.inputTokens + totals.outputTokens;

  const safeName = escapeSlackMrkdwn(userName);
  const text = `\u{1f4ca} ${safeName} — Usage ${usage.date}: ${formatTokenCount(totalTokens)} tokens, ~$${estimatedCostUsd.toFixed(2)}`;

  const blocks: object[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\u{1f4ca} *${safeName}* — Usage Summary (${usage.date})`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Sessions:* ${totals.sessionCount}` },
        { type: "mrkdwn", text: `*Prompts:* ${totals.userMessages}` },
        { type: "mrkdwn", text: `*Claude turns:* ${totals.assistantTurns}` },
        { type: "mrkdwn", text: `*Input:* ${formatTokenCount(totals.inputTokens)}` },
        { type: "mrkdwn", text: `*Output:* ${formatTokenCount(totals.outputTokens)}` },
        { type: "mrkdwn", text: `*Est. cost:* $${estimatedCostUsd.toFixed(2)}` },
      ],
    },
  ];

  // Per-project breakdown if multiple projects
  if (sessions.length > 1) {
    const byProject = new Map<string, { tokens: number; prompts: number; turns: number }>();
    for (const s of sessions) {
      const existing = byProject.get(s.project) || { tokens: 0, prompts: 0, turns: 0 };
      existing.tokens += s.inputTokens + s.outputTokens;
      existing.prompts += s.userMessages;
      existing.turns += s.assistantTurns;
      byProject.set(s.project, existing);
    }

    const projectLines = [...byProject.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([p, v]) => `\`${p}\` — ${v.prompts} prompts, ${formatTokenCount(v.tokens)} tokens`)
      .join("\n");

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*By project:*\n${projectLines}` },
    });
  }

  // Project summaries — injected by the caller (MCP tool asks Claude to generate these)
  // The formatUsageSlackBlocks function only handles the stats part.
  // Summaries are appended by the MCP tool after Claude generates them.

  return { text, blocks };
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Get per-project context snippets for LLM summarization.
 * Returns a compact text block per project with sampled user prompts + commit messages.
 * Designed to be passed to Claude for summary generation.
 */
export function getProjectSnippets(usage: DailyUsage): string {
  const byProject = new Map<string, {
    prompts: string[]; commits: string[]; pushes: string[];
    prs: string[]; files: Set<string>;
  }>();

  for (const s of usage.sessions) {
    const existing = byProject.get(s.project) || {
      prompts: [], commits: [], pushes: [], prs: [], files: new Set<string>(),
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
        // Store relative file path (last 3 segments)
        const parts = a.text.split("/");
        const short = parts.length > 3 ? parts.slice(-3).join("/") : a.text;
        existing.files.add(short);
      }
    }
    byProject.set(s.project, existing);
  }

  const sections: string[] = [];
  for (const [project, data] of byProject) {
    const lines: string[] = [`## ${project}`];
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
