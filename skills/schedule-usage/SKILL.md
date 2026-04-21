---
name: schedule-usage
description: Set up daily usage reporting to Slack at 19:00 JST for this session
user_invocable: true
---

Set up a scheduled task to post daily token usage summaries to Slack at 19:00 JST.

## Instructions

1. Use the CronCreate tool with these parameters:
   - `cron`: `"0 19 * * *"` (19:00 local time — end of day report)
   - `prompt`: `"Call the report_usage MCP tool for today's date (end-of-day report). Write 1-10 Japanese bullet points (だ・である調) per project describing what was done — match bullet count to actual work, do not pad. Then call post_usage_to_slack with summaries as {project: [bullet1, bullet2, ...]}. Hard constraints: if those MCP tools are not available, print 'FATAL: MCP unavailable' and stop — do not suggest webhooks or alternative Slack paths. On a successful post, the final line of your output must contain 'DAILY_USAGE_POSTED_OK'."`
   - `recurring`: `true`
2. Confirm to the user that the schedule was created.
3. Inform the user of these limitations:
   - The schedule is **session-only** — it runs while this Claude session is active, and is lost when Claude exits.
   - It **auto-expires after 7 days**. Run `/schedule-usage` again to renew.
   - For a persistent solution, use an external cron job: `crontab -e` and add:
     `3 10 * * * cd /path/to/project && claude -p "call report_usage for yesterday's date"`
