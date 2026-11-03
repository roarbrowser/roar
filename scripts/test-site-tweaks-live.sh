#!/bin/bash
# Site tweaks end to end against a headless scratch Roar (needs a build): userScripts allowed in a fresh
# profile, install pages, document-start, GM values, GM_xmlhttpRequest and @connect, UserCSS @var, site menu, ghost.
# Optional $1: a directory for CDP screenshots.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/site_tweaks_live_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}" "$@"
