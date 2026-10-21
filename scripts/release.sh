#!/usr/bin/env bash
# Cuts a release: bumps the version, builds, packs Roar-<version>.dmg, commits,
# tags, pushes and publishes a GitHub release with the DMG attached.
# Usage: scripts/release.sh <version> [notes]    e.g. scripts/release.sh 0.1.1 "Cleans Outlook and Teams links"
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:?usage: scripts/release.sh <version> [notes]}"
NOTES="${2:-}"
TAG="v$VERSION"
PLIST=resources/Info.plist.in

# Release commits go to main: windows.yml only attaches Windows builds for a main push (or a tag dispatch).
git fetch -q origin main
git merge-base --is-ancestor origin/main HEAD || { echo "HEAD is not ahead of origin/main; rebase first (release.sh pushes HEAD to main)" >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "working tree dirty; commit first" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "$TAG already exists" >&2; exit 1; }

# Version lives in Info.plist.in. Sparkle compares the build number (CFBundleVersion against
# sparkle:version), so it must rise with every release: major*10000 + minor*100 + patch (0.17.0 -> 1700).
# Builds before 0.17 all said 1, which Sparkle ranked above every "0.x.y" it was offered.
BUILD=$(awk -F. '{print $1 * 10000 + $2 * 100 + $3}' <<<"$VERSION")
(( BUILD > 1 )) || { echo "version $VERSION gives build number $BUILD" >&2; exit 1; }
sed -i '' -E "s|(<key>CFBundleShortVersionString</key><string>)[^<]*|\1$VERSION|" "$PLIST"
sed -i '' -E "s|(<key>CFBundleVersion</key><string>)[^<]*|\1$BUILD|" "$PLIST"

# Public builds use the company Developer ID when it is in the keychain, else ad-hoc:
# an Apple Development identity embeds the developer's real name.
DEVID="$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/{print $2; exit}')"
# One DMG per Mac, never universal: Roar-<v>.dmg (Apple Silicon; the name Sparkle and Homebrew
# have always used) and, once third_party/cef-x64 exists, Roar-<v>-intel.dmg with its own feed.
ARCHES=(arm64); [[ -d third_party/cef-x64 ]] && ARCHES+=(x64)
# x64 notices need their own committed copy (build.sh diffs against it); refuse until it exists.
[[ ! -d third_party/cef-x64 || -f THIRD_PARTY_NOTICES-x64.txt ]] || { echo "release.sh: third_party/cef-x64 exists but THIRD_PARTY_NOTICES-x64.txt is not committed (scripts/gen-notices.sh third_party/cef-x64)" >&2; exit 1; }
# ALLOW_HEVC=1 is for local builds only; shipping HEVC needs clearance, not an env override.
[[ -z ${ALLOW_HEVC:-} ]] || { echo "release.sh: unset ALLOW_HEVC; releases never bypass the HEVC gate" >&2; exit 1; }
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ROAR_NOTARY_PROFILE="${ROAR_NOTARY_PROFILE:-roar-notary}"
NOTARIZED=1 DMGS=() FEEDS=()
for ARCH in "${ARCHES[@]}"; do
  if [[ $ARCH == x64 ]]; then APP="$ROOT/build-x64/src/Release/Roar.app" SUFFIX=-intel FEED=appcast-intel.xml
  else APP="$ROOT/build/src/Release/Roar.app" SUFFIX= FEED=appcast.xml; fi
  # build.sh runs the notices gates and, with ROAR_RELEASE=ON, the codec gate (dSYM kept beside the CEF).
  # DMGs come only from here.
  ROAR_ARCH=$ARCH ROAR_RELEASE=ON ROAR_SIGN_IDENTITY="${ROAR_SIGN_IDENTITY:-${DEVID:--}}" bash scripts/build.sh
  DMG="$ROOT/build/Roar-$VERSION$SUFFIX.dmg"
  # "Uninstall Roar.app" for the DMG, signed like Roar (the DMG's notarization covers it).
  UNINST="$ROOT/build/dmg-extra$SUFFIX/Uninstall Roar.app"
  rm -rf "$(dirname "$UNINST")" && mkdir -p "$(dirname "$UNINST")"
  osacompile -o "$UNINST" packaging/dmg/uninstall.applescript
  cp resources/uninstall-roar.sh "$UNINST/Contents/Resources/"
  U_ID="${ROAR_SIGN_IDENTITY:-${DEVID:--}}"
  codesign --force --sign "$U_ID" $([ "$U_ID" = - ] || echo --options runtime --timestamp) "$UNINST"
  rm -f "$DMG"
  # dmgbuild writes the window layout (background arrow, icon spots) straight into
  # .DS_Store, so no Finder window opens. Without uv, a plain DMG with the same two items.
  if command -v uvx >/dev/null; then
    uvx --from dmgbuild dmgbuild -s packaging/dmg/settings.py -D app="$APP" -D uninstaller="$UNINST" -D dmgdir="$ROOT/packaging/dmg" "Roar $VERSION" "$DMG"
  else
    echo "uvx not found: building a DMG without the background" >&2
    rm -rf "$STAGE"/*
    ditto "$APP" "$STAGE/Roar.app"
    ln -s /Applications "$STAGE/Applications"
    ditto "$UNINST" "$STAGE/Uninstall Roar.app"
    hdiutil create -quiet -volname "Roar $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
  fi

  # Notarize when the app carries a Developer ID signature and a notarytool keychain
  # profile is named (xcrun notarytool store-credentials <name>; ROAR_NOTARY_PROFILE=<name>).
  # Read the signature once: under pipefail, `codesign | grep -q` fails whenever grep exits early.
  SIGN_ID="$(codesign -dvv "$APP" 2>&1 | sed -n 's/^Authority=\(Developer ID Application.*\)/\1/p' | head -1 || true)"
  if [[ -n "$SIGN_ID" && -n "${ROAR_NOTARY_PROFILE:-}" ]]; then
    codesign --force --timestamp --sign "$SIGN_ID" "$DMG"
    xcrun notarytool submit "$DMG" --keychain-profile "$ROAR_NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
  else
    NOTARIZED=0
    echo "not notarizing: needs a Developer ID Application identity and ROAR_NOTARY_PROFILE" >&2
  fi
  [[ $ARCH == arm64 ]] && SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"

  # Sparkle appcast entry; sign_update reads the EdDSA private key from the login keychain.
  SIG="$(third_party/Sparkle/bin/sign_update "$DMG")"   # sparkle:edSignature="..." length="..."
  ITEM="    <item>
      <title>$VERSION</title>
      <pubDate>$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')</pubDate>
      <sparkle:version>$BUILD</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      <description><![CDATA[${NOTES//]]>/]]]]><![CDATA[>}]]></description>
      <enclosure url=\"https://github.com/roarbrowser/roar/releases/download/$TAG/Roar-$VERSION$SUFFIX.dmg\" type=\"application/octet-stream\" $SIG/>
    </item>"
  [[ -f $FEED ]] || sed -n '1,/<channel>/p;/<\/channel>/,$p' appcast.xml | sed '/<item>/,/<\/item>/d' >"$FEED"
  ITEM="$ITEM" perl -0pi -e 's|(\s*</channel>)|\n$ENV{ITEM}$1|' "$FEED"
  DMGS+=("$DMG") FEEDS+=("$FEED")
done
# The Homebrew cask (packaging/homebrew/roar.rb) pins this version and checksum.
sed -i '' -E "s|^  version \"[^\"]*\"|  version \"$VERSION\"|; s|^  sha256 \"[^\"]*\"|  sha256 \"$SHA\"|" packaging/homebrew/roar.rb

# Fetched before the release commit: a failed download used to leave a pushed appcast pointing at a missing DMG.
# Corresponding source the notices point to: the pinned uBO Lite zip, and Roar's CEF patches plus GN args.
UBOL_VERSION="$(sed -n "s/^VERSION='\(.*\)'/\1/p" scripts/fetch-ubol.sh)"
UBOL_ZIP="$STAGE/uBOLite_$UBOL_VERSION.chromium.zip"
curl -sfL -o "$UBOL_ZIP" "https://github.com/uBlockOrigin/uBOL-home/releases/download/$UBOL_VERSION/uBOLite_$UBOL_VERSION.chromium.zip"
echo "$(sed -n "s/^SHA256='\(.*\)'/\1/p" scripts/fetch-ubol.sh)  $UBOL_ZIP" | shasum -a 256 -c -
# Same args file the notices were generated from (arm64 CEF), so the tarball matches "the args above".
cp "$(scripts/cef-args-gn.sh third_party/cef || [[ $? == 2 ]])" "$STAGE/gn-args.txt"
GN_FILES=(gn-args.txt)
# The Intel notices name gn-args-x64.txt (gen-notices.sh), so stage the x64 CEF's args under that name.
if [[ -d third_party/cef-x64 ]]; then
  cp "$(scripts/cef-args-gn.sh third_party/cef-x64 || [[ $? == 2 ]])" "$STAGE/gn-args-x64.txt"
  GN_FILES+=(gn-args-x64.txt)
fi
tar -czf "$STAGE/roar-cef-patches.tar.gz" -C scripts cef-patches -C "$STAGE" "${GN_FILES[@]}"
UBOL_SRC="$STAGE/uBOL-home-$UBOL_VERSION.tar.gz"
curl -sfL -o "$UBOL_SRC" "https://github.com/uBlockOrigin/uBOL-home/archive/refs/tags/$UBOL_VERSION.tar.gz"
FFMPEG_REV="$(cat licenses/ffmpeg-revision)"
FFMPEG_SRC="$STAGE/ffmpeg-$FFMPEG_REV.tar.gz"
curl -sfL -o "$FFMPEG_SRC" "https://chromium.googlesource.com/chromium/third_party/ffmpeg/+archive/$FFMPEG_REV.tar.gz"
# A truncated download would ship as the GPL/LGPL source; check the archives open.
tar -tzf "$UBOL_SRC" >/dev/null
tar -tzf "$FFMPEG_SRC" >/dev/null
git add "$PLIST" "${FEEDS[@]}" packaging/homebrew/roar.rb
git commit -q -m "Release $VERSION"
git tag "$TAG"
# Tag and release first, appcast (main) last: Sparkle reads main/appcast.xml, so it must never point at a missing DMG.
git push -q origin "$TAG"

BODY="Roar-$VERSION.dmg is for Apple Silicon Macs$([[ ${#DMGS[@]} -gt 1 ]] && echo ", Roar-$VERSION-intel.dmg for Intel Macs" || true). Open the DMG and drag Roar to Applications."
[[ $NOTARIZED == 1 ]] || BODY="$BODY

The app is not notarized. On first launch, open System Settings › Privacy & Security and click Open Anyway, or run \`xattr -dr com.apple.quarantine /Applications/Roar.app\`."
[[ -n "$NOTES" ]] && BODY="$NOTES

$BODY"
gh release create "$TAG" "${DMGS[@]}" "$UBOL_ZIP" "$UBOL_SRC" "$FFMPEG_SRC" "$STAGE/roar-cef-patches.tar.gz" --title "Roar $VERSION" --notes "$BODY"
git push -q origin HEAD:main
# The tap (roarbrowser/homebrew-tap, Casks/roar.rb) is what `brew install` reads.
TAP_SHA="$(gh api repos/roarbrowser/homebrew-tap/contents/Casks/roar.rb -q .sha)"
gh api -X PUT repos/roarbrowser/homebrew-tap/contents/Casks/roar.rb -f message="roar $VERSION" \
  -f content="$(base64 < packaging/homebrew/roar.rb)" -f sha="$TAP_SHA" \
  -f 'author[name]=roarbrowser' -f 'author[email]=342802191+roarbrowser@users.noreply.github.com' \
  -f 'committer[name]=roarbrowser' -f 'committer[email]=342802191+roarbrowser@users.noreply.github.com' >/dev/null
# Windows: the main push's windows.yml run attaches the zips and installers. Wait for it, and
# re-run it for the tag if the assets still are not there (as 0.37.4 needed).
# Repo variable WINDOWS_PAUSED=1 (gh variable set) skips Windows: windows.yml publishes nothing then.
if [[ "$(gh variable get WINDOWS_PAUSED 2>/dev/null || true)" == 1 ]]; then echo "released $TAG (sha256 $SHA); Windows paused"; exit 0; fi
REL_SHA="$(git rev-parse HEAD)" RUN=
for _ in $(seq 1 30); do
  RUN="$(gh run list -w windows.yml -c "$REL_SHA" -L 1 --json databaseId -q '.[0].databaseId')"; [[ -n $RUN ]] && break; sleep 10
done
[[ -n $RUN ]] && gh run watch "$RUN" --exit-status >/dev/null || echo "windows.yml run for $REL_SHA failed or was not found" >&2
if ! gh release view "$TAG" --json assets -q '.assets[].name' | grep -q 'windows-x64-setup.exe'; then
  echo "Windows assets missing; dispatching windows.yml tag=$TAG" >&2
  LAST="$(gh run list -w windows.yml -e workflow_dispatch -L 1 --json databaseId -q '.[0].databaseId')"
  gh workflow run windows.yml --ref main -f tag="$TAG"
  # Wait for the new run: the newest one may still be an older, finished run.
  for _ in $(seq 1 30); do
    sleep 5; RUN="$(gh run list -w windows.yml -e workflow_dispatch -L 1 --json databaseId -q '.[0].databaseId')"; [[ $RUN != "$LAST" ]] && break
  done
  [[ $RUN != "$LAST" ]] || { echo "dispatched windows.yml run not found" >&2; exit 1; }
  gh run watch "$RUN" --exit-status >/dev/null
fi
echo "released $TAG (sha256 $SHA)"
