#!/bin/bash
# Sidebar space dots: agent-access ring, tooltips and click action (resources/ui/space-dots.js). No CEF.
set -euo pipefail
exec node "$(cd "$(dirname "$0")/.." && pwd)/tests/space_dots_test.mjs"
