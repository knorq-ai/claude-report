import { readCurrentSession, loadConfig, getConfigDir } from "../core/index.js";
import { listRegisteredProjects } from "../core/registry.js";

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

  console.log(`  User: ${config.user.name || "(not set)"}`);
  console.log(`  Mode: ${hasRelay ? "relay" : "direct"}`);
  console.log(`  Channel: ${config.slack.channel || "(from relay)"}`);
  console.log(`  Notifications: ${config.notifications.enabled ? "enabled" : "disabled"}`);
  console.log(`  Dry run: ${config.notifications.dryRun ? "yes" : "no"}`);

  // Registered projects
  const registered = listRegisteredProjects();
  if (registered.length > 0) {
    console.log(`  Registered projects: ${registered.length}`);
  } else {
    console.log("  Registered projects: (all — run 'claude-report register' to restrict)");
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
