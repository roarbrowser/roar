#!/bin/bash
# Headless Roar puts no window on screen (launch, agent pages, popups, native CDP windows), against a headless scratch Roar (needs a build).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
watch="$(mktemp -d)/onscreen_windows"
swiftc -O "$root/tests/onscreen_windows.swift" -o "$watch"
exec node "$root/tests/headless_windows_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}" "$watch"
