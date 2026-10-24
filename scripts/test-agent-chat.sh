#!/bin/bash
# Agent sessions as chat (mcp/agent-chat.mjs): transcript parsing, role filter, linking, chips, prompts. No CEF.
set -euo pipefail
exec node "$(cd "$(dirname "$0")/.." && pwd)/tests/agent_chat_test.mjs"
