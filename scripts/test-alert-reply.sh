#!/bin/bash
# Done-card Reply routing: which agent session a reply goes to (resources/ui/cl-session.js). No CEF.
set -euo pipefail
exec node "$(cd "$(dirname "$0")/.." && pwd)/tests/alert_reply_test.mjs"
