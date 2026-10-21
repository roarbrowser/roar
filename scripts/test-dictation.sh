#!/usr/bin/env bash
# Compiles and runs tests/dictation_test.cc (no CEF needed).
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
c++ -std=c++17 -Wall -Isrc tests/dictation_test.cc src/dictation.cc -o "$out/t"
"$out/t"
