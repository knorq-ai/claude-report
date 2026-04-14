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

To schedule this to run automatically every day at 19:00 JST (10:00 UTC), the user should run:

```
/schedule create --cron "0 10 * * *" --prompt "call report_usage for yesterday's date"
```

This is a one-time setup. After that, a daily usage summary will be posted to Slack automatically.
