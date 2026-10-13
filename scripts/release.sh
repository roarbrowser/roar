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

bash scripts/build.sh

APP="$ROOT/build/src/Release/Roar.app"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
DMG="$ROOT/build/Roar-$VERSION.dmg"
rm -f "$DMG"
ditto "$APP" "$STAGE/Roar.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Roar $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG"

git add "$PLIST"
git commit -q -m "Release $VERSION"
git tag "$TAG"
git push -q origin HEAD "$TAG"

BODY="macOS (Apple Silicon) build of Roar. Open the DMG and drag Roar to Applications.

The app is not notarized. On first launch, right-click Roar → Open, or run \`xattr -dr com.apple.quarantine /Applications/Roar.app\`."
[[ -n "$NOTES" ]] && BODY="$NOTES

$BODY"
gh release create "$TAG" "$DMG" --title "Roar $VERSION" --notes "$BODY"
echo "released $TAG"
