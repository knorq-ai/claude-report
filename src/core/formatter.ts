import type { StatusUpdate } from "./types.js";

/** Escape Slack mrkdwn special characters to prevent injection */
function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const TYPE_INDICATORS: Record<string, string> = {
  status: "\u{1f535}", // blue circle
  blocker: "\u{1f534}", // red circle
  completion: "\u{1f7e2}", // green circle
  pivot: "\u{1f7e1}", // yellow circle
  push: "\u{1f7e2}", // green circle
};

const TYPE_LABELS: Record<string, string> = {
  status: "Status",
  blocker: "Blocker",
  completion: "Completed",
  pivot: "Pivot",
  push: "Pushed",
};

/**
 * Format a status update as Slack Block Kit blocks.
 */
export function formatSlackBlocks(
  update: StatusUpdate,
  userName: string,
): object[] {
  const indicator = TYPE_INDICATORS[update.type] || "\u{1f535}";
  const label = TYPE_LABELS[update.type] || "Update";
  const time = new Date(update.timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const blocks: object[] = [];

  // Main content
  let text = `${indicator} *${label}:* ${escapeSlackMrkdwn(update.summary)}`;
  if (update.details) {
    text += `\n${escapeSlackMrkdwn(update.details)}`;
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text },
  });

  // Context line with metadata
  const contextElements: string[] = [];
  if (update.metadata?.branch) {
    contextElements.push(`\u{1f33f} \`${escapeSlackMrkdwn(update.metadata.branch)}\``);
  }
  if (update.metadata?.filesChanged !== undefined) {
    contextElements.push(
      `${update.metadata.filesChanged} file${update.metadata.filesChanged === 1 ? "" : "s"} changed`,
    );
  }
  contextElements.push(`\u{1f553} ${time}`);

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: contextElements.join("  \u00b7  ") }],
  });

  return blocks;
}

/**
 * Format the daily parent message for a developer.
 */
export function formatDailyParent(
  userName: string,
  project: string,
  date: string,
): { text: string; blocks: object[] } {
  const safeName = escapeSlackMrkdwn(userName);
  const safeProject = escapeSlackMrkdwn(project);
  const text = `\u{1f4cb} ${safeName} \u2014 ${date}\n${safeProject}`;
  return {
    text,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `\u{1f4cb} *${safeName}* \u2014 ${date}\n\`${safeProject}\`` },
      },
    ],
  };
}

/**
 * Format a plain text fallback (for DryRunPoster / logs).
 */
export function formatPlainText(
  update: StatusUpdate,
  userName: string,
): string {
  const indicator = TYPE_INDICATORS[update.type] || "?";
  const label = TYPE_LABELS[update.type] || "Update";
  const time = new Date(update.timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  let text = `${indicator} [${label}] ${update.summary}`;
  if (update.details) {
    text += `\n   ${update.details}`;
  }
  if (update.metadata?.branch) {
    text += `\n   branch: ${update.metadata.branch}`;
  }
  text += `  (${time}, ${userName})`;
  return text;
}
