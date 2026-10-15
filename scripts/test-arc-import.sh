#!/usr/bin/env bash
# Compiles and runs tests/arc_import_test.cc (no CEF needed).
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
c++ -std=c++17 -Wall -Isrc tests/arc_import_test.cc src/arc_import.cc -o "$out/t"
"$out/t"
