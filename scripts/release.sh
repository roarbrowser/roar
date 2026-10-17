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
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ROAR_NOTARY_PROFILE="${ROAR_NOTARY_PROFILE:-roar-notary}"
NOTARIZED=1 DMGS=() FEEDS=()
for ARCH in "${ARCHES[@]}"; do
  if [[ $ARCH == x64 ]]; then APP="$ROOT/build-x64/src/Release/Roar.app" SUFFIX=-intel FEED=appcast-intel.xml
  else APP="$ROOT/build/src/Release/Roar.app" SUFFIX= FEED=appcast.xml; fi
  ROAR_ARCH=$ARCH ROAR_RELEASE=ON ROAR_SIGN_IDENTITY="${ROAR_SIGN_IDENTITY:-${DEVID:--}}" bash scripts/build.sh
  DMG="$ROOT/build/Roar-$VERSION$SUFFIX.dmg"
  rm -f "$DMG"
  # dmgbuild writes the window layout (background arrow, icon spots) straight into
  # .DS_Store, so no Finder window opens. Without uv, a plain DMG with the same two items.
  if command -v uvx >/dev/null; then
    uvx --from dmgbuild dmgbuild -s packaging/dmg/settings.py -D app="$APP" -D dmgdir="$ROOT/packaging/dmg" "Roar $VERSION" "$DMG"
  else
    echo "uvx not found: building a DMG without the background" >&2
    rm -rf "$STAGE"/*
    ditto "$APP" "$STAGE/Roar.app"
    ln -s /Applications "$STAGE/Applications"
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

git add "$PLIST" "${FEEDS[@]}" packaging/homebrew/roar.rb
git commit -q -m "Release $VERSION"
git tag "$TAG"
git push -q origin HEAD "$TAG"

BODY="Roar-$VERSION.dmg is for Apple Silicon Macs$([[ ${#DMGS[@]} -gt 1 ]] && echo ", Roar-$VERSION-intel.dmg for Intel Macs" || true). Open the DMG and drag Roar to Applications."
[[ $NOTARIZED == 1 ]] || BODY="$BODY

The app is not notarized. On first launch, open System Settings › Privacy & Security and click Open Anyway, or run \`xattr -dr com.apple.quarantine /Applications/Roar.app\`."
[[ -n "$NOTES" ]] && BODY="$NOTES

$BODY"
gh release create "$TAG" "${DMGS[@]}" --title "Roar $VERSION" --notes "$BODY"
# The tap (roarbrowser/homebrew-tap, Casks/roar.rb) is what `brew install` reads.
TAP_SHA="$(gh api repos/roarbrowser/homebrew-tap/contents/Casks/roar.rb -q .sha)"
gh api -X PUT repos/roarbrowser/homebrew-tap/contents/Casks/roar.rb -f message="roar $VERSION" \
  -f content="$(base64 < packaging/homebrew/roar.rb)" -f sha="$TAP_SHA" \
  -f 'author[name]=Roar' -f 'author[email]=roarbrowser@gmail.com' \
  -f 'committer[name]=Roar' -f 'committer[email]=roarbrowser@gmail.com' >/dev/null
echo "released $TAG (sha256 $SHA)"
