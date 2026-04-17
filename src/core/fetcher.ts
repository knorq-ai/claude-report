import slackPkg from "@slack/web-api";
import type { WebClient as WebClientType } from "@slack/web-api";
const { WebClient, retryPolicies } = slackPkg;
import type { Reply, ReplyFetcher } from "./types.js";

const FETCH_TIMEOUT_MS = 5000;

/**
 * Error classes exposed so callers can distinguish transient failures
 * (worth retrying silently) from terminal ones (auth revoked — surface to user).
 */
export class FetchAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchAuthError";
  }
}

export class FetchTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchTransientError";
  }
}

/**
 * Fetches thread replies via the hosted relay service.
 *
 * Distinguishes auth failures (401/403) from transient failures (429/5xx).
 * Returns [] only on 404 (thread not found). Other errors throw so the
 * caller can decide whether to alert the user.
 */
export class RelayFetcher implements ReplyFetcher {
  constructor(
    private relayUrl: string,
    private apiKey: string,
  ) {}

  async fetchReplies(threadId: string, since?: Date): Promise<Reply[]> {
    const params = new URLSearchParams({ threadId });
    if (since) {
      params.set("since", since.toISOString());
    }

    const response = await fetch(
      `${this.relayUrl}/replies?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );

    if (response.status === 404) return [];
    if (response.status === 401 || response.status === 403) {
      throw new FetchAuthError(`Relay auth failed: ${response.status}`);
    }
    if (!response.ok) {
      throw new FetchTransientError(`Relay error ${response.status}`);
    }

    const data = (await response.json()) as Array<{
      author: string;
      text: string;
      timestamp: string;
    }>;

    if (!Array.isArray(data)) return [];
    return data
      .filter((r) => r && typeof r.text === "string" && typeof r.author === "string")
      .map((r) => ({
        author: r.author,
        text: r.text,
        timestamp: safeDate(r.timestamp),
      }));
  }
}

/** Parse Slack/ISO timestamp, falling back to `new Date(0)` on garbage. */
function safeDate(value: unknown): Date {
  if (typeof value !== "string") return new Date(0);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

/**
 * Fetches thread replies directly from Slack API (fallback for --direct mode).
 */
export class DirectSlackFetcher implements ReplyFetcher {
  private client: WebClientType;
  private channel: string;

  constructor(botToken: string, channel: string) {
    this.client = new WebClient(botToken, {
      timeout: FETCH_TIMEOUT_MS,
      retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
    });
    this.channel = channel;
  }

  async fetchReplies(threadId: string, since?: Date): Promise<Reply[]> {
    const channel = this.channel;
    const oldest = since ? (since.getTime() / 1000).toFixed(6) : undefined;

    const result = await this.client.conversations.replies({
      channel,
      ts: threadId,
      limit: 50,
      ...(oldest ? { oldest } : {}),
    });

    if (!result.messages || result.messages.length <= 1) return [];

    // Skip the parent message (first entry)
    return result.messages.slice(1).map((msg) => ({
      author: msg.user || "unknown",
      text: msg.text || "",
      timestamp: slackTsToDate(msg.ts),
    }));
  }
}

function slackTsToDate(ts: string | undefined): Date {
  if (!ts) return new Date(0);
  const num = Number(ts);
  if (!Number.isFinite(num)) return new Date(0);
  return new Date(num * 1000);
}
