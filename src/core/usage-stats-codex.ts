/**
 * Parse Codex CLI session JSONL files to aggregate token usage.
 *
 * Codex stores sessions at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 * One line per event. Schema is unversioned and shifts across CLI releases —
 * the parser tolerates unknown event types and missing fields.
 *
 * Differences from the Claude Code parser (src/core/usage-stats.ts):
 *   - Tokens come from `event_msg.token_count.info.total_token_usage` which is
 *     CUMULATIVE per session and sometimes repeats on no-op snapshots. We sum
 *     `max(0, total_now - total_prev)` instead of summing `last_token_usage`.
 *   - Cost: Codex uses subscription quota (`rate_limits.primary.used_percent`,
 *     `plan_type`), not per-token billing — `estimatedCostUsd` is always 0.
 *     The latest `rate_limits` snapshot bubbles up via `getCodexQuota`.
 *   - Sessions can span days and resumed sessions append to their original
 *     file, so we cannot key on date directories alone — we walk the whole
 *     tree and filter events by entry timestamp.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionUsage, DailyUsage, Activity } from "./usage-stats.js";

export interface CodexQuotaSnapshot {
  /** "plus", "pro", "free", etc. — verbatim from rate_limits.plan_type. */
  planType: string;
  /** rate_limits.primary.used_percent (rolling 5h window typically). */
  primaryPct: number | null;
  /** rate_limits.secondary.used_percent (rolling weekly window typically). */
  secondaryPct: number | null;
  /** ISO timestamp of the snapshot — latest seen across all sessions. */
  capturedAt: string;
}

function getCodexSessionsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

/**
 * Recursively collect all rollout JSONL files under the sessions root.
 * Filters by file mtime: keeps files modified on or after `date - 1 day`,
 * which catches sessions that span midnight. Cheap precheck — the per-event
 * timestamp filter inside `parseCodexSession` is the source of truth.
 */
async function collectCodexSessionFiles(
  root: string,
  date: string,
): Promise<string[]> {
  const cutoff = prevDate(date);
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
        try {
          const st = statSync(p);
          if (localDateString(st.mtime) >= cutoff) out.push(p);
        } catch { /* ignore */ }
      }
    }
  }

  await walk(root);
  return out;
}

/**
 * Walk all Codex sessions and aggregate usage for `date` (local TZ).
 */
export async function getCodexDailyUsage(date: string): Promise<DailyUsage> {
  const root = getCodexSessionsRoot();
  if (!existsSync(root)) return emptyUsage(date);

  const files = await collectCodexSessionFiles(root, date);

  const sessions: SessionUsage[] = [];
  let latestQuota: CodexQuotaSnapshot | null = null;

  for (const file of files) {
    const result = await parseCodexSession(file, date);
    if (result.usage) sessions.push(result.usage);
    if (result.quota && (!latestQuota || result.quota.capturedAt > latestQuota.capturedAt)) {
      latestQuota = result.quota;
    }
  }

  // Aggregate totals (cost stays 0 — quota is reported separately)
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    userMessages: 0,
    assistantTurns: 0,
    sessionCount: sessions.length,
  };
  for (const s of sessions) {
    totals.inputTokens += s.inputTokens;
    totals.outputTokens += s.outputTokens;
    totals.cacheReadTokens += s.cacheReadTokens;
    totals.cacheWriteTokens += s.cacheWriteTokens;
    totals.userMessages += s.userMessages;
    totals.assistantTurns += s.assistantTurns;
  }

  const activities = sessions
    .flatMap((s) => s.activities)
    .sort((a, b) => a.time.localeCompare(b.time));

  return {
    date,
    sessions,
    totals,
    estimatedCostUsd: 0,
    activities,
    codexQuota: latestQuota ?? undefined,
  };
}

interface ParseResult {
  usage: SessionUsage | null;
  quota: CodexQuotaSnapshot | null;
}

/**
 * Stream-parse one Codex session file. Stays memory-bounded even when a
 * `compacted` event blows past 10 MB — we read line-by-line and only retain
 * structured fields, not the original JSON text.
 *
 * Date filter: a session may span days, so per-event timestamps decide which
 * tokens/activities count toward `date`. Token deltas allocate to whichever
 * day the *current* snapshot's timestamp falls on (approximation — we don't
 * try to redistribute deltas spanning midnight).
 */
async function parseCodexSession(
  filePath: string,
  date: string,
): Promise<ParseResult> {
  const sessionId = filePath.split("/").pop()?.replace(".jsonl", "") || "unknown";

  let cwd: string | undefined;
  let model = "codex";
  let cliVersion = "";
  let startedAt = "";
  let lastActiveAt = "";

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let userMessages = 0;
  let assistantTurns = 0;
  const activities: Activity[] = [];

  // Token-delta state: total_tokens monotonic per session, sum max(0, delta).
  // Keep input/output/cached deltas in lockstep so they stay self-consistent.
  let prevTotal = 0;
  let prevInput = 0;
  let prevOutput = 0;
  let prevCacheRead = 0;

  let latestQuota: CodexQuotaSnapshot | null = null;

  const stream = createReadStream(filePath, { encoding: "utf-8" });
  // crlfDelay: Infinity treats CRLF and LF identically. Required for parsing
  // logs that may have been touched on Windows.
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // tolerate occasional truncation / non-JSON lines
      }

      const ts: string | undefined = entry.timestamp;
      const entryDate = ts ? localDateString(new Date(ts)) : null;

      // session_meta — captures cwd/model once per session. Always read it
      // even if the session_meta entry's date is outside `date`, so a session
      // that started yesterday but produced today's tokens still attributes
      // correctly.
      if (entry.type === "session_meta" && entry.payload) {
        if (!cwd && typeof entry.payload.cwd === "string") cwd = entry.payload.cwd;
        if (typeof entry.payload.model_provider === "string") {
          model = entry.payload.model_provider; // "openai" / "anthropic" / etc.
        }
        if (typeof entry.payload.cli_version === "string") {
          cliVersion = entry.payload.cli_version;
        }
        continue;
      }

      // turn_context — also carries cwd/model and may be more current than
      // session_meta (e.g. user `cd`'d mid-session). Prefer the latest.
      if (entry.type === "turn_context" && entry.payload) {
        if (typeof entry.payload.cwd === "string") cwd = entry.payload.cwd;
        if (typeof entry.payload.model === "string") model = entry.payload.model;
        continue;
      }

      // Only events on the target date count toward today's totals.
      if (entryDate !== date) continue;

      // event_msg subtypes
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
          // command is an array like ["/bin/zsh", "-lc", "git push origin main"]
          const cmdArr = entry.payload.command;
          const cmdText = Array.isArray(cmdArr) ? cmdArr.join(" ") : "";
          if (cmdText) extractBashActivities(cmdText, activities, ts || "");
          lastActiveAt = ts || lastActiveAt;
          continue;
        }

        if (sub === "patch_apply_end") {
          // Codex applied a patch — strong signal of "did real work". Try to
          // pull edited file paths from payload.changes / payload.files /
          // payload.patches (shape varies across CLI versions).
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
          // info can be null on the initial probe event — only `rate_limits`
          // is populated. Capture quota even if no usage delta yet.
          const info = entry.payload.info;
          if (info && typeof info.total_token_usage === "object" && info.total_token_usage) {
            const t = info.total_token_usage;
            const totalNow = numField(t.total_tokens);
            const inputNow = numField(t.input_tokens);
            const outputNow = numField(t.output_tokens);
            const cachedNow = numField(t.cached_input_tokens);

            // Only count when total advanced. Codex sometimes re-emits the
            // same snapshot on context-window pings — summing last_token_usage
            // would double-count those.
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
          // Capture rate_limits regardless of info presence.
          const rl = entry.payload.rate_limits;
          if (rl && ts) {
            const snapshot: CodexQuotaSnapshot = {
              planType: typeof rl.plan_type === "string" ? rl.plan_type : "unknown",
              primaryPct: pctField(rl.primary?.used_percent),
              secondaryPct: pctField(rl.secondary?.used_percent),
              capturedAt: ts,
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
    // readline doesn't reliably close the underlying stream on early returns.
    rl.close();
    stream.destroy();
  }

  // Skip sessions with no activity on the target date — keeps the daily list
  // free of yesterday's stale sessions whose mtime crept past midnight.
  if (assistantTurns === 0 && userMessages === 0 && inputTokens === 0 && outputTokens === 0) {
    return { usage: null, quota: latestQuota };
  }

  const project = cwd ? projectNameFromPath(cwd) : "codex/unknown";

  return {
    usage: {
      sessionId: sessionId.slice(-12), // Codex IDs are long; tail is more recognizable
      project,
      cwd,
      model: cliVersion ? `codex/${cliVersion}` : "codex",
      source: "codex",
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0, // Codex telemetry doesn't expose cache-creation
      userMessages,
      assistantTurns,
      startedAt,
      lastActiveAt,
      activities,
    },
    quota: latestQuota,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function numField(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function pctField(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Sanitize the first line of a user prompt for display in activity feeds. */
function sanitizePromptLine(text: string): string | null {
  if (!text) return null;
  const firstLine = text.split("\n")[0].trim();
  if (!firstLine || firstLine.length < 5) return null;
  if (firstLine.startsWith("<") || firstLine.startsWith("{")) return null;
  return firstLine.slice(0, 120);
}

/**
 * Extract file paths from a `patch_apply_end` payload. Schema varies across
 * Codex versions — try the shapes seen in the wild and tolerate missing keys.
 */
function extractPatchFiles(payload: any): string[] {
  const out = new Set<string>();
  const candidates: any[] = [];
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

/**
 * Detect git push / commit / PR / test runs from a Codex shell command.
 * Mirrors the Claude Code Bash hook regexes — kept inline (rather than
 * imported from src/hooks/post-tool-use.ts) so this module stays
 * dependency-free for testing.
 */
function extractBashActivities(cmd: string, activities: Activity[], ts: string): void {
  if (/git\s+commit/.test(cmd) && /-m/.test(cmd)) {
    let msg = "";
    const heredoc = cmd.match(/cat\s+<<'?EOF'?\n([\s\S]*?)\nEOF/);
    if (heredoc) {
      const lines = heredoc[1].trim().split("\n");
      msg = lines[0];
      if (lines.length > 1 && lines[1].trim()) msg += " — " + lines[1].trim();
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

function localDateString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function prevDate(date: string): string {
  const [y, m, d] = date.split("-").map((s) => Number.parseInt(s, 10));
  if (!y || !m || !d) return date;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return localDateString(dt);
}

function projectNameFromPath(cwd: string): string {
  const home = homedir();
  const relative = cwd.startsWith(home) ? cwd.slice(home.length + 1) : cwd;
  const segments = relative.split("/").filter(Boolean);
  if (segments.length <= 2) return segments.join("/") || cwd;
  return segments.slice(-2).join("/");
}

function emptyUsage(date: string): DailyUsage {
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
      sessionCount: 0,
    },
    estimatedCostUsd: 0,
    activities: [],
  };
}
