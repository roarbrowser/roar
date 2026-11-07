#!/usr/bin/env bash
# Copying extensions between spaces: compiles and runs tests/ext_copy_test.cc (no CEF), then, when a built Roar exists
# (build/src/Release, or ROAR_EXE), the round trip in tests/ext_copy_roundtrip.mjs. Needs a C++17 compiler and Node 22+.
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
c++ -std=c++17 -Wall -Wextra -Isrc tests/ext_copy_test.cc -o "$out/t"
"$out/t"
exe="${ROAR_EXE:-build/src/Release/Roar.app/Contents/MacOS/Roar}"
if [[ -x "$exe" ]]; then ROAR_EXE="$exe" node tests/ext_copy_roundtrip.mjs
else echo "skip round trip: no built Roar at $exe"; fi
