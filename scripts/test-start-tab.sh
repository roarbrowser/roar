#!/usr/bin/env bash
# Compiles and runs tests/start_tab_test.cc (no CEF needed).
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
c++ -std=c++17 -Wall -Isrc tests/start_tab_test.cc -o "$out/t"
"$out/t"
