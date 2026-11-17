#!/bin/bash
# What extensions take for the page the person sees: content scripts and the action popup's current tab and
# window, against a headless scratch Roar (needs a build).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/ext_page_context_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}"
