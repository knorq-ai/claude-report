[English](./README.md) | [日本語](./README.ja.md)

# claude-report

A Claude Code plugin that gives engineering managers real-time visibility into developer activity through Slack — without interrupting developers.

## Overview

claude-report integrates with Claude Code to provide two layers of visibility:

1. **Real-time activity log** — hooks automatically detect git commits, pushes, PR creation, test failures, and task completions, posting compact log entries to a daily Slack thread
2. **End-of-day summary** — parses Claude Code transcript files to generate per-project usage stats and AI-written summaries of what was accomplished

The plugin also surfaces manager feedback: replies on Slack threads are automatically injected into the developer's next Claude Code session.

## Quick Start

### 1. Create a Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app **from manifest**. Paste the contents of [`slack-app-manifest.json`](./slack-app-manifest.json). Install it to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`).

Invite the bot to your target channel:

```
/invite @Claude Report
```

### 2. Install the Plugin

```bash
claude plugin install claude-report
```

Claude Code will prompt for three values:

| Prompt | Value |
|--------|-------|
| **Slack Bot Token** | `xoxb-...` from step 1 |
| **Slack Channel ID** | Channel ID from Slack channel details (e.g. `C0AS7LC0X9B`) |
| **Display Name** | Your name as shown in Slack posts |

### 3. Restart Claude Code

The plugin's hooks and MCP server activate on session startup.

## How It Works

### Real-Time Activity Log

Hooks fire on every Bash and TaskUpdate tool call. Detected events are posted as compact log entries to a **single daily thread per user**:

```
📋 Yuya — Activity Log (2026-04-15)
  ├─ `Projects/claude-report` 🚀 Pushed to main
  ├─ `valorize/valorize-app` 📝 Committed: fix Vercel build permission error
  ├─ `firstlooptechnology/davie` ✅ Task completed: Add anomaly detection processor
  └─ `Projects/claude-report` 🛑 Tests failing: 3 failures
```

| Event | Icon | Example |
|-------|------|---------|
| Git push | 🚀 | `Pushed to main` |
| Git commit | 📝 | `Committed: fix auth bug` |
| PR creation | 📝 | `PR created: .../pull/42` |
| Task completion | ✅ | `Task completed: Implement JWT auth` |
| Test failure | 🛑 | `Tests failing: 3 failures` |

### End-of-Day Usage Report

The `/usage` slash command (or `report_usage` MCP tool) parses local Claude Code transcript JSONL files and generates a daily summary:

- **Token usage stats** — sessions, prompts (excluding internal tool calls), input/output tokens, estimated cost
- **Per-project breakdown** — prompts and tokens per project with readable project paths
- **AI-written summaries** — Claude reads commit messages, edited files, and user prompts to write a 1-line Japanese summary per project

Schedule automatic daily posting with `/schedule-usage` or via launchd:

```bash
# macOS launchd (persists across restarts)
# See the launchd setup section below
```

### Manager Feedback Loop

When a manager replies to a Slack thread, the `UserPromptSubmit` hook fetches the reply (cached, 5-minute TTL) and injects it into the developer's next Claude Code prompt.

## Configuration

### Project-Level Overrides

Create `.claude-report.json` in any project root:

```json
{
  "notifications": {
    "enabled": true,
    "onGitPush": true,
    "onBlocker": true,
    "onCompletion": true,
    "dryRun": false
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `notifications.enabled` | `boolean` | `true` | Master switch for all posting |
| `notifications.onGitPush` | `boolean` | `true` | Include git push in activity log |
| `notifications.onBlocker` | `boolean` | `true` | Include test failures |
| `notifications.onCompletion` | `boolean` | `true` | Include task/PR completion |
| `notifications.dryRun` | `boolean` | `false` | Log to file instead of posting |

### Disabling for a Project

Create a `.claude-report.ignore` file in the project root, or set `CLAUDE_REPORT_DISABLED=1`.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_REPORT_SLACK_BOT_TOKEN` | Slack bot token (overrides plugin config) |
| `CLAUDE_REPORT_SLACK_CHANNEL` | Slack channel ID |
| `CLAUDE_REPORT_USER_NAME` | Display name |
| `CLAUDE_REPORT_DATA_DIR` | Data directory path (overrides default) |
| `CLAUDE_REPORT_DRY_RUN=1` | Enable dry-run mode |
| `CLAUDE_REPORT_DISABLED=1` | Disable all posting |

## CLI

```bash
claude-report enable [user]              # Enable reporting for a git user
claude-report disable [user]             # Disable reporting for a git user
claude-report users                      # List enabled users
claude-report post <message> -t <type>   # Manually post an update
claude-report pause                      # Mute posting for current project
claude-report resume                     # Unmute posting
claude-report status                     # Show session state
```

### Slash Commands

| Command | Description |
|---------|-------------|
| `/report` | Post a manual status update — Claude summarizes the session |
| `/usage` | Post a daily token usage summary to Slack |
| `/schedule-usage` | Set up automatic daily usage reporting |

### MCP Tools

| Tool | Description |
|------|-------------|
| `report_status` | Post a progress update (status, blocker, completion, pivot, push) |
| `report_blocker` | Shorthand for blocker reports |
| `report_done` | Shorthand for completion reports |
| `fetch_feedback` | Fetch manager replies from the Slack thread |
| `report_usage` | Get daily usage stats and per-project activity snippets |
| `post_usage_to_slack` | Post usage summary with AI-generated project summaries |
| `report_mute` / `report_unmute` | Pause/resume posting |

## Scheduling the Daily Report

### Recommended: `/install-daily-report` (macOS, persistent)

Run the skill from any Claude Code session that has the plugin loaded:

```
/install-daily-report
```

This generates a launchd plist with correctly-resolved paths for your machine, loads it via `launchctl bootstrap`, and logs to `~/.claude-report/logs/daily-usage-{stdout,stderr}.log`. Runs daily at 18:57 local (the post lands around 19:00 after the `claude -p` session finishes summarizing). Re-run the skill any time to refresh the schedule.

Before the first scheduled fire, run `/verify` to confirm Slack posts work end-to-end.

### Alternative: `/schedule-usage` (session-only, 7-day expiry)

```
/schedule-usage
```

Session-scoped CronCreate — dies when the Claude Code session ends, auto-expires after 7 days. Use only for ad-hoc demos; `/install-daily-report` is the right choice for real distribution.

### Linux

`/install-daily-report` is macOS-only today. On Linux, create a systemd timer that runs `$CLAUDE_PLUGIN_ROOT/bin/daily-usage-wrapper.sh` at 18:57 local, with `CLAUDE_REPORT_PLUGIN_DIR` and `CLAUDE_BIN` exported in the unit's environment.

## Safety & Privacy

- **Content filter**: secrets (AWS keys, JWTs, Slack tokens, GitHub PATs, Stripe keys), `key=value` patterns, and absolute file paths are automatically redacted before posting
- **Slack mrkdwn escaping**: user-controlled text is sanitized to prevent formatting injection
- **Prompt injection mitigation**: Slack reply text is sanitized and boundary-marked before injection into Claude's context
- **Mute controls**: `claude-report pause`, `report_mute` MCP tool, `.claude-report.ignore` file, or `CLAUDE_REPORT_DISABLED=1`
- **User-based access control**: enable/disable reporting per git user across all repos
- **File locking**: advisory locks prevent concurrent hook processes from corrupting session state

## Development

```bash
git clone https://github.com/knorq-ai/claude-report.git
cd claude-report
npm install
npm run build
npm test

# Test locally as a plugin (without installing from a marketplace)
claude --plugin-dir .
```

## License

MIT
