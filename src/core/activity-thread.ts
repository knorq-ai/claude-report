/**
 * Slack daily-thread machinery — shared between the Claude Code PostToolUse
 * hook (short-lived subprocess, one per tool call) and the Codex watcher
 * daemon (long-lived process). Both append to a single per-user daily thread,
 * so the parent-message creation + session-state writes must coordinate
 * across processes via the file lock + claim-marker dance below.
 *
 * Extracted from src/hooks/post-tool-use.ts unchanged; the post-tool-use hook
 * now imports these helpers from here.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { withFileLock } from "./fs-utils.js";
import { atomicWriteJson } from "./fs-utils.js";
import { getStateDir } from "./config.js";
import { updateSessionForProject } from "./session.js";

/** Post to Slack using raw fetch — no external dependencies needed. */
export async function slackPost(
  token: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; ts?: string }> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return res.json() as Promise<{ ok: boolean; ts?: string }>;
}

/** YYYY-MM-DD in the local timezone. */
export function localDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Claim markers — protect the parent-thread POST from split-brain across
// concurrent hook subprocesses (and now the watcher daemon too).
// ---------------------------------------------------------------------------

const CLAIM_PREFIX = "__claiming__";
const CLAIM_STALE_MS = 60_000;

function makeClaim(): string {
  return `${CLAIM_PREFIX}:${process.pid}:${Date.now()}`;
}

/**
 * Parse a claim marker. Returns null if the string is not a claim marker or
 * is malformed. Returns `{stale: true}` if the owner is dead or the claim is
 * older than CLAIM_STALE_MS — callers should treat this as "claim is free".
 */
function parseClaim(threadId: string | null): { stale: boolean } | null {
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
  } catch (err: any) {
    if (err?.code === "ESRCH") return { stale: true };
    return { stale: false }; // EPERM — owned by another user; assume alive
  }
}

/** Path to the activity-log session file for a user. Mirrors session.ts. */
export function sessionFilePathFor(userId: string): string {
  const hash = createHash("sha256")
    .update(`${userId}:activity-log`)
    .digest("hex")
    .slice(0, 12);
  return join(getStateDir(), `session-${hash}.json`);
}

function readSessionJson(userId: string): { threadId: string | null; dailyPostDate?: string } | null {
  const filePath = sessionFilePathFor(userId);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Lock-free read-modify-write of the activity-log session file. MUST be
 * called only from inside a withFileLock block on the same file — otherwise
 * it races. Used to avoid re-entering the lock via updateSessionForProject
 * (the mkdir-based lock is non-reentrant).
 */
function writeSessionFieldsInLock(userId: string, updates: Record<string, unknown>): void {
  const path = sessionFilePathFor(userId);
  if (!existsSync(path)) return;
  try {
    const session = JSON.parse(readFileSync(path, "utf-8"));
    Object.assign(session, updates, { lastActiveAt: new Date().toISOString() });
    atomicWriteJson(path, session);
  } catch { /* best-effort */ }
}

/**
 * Release OUR claim so the next caller can retry. Only clears if the current
 * threadId is still our specific claim marker — otherwise someone else may
 * have legitimately taken over.
 */
function releaseClaim(userId: string, myClaim: string): void {
  try {
    withFileLock(sessionFilePathFor(userId), () => {
      const cur = readSessionJson(userId);
      if (cur?.threadId === myClaim) {
        writeSessionFieldsInLock(userId, { threadId: null });
      }
    });
  } catch { /* best-effort */ }
}

/**
 * Claim-or-read the daily parent threadId. Algorithm:
 *   - Real threadId already present → reuse
 *   - Live claim marker → wait/poll, possibly steal if stale
 *   - Null or stale marker → claim, POST parent, commit
 */
export async function acquireThreadId(
  userId: string,
  existingThreadId: string | null,
  botToken: string,
  channel: string,
  safeUserName: string,
  today: string,
): Promise<string | null> {
  // Day rollover: a threadId set on a previous day must NOT be reused —
  // otherwise local-midnight events keep appending to yesterday's parent.
  // We re-read the session because `existingThreadId` is a caller snapshot
  // that can be hours stale in the long-lived watcher.
  const fresh = readSessionJson(userId);
  if (fresh?.dailyPostDate && fresh.dailyPostDate !== today) {
    existingThreadId = null;
  }

  if (existingThreadId && parseClaim(existingThreadId) === null) return existingThreadId;

  type State = "reuse" | "claimed" | "wait";
  const myClaim = makeClaim();

  const claim: { state: State; existing?: string } = withFileLock(
    sessionFilePathFor(userId),
    () => {
      const cur = readSessionJson(userId);
      if (!cur) return { state: "claimed" as State };

      // Same day-rollover check inside the lock so we don't reuse yesterday's
      // thread on the slow path either.
      if (cur.dailyPostDate && cur.dailyPostDate !== today) {
        const claimInfo2 = parseClaim(cur.threadId);
        if (claimInfo2 === null || claimInfo2.stale) {
          writeSessionFieldsInLock(userId, { threadId: myClaim });
          return { state: "claimed" as State };
        }
        return { state: "wait" as State };
      }

      const claimInfo = parseClaim(cur.threadId);
      if (cur.threadId && claimInfo === null) {
        return { state: "reuse" as State, existing: cur.threadId };
      }
      if (claimInfo && !claimInfo.stale) {
        return { state: "wait" as State };
      }
      writeSessionFieldsInLock(userId, { threadId: myClaim });
      return { state: "claimed" as State };
    },
  );

  if (claim.state === "reuse") return claim.existing!;

  if (claim.state === "wait") {
    const WAIT_POLL_MS = 150;
    const WAIT_MAX_ATTEMPTS = 20;
    for (let i = 0; i < WAIT_MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
      const cur = readSessionJson(userId);
      if (!cur) continue;
      const info = parseClaim(cur.threadId);
      if (cur.threadId && info === null) return cur.threadId;
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

  // We claimed — POST the parent, then commit the real threadId.
  try {
    const parent = await slackPost(botToken, {
      channel,
      text: `\u{1f4cb} ${safeUserName} — ${today}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `\u{1f4cb} *${safeUserName}* — Activity Log (${today})`,
          },
        },
      ],
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

export const ACTIVITY_EVENT_ICONS: Record<string, string> = {
  push: "\u{1f680}",       // rocket
  status: "\u{1f4dd}",     // memo
  completion: "\u{2705}",  // check
  blocker: "\u{1f6d1}",    // stop
  pivot: "\u{1f504}",      // arrows
  edit: "\u{270f}\u{fe0f}", // pencil
};
