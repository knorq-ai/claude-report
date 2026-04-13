import type { RateLimitConfig } from "./config.js";
import type { StatusUpdate, Session } from "./types.js";

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Rate limiter with:
 * - Minimum interval between posts (uses persisted session.lastPostAt for cross-process accuracy)
 * - Per-session cap
 * - Per-day cap
 * - In-process deduplication (similarity-based, only effective in long-running MCP server)
 */
export class RateLimiter {
  private lastPostSummary: { time: number; summary: string } | null = null;

  constructor(private config: RateLimitConfig) {}

  shouldPost(update: StatusUpdate, session: Session): RateLimitResult {
    // Bypass types are never rate-limited
    if (this.config.bypassTypes.includes(update.type)) {
      return { allowed: true };
    }

    // Check mute
    if (session.muted) {
      return { allowed: false, reason: "Session is muted" };
    }

    // Check per-session cap
    if (session.postCount >= this.config.maxPerSession) {
      return {
        allowed: false,
        reason: `Session cap reached (${this.config.maxPerSession} posts)`,
      };
    }

    // Check per-day cap
    if (session.dailyPostCount >= this.config.maxPerDay) {
      return {
        allowed: false,
        reason: `Daily cap reached (${this.config.maxPerDay} posts)`,
      };
    }

    // Check minimum interval — uses persisted session.lastPostAt (works across processes)
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

    // Check deduplication — in-process only (effective in MCP server's long-lived process)
    if (this.lastPostSummary) {
      const elapsed = Date.now() - this.lastPostSummary.time;
      if (elapsed < this.config.deduplicationWindowMs) {
        const similarity = tokenSimilarity(
          this.lastPostSummary.summary,
          update.summary,
        );
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

  /** Record that a post was made (call after successful post) */
  recordPost(update: StatusUpdate): void {
    this.lastPostSummary = {
      time: Date.now(),
      summary: update.summary,
    };
  }
}

/** Token-based similarity: |intersection| / |union| of whitespace-split tokens */
export function tokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));

  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  return intersection / union;
}
