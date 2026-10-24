#!/bin/bash
# Inline <script> blocks in resources/ui parse (tests/ui_syntax_test.mjs). No CEF.
set -euo pipefail
exec node --experimental-vm-modules "$(cd "$(dirname "$0")/.." && pwd)/tests/ui_syntax_test.mjs"
