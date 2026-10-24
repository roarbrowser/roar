#!/bin/bash
# The macOS uninstaller (resources/uninstall-roar.sh) in a fake HOME against the built Roar.app. No CEF run.
set -euo pipefail
exec bash "$(cd "$(dirname "$0")/.." && pwd)/tests/uninstall_test.sh"
