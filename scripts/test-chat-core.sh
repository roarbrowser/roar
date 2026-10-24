#!/bin/bash
# Model chat's provider config, SSE parser and Markdown sanitizer (resources/ui/chat-core.js). No CEF.
set -euo pipefail
exec node "$(cd "$(dirname "$0")/.." && pwd)/tests/chat_core_test.mjs"
