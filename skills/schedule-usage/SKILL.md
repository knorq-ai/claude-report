---
name: schedule-usage
description: Set up daily usage reporting to Slack at 19:00 JST for this session
user_invocable: true
---

Set up a scheduled task to post daily token usage summaries to Slack at 19:00 JST.

## Instructions

1. Use the CronCreate tool with these parameters:
   - `cron`: `"3 10 * * *"` (10:03 UTC = 19:03 JST, offset to avoid burst)
   - `prompt`: `"Call the report_usage MCP tool with yesterday's date to post token usage summary to Slack."`
   - `recurring`: `true`
2. Confirm to the user that the schedule was created.
3. Inform the user of these limitations:
   - The schedule is **session-only** — it runs while this Claude session is active, and is lost when Claude exits.
   - It **auto-expires after 7 days**. Run `/schedule-usage` again to renew.
   - For a persistent solution, use an external cron job: `crontab -e` and add:
     `3 10 * * * cd /path/to/project && claude -p "call report_usage for yesterday's date"`
