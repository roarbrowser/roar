#!/bin/bash
# take_screenshot of a background tab returns instead of hanging, in a windowed scratch Roar opened behind and in a headless one (needs a build; macOS).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
app="${ROAR_APP:-$root/build/src/Release/Roar.app}"
node "$root/tests/background_screenshot_test.mjs" "$app"
node "$root/tests/background_screenshot_test.mjs" "$app" --headless
