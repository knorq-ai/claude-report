import slackPkg from "@slack/web-api";
import type { WebClient as WebClientType } from "@slack/web-api";
const { WebClient, retryPolicies } = slackPkg;
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getLogDir } from "./config.js";
import { formatSlackBlocks, formatDailyParent, formatPlainText } from "./formatter.js";
import type { StatusUpdate, PostResult, StatusPoster } from "./types.js";

const RELAY_TIMEOUT_MS = 5000;
const RELAY_MAX_ATTEMPTS = 3;

/** Retry-eligible HTTP status codes for transient failures. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Posts status updates via the hosted relay service.
 * Bot token never touches the developer's machine.
 *
 * Retries transient failures (network errors, 429, 5xx) with exponential
 * backoff + jitter, honoring Retry-After when present.
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
    const body = JSON.stringify({
      update: {
        ...update,
        timestamp: update.timestamp.toISOString(),
      },
      threadId: threadId || undefined,
      userName: this.userName,
    });

    let lastErr: unknown;
    for (let attempt = 0; attempt < RELAY_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(`${this.relayUrl}/post`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
        });

        if (response.ok) {
          const result = (await response.json()) as Partial<PostResult>;
          if (!result.threadId || typeof result.threadId !== "string") {
            throw new Error("Relay returned invalid response: missing threadId");
          }
          if (result.permalink && !/^https:\/\//.test(result.permalink)) {
            throw new Error("Relay returned invalid permalink scheme");
          }
          return {
            threadId: result.threadId,
            channel: typeof result.channel === "string" ? result.channel : "",
            permalink: typeof result.permalink === "string" ? result.permalink : "",
          };
        }

        if (!RETRYABLE_STATUSES.has(response.status)) {
          const text = await response.text().catch(() => "");
          throw new Error(`Relay error ${response.status}: ${text.slice(0, 200)}`);
        }

        // Retryable 4xx/5xx — honor Retry-After if provided
        const retryAfter = response.headers.get("retry-after");
        const waitMs = computeBackoff(attempt, retryAfter);
        lastErr = new Error(`Relay ${response.status} (attempt ${attempt + 1})`);
        if (attempt < RELAY_MAX_ATTEMPTS - 1) await sleep(waitMs);
      } catch (err) {
        lastErr = err;
        // Abort/network errors — retry unless last attempt
        if (attempt < RELAY_MAX_ATTEMPTS - 1) {
          await sleep(computeBackoff(attempt, null));
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

/** Exponential backoff with jitter. Honors Retry-After header when present. */
function computeBackoff(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 10_000);
  }
  const base = 250 * 2 ** attempt; // 250ms, 500ms, 1000ms
  return base + Math.floor(Math.random() * base); // full jitter
}

/**
 * Posts directly to Slack API. @slack/web-api's WebClient has built-in
 * retries via retryConfig.
 */
export class DirectSlackPoster implements StatusPoster {
  private client: WebClientType;

  constructor(
    private botToken: string,
    private channel: string,
    private userName: string,
  ) {
    this.client = new WebClient(botToken, {
      timeout: RELAY_TIMEOUT_MS,
      retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
    });
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

    // threadId has been assigned above (either passed in or created). Assert for TS.
    return {
      threadId: threadId!,
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
  private logDirReady: Promise<void>;

  constructor(userName: string, logDir?: string) {
    const dir = logDir || getLogDir();
    this.logPath = join(dir, "dry-run.log");
    this.userName = userName;
    this.logDirReady = mkdir(dir, { recursive: true }).then(() => undefined);
  }

  async postUpdate(
    update: StatusUpdate,
    threadId?: string | null,
  ): Promise<PostResult> {
    await this.logDirReady;
    const line = `[${new Date().toISOString()}] ${formatPlainText(update, this.userName)}\n`;
    await appendFile(this.logPath, line, "utf-8");

    const fakeThreadId = threadId || `dry-run-${Date.now()}`;
    return {
      threadId: fakeThreadId,
      channel: "dry-run",
      permalink: `file://${this.logPath}`,
    };
  }
}
