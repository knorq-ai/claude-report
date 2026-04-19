#!/bin/bash
# Wrapper for the daily-usage launchd job.
# Exits non-zero if the MCP tools aren't reachable or if the Slack post didn't succeed,
# so launchd (and any higher-level monitor) can distinguish a real post from a
# hallucinated "explanation" of failure.
#
# Portable. Resolves paths from environment / script location; does not hardcode
# the plugin author's home or homebrew prefix.

set -u

# Resolve plugin dir: env override → two levels up from this script → fail.
if [ -n "${CLAUDE_REPORT_PLUGIN_DIR:-}" ]; then
  PLUGIN_DIR="$CLAUDE_REPORT_PLUGIN_DIR"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

if [ ! -f "$PLUGIN_DIR/dist/mcp/server.js" ]; then
  echo "wrapper: plugin dir $PLUGIN_DIR does not look like a built claude-report checkout (missing dist/mcp/server.js)" >&2
  exit 10
fi

# Resolve claude binary: env override → PATH lookup → fail loudly.
if [ -n "${CLAUDE_BIN:-}" ]; then
  CLAUDE_CMD="$CLAUDE_BIN"
else
  CLAUDE_CMD="$(command -v claude || true)"
fi

if [ -z "$CLAUDE_CMD" ] || [ ! -x "$CLAUDE_CMD" ]; then
  echo "wrapper: could not locate 'claude' executable. Set CLAUDE_BIN or ensure claude is on PATH." >&2
  exit 11
fi

TMP_OUT="$(mktemp -t claude-report-daily.XXXXXX)"
trap 'rm -f "$TMP_OUT"' EXIT

PROMPT='Call the report_usage MCP tool for today'\''s date (this is an end-of-day report). Read the per-project snippets and write a concise 1-line Japanese summary (だ・である調) per project. Then call post_usage_to_slack with the date and summaries as a JSON object mapping project path to Japanese summary string.

Hard constraints:
- If the report_usage or post_usage_to_slack MCP tools are not available, print exactly the line "FATAL: MCP unavailable" and stop. Do not suggest webhooks, do not propose alternative Slack integrations, do not output summary tables.
- On a successful Slack post, ensure the final line of your output contains the exact marker "DAILY_USAGE_POSTED_OK". If the post_usage_to_slack tool returns an error, print "FATAL: Slack post failed" and stop.'

# Run with a 600s hard timeout. macOS doesn't ship coreutils `timeout`, so use
# perl's alarm (present on every macOS). exec replaces perl with claude so the
# alarm signal targets the right process.
TIMEOUT_SECS="${CLAUDE_REPORT_TIMEOUT_SECS:-600}"
/usr/bin/perl -e 'alarm shift; exec @ARGV or exit 127' "$TIMEOUT_SECS" \
  "$CLAUDE_CMD" \
  -p "$PROMPT" \
  --plugin-dir "$PLUGIN_DIR" \
  --permission-mode bypassPermissions \
  --model sonnet \
  > "$TMP_OUT" 2>&1
claude_exit=$?

# perl's alarm() kills the process with SIGALRM (exit code 142 in bash: 128+14).
if [ "$claude_exit" = "142" ]; then
  echo "wrapper: claude -p exceeded ${TIMEOUT_SECS}s timeout (SIGALRM)" >&2
  exit 4
fi

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
