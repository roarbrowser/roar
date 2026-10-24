#!/usr/bin/env bash
# Compiles and runs tests/agent_connect_test.cc (no CEF needed) in a scratch HOME.
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
c++ -std=c++17 -Wall -Isrc tests/agent_connect_test.cc src/agent_connect.cc -o "$out/t"
HOME="$out/home" "$out/t"
