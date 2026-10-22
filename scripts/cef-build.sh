#!/usr/bin/env bash
# One entry point for every CEF Roar ships, built (or, for Windows, fetched) and then verified.
#
#   target     | where it comes from                                   | installed at          | used by
#   mac-arm64  | ~/cef-src source build, out/Release_GN_arm64          | third_party/cef       | build.sh, release.sh
#   mac-x64    | ~/cef-src source build, out/Release_GN_x64            | third_party/cef-x64   | ROAR_ARCH=x64 build.sh
#   win-x64    | Spotify CDN prebuilt, pinned in scripts/fetch-cef.ps1 | (CI fetches its own)  | .github/workflows/windows.yml
#
# Mac builds use Roar's patches and GN args (scripts/build-cef-codecs.sh): H.264/AAC go to macOS's own
# decoders and no FFmpeg H.264/AAC/HEVC code ships. Windows ships stock CEF, which has no H.264/AAC.
# shortcut: Windows has no built-in-decoder (Media Foundation/D3D11) build yet; docs/cef-builds.md has the plan.
#
# Usage: scripts/cef-build.sh <mac-arm64|mac-x64|win-x64|all> [--verify-only]
# Every run logs to ~/Library/Logs/Roar-cef/<target>-<time>.log, and each Mac build writes
# BUILD-RECORD.txt next to the CEF it installed. A Mac source build takes hours; run it unattended.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CEF_SRC="${CEF_SRC:-$HOME/cef-src}"
TARGET="${1:-}" VERIFY_ONLY="${2:-}"
case "$TARGET" in
  all) for t in mac-arm64 mac-x64 win-x64; do "$0" "$t" "$VERIFY_ONLY"; done; exit ;;
  mac-arm64|mac-x64|win-x64) ;;
  *) sed -n '2,17p' "$0"; exit 1 ;;
esac
LOGDIR="$HOME/Library/Logs/Roar-cef"; mkdir -p "$LOGDIR"
LOG="$LOGDIR/$TARGET-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
step() { printf '\n[%s] == %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail() { printf '[%s] FAIL: %s\n' "$(date '+%H:%M:%S')" "$*"; exit 1; }
uuid() { dwarfdump --uuid "$1" | awk '{print $2}'; }
step "$TARGET$( [[ -n $VERIFY_ONLY ]] && echo ' (verify only)'); log: $LOG"

if [[ "$TARGET" == win-x64 ]]; then
  # The exact CEF Windows CI downloads: same pin, same checksum, then the same checks a release would want.
  VERSION=$(sed -n "s/^\$Version = '\(.*\)'$/\1/p" "$ROOT/scripts/fetch-cef.ps1")
  SHA1=$(grep -o "windows64 = '[0-9a-f]*'" "$ROOT/scripts/fetch-cef.ps1" | cut -d"'" -f2)
  NAME="${VERSION}_windows64_minimal"
  WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
  step "Download $NAME (pinned SHA-1 $SHA1)"
  curl -fL --retry 5 -o "$WORK/cef.tar.bz2" "https://cef-builds.spotifycdn.com/${NAME//+/%2B}.tar.bz2"
  [[ "$(shasum "$WORK/cef.tar.bz2" | cut -d' ' -f1)" == "$SHA1" ]] || fail "SHA-1 differs from the pin"
  tar -xjf "$WORK/cef.tar.bz2" -C "$WORK"
  DLL="$WORK/$NAME/Release/libcef.dll"
  CHROMIUM=$(sed -n 's/^Chromium Version: *//p' "$WORK/$NAME/README.txt")
  step "Chromium $CHROMIUM: FFmpeg revision it pins vs licenses/ffmpeg-revision (the source we publish)"
  PINNED=$(curl -sf "https://chromium.googlesource.com/chromium/src/+/refs/tags/$CHROMIUM/DEPS?format=TEXT" | base64 -d | sed -n "s/.*'ffmpeg_revision': '\([0-9a-f]*\)'.*/\1/p")
  OURS=$(cat "$ROOT/licenses/ffmpeg-revision")
  echo "Chromium pins $PINNED; Roar publishes $OURS"
  [[ -n "$PINNED" && "$PINNED" == "$OURS" ]] || fail "FFmpeg revision mismatch: published source would not match Windows"
  step "No H.264/AAC decoders or OpenH264 in libcef.dll"
  HITS=$(strings -a "$DLL" | grep -cE 'H264 Decoder|AAC decoder|CWelsH264SVCEncoder' || true)
  echo "matches: $HITS"; [[ "$HITS" == 0 ]] || fail "codec decoder strings found"
  step "OK: win-x64 = $VERSION, FFmpeg $OURS, no proprietary decoders"
  exit 0
fi

ARCH="${TARGET#mac-}"
DEST="$ROOT/third_party/$([[ $ARCH == x64 ]] && echo cef-x64 || echo cef)"
if [[ -z "$VERIFY_ONLY" ]]; then
  step "Source build: ROAR_CEF_ARCH=$ARCH scripts/build-cef-codecs.sh (hours; output in $CEF_SRC/chromium/src/out/Release_GN_$ARCH)"
  ROAR_CEF_ARCH="$ARCH" CEF_SRC="$CEF_SRC" "$ROOT/scripts/build-cef-codecs.sh"
fi

FW="$DEST/Release/Chromium Embedded Framework.framework/Chromium Embedded Framework"
SYM="$DEST/Chromium Embedded Framework.dSYM"
step "Build record in $DEST"
[[ -f "$FW" ]] || fail "no framework at $FW"
[[ -f "$DEST/args.gn" ]] || fail "no args.gn (not a source build, or installed without its record)"
[[ -d "$SYM" && "$(uuid "$SYM")" == "$(uuid "$FW")" ]] || fail "framework dSYM missing or its UUID differs"
grep -q "target_cpu=\"$ARCH\"" "$DEST/args.gn" || fail "args.gn is not for $ARCH"
grep -q 'enable_hevc_parser_and_hw_decoder=false' "$DEST/args.gn" || fail "args.gn keeps the HEVC parser"
echo "framework UUID $(uuid "$FW") matches its dSYM"

step "Codec gate (release mode)"
RELEASE=1 "$ROOT/scripts/check-no-codecs.sh" "$FW" "$SYM"

step "Notices for this CEF vs the committed copy"
NOTICES="$ROOT/THIRD_PARTY_NOTICES$([[ $ARCH == x64 ]] && echo -x64 || true).txt"
GEN="$(mktemp)"; "$ROOT/scripts/gen-notices.sh" "$DEST" > "$GEN"
if diff -q "$NOTICES" "$GEN" >/dev/null 2>&1; then echo "$(basename "$NOTICES") is current"
else cp "$GEN" "$NOTICES"; echo "UPDATED $(basename "$NOTICES"): review and commit it before the next release"; fi

{
  echo "Roar CEF build record ($TARGET), written $(date '+%Y-%m-%d %H:%M:%S') by scripts/cef-build.sh"
  grep -E '^(CEF|Chromium) Version:' "$DEST/README.txt" | tr -s ' '
  echo "FFmpeg revision: $(cat "$ROOT/licenses/ffmpeg-revision")"
  echo "Source: $CEF_SRC/chromium/src/out/Release_GN_$ARCH"
  echo "Framework UUID: $(uuid "$FW") (dSYM matches)"
  echo "Codec gate: passed (RELEASE=1 check-no-codecs.sh)"
  echo "args.gn:"; sed 's/^/  /' "$DEST/args.gn"
} > "$DEST/BUILD-RECORD.txt"
step "OK: $TARGET installed at $DEST; record: $DEST/BUILD-RECORD.txt"
