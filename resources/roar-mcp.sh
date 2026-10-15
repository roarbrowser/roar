#!/bin/bash
# Roar's MCP server: lets an AI agent (Claude Code, Claude Desktop, Cursor, …) drive
# Roar over the Chrome DevTools Protocol through chrome-devtools-mcp. Ships inside
# Roar.app/Contents/Resources. Register it once:
#   claude mcp add roar -- /Applications/Roar.app/Contents/Resources/roar-mcp.sh
# Pages the agent opens (new_page) become real Roar tabs in the active space.
#
# Port: ROAR_CDP_PORT if set, else a headless Roar on 9444 if one is up, else 9222.
# Starts Roar when it is not running. Needs Node (npx).
set -euo pipefail

APP="$(cd "$(dirname "$0")/../.." && pwd)"
MCP_PKG="chrome-devtools-mcp@1.10.1"
up() { curl -sf "http://127.0.0.1:$1/json/version" >/dev/null 2>&1; }

if ! command -v npx >/dev/null 2>&1; then
  echo "roar-mcp: npx not found; install Node.js (https://nodejs.org) and retry" >&2
  exit 1
fi

if [ -n "${ROAR_CDP_PORT:-}" ]; then PORT=$ROAR_CDP_PORT
elif up 9444; then PORT=9444
else PORT=9222
fi

if ! up "$PORT"; then
  pgrep -f "$APP/Contents/MacOS/Roar" >/dev/null || open -a "$APP"
  for _ in $(seq 1 40); do up "$PORT" && break; sleep 0.5; done
fi
if ! up "$PORT"; then
  echo "roar-mcp: Roar's CDP port $PORT is closed. Click the dot under the settings icon" \
       "at the bottom right of Roar's sidebar to open it." >&2
  exit 1
fi

exec npx -y "$MCP_PKG" --browserUrl "http://127.0.0.1:$PORT"
