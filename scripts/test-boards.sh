#!/usr/bin/env bash
# Boards: compiles and runs tests/boards_test.cc (no CEF needed), then, when a built Roar exists
# (build/src/Release, or ROAR_BIN), the headless round trip in tests/boards_test.mjs.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
c++ -std=c++17 -Wall -Wextra -I"$root/src" "$root/tests/boards_test.cc" -o "$out/t"
"$out/t"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exe="$root/build/src/Release/Roar.exe" ;; *) exe="$root/build/src/Release/Roar.app/Contents/MacOS/Roar" ;; esac
exe="${ROAR_BIN:-$exe}"
if [[ -x "$exe" ]]; then node "$root/tests/boards_test.mjs" "$exe"
else echo "skip headless test: no built Roar at $exe"; fi
