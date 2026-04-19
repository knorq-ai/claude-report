---
name: usage
description: Post a daily token usage summary to the team Slack channel
user_invocable: true
---

Post a daily token usage summary to the team Slack channel by parsing local Claude Code transcript files.

## Instructions

1. Determine the target date:
   - If the user specified a date (e.g., `/usage 2026-04-13`), use that date.
   - If the user said "yesterday", calculate yesterday's date.
   - Otherwise, default to today's date.
2. Call the `report_usage` MCP tool with the `date` parameter (YYYY-MM-DD format).
3. Report the result to the user.

## Automatic daily posting

For a persistent daily 19:00 report that survives reboots, run `/install-daily-report`. It installs a launchd job on macOS.

The old `/schedule-usage` path creates a session-only CronCreate that expires after 7 days; prefer `/install-daily-report` for team distribution.
