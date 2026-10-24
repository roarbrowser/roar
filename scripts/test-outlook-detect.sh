#!/usr/bin/env bash
# Compiles and runs tests/outlook_detect_test.cc (no CEF needed).
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
c++ -std=c++17 -Wall -Isrc tests/outlook_detect_test.cc src/link_clean.cc -o "$out/t"
"$out/t"
