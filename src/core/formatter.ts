import type { StatusUpdate } from "./types.js";

/**
 * Escape Slack mrkdwn special characters to prevent injection.
 *
 * Defends against:
 * - `<url|label>` / `<!channel>` / `<!here>` / `<!everyone>` broadcast control sequences
 *   (escaped via &lt; / &gt; — Slack does not parse entity-escaped angle brackets)
 * - `@channel` / `@here` / `@everyone` raw mentions (Slack auto-links in some contexts;
 *   we insert a zero-width space to neutralize)
 * - `*bold*`, `_italic_`, `~strike~`, `` `code` `` formatting injection
 */
export function escapeSlackMrkdwn(text: string): string {
  // HTML entities — critical: &lt; defuses <!channel>, <!here>, <!everyone>, <@UID>
  let escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Neutralize @channel / @here / @everyone that Slack's parser might still auto-link
  escaped = escaped.replace(/@(channel|here|everyone)\b/gi, "@\u200B$1");
  // Neutralize mrkdwn formatting by inserting zero-width space before trigger chars
  escaped = escaped.replace(/([*_~`])/g, "\u200B$1");
  return escaped;
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
    // Inside code span: mrkdwn is already neutralized, just strip backticks to prevent breakout
    const safeBranch = update.metadata.branch.replace(/`/g, "'");
    contextElements.push(`\u{1f33f} \`${safeBranch}\``);
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
