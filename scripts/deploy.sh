#!/usr/bin/env bash
# Replaces /Applications/Roar.app with the build and relaunches it. Refuses to
# swap the bundle while the old Roar is still running.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP=/Applications/Roar.app
# "tell … to quit" launches a Roar that isn't running, and a starting Roar ignores it.
pgrep -f "$APP/Contents/MacOS/Roar" >/dev/null && { osascript -e "tell application \"$APP\" to quit" || true; }
for _ in $(seq 90); do pgrep -f "$APP/Contents/MacOS/Roar" >/dev/null || break; sleep 1; done
if pgrep -f "$APP/Contents/MacOS/Roar" >/dev/null; then echo "Roar did not quit; not deploying"; exit 1; fi
rm -rf "$APP"
ditto "$ROOT/build/src/Release/Roar.app" "$APP"
# A replaced bundle can keep a blank cached Dock icon; re-register it.
touch "$APP"; /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
open -n "$APP"
