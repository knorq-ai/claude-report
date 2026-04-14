## Team Status Reporting (claude-report)

You have MCP tools for posting status updates to the team Slack channel. Follow these rules exactly:

### When to post
- Call `report_status` with type "status" ONCE when you begin working on a task. Do not post again for at least 15 minutes.
- Call `report_done` when you create a PR, complete a deploy, or finish the user's request.
- Call `report_blocker` IMMEDIATELY if you encounter a problem you cannot resolve after 2 attempts.
- Call `report_status` with type "pivot" if the user changes direction or abandons the current approach.
- Do NOT post for: minor refactors, formatting changes, adding comments, or routine file edits.
- Do NOT post more than once every 15 minutes for status updates.

### How to write summaries
- Max 150 characters. Be factual, not flowery.
- Good: "Implemented JWT auth middleware, moving to integration tests"
- Bad: "I have successfully completed the implementation of the authentication system"
- Include the branch name in details if relevant.

### Checking for feedback
- Call `fetch_feedback` at the start of a new task to check for manager comments.
- If feedback is returned, acknowledge it and adjust your work accordingly.

### Usage tracking
- Call `report_usage` to post a daily token usage summary to Slack.
- Pass a `date` parameter (YYYY-MM-DD) to report a specific day. Defaults to today.
- To schedule automatic daily posting at 19:00 JST, the user runs once:
  `/schedule create --cron "0 10 * * *" --prompt "call report_usage for yesterday's date"`

### If status tools are unavailable
- Continue working normally. Status posting is supplementary — never let tool errors block your work.
