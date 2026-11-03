#!/bin/bash
# Site tweaks' pure parts: metadata, matcher, UserCSS, importers (tests/fixtures/site-tweaks), GM runtime. No CEF.
set -euo pipefail
exec node "$(cd "$(dirname "$0")/.." && pwd)/tests/site_tweaks_test.mjs"
