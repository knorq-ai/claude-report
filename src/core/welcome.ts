import { existsSync } from "node:fs";
import { join } from "node:path";
import slackPkg from "@slack/web-api";
const { WebClient } = slackPkg;
import { getDataDir } from "./config.js";
import { atomicWriteJson, withFileLock, LockTimeoutError } from "./fs-utils.js";
import { escapeSlackMrkdwn } from "./formatter.js";
import type { Config } from "./config.js";

const MARKER_FILE = "welcome-sent.json";

/**
 * Send a one-time welcome message when a user first starts using claude-report.
 * Idempotent and concurrent-safe — uses the marker file as a lock so two
 * simultaneous hook invocations don't each send a welcome.
 *
 * Contention handling: if another process holds the lock (actively sending a
 * welcome), we skip silently — the marker will be present on the next check.
 */
export async function sendWelcomeIfNeeded(config: Config): Promise<void> {
  const markerPath = join(getDataDir(), MARKER_FILE);

  // Fast-path check — no lock needed if marker already exists
  if (existsSync(markerPath)) return;

  // Need valid direct Slack credentials
  if (!config.slack.botToken || !config.slack.channel) return;

  // Claim-the-marker pattern: under the lock, re-check and write a placeholder
  // marker if we're first. Then send the Slack message (outside the lock,
  // because it's slow). If Slack fails, remove the placeholder so the next
  // run can retry.
  type ClaimResult = "already_sent" | "claimed" | "contention";
  let claim: ClaimResult;
  try {
    claim = withFileLock(markerPath, () => {
      if (existsSync(markerPath)) return "already_sent" as const;
      // Write a placeholder marker — present on disk so another waiter sees "sent"
      // and skips. We'll replace it with the real content on success.
      atomicWriteJson(markerPath, { sentAt: null, userName: null, pending: true });
      return "claimed" as const;
    });
  } catch (err) {
    if (err instanceof LockTimeoutError) return; // another writer is creating — skip
    throw err;
  }

  if (claim === "already_sent") return;

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

    // Replace placeholder with real marker
    atomicWriteJson(markerPath, {
      sentAt: new Date().toISOString(),
      userName,
    });
  } catch (err) {
    // Remove our placeholder so the next hook invocation retries.
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(markerPath);
    } catch { /* best-effort */ }
    console.error(
      `[claude-report] welcome message failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}
