#!/bin/bash
# Wrapper for the codex-watcher launchd job. Long-lived process — launchd's
# KeepAlive=true restarts it on crash. This wrapper exists only to resolve
# the plugin path and `node` binary in a way that survives /plugin update
# (which can change the plugin cache directory).

set -u

# Resolve plugin dir: env override → two levels up from this script → fail.
if [ -n "${CLAUDE_REPORT_PLUGIN_DIR:-}" ]; then
  PLUGIN_DIR="$CLAUDE_REPORT_PLUGIN_DIR"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

WATCHER_JS="$PLUGIN_DIR/dist/codex-watcher/index.js"
if [ ! -f "$WATCHER_JS" ]; then
  echo "wrapper: $WATCHER_JS not found — run npm run build in $PLUGIN_DIR" >&2
  exit 10
fi

# Resolve node binary: env override → PATH lookup → fail loudly.
if [ -n "${NODE_BIN:-}" ]; then
  NODE_CMD="$NODE_BIN"
else
  NODE_CMD="$(command -v node || true)"
fi

if [ -z "$NODE_CMD" ] || [ ! -x "$NODE_CMD" ]; then
  echo "wrapper: could not locate 'node' executable. Set NODE_BIN or ensure node is on PATH." >&2
  exit 11
fi

# exec so launchd sees the watcher's exit code directly (KeepAlive triggers
# on non-zero exit).
exec "$NODE_CMD" "$WATCHER_JS"
