#!/bin/bash
# Slash-command marking in agent chat and terminal (resources/ui/slash-mark.js). No CEF.
set -euo pipefail
exec node "$(cd "$(dirname "$0")/.." && pwd)/tests/slash_mark_test.mjs"
