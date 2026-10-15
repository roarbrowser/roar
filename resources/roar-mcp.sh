#!/bin/bash
# Roar's MCP server: lets an AI agent (Claude Code, Claude Desktop, Cursor, …) drive
# Roar over the Chrome DevTools Protocol through chrome-devtools-mcp. Ships inside
# Roar.app/Contents/Resources. Register it once:
#   claude mcp add roar -- /Applications/Roar.app/Contents/Resources/roar-mcp.sh
# Pages the agent opens (new_page) become real Roar tabs in the active space.
#
# Which Roar: Settings > "Agents use" (agentHeadless in state.json). Headed (default)
# drives your Roar on 9222; headless starts a hidden Roar with its own profile
# (~/.roar-headless) on 9444. ROAR_CDP_PORT overrides both. Needs Node (npx).
set -euo pipefail

APP="$(cd "$(dirname "$0")/../.." && pwd)"
MCP_PKG="chrome-devtools-mcp@1.10.1"
up() { curl -sf "http://127.0.0.1:$1/json/version" >/dev/null 2>&1; }

if ! command -v npx >/dev/null 2>&1; then
  echo "roar-mcp: npx not found; install Node.js (https://nodejs.org) and retry" >&2
  exit 1
fi

STATE="${ROAR_DATA_DIR:-$HOME/Library/Application Support/Roar}/state.json"
HEADLESS=$(plutil -extract settings.agentHeadless raw -o - "$STATE" 2>/dev/null || echo false)

if [ -n "${ROAR_CDP_PORT:-}" ]; then PORT=$ROAR_CDP_PORT
elif [ "$HEADLESS" = true ]; then PORT=9444
else PORT=9222
fi

if [ -z "${ROAR_CDP_PORT:-}" ] && [ "$HEADLESS" = true ] && ! up "$PORT"; then
  mkdir -p "$HOME/.roar-headless"
  ROAR_DATA_DIR="$HOME/.roar-headless" ROAR_CDP_PORT=$PORT nohup "$APP/Contents/MacOS/Roar" --headless=new \
    >/dev/null 2>&1 &
  for _ in $(seq 1 40); do up "$PORT" && break; sleep 0.5; done
  # CDP answers before Roar's UI exists; an agent attaching then sees no pages.
  for _ in $(seq 1 40); do
    curl -sf "http://127.0.0.1:$PORT/json/list" | grep -q 'roar://ui/sidebar' && break; sleep 0.5
  done
  curl -sf -X PUT "http://127.0.0.1:$PORT/json/new?about:blank" >/dev/null || true
elif ! up "$PORT"; then
  # Anchored: a headless Roar runs the same binary, with arguments.
  pgrep -f "$APP/Contents/MacOS/Roar$" >/dev/null || open -a "$APP"
  for _ in $(seq 1 40); do up "$PORT" && break; sleep 0.5; done
fi
if ! up "$PORT"; then
  echo "roar-mcp: Roar's CDP port $PORT is closed. Click the dot under the settings icon" \
       "at the bottom right of Roar's sidebar to open it." >&2
  exit 1
fi

exec npx -y "$MCP_PKG" --browserUrl "http://127.0.0.1:$PORT"
