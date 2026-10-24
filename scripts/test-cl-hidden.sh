#!/bin/bash
# Hidden agent sessions: settings.agentHidden parsing and pruning (resources/ui/cl-session.js). No CEF.
set -euo pipefail
exec node "$(cd "$(dirname "$0")/.." && pwd)/tests/cl_hidden_test.mjs"
