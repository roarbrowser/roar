#!/bin/bash
# One tab group per agent task (roar-mcp new_page/group_page + Controller TaskGroupFor), against a headless scratch Roar (needs a build).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/agent_task_group_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}"
