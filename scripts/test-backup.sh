#!/usr/bin/env bash
# Backup & Restore: compiles and runs tests/backup_test.cc (no CEF needed), then, when a built Roar
# exists (build/src/Release, or ROAR_EXE), the round trip in tests/backup_roundtrip.mjs on two fresh
# data dirs. Works on macOS and in Git Bash on Windows; needs a C++17 compiler and Node 22+.
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
c++ -std=c++17 -Wall -Wextra -Isrc tests/backup_test.cc -o "$out/t"
"$out/t"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exe=build/src/Release/Roar.exe ;; *) exe=build/src/Release/Roar.app/Contents/MacOS/Roar ;; esac
exe="${ROAR_EXE:-$exe}"
if [[ -x "$exe" ]]; then ROAR_EXE="$exe" node tests/backup_roundtrip.mjs
else echo "skip round trip: no built Roar at $exe"; fi
