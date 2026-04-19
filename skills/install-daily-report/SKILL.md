---
name: install-daily-report
description: Install a persistent daily Slack usage report (macOS launchd) that fires at 19:00 local time. Survives reboots and Claude Code restarts.
user_invocable: true
---

Install a persistent daily usage report on this machine.

Unlike `/schedule-usage` (which uses a session-only CronCreate that expires after 7 days), this skill installs a real launchd job that runs even when Claude Code is closed.

## Instructions

1. Call the `install_daily_report` MCP tool. Optional args: `hour` (0–23, default 18) and `minute` (0–59, default 57). 18:57 is used by default so the post lands just before 19:00 after `claude -p` finishes summarizing.
2. Print the tool's output verbatim so the user sees the plist path, wrapper path, and schedule.
3. Recommend running `/verify` (or the `verify_setup` MCP tool) to confirm the Slack pipeline works before the first scheduled fire.

## macOS only

This skill currently supports macOS only. On Linux, set up a systemd timer or cron job that runs `$CLAUDE_PLUGIN_ROOT/bin/daily-usage-wrapper.sh` at 18:57 local time, with `CLAUDE_REPORT_PLUGIN_DIR` and `CLAUDE_BIN` exported in the unit's environment.

## Idempotency

Running the skill again is safe: it overwrites the plist and reloads the launchd job. Use this after updating the plugin or changing the hour/minute.
