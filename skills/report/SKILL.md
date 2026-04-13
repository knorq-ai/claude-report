---
name: report
description: Post a status update to the team Slack channel
user_invocable: true
---

Post a status update to the team Slack channel summarizing your current session.

## Instructions

1. Review what you have been working on in this session — what was accomplished, what is in progress, and any blockers encountered.
2. Call the `report_status` MCP tool with:
   - `type`: The most appropriate type:
     - `"status"` — general progress update
     - `"completion"` — task or feature just finished
     - `"blocker"` — stuck on something
     - `"pivot"` — direction changed
   - `summary`: A concise one-line summary (max 150 chars). Be factual, not flowery.
   - `details`: Optional extra context — branch name, files changed, what's next.
3. Confirm to the user what was posted.

If the `report_status` tool is not available, tell the user to check that the claude-report plugin is installed and configured.
