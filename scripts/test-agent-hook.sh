#!/bin/bash
# Agent-session hook adapters and installers (mcp/claude-hook.mjs), in a scratch HOME. No CEF.
set -euo pipefail
exec node "$(cd "$(dirname "$0")/.." && pwd)/tests/agent_hook_test.mjs"
