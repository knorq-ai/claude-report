[English](./README.md) | [日本語](./README.ja.md)

# claude-report

A Claude Code plugin that gives engineering managers real-time visibility into developer activity through Slack — without interrupting developers.

## Overview

claude-report integrates with Claude Code to provide two layers of visibility:

1. **Real-time activity log** — hooks automatically detect git commits, pushes, PR creation, test failures, and task completions, posting compact log entries to a daily Slack thread
2. **End-of-day summary** — parses Claude Code transcript files to generate per-project usage stats and AI-written summaries of what was accomplished

The plugin also surfaces manager feedback: replies on Slack threads are automatically injected into the developer's next Claude Code session.

> **Scope:** claude-report covers **Claude Code (CLI) only**. The Claude desktop app's Cowork / agent mode stores its sessions under `~/Library/Application Support/Claude/local-agent-mode-sessions/` and does not run Claude Code hooks, so Cowork activity and token usage are not included in the activity log or the daily summary.

## Team Rollout

claude-report is designed to be rolled out to a whole engineering team so every developer's daily activity and 19:00 usage summary land in one shared channel. The flow splits into a one-time setup by a team lead and a ~2-minute install per teammate.

### Team Lead — one-time setup

**1. Create the shared Slack app**

Go to [api.slack.com/apps](https://api.slack.com/apps), create an app **from manifest**, paste [`slack-app-manifest.json`](./slack-app-manifest.json). Install to your workspace; copy the **Bot User OAuth Token** (`xoxb-…`). Invite the bot into the channel where daily reports should land (`/invite @Claude Report`).

The team shares one bot token + one channel. Per-user threading is handled inside the plugin (thread per git-email-hash), so there's no per-user app setup.

**2. Publish the plugin to a marketplace**

Push this repo to a public (or org-internal) GitHub repo and keep `.claude-plugin/marketplace.json` at the root.

**3. Share the install instructions**

Send teammates the block below with the bot token and channel ID filled in.

### Teammate — install (~2 minutes)

```
# 1. Register the marketplace (one-time)
/plugin marketplace add knorq-ai/claude-report

# 2. Install the plugin
/plugin install claude-report@claude-report-marketplace
```

Claude Code prompts for three values at install:

| Prompt | Value |
|--------|-------|
| **Slack Bot Token** | `xoxb-…` (from the team lead) |
| **Slack Channel ID** | Channel ID, e.g. `C0AS7LC0X9B` (from the team lead) |
| **Display Name** | Your name as shown in Slack posts |

Then reload and set up the daily schedule:

```
/reload-plugins
/install-daily-report
/verify
```

`/install-daily-report` writes a launchd plist and loads it (macOS). `/verify` runs nine checks (Slack auth, channel membership, plist, launchd job loaded, wrapper executable, dist built, `claude` on PATH). If all green, your daily 19:00 report is live and will survive reboots.

If any check fails, the output includes the exact remediation. Common ones:
- `auth.test: invalid_auth` → bot token pasted wrong; rerun `/plugin config claude-report`.
- `chat.postMessage: not_in_channel` → bot isn't in the channel; `/invite @Claude Report` in Slack.
- `claude on PATH (login shell): not resolvable` → ensure `claude` is in `/usr/local/bin` or `/opt/homebrew/bin` (or set `CLAUDE_BIN` in the plist).

### Opting a repo out

`echo > .claude-report.ignore` in any project root. The file is honored by both the real-time activity log **and** the 19:00 usage report (tokens, prompts, and estimated cost from opted-out projects are stripped from the Slack header, not just the per-project breakdown).

### Updating

When the team lead ships a new version:

```
/plugin marketplace update claude-report-marketplace
/plugin update claude-report
/reload-plugins
/install-daily-report   # refresh the plist with the new wrapper/paths
```

### Linux teammates

`/install-daily-report` is macOS-only today. On Linux, create a systemd timer that runs `$CLAUDE_PLUGIN_ROOT/bin/daily-usage-wrapper.sh` at 18:57 local with `CLAUDE_REPORT_PLUGIN_DIR`, `CLAUDE_REPORT_DATA_DIR=$HOME/.claude-report`, and `CLAUDE_BIN` exported. See [`bin/daily-usage-wrapper.sh`](./bin/daily-usage-wrapper.sh) for the expected contract.

### What survives `/plugin uninstall`

The durable config and state live at `~/.claude-report/` (config.json, state/, logs/). Plugin-data (`$CLAUDE_PLUGIN_DATA`) is wiped by `/plugin uninstall`. `/install-daily-report` migrates `$CLAUDE_PLUGIN_DATA/config.json` → `~/.claude-report/config.json` on first run so teammates who configured via `/plugin` keep their Slack creds across reinstalls.

## How It Works

### Real-Time Activity Log

Hooks fire on every Bash and TaskUpdate tool call. Detected events are posted as compact log entries to a **single daily thread per user**:

```
📋 Alex — Activity Log (2026-04-15)
  ├─ `acme/web-app`      🚀 Pushed to main
  ├─ `acme/api-gateway`  📝 Committed: fix auth middleware redirect loop
  ├─ `acme/data-pipeline` ✅ Task completed: Add anomaly detection processor
  └─ `acme/web-app`      🛑 Tests failing: 3 failures
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
- **AI-written bullet summaries** — Sonnet reads commit messages, edited files, and user prompts to write 1–10 Japanese bullet points per project (bullet count scales to the amount of work; tiny sessions get one line)

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
| `/install-daily-report` | Install the persistent 19:00 launchd job (macOS) |
| `/verify` | Smoke-test the full setup — Slack auth, channel, plist, launchd, wrapper, dist, PATH |
| `/schedule-usage` | Legacy session-only scheduler (prefer `/install-daily-report` for real distribution) |

### MCP Tools

| Tool | Description |
|------|-------------|
| `report_status` | Post a progress update (status, blocker, completion, pivot, push) |
| `report_blocker` | Shorthand for blocker reports |
| `report_done` | Shorthand for completion reports |
| `fetch_feedback` | Fetch manager replies from the Slack thread |
| `report_usage` | Get daily usage stats and per-project activity snippets |
| `post_usage_to_slack` | Post usage summary with AI-generated per-project bullet lists |
| `verify_setup` | Run the 9-check setup smoke test |
| `install_daily_report` | Generate and load the macOS launchd plist |
| `report_mute` / `report_unmute` | Pause/resume posting |

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
