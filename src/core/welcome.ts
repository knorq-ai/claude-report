import { existsSync } from "node:fs";
import { join } from "node:path";
import { WebClient } from "@slack/web-api";
import { getDataDir } from "./config.js";
import { atomicWriteJson } from "./fs-utils.js";
import { escapeSlackMrkdwn } from "./formatter.js";
import type { Config } from "./config.js";

const MARKER_FILE = "welcome-sent.json";

/**
 * Send a one-time welcome message when a user first starts using claude-report.
 * Idempotent — writes a marker file after the first successful post.
 */
export async function sendWelcomeIfNeeded(config: Config): Promise<void> {
  const markerPath = join(getDataDir(), MARKER_FILE);
  if (existsSync(markerPath)) return;

  // Need valid direct Slack credentials
  if (!config.slack.botToken || !config.slack.channel) return;

  const userName = config.user.name || "Someone";
  const safeName = escapeSlackMrkdwn(userName);

  const client = new WebClient(config.slack.botToken, { timeout: 5000 });

  try {
    await client.chat.postMessage({
      channel: config.slack.channel,
      text: `\u{1f44b} ${safeName} started using claude-report`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `\u{1f44b} *${safeName}* started using claude-report`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "Dev status updates will appear in this channel automatically.",
            },
          ],
        },
      ],
    });

    atomicWriteJson(markerPath, {
      sentAt: new Date().toISOString(),
      userName,
    });
  } catch (err) {
    console.error(
      `[claude-report] welcome message failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}
