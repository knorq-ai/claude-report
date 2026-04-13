[English](./README.md) | [日本語](./README.ja.md)

# claude-report

A Claude Code plugin that automatically posts dev status updates to Slack. Gives engineering managers real-time visibility into what the team is working on, without interrupting developers.

## Overview

When team members use Claude Code for development, claude-report detects key events (git push, commits, PR creation, test failures, task completion) and posts structured updates to a shared Slack channel. Each developer gets a daily thread per project, keeping the channel scannable. Managers can reply on threads, and the feedback is automatically surfaced in the developer's next Claude Code session.

The plugin combines three mechanisms: deterministic hooks for reliable event detection, MCP tools for richer LLM-driven updates, and a `/report` slash command for manual posting.

## Quick Start

### 1. Create a Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app **from manifest**. Paste the contents of [`slack-app-manifest.json`](./slack-app-manifest.json). Install it to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`).

Invite the bot to your target channel:

```
/invite @Claude Report
```

### 2. Install the Plugin

```bash
claude plugin add claude-report
```

Claude Code will prompt for three values:

| Prompt | Value |
|--------|-------|
| **Slack Bot Token** | `xoxb-...` from step 1 (stored in system keychain) |
| **Slack Channel ID** | Channel ID from Slack channel details (e.g. `C0AS7LC0X9B`) |
| **Display Name** | Your name as shown in Slack posts |

### 3. Register Projects

Only registered directories emit status updates. Navigate to each project you want tracked:

```bash
cd ~/Projects/company-api
claude-report register

cd ~/Projects/mobile-app
claude-report register
```

That's it. Status updates will post automatically when you use Claude Code in registered directories.

## How It Works

**Deterministic hooks** (always fire):

| Event | Detection | Slack Post |
|-------|-----------|------------|
| Git push | `git push` command + success output | `Pushed to feat/auth` |
| Git commit | `git commit` + commit message | `Committed: fix auth bug` |
| PR creation | `gh pr create` + PR URL | `PR created: .../pull/42` |
| Test failure | Test runner + failure indicators | `Tests failing: 3 failures` |
| Task completion | Claude marks a task complete | `Task completed: Implement JWT auth` |

**MCP tools** (LLM-driven, best-effort):

Claude reads the CLAUDE.md instructions and calls `report_status`, `report_blocker`, or `report_done` at appropriate milestones. These provide richer context than hooks but are not guaranteed to fire.

**Manager feedback loop**:

When a manager replies to a Slack thread, the `UserPromptSubmit` hook fetches the reply (cached, 5-minute TTL) and injects it into the developer's next Claude Code prompt.

### Slack Output

Each developer gets **one thread per project per day**:

```
Claude Report  12:07 PM
  Yuya Morita — 2026-04-12 · company-api
    Committed: fix auth bug                    (feat/auth)
    Pushed to feat/auth                        (3 files changed)
    Tests failing: 3 failures
    PR created: github.com/.../pull/42

Claude Report  12:07 PM
  Yuya Morita — 2026-04-12 · mobile-app
    Task completed: Implement push notifications
```

## Configuration

### Project-Level Overrides

Create `.claude-report.json` in any project root:

```json
{
  "notifications": {
    "onGitPush": true,
    "onBlocker": true,
    "onCompletion": true,
    "verbosity": "normal"
  },
  "rateLimit": {
    "minIntervalMs": 600000,
    "maxPerSession": 10,
    "maxPerDay": 30
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `notifications.enabled` | `boolean` | `true` | Master switch for all posting |
| `notifications.onGitPush` | `boolean` | `true` | Post on git push |
| `notifications.onBlocker` | `boolean` | `true` | Post on test failures |
| `notifications.onCompletion` | `boolean` | `true` | Post on task/PR completion |
| `notifications.verbosity` | `string` | `"normal"` | `"minimal"` \| `"normal"` \| `"verbose"` |
| `notifications.dryRun` | `boolean` | `false` | Log to file instead of posting |
| `rateLimit.minIntervalMs` | `number` | `600000` | Minimum ms between status posts (10 min) |
| `rateLimit.maxPerSession` | `number` | `10` | Max posts per session |
| `rateLimit.maxPerDay` | `number` | `30` | Max posts per day per project |

### Disabling for a Project

Create a `.claude-report.ignore` file in the project root, or set `CLAUDE_REPORT_DISABLED=1`.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_REPORT_SLACK_BOT_TOKEN` | Slack bot token (overrides plugin config) |
| `CLAUDE_REPORT_SLACK_CHANNEL` | Slack channel ID |
| `CLAUDE_REPORT_USER_NAME` | Display name |
| `CLAUDE_REPORT_DRY_RUN=1` | Enable dry-run mode |
| `CLAUDE_REPORT_DISABLED=1` | Disable all posting |

## CLI

```bash
claude-report register [path]     # Register a directory for status logging
claude-report unregister [path]   # Unregister a directory
claude-report list                # List registered directories
claude-report post <message> -t <type>  # Manually post an update
claude-report pause               # Mute posting for current project
claude-report resume              # Unmute posting
claude-report status              # Show session state and recent posts
```

### Slash Command

Type `/report` in Claude Code to trigger a manual status update. Claude will summarize the current session and post to Slack.

### MCP Tools

These tools are available to Claude when the plugin is active:

| Tool | Description |
|------|-------------|
| `report_status` | Post a progress update (status, blocker, completion, pivot, push) |
| `report_blocker` | Shorthand for blocker reports |
| `report_done` | Shorthand for completion reports |
| `fetch_feedback` | Fetch manager replies from the Slack thread |
| `report_mute` | Pause posting for the current session |
| `report_unmute` | Resume posting |

## Safety & Privacy

- **Content filter**: Secrets (AWS keys, JWTs, Slack tokens, GitHub PATs) and absolute file paths are automatically redacted before posting
- **Rate limiting**: 10-minute interval between posts, 10 per session, 30 per day. Blockers and completions bypass the interval limit
- **Mute controls**: `claude-report pause`, `report_mute` MCP tool, `.claude-report.ignore` file, or `CLAUDE_REPORT_DISABLED=1`
- **Project registration**: Only registered directories emit updates. Unregistered directories are silent
- **Credential storage**: Slack bot token is stored in the system keychain, never in config files

## Development

```bash
git clone https://github.com/anthropics/claude-report
cd claude-report
npm install
npm run build
npm test

# Test locally as a plugin
claude --plugin-dir .
```

## License

MIT
