#!/bin/bash
# OpenCode TUI plugin: event mapping and the written file running on its own (mcp/agent-opencode.mjs). No CEF.
set -euo pipefail
exec node "$(cd "$(dirname "$0")/.." && pwd)/tests/agent_opencode_test.mjs"
