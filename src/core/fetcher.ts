import { WebClient } from "@slack/web-api";
import type { Reply, ReplyFetcher } from "./types.js";

/**
 * Fetches thread replies via the hosted relay service.
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
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(2000),
      },
    );

    if (!response.ok) return [];

    const data = (await response.json()) as Array<{
      author: string;
      text: string;
      timestamp: string;
    }>;

    return data.map((r) => ({
      author: r.author,
      text: r.text,
      timestamp: new Date(r.timestamp),
    }));
  }
}

/**
 * Fetches thread replies directly from Slack API (fallback for --direct mode).
 */
export class DirectSlackFetcher implements ReplyFetcher {
  private client: WebClient;
  private channel: string;

  constructor(botToken: string, channel: string) {
    this.client = new WebClient(botToken);
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
      timestamp: new Date(Number(msg.ts) * 1000),
    }));
  }
}
