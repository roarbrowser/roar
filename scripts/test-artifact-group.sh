#!/bin/bash
# Sidebar Artifacts section: which tabs it takes (resources/ui/artifact-group.js). No CEF.
set -euo pipefail
exec node "$(cd "$(dirname "$0")/.." && pwd)/tests/artifact_group_test.mjs"
