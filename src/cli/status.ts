import { readCurrentSession, loadConfig } from "../core/index.js";
import { listEnabledUsers, getGitUser, isUserEnabled } from "../core/registry.js";

export async function status(): Promise<void> {
  console.log("\n  claude-report status\n");

  const config = loadConfig(process.cwd());

  const hasSlack = !!(config.slack.botToken && config.slack.channel);
  const hasRelay = !!config.relay?.url;

  if (!hasSlack && !hasRelay) {
    console.log("  Not configured.");
    console.log("  Install as plugin: claude plugin add claude-report");
    console.log("  Or set env vars: CLAUDE_REPORT_SLACK_BOT_TOKEN, CLAUDE_REPORT_SLACK_CHANNEL\n");
    return;
  }

  console.log(`  User: ${config.user.name || "(auto-detected)"}`);
  console.log(`  Mode: ${hasRelay ? "relay" : "direct"}`);
  console.log(`  Channel: ${config.slack.channel || "(from relay)"}`);
  console.log(`  Notifications: ${config.notifications.enabled ? "enabled" : "disabled"}`);
  console.log(`  Dry run: ${config.notifications.dryRun ? "yes" : "no"}`);

  // User-based access control
  const gitUser = getGitUser();
  const enabled = listEnabledUsers();
  const active = isUserEnabled();
  if (enabled.length > 0) {
    console.log(`  Git user: ${gitUser || "(not in a git repo)"} → ${active ? "enabled" : "disabled"}`);
    console.log(`  Enabled users: ${enabled.join(", ")}`);
  } else {
    console.log(`  Git user: ${gitUser || "(not in a git repo)"} → enabled (no restrictions)`);
  }

  // Session
  const session = readCurrentSession();
  if (session) {
    console.log(`\n  Session: ${session.sessionId.slice(0, 8)}...`);
    console.log(`  Project: ${session.project}`);
    console.log(`  Started: ${session.startedAt}`);
    console.log(`  Posts: ${session.postCount} (today: ${session.dailyPostCount})`);
    console.log(`  Muted: ${session.muted ? "yes" : "no"}`);
    console.log(`  Thread: ${session.threadId || "(none yet)"}`);
  } else {
    console.log("\n  No active session.");
  }

  console.log();
}
