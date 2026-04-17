import type { RateLimitConfig } from "./config.js";
import type { StatusUpdate, Session } from "./types.js";

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

/** Bounded LRU-ish cache entries for per-user dedup. */
const MAX_DEDUP_ENTRIES = 100;

/**
 * Rate limiter with:
 * - Minimum interval between posts (uses persisted session.lastPostAt for cross-process accuracy)
 * - Per-session cap
 * - Per-day cap
 * - In-process deduplication keyed by userId (prevents cross-user dedup in MCP server)
 *
 * Mute always wins — even bypassTypes honor the mute. `bypassTypes` only
 * exempts from interval/session/daily caps, not from mute.
 */
export class RateLimiter {
  /** userId → last summary + timestamp. Bounded to prevent unbounded growth. */
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
    // Keyed by userId so concurrent sessions from different users don't shadow each other.
    const userKey = update.userId || "unknown";
    const last = this.lastPostByUser.get(userKey);
    if (last) {
      const elapsed = Date.now() - last.time;
      if (elapsed < this.config.deduplicationWindowMs) {
        const similarity = tokenSimilarity(last.summary, update.summary);
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
