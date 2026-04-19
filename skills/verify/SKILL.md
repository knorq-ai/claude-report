---
name: verify
description: Smoke-test the claude-report setup. Checks config, posts a [verify] message to Slack, and reports what works.
user_invocable: true
---

Run a full setup smoke test for claude-report.

Useful after installing the plugin, changing the bot token or channel, or when the 19:00 report silently fails and you need to know why.

## Instructions

1. Call the `verify_setup` MCP tool (no arguments).
2. Print the tool's output verbatim. It lists config state, runs `auth.test` against Slack, and posts a clearly-marked `[claude-report verify]` message to the configured channel.
3. If any step fails, the output includes the most likely fix. Surface it to the user — do not speculate beyond what the tool reports.

## What "passing" means

- Slack bot token is set and valid (`auth.test` succeeds).
- The configured channel is reachable and the bot is a member.
- `chat.postMessage` returns a timestamp.

If all three pass, the daily 19:00 report will post to the same channel with the same credentials.

## What this does NOT test

- Whether the launchd job is actually loaded (use `/install-daily-report` to (re)install).
- Whether your Mac will be awake at 19:00. launchd fires on wake if the scheduled time was missed, but does not wake the machine.
