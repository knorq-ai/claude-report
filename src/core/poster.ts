import { WebClient } from "@slack/web-api";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLogDir } from "./config.js";
import { formatSlackBlocks, formatDailyParent, formatPlainText } from "./formatter.js";
import type { StatusUpdate, PostResult, StatusPoster } from "./types.js";

/**
 * Posts status updates via the hosted relay service.
 * Bot token never touches the developer's machine.
 */
export class RelayPoster implements StatusPoster {
  constructor(
    private relayUrl: string,
    private apiKey: string,
    private userName: string,
  ) {}

  async postUpdate(
    update: StatusUpdate,
    threadId?: string | null,
  ): Promise<PostResult> {
    const response = await fetch(`${this.relayUrl}/post`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        update: {
          ...update,
          timestamp: update.timestamp.toISOString(),
        },
        threadId: threadId || undefined,
        userName: this.userName,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Relay error ${response.status}: ${text}`);
    }

    const result = (await response.json()) as PostResult;
    if (!result.threadId || typeof result.threadId !== "string") {
      throw new Error("Relay returned invalid response: missing threadId");
    }
    return result;
  }
}

/**
 * Posts directly to Slack API (fallback for --direct mode).
 */
export class DirectSlackPoster implements StatusPoster {
  private client: WebClient;

  constructor(
    private botToken: string,
    private channel: string,
    private userName: string,
  ) {
    this.client = new WebClient(botToken, { timeout: 5000 });
  }

  async postUpdate(
    update: StatusUpdate,
    threadId?: string | null,
  ): Promise<PostResult> {
    // If no thread yet, create daily parent message
    if (!threadId) {
      const parent = formatDailyParent(
        this.userName,
        update.project,
        new Date().toISOString().slice(0, 10),
      );
      const parentResult = await this.client.chat.postMessage({
        channel: this.channel,
        text: parent.text,
        blocks: parent.blocks as any,
      });

      if (!parentResult.ts) {
        throw new Error("Slack did not return a message timestamp for the parent post");
      }
      threadId = parentResult.ts;
    }

    // Post the update as a thread reply
    const blocks = formatSlackBlocks(update, this.userName);
    const result = await this.client.chat.postMessage({
      channel: this.channel,
      thread_ts: threadId,
      text: update.summary,
      blocks: blocks as any,
    });

    return {
      threadId,
      channel: this.channel,
      permalink: result.ts
        ? `https://slack.com/archives/${this.channel}/p${result.ts.replace(".", "")}`
        : "",
    };
  }
}

/**
 * Logs updates to a file instead of posting to Slack.
 * Used for dry-run mode and testing.
 */
export class DryRunPoster implements StatusPoster {
  private logPath: string;
  private userName: string;

  constructor(userName: string, logDir?: string) {
    const dir = logDir || getLogDir();
    mkdirSync(dir, { recursive: true });
    this.logPath = join(dir, "dry-run.log");
    this.userName = userName;
  }

  async postUpdate(
    update: StatusUpdate,
    threadId?: string | null,
  ): Promise<PostResult> {
    const line = `[${new Date().toISOString()}] ${formatPlainText(update, this.userName)}\n`;
    appendFileSync(this.logPath, line, "utf-8");

    const fakeThreadId = threadId || `dry-run-${Date.now()}`;
    return {
      threadId: fakeThreadId,
      channel: "dry-run",
      permalink: `file://${this.logPath}`,
    };
  }
}
