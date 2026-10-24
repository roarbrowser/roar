#!/usr/bin/env bash
# Prints THIRD_PARTY_NOTICES.txt to stdout. build.sh bundles it; CI checks the checked-in copy:
#   scripts/gen-notices.sh > THIRD_PARTY_NOTICES.txt && git diff --exit-code THIRD_PARTY_NOTICES.txt
# Needs fetch-cef.sh, fetch-ubol.sh, fetch-sparkle.sh and `bun install` in mcp/ to have run.
set -euo pipefail
ROOT="${ROAR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CEF_DIR="${1:-$ROOT/third_party/cef}"
# Third-party notices, assembled from the vendored license files; a missing one fails the build.
UBOL_VERSION="$(sed -n "s/^VERSION='\(.*\)'/\1/p" "$ROOT/scripts/fetch-ubol.sh")"
CEF_VERSION="$(sed -n 's/^CEF Version: *//p' "$CEF_DIR/README.txt")"
CHROMIUM_VERSION="$(sed -n 's/^Chromium Version: *//p' "$CEF_DIR/README.txt")"
# GN args of the CEF actually bundled (scripts/cef-args-gn.sh; exit 2 = licenses/cef-args.gn fallback).
ARGS_FALLBACK=0; ARGS_GN="$("$ROOT/scripts/cef-args-gn.sh" "$CEF_DIR")" || { [[ $? == 2 ]] && ARGS_FALLBACK=1; } || exit 1
GN_ARGS="$(grep -Ev '^[[:space:]]*(#|$)' "$ARGS_GN" | sed -E 's/[[:space:]]*=[[:space:]]*/=/' | tr '\n' ' ' | sed 's/ $//')"
[[ -n "$CEF_VERSION" && -n "$CHROMIUM_VERSION" && -n "$GN_ARGS" ]] || { echo "gen-notices.sh: cannot read CEF version or GN args" >&2; exit 1; }
RELEASES="https://github.com/roarbrowser/roar/releases"
# release.sh stages each arch's args under its own name in roar-cef-patches.tar.gz.
GN_ARGS_FILE=gn-args.txt; [[ $(basename "$CEF_DIR") == cef-x64 ]] && GN_ARGS_FILE=gn-args-x64.txt
FFMPEG_REV="$(cat "$ROOT/licenses/ffmpeg-revision")"
BUN_VERSION="$(sed -n 's/^BUN_VERSION=//p' "$ROOT/scripts/build.sh")"
# The oven-sh/WebKit commit bun-v$BUN_VERSION pins (WEBKIT_VERSION in scripts/build/deps/webkit.ts); update with BUN_VERSION.
WEBKIT_COMMIT=2e2aa2290fac856d6f451ceacb58f7f5b44dd057
TINYCC_COMMIT="$(awk -F'\t' '$1 == "tinycc" {print $3}' "$ROOT/licenses/bun-deps.tsv")"
FLUIDAUDIO_VERSION="$(awk -F'"' '/"version"/{print $4; exit}' "$ROOT/dictate/mac/Package.resolved")"
FLUIDAUDIO_REV="$(awk -F'"' '/"revision"/{print $4; exit}' "$ROOT/dictate/mac/Package.resolved")"
[[ -n "$BUN_VERSION" && -n "$TINYCC_COMMIT" && -n "$FLUIDAUDIO_VERSION" && -n "$FLUIDAUDIO_REV" ]] || { echo "gen-notices.sh: cannot read bun or FluidAudio version" >&2; exit 1; }
notice() {  # notice <heading> <file>
  [[ -f "$2" ]] || { echo "gen-notices.sh: missing license file $2" >&2; exit 1; }
  printf '\n================================================================================\n%s\n================================================================================\n\n' "$1"
  cat "$2"
}
{
  echo "Roar third-party notices"
  echo "Roar bundles the components below. Each section reproduces the license that came with it."
  echo "Roar 0.37.14 shipped without some of these sections; its full notices are in legal/roar-0.37.14-notices-supplement.md in the Roar source repository."
  notice "Roar (MIT License)" "$ROOT/LICENSE"
  notice "Chromium Embedded Framework (CEF). Chromium's own credits: CREDITS.html beside this file. Roar builds CEF from source with its own patches (scripts/cef-patches); see Chromium/CEF source below." "$CEF_DIR/LICENSE.txt"
  printf '\n================================================================================\nChromium/CEF source\n================================================================================\n\n'
  if [[ $ARGS_FALLBACK == 1 ]]; then
    echo "CEF $CEF_VERSION, Chromium $CHROMIUM_VERSION. Principal codec-relevant GN args, as configured"
    echo "(the full args.gn is unavailable for this build and these are not verified against the binary):"
  else echo "CEF $CEF_VERSION, Chromium $CHROMIUM_VERSION, built with GN args:"; fi
  echo "  $GN_ARGS"
  # The binary decides, as in check-no-codecs.sh: H265Parser symbols in the CEF dSYM. No dSYM: disclose.
  DWARF="$(ls "${ROAR_CEF_DSYM:-$CEF_DIR/Chromium Embedded Framework.dSYM}"/Contents/Resources/DWARF/* 2>/dev/null | head -1 || true)"
  if [[ ! -f $DWARF ]] || nm -a "$DWARF" 2>/dev/null | grep -q H265Parser; then
    echo "HEVC (H.265): this CEF keeps Chromium's HEVC parser; HEVC video is decoded by macOS"
    echo "VideoToolbox, not by bundled decoder code. CEF rebuilt with scripts/build-cef-codecs.sh drops it."
  fi
  echo "Roar patches CEF/Chromium with scripts/cef-patches at the matching release tag of"
  echo "https://github.com/roarbrowser/roar. The corresponding source is available from this"
  echo "version's GitHub release at $RELEASES, whose assets contain:"
  echo "  ffmpeg-$FFMPEG_REV.tar.gz: the LGPL FFmpeg source (chromium/third_party/ffmpeg at"
  echo "    commit $FFMPEG_REV, as pinned by Chromium $CHROMIUM_VERSION's DEPS)"
  echo "  roar-cef-patches.tar.gz: Roar's CEF/Chromium patches and $GN_ARGS_FILE (the args above)"
  echo "  uBOLite_$UBOL_VERSION.chromium.zip and uBOL-home-$UBOL_VERSION.tar.gz: uBO Lite build and source"
  echo "The rest of Chromium and CEF (including the MPL-licensed files) is the upstream source at the"
  echo "exact versions below, plus Roar's patches:"
  echo "  CEF: https://github.com/chromiumembedded/cef (version $CEF_VERSION)"
  echo "  Chromium: https://chromium.googlesource.com/chromium/src/+/refs/tags/$CHROMIUM_VERSION"
  echo "  FFmpeg: https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/$FFMPEG_REV"
  echo "The written offer below also covers this complete CEF/Chromium source."
  printf '\n================================================================================\nWritten offer for source code (LGPL and GPL components)\n================================================================================\n\n'
  echo "For at least three years after the last distribution of this version of Roar, and for as"
  echo "long as spare parts or customer support for it are offered, the Roar project will give anyone"
  echo "who asks a copy of the complete corresponding source code of: the LGPL-2.1 FFmpeg library; the"
  echo "complete CEF and Chromium source (CEF $CEF_VERSION, Chromium $CHROMIUM_VERSION) with Roar's"
  echo "patches and build settings; the LGPL JavaScriptCore/WebKit source (oven-sh/WebKit commit"
  echo "$WEBKIT_COMMIT), the LGPL-2.1 TinyCC source (oven-sh/tinycc commit $TINYCC_COMMIT) and Bun"
  echo "$BUN_VERSION source (tag bun-v$BUN_VERSION) that roar-mcp is built from; the complete corresponding source of roar-mcp (the mcp/ directory at"
  echo "this release's git tag, MIT), Bun $BUN_VERSION and the build command (\`bun install --frozen-lockfile"
  echo "--production\` in mcp/, then \`bun build --compile --target=bun-darwin-arm64 mcp/roar-mcp.mjs\`; x64 builds use"
  echo "bun-darwin-x64), so that roar-mcp can be rebuilt against a modified Bun or JavaScriptCore; and the"
  echo "GPL-3.0 uBO Lite extension shipped in this version. It comes on a medium"
  echo "customarily used for software interchange or by download, for no more than the cost of"
  echo "physically performing the distribution. Email"
  echo "roarbrowser@gmail.com and name the Roar version (shown in Roar > About Roar)."
  notice "FFmpeg (GNU Lesser General Public License v2.1, full text)" "$ROOT/licenses/ffmpeg-COPYING.LGPLv2.1"
  notice "Sparkle" "$ROOT/third_party/Sparkle/LICENSE"
  printf '\n================================================================================\nBun (MIT License), JavaScriptCore (LGPL) and TinyCC (LGPL-2.1), embedded in Resources/roar-mcp\n================================================================================\n\n'
  echo "Resources/roar-mcp is built with \`bun build --compile\` (Bun $BUN_VERSION, https://github.com/oven-sh/bun"
  echo "tag bun-v$BUN_VERSION), which embeds the Bun runtime. Bun is MIT-licensed and statically links"
  echo "JavaScriptCore/WebKit (LGPL) from https://github.com/oven-sh/WebKit at commit"
  echo "$WEBKIT_COMMIT, TinyCC (libtcc, LGPL-2.1) from https://github.com/oven-sh/tinycc at"
  echo "commit $TINYCC_COMMIT, and the permissively licensed libraries whose licences follow."
  echo "To relink roar-mcp with a modified JavaScriptCore or libtcc: build Bun bun-v$BUN_VERSION from"
  echo "source with your modified WebKit or tinycc checkout (see Bun's LICENSE.md and"
  echo "scripts/build/deps/ in Bun's source), then run \`bun build --compile mcp/roar-mcp.mjs\` from"
  echo "Roar's source with that bun. Source is also available under the written offer above."
  notice "Bun $BUN_VERSION: LICENSE.md (verbatim from tag bun-v$BUN_VERSION)" "$ROOT/licenses/bun-LICENSE.md"
  notice "Bun: MIT License (standard text; Bun's LICENSE.md names the licence without reproducing it)" "$ROOT/licenses/mit-LICENSE"
  # Licences of the libraries Bun links statically (licenses/bun-deps.tsv; scripts/fetch-bun-licenses.sh).
  while IFS=$'\t' read -r name repo ref file _; do
    notice "Bun component: $name $(basename "$file") ($repo at $ref)" "$ROOT/licenses/bun-deps/$name-$(basename "$file")"
  done < <(grep -v '^#' "$ROOT/licenses/bun-deps.tsv")
  notice "JavaScriptCore (GNU Library General Public License v2, Source/JavaScriptCore/COPYING.LIB at oven-sh/WebKit $WEBKIT_COMMIT)" "$ROOT/licenses/javascriptcore-COPYING.LIB"
  printf '\n================================================================================\nFluidAudio, statically linked into Resources/roar-dictate\n================================================================================\n\n'
  echo "FluidAudio $FLUIDAUDIO_VERSION (https://github.com/FluidInference/FluidAudio, commit $FLUIDAUDIO_REV)."
  echo "Speech model: on first use roar-dictate downloads NVIDIA Parakeet TDT 0.6B v3 (Core ML conversion"
  echo "FluidInference/parakeet-tdt-0.6b-v3-coreml, based on nvidia/parakeet-tdt-0.6b-v3) from Hugging Face."
  echo "The model is not bundled; it is licensed CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/)"
  echo "by NVIDIA, per its model card."
  notice "FluidAudio $FLUIDAUDIO_VERSION (Apache License 2.0)" "$ROOT/licenses/fluidaudio-LICENSE"
  notice "FluidAudio component: fastcluster (BSD License)" "$ROOT/licenses/fluidaudio-fastcluster-LICENSE.md"
  notice "FluidAudio component: vbx (Apache License 2.0)" "$ROOT/licenses/fluidaudio-vbx-LICENSE.md"
  notice "chrome-devtools-mcp" "$ROOT/mcp/node_modules/chrome-devtools-mcp/LICENSE"
  notice "chrome-devtools-mcp: bundled third-party notices" "$ROOT/mcp/node_modules/chrome-devtools-mcp/build/src/third_party/THIRD_PARTY_NOTICES"
  notice "chrome-devtools-mcp addendum: lookup-closest-locale (MIT License)" "$ROOT/licenses/lookup-closest-locale-LICENSE"
  # The license files uBO Lite ships for its own bundled parts (fonts, libraries).
  UBOL_LICENSES="$(cd "$ROOT/third_party/ubol" && find -L . -mindepth 2 -type f \( -iname '*licen[cs]e*' -o -iname 'copying*' \) | sort)"
  [[ -n "$UBOL_LICENSES" ]] || { echo "gen-notices.sh: no license files in third_party/ubol" >&2; exit 1; }
  while read -r f; do notice "uBO Lite component: ${f#./}" "$ROOT/third_party/ubol/$f"; done <<<"$UBOL_LICENSES"
  # lib/regexanalyzer ships no license file; upstream foo123/RegexAnalyzer v1.2.0 is under its UNLICENSE (added ef09378, 2021).
  notice "uBO Lite component: lib/regexanalyzer (RegexAnalyzer 1.2.0 by Nikos M., The Unlicense; https://github.com/foo123/RegexAnalyzer)" "$ROOT/licenses/regexanalyzer-UNLICENSE"
  printf '\n================================================================================\nuBO Lite (GNU General Public License v3.0)\n================================================================================\n\n'
  echo "uBO Lite $UBOL_VERSION ships unmodified as a separate browser extension, aggregated with Roar"
  echo "(mere aggregation); Roar itself is not covered by the GPL. Source code: uBOLite_$UBOL_VERSION.chromium.zip"
  echo "and uBOL-home-$UBOL_VERSION.tar.gz in this version's GitHub release assets at $RELEASES; upstream:"
  echo "https://github.com/uBlockOrigin/uBOL-home (tag $UBOL_VERSION). Editable source:"
  echo "https://github.com/gorhill/uBlock (platform/mv3)"
  notice "GNU General Public License v3.0 (full text)" "$ROOT/third_party/ubol/LICENSE.txt"
}
