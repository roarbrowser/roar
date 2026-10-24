#!/bin/bash
# Codec matrix (H.264 via VideoToolbox, VP8/VP9/AV1, AAC; HEVC off) in a background scratch Roar (needs a build, ffmpeg).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/video_codecs_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}"
