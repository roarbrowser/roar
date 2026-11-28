#!/bin/bash
# What extensions are told about Roar's windows: normal windows in the worker, the action popup, extension pages
# in a tab and normal-only window event filters, against a headless scratch Roar (needs a build on the patched CEF).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/ext_window_type_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}"
