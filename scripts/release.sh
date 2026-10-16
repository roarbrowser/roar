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

# Version lives in Info.plist.in; the build number stays in step with it.
sed -i '' -E "s|(<key>CFBundleShortVersionString</key><string>)[^<]*|\1$VERSION|" "$PLIST"

# Public builds are ad-hoc signed: an Apple Development identity embeds the developer's real name.
ROAR_SIGN_IDENTITY="${ROAR_SIGN_IDENTITY:--}" bash scripts/build.sh

APP="$ROOT/build/src/Release/Roar.app"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
DMG="$ROOT/build/Roar-$VERSION.dmg"
rm -f "$DMG"
# dmgbuild writes the window layout (background arrow, icon spots) straight into
# .DS_Store, so no Finder window opens. Without uv, a plain DMG with the same two items.
if command -v uvx >/dev/null; then
  uvx --from dmgbuild dmgbuild -s packaging/dmg/settings.py -D app="$APP" -D dmgdir="$ROOT/packaging/dmg" "Roar $VERSION" "$DMG"
else
  echo "uvx not found: building a DMG without the background" >&2
  ditto "$APP" "$STAGE/Roar.app"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -quiet -volname "Roar $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
fi

# Notarize when the app carries a Developer ID signature and a notarytool keychain
# profile is named (xcrun notarytool store-credentials <name>; ROAR_NOTARY_PROFILE=<name>).
NOTARIZED=0
if codesign -dvv "$APP" 2>&1 | grep -q "Authority=Developer ID Application" && [[ -n "${ROAR_NOTARY_PROFILE:-}" ]]; then
  SIGN_ID="$(codesign -dvv "$APP" 2>&1 | sed -n 's/^Authority=\(Developer ID Application.*\)/\1/p' | head -1)"
  codesign --force --timestamp --sign "$SIGN_ID" "$DMG"
  xcrun notarytool submit "$DMG" --keychain-profile "$ROAR_NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
  NOTARIZED=1
else
  echo "not notarizing: needs a Developer ID Application identity and ROAR_NOTARY_PROFILE" >&2
fi
SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"

# Sparkle appcast entry; sign_update reads the EdDSA private key from the login keychain.
SIG="$(third_party/Sparkle/bin/sign_update "$DMG")"   # sparkle:edSignature="..." length="..."
ITEM="    <item>
      <title>$VERSION</title>
      <pubDate>$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')</pubDate>
      <sparkle:version>$VERSION</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      <description><![CDATA[${NOTES//]]>/]]]]><![CDATA[>}]]></description>
      <enclosure url=\"https://github.com/roarbrowser/roar/releases/download/$TAG/Roar-$VERSION.dmg\" type=\"application/octet-stream\" $SIG/>
    </item>"
ITEM="$ITEM" perl -0pi -e 's|(\s*</channel>)|\n$ENV{ITEM}$1|' appcast.xml
# The Homebrew cask (packaging/homebrew/roar.rb) pins this version and checksum.
sed -i '' -E "s|^  version \"[^\"]*\"|  version \"$VERSION\"|; s|^  sha256 \"[^\"]*\"|  sha256 \"$SHA\"|" packaging/homebrew/roar.rb

git add "$PLIST" appcast.xml packaging/homebrew/roar.rb
git commit -q -m "Release $VERSION"
git tag "$TAG"
git push -q origin HEAD "$TAG"

BODY="macOS (Apple Silicon) build of Roar. Open the DMG and drag Roar to Applications."
[[ $NOTARIZED == 1 ]] || BODY="$BODY

The app is not notarized. On first launch, open System Settings › Privacy & Security and click Open Anyway, or run \`xattr -dr com.apple.quarantine /Applications/Roar.app\`."
[[ -n "$NOTES" ]] && BODY="$NOTES

$BODY"
gh release create "$TAG" "$DMG" --title "Roar $VERSION" --notes "$BODY"
# The tap (roarbrowser/homebrew-roar, Casks/roar.rb) is what `brew install` reads.
TAP_SHA="$(gh api repos/roarbrowser/homebrew-roar/contents/Casks/roar.rb -q .sha)"
gh api -X PUT repos/roarbrowser/homebrew-roar/contents/Casks/roar.rb -f message="roar $VERSION" \
  -f content="$(base64 < packaging/homebrew/roar.rb)" -f sha="$TAP_SHA" >/dev/null
echo "released $TAG (sha256 $SHA)"
