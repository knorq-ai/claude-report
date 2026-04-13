/**
 * Slack API クライアント。
 * Cloudflare Worker 環境向けに fetch() のみを使用する。
 */

const SLACK_API_BASE = "https://slack.com/api";

export interface SlackPostMessageParams {
  channel: string;
  text: string;
  blocks?: object[];
  thread_ts?: string;
}

export interface SlackPostMessageResult {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
}

export interface SlackConversationsRepliesResult {
  ok: boolean;
  messages?: Array<{
    user?: string;
    text?: string;
    ts?: string;
  }>;
  error?: string;
}

export interface SlackPermalinkResult {
  ok: boolean;
  permalink?: string;
  error?: string;
}

/**
 * Slack API を直接呼び出すクライアント。
 * @slack/web-api は Node.js 依存のため使用しない。
 */
export class SlackClient {
  constructor(private botToken: string) {}

  /** chat.postMessage を呼び出す */
  async postMessage(
    params: SlackPostMessageParams,
  ): Promise<SlackPostMessageResult> {
    const body: Record<string, unknown> = {
      channel: params.channel,
      text: params.text,
    };
    if (params.blocks) {
      body.blocks = params.blocks;
    }
    if (params.thread_ts) {
      body.thread_ts = params.thread_ts;
    }

    return this.call<SlackPostMessageResult>("chat.postMessage", body);
  }

  /** conversations.replies を呼び出す */
  async conversationsReplies(
    channel: string,
    ts: string,
    oldest?: string,
    limit = 50,
  ): Promise<SlackConversationsRepliesResult> {
    const params = new URLSearchParams({
      channel,
      ts,
      limit: String(limit),
    });
    if (oldest) {
      params.set("oldest", oldest);
    }

    return this.callGet<SlackConversationsRepliesResult>(
      "conversations.replies",
      params,
    );
  }

  /** chat.getPermalink を呼び出す */
  async getPermalink(
    channel: string,
    messageTs: string,
  ): Promise<SlackPermalinkResult> {
    const params = new URLSearchParams({
      channel,
      message_ts: messageTs,
    });

    return this.callGet<SlackPermalinkResult>("chat.getPermalink", params);
  }

  /** POST リクエストを送信する */
  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Slack API HTTP error: ${res.status}`);
    }

    return res.json() as Promise<T>;
  }

  /** GET リクエストを送信する */
  private async callGet<T>(method: string, params: URLSearchParams): Promise<T> {
    const res = await fetch(`${SLACK_API_BASE}/${method}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${this.botToken}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Slack API HTTP error: ${res.status}`);
    }

    return res.json() as Promise<T>;
  }
}
