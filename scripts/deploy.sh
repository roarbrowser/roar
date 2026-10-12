#!/usr/bin/env bash
# Replaces /Applications/Roar.app with the build and relaunches it. Refuses to
# swap the bundle while the old Roar is still running.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP=/Applications/Roar.app
osascript -e "tell application \"$APP\" to quit" || true
for _ in $(seq 30); do pgrep -f "$APP/Contents/MacOS/Roar" >/dev/null || break; sleep 1; done
if pgrep -f "$APP/Contents/MacOS/Roar" >/dev/null; then echo "Roar did not quit; not deploying"; exit 1; fi
rm -rf "$APP"
ditto "$ROOT/build/src/Release/Roar.app" "$APP"
open -n "$APP"
