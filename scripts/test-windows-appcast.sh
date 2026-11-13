#!/bin/bash
# scripts/windows-appcast.sh: rebuilds the committed Windows feed from its own values, leaves the feed
# alone when it already offers the same installer, and rewrites it for a new one. No network, no keys.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail=0; check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
feed="$root/appcast-windows-x64.xml"
attr() { sed -n "s/.* $1=\"\([^\"]*\)\".*/\1/p" "$feed"; }
tag="v$(attr sparkle:shortVersionString)" build="$(attr sparkle:version)" sig="$(attr sparkle:edSignature)" len="$(attr length)"
cd "$t"
dd if=/dev/null of=Roar-windows-x64-setup.exe bs=1 seek="$len" 2>/dev/null   # sparse, same length as the real one
bash "$root/scripts/windows-appcast.sh" "$tag" x64 "$build" Roar-windows-x64-setup.exe "$sig" roarbrowser/roar >/dev/null
check "rebuilds the committed feed (all but pubDate)" 'cmp -s <(grep -v "<pubDate>" appcast-windows-x64.xml) <(grep -v "<pubDate>" "$feed")'
cp appcast-windows-x64.xml before.xml; sleep 1
out="$(bash "$root/scripts/windows-appcast.sh" "$tag" x64 "$build" Roar-windows-x64-setup.exe "$sig" roarbrowser/roar)"
check "same installer again: feed untouched, pubDate too ($out)" 'cmp -s before.xml appcast-windows-x64.xml && [[ $out == *"left as is"* ]]'
bash "$root/scripts/windows-appcast.sh" "$tag" x64 "$build" Roar-windows-x64-setup.exe "other$sig" roarbrowser/roar >/dev/null
check "a rebuilt installer (new signature) rewrites the feed" 'grep -qF "sparkle:edSignature=\"other$sig\"" appcast-windows-x64.xml'
exit $fail
