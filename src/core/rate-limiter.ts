import type { RateLimitConfig } from "./config.js";
import type { StatusUpdate, Session } from "./types.js";

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

/** Bounded LRU-ish cache entries for per-user dedup in long-lived processes. */
const MAX_DEDUP_ENTRIES = 100;

/**
 * Rate limiter. All state either:
 *   - comes from the persisted `Session` (cross-process: threadId, postCount,
 *     dailyPostCount, lastPostAt, muted, lastPostSummary)
 *   - or is held in-memory on this instance (only meaningful in long-lived
 *     processes like the MCP server)
 *
 * This means the short-lived hook subprocess gets dedup too, because dedup
 * reads `session.lastPostSummary` + `session.lastPostAt` (both persisted).
 *
 * Mute always wins — even bypassTypes honor the mute. `bypassTypes` only
 * exempts from interval/session/daily caps, not from mute or dedup.
 */
export class RateLimiter {
  /** userId → last summary + timestamp. In-memory, bounded. Only useful in MCP server. */
  private lastPostByUser = new Map<string, { time: number; summary: string }>();

  constructor(private config: RateLimitConfig) {}

  shouldPost(update: StatusUpdate, session: Session): RateLimitResult {
    // Mute always wins — a muted user should not post regardless of type
    if (session.muted) {
      return { allowed: false, reason: "Session is muted" };
    }

    const isBypass = this.config.bypassTypes.includes(update.type);

    if (!isBypass) {
      // Per-session cap
      if (session.postCount >= this.config.maxPerSession) {
        return {
          allowed: false,
          reason: `Session cap reached (${this.config.maxPerSession} posts)`,
        };
      }

      // Per-day cap
      if (session.dailyPostCount >= this.config.maxPerDay) {
        return {
          allowed: false,
          reason: `Daily cap reached (${this.config.maxPerDay} posts)`,
        };
      }

      // Minimum interval — persisted in session.lastPostAt (works across processes)
      if (session.lastPostAt) {
        const elapsed = Date.now() - new Date(session.lastPostAt).getTime();
        if (elapsed < this.config.minIntervalMs) {
          const waitSec = Math.ceil(
            (this.config.minIntervalMs - elapsed) / 1000,
          );
          return {
            allowed: false,
            reason: `Rate limited: wait ${waitSec}s before next update`,
          };
        }
      }
    }

    // Deduplication — always applied, including bypass types (prevents blocker spam loops).
    // Source the comparison pair from the most recent signal available:
    //   - in-memory (MCP server, this same process) takes precedence
    //   - falls back to persisted session fields (works for short-lived hooks)
    const userKey = update.userId || "unknown";
    const memory = this.lastPostByUser.get(userKey);
    let lastSummary: string | null = null;
    let lastTime: number | null = null;

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
            reason: "Duplicate: too similar to recent post",
          };
        }
      }
    }

    return { allowed: true };
  }

  /** Record that a post was made (call after successful post). */
  recordPost(update: StatusUpdate): void {
    const userKey = update.userId || "unknown";
    // Bound cache size by evicting oldest entry
    if (
      !this.lastPostByUser.has(userKey) &&
      this.lastPostByUser.size >= MAX_DEDUP_ENTRIES
    ) {
      const firstKey = this.lastPostByUser.keys().next().value;
      if (firstKey !== undefined) this.lastPostByUser.delete(firstKey);
    }
    this.lastPostByUser.set(userKey, {
      time: Date.now(),
      summary: update.summary,
    });
  }
}

/** Token-based Jaccard similarity. Normalizes whitespace and punctuation. */
export function tokenSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[\s,.;:!?()[\]{}<>"'`]+/)
        .filter(Boolean),
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
