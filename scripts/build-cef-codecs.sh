#!/usr/bin/env bash
# Builds the pinned CEF from source with Roar's patches and MP4/H.264/AAC
# playback, then swaps it into third_party/cef. Takes hours and ~100 GB under $CEF_SRC.
# H.264 and AAC are decoded by macOS (VideoToolbox, AudioToolbox): FFmpeg is the
# Chromium-branded build without H.264/AAC decoders, OpenH264 is left out, and
# scripts/cef-patches/chromium/roar_platform_codecs.patch lifts Chromium's
# proprietary_codecs/ffmpeg_branding=Chrome assert on macOS and routes all AAC to
# AudioToolbox. H.264 and AAC are patent-encumbered, so check the licensing
# before distributing a Roar built this way.
# ROAR_CEF_ARCH=x64 cross-compiles an Intel build from the same checkout and patches
# into out/Release_GN_x64 and installs it at third_party/cef-x64 (for universal builds).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CEF_SRC="${CEF_SRC:-$HOME/cef-src}"
NAME=$(grep -o "cef_binary_[^']*" "$ROOT/scripts/fetch-cef.sh")
CEF_COMMIT=$(sed -E 's/.*\+g([0-9a-f]+)\+.*/\1/' <<<"$NAME")
CHROMIUM=$(sed -E 's/.*chromium-([0-9.]+)_.*/\1/' <<<"$NAME")
ARCH="${ROAR_CEF_ARCH:-arm64}"
[[ "$ARCH" == arm64 || "$ARCH" == x64 ]] || { echo "ROAR_CEF_ARCH must be arm64 or x64"; exit 1; }
mkdir -p "$CEF_SRC"

# automate-git wants the CEF release branch; find the one holding the commit.
if [[ ! -d "$CEF_SRC/cef-probe" ]]; then
  git clone -q --filter=blob:none --no-checkout https://bitbucket.org/chromiumembedded/cef.git "$CEF_SRC/cef-probe"
fi
BRANCH=$(git -C "$CEF_SRC/cef-probe" branch -r --contains "$CEF_COMMIT" | grep -oE 'origin/[0-9]+$' | head -1 | cut -d/ -f2)
[[ -n "$BRANCH" ]] || { echo "No CEF branch contains $CEF_COMMIT"; exit 1; }
echo "CEF $CEF_COMMIT on branch $BRANCH, Chromium $CHROMIUM"

curl -sfL -o "$CEF_SRC/automate-git.py" \
  "https://bitbucket.org/chromiumembedded/cef/raw/$CEF_COMMIT/tools/automate/automate-git.py"

export GN_DEFINES="is_official_build=true proprietary_codecs=true ffmpeg_branding=Chromium media_use_openh264=false enable_ffmpeg_video_decoders=false enable_hevc_parser_and_hw_decoder=false chrome_pgo_phase=0"
export CEF_ARCHIVE_FORMAT=tar.bz2
# CEF only generates the host arch out dir unless told otherwise.
[[ "$ARCH" == x64 ]] && export CEF_ENABLE_AMD64=1
AUTOMATE=(python3 "$CEF_SRC/automate-git.py"
  --download-dir="$CEF_SRC" --branch="$BRANCH" --checkout="$CEF_COMMIT"
  --chromium-checkout="refs/tags/$CHROMIUM"
  "--$ARCH-build" --minimal-distrib-only --no-distrib-docs --no-distrib-symbols
  --no-debug-build --no-chromium-history --no-distrib-archive)
# Check out, add Roar's patches, then build without updating (an update would
# discard them). Chromium-side patches join CEF's own patch list, because CEF
# re-runs its patcher before every build and rejects files changed under it.
"${AUTOMATE[@]}" --no-build --no-distrib
SRC="$CEF_SRC/chromium/src"
# Undo Roar patches that left the repo (rollback or a dropped optional patch).
for cp in "$SRC"/cef/patch/patches/roar_*.patch; do
  [[ -e "$cp" && ! -e "$ROOT/scripts/cef-patches/chromium/$(basename "$cp")" ]] || continue
  sed -n 's#^+++ ##p' "$cp" | xargs git -C "$SRC" checkout --
  rm -f "$cp"
done
git -C "$SRC/cef" checkout -- patch/patch.cfg   # the loop below re-adds current entries
# Reset files Roar patches: CEF's patcher skips a patch only when it reverses
# cleanly, and a later patch on the same file stops that on a rerun.
# A CEF patch sharing a file with Roar's is reset whole, or it neither applies
# nor reverses on the reset file and CEF's patcher fails.
for p in "$ROOT"/scripts/cef-patches/chromium/*.patch; do
  for f in $(sed -n 's#^+++ ##p' "$p"); do
    git -C "$SRC" checkout -- "$f"
    for cp in $(grep -l "^+++ $f\$" "$SRC"/cef/patch/patches/*.patch); do
      [[ -e "$ROOT/scripts/cef-patches/chromium/$(basename "$cp")" ]] ||
        sed -n 's#^+++ ##p' "$cp" | xargs git -C "$SRC" checkout --
    done
  done
done
for p in "$ROOT"/scripts/cef-patches/chromium/*.patch; do
  name=$(basename "$p" .patch)
  cp -f "$p" "$SRC/cef/patch/patches/$name.patch"
  grep -q "'$name'" "$SRC/cef/patch/patch.cfg" ||
    sed -i '' "\$s/^]/  , { 'name': '$name' }\\
]/" "$SRC/cef/patch/patch.cfg"
done
# Reset what cef/* patches touch so they apply fresh: a skipped stale copy broke the link.
for p in "$ROOT"/scripts/cef-patches/cef/*.patch; do
  for f in $(sed -n 's#^+++ b/##p' "$p"); do
    if git -C "$SRC/cef" ls-files --error-unmatch "${f#cef/}" >/dev/null 2>&1; then
      git -C "$SRC/cef" checkout -- "${f#cef/}"
    else rm -f "$SRC/$f"; fi   # created by the patch
  done
done
for p in "$ROOT"/scripts/cef-patches/cef/*.patch; do
  patch -d "$SRC" -p1 -N -s <"$p" || { echo "CEF patch failed: $p" >&2; exit 1; }
done
"${AUTOMATE[@]}" --no-update --force-build
# Keep this build's args.gn and framework dSYM with the installed CEF: gen-notices.sh discloses that
# args.gn, and release builds run check-no-codecs.sh against that dSYM, not the live out dir.
OUT="$CEF_SRC/chromium/src/out/Release_GN_$ARCH"
# The out dir's dSYM goes stale when the out dir relinks after the distrib was made, so the dSYM kept is
# whichever one's UUID matches the installed framework (the distrib's release_symbols first); none: fail.
keep_build_record() {  # keep_build_record <installed CEF dir>
  cp "$OUT/args.gn" "$1/args.gn"
  local want sym
  want=$(dwarfdump --uuid "$1/Release/Chromium Embedded Framework.framework/Chromium Embedded Framework" | awk '{print $2}')
  for sym in "$(ls -d "$CEF_SRC"/chromium/src/cef/binary_distrib/cef_binary_*_macos${ARCH}_minimal_release_symbols 2>/dev/null | head -1)/Chromium Embedded Framework.dSYM" \
             "$OUT/Chromium Embedded Framework.dSYM"; do
    [[ -d "$sym" && "$(dwarfdump --uuid "$sym" | awk '{print $2}')" == "$want" ]] || continue
    rm -rf "$1/Chromium Embedded Framework.dSYM"; ditto "$sym" "$1/Chromium Embedded Framework.dSYM"; return
  done
  echo "build-cef-codecs.sh: no dSYM matches the installed framework ($want); rebuild without --no-distrib-symbols" >&2; exit 1
}

if [[ "$ARCH" == x64 ]]; then
  DIST=$(ls -d "$CEF_SRC"/chromium/src/cef/binary_distrib/cef_binary_*_macosx64_minimal | head -1)
  rm -rf "$ROOT/third_party/cef-x64"
  cp -R "$DIST" "$ROOT/third_party/cef-x64"
  keep_build_record "$ROOT/third_party/cef-x64"
  echo "Codec-enabled x64 CEF installed at third_party/cef-x64; scripts/build.sh now builds universal"
  exit 0
fi
DIST=$(ls -d "$CEF_SRC"/chromium/src/cef/binary_distrib/cef_binary_*_macosarm64_minimal | head -1)
rm -rf "$ROOT/third_party/cef"
cp -R "$DIST" "$ROOT/third_party/cef"
keep_build_record "$ROOT/third_party/cef"
echo "Codec-enabled CEF installed at third_party/cef; run scripts/build.sh"
