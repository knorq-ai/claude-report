#!/bin/bash
# Wrapper for the daily-usage launchd job.
# Exits non-zero if the MCP tools aren't reachable or if the Slack post didn't succeed,
# so launchd (and any higher-level monitor) can distinguish a real post from a
# hallucinated "explanation" of failure.

set -u

PLUGIN_DIR="/Users/yuyamorita/Projects/claude-report"
TMP_OUT="$(mktemp -t claude-report-daily.XXXXXX)"
trap 'rm -f "$TMP_OUT"' EXIT

PROMPT='Call the report_usage MCP tool for today'\''s date (this is an end-of-day report). Read the per-project snippets and write a concise 1-line Japanese summary (だ・である調) per project. Then call post_usage_to_slack with the date and summaries as a JSON object mapping project path to Japanese summary string.

Hard constraints:
- If the report_usage or post_usage_to_slack MCP tools are not available, print exactly the line "FATAL: MCP unavailable" and stop. Do not suggest webhooks, do not propose alternative Slack integrations, do not output summary tables.
- On a successful Slack post, ensure the final line of your output contains the exact marker "DAILY_USAGE_POSTED_OK". If the post_usage_to_slack tool returns an error, print "FATAL: Slack post failed" and stop.'

/usr/bin/timeout 600 /opt/homebrew/bin/claude \
  -p "$PROMPT" \
  --plugin-dir "$PLUGIN_DIR" \
  --permission-mode bypassPermissions \
  --model sonnet \
  > "$TMP_OUT" 2>&1
claude_exit=$?

cat "$TMP_OUT"

if [ $claude_exit -ne 0 ]; then
  echo "wrapper: claude exited with status $claude_exit" >&2
  exit $claude_exit
fi

if grep -q "^FATAL:" "$TMP_OUT"; then
  echo "wrapper: FATAL line detected in output" >&2
  exit 2
fi

if ! grep -q "DAILY_USAGE_POSTED_OK" "$TMP_OUT"; then
  echo "wrapper: success marker DAILY_USAGE_POSTED_OK missing — treating as failure" >&2
  exit 3
fi

exit 0
