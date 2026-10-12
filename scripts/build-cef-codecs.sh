#!/usr/bin/env bash
# Builds the pinned CEF from source with MP4/H.264/AAC support, then swaps it
# into third_party/cef. Takes hours and ~100 GB under $CEF_SRC.
# Chromium refuses proprietary_codecs without ffmpeg_branding=Chrome, so this
# bundles FFmpeg's H.264/AAC decoders like Chrome does: patent-encumbered, so
# check the licensing before distributing a Roar built this way.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CEF_SRC="${CEF_SRC:-$HOME/cef-src}"
NAME=$(grep -o "cef_binary_[^']*" "$ROOT/scripts/fetch-cef.sh")
CEF_COMMIT=$(sed -E 's/.*\+g([0-9a-f]+)\+.*/\1/' <<<"$NAME")
CHROMIUM=$(sed -E 's/.*chromium-([0-9.]+)_.*/\1/' <<<"$NAME")
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

export GN_DEFINES="is_official_build=true proprietary_codecs=true ffmpeg_branding=Chrome chrome_pgo_phase=0"
export CEF_ARCHIVE_FORMAT=tar.bz2
python3 "$CEF_SRC/automate-git.py" \
  --download-dir="$CEF_SRC" --branch="$BRANCH" --checkout="$CEF_COMMIT" \
  --chromium-checkout="refs/tags/$CHROMIUM" \
  --arm64-build --minimal-distrib-only --no-distrib-docs --no-distrib-symbols \
  --no-debug-build --no-chromium-history --force-build

DIST=$(ls -d "$CEF_SRC"/chromium/src/cef/binary_distrib/cef_binary_*_macosarm64_minimal | head -1)
rm -rf "$ROOT/third_party/cef.prebuilt"
[[ -d "$ROOT/third_party/cef" ]] && mv "$ROOT/third_party/cef" "$ROOT/third_party/cef.prebuilt"
cp -R "$DIST" "$ROOT/third_party/cef"
echo "Codec-enabled CEF installed at third_party/cef; run scripts/build.sh"
