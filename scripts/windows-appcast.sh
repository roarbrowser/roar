#!/usr/bin/env bash
# Writes appcast-windows-<arch>.xml (the WinSparkle feed on main) for one release installer; windows.yml's
# appcast job runs it. A feed that already offers this exact installer (same version, length and EdDSA
# signature, which is deterministic) is left untouched, so a re-run never commits a pubDate-only change.
# Usage: scripts/windows-appcast.sh <tag> <arch> <build number> <installer> <edSignature> <owner/repo>
set -euo pipefail
TAG=$1 ARCH=$2 BUILD=$3 FILE=$4 SIG=$5 REPO=$6
SHORT=${TAG#v} NAME=$(basename "$FILE") FEED=appcast-windows-$ARCH.xml
LEN=$(($(wc -c <"$FILE")))
NEW="$(mktemp)"
trap 'rm -f "$NEW"' EXIT
cat >"$NEW" <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Roar for Windows ($ARCH)</title>
    <item>
      <title>Roar $SHORT</title>
      <sparkle:releaseNotesLink>https://github.com/$REPO/releases/tag/$TAG</sparkle:releaseNotesLink>
      <pubDate>$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')</pubDate>
      <enclosure url="https://github.com/$REPO/releases/download/$TAG/$NAME" sparkle:version="$BUILD" sparkle:shortVersionString="$SHORT" sparkle:os="windows" sparkle:installerArguments="/SILENT /SP- /NOCANCEL /NORESTART" sparkle:edSignature="$SIG" length="$LEN" type="application/octet-stream"/>
    </item>
  </channel>
</rss>
XML
if [[ -f $FEED ]] && cmp -s <(grep -v '<pubDate>' "$FEED") <(grep -v '<pubDate>' "$NEW"); then
  echo "$FEED already offers $TAG with this installer; left as is"
else
  mv "$NEW" "$FEED"
  echo "$FEED now offers $TAG ($NAME, $LEN bytes)"
fi
