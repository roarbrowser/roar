#!/usr/bin/env bash
# Notices completeness gate: every Mach-O file and npm package in Roar.app must map to a
# heading line in THIRD_PARTY_NOTICES.txt whose licence text (a marker line from it) is also there, and
# every Mach-O file must be listed in scripts/notices-macho-files.txt, so a new binary needs a review.
# CREDITS.html (Chromium's per-component licences) must be bundled and cover ANGLE and SwiftShader.
#   scripts/check-notices.sh <Roar.app> [notices file, default: the app's bundled copy]
set -euo pipefail
APP="${1:?usage: check-notices.sh <Roar.app> [THIRD_PARTY_NOTICES.txt]}"
C="$APP/Contents"
NOTICES="${2:-$C/Resources/THIRD_PARTY_NOTICES.txt}"
[[ -f "$NOTICES" ]] || { echo "check-notices.sh: no notices file $NOTICES" >&2; exit 1; }
# heading <relative path>: "<heading (start of a line)>|<line of its licence text>" covering this file.
heading() {
  case "$1" in
    MacOS/Roar|Frameworks/Roar\ Helper*.app/*) echo "Roar (MIT License)|Permission is hereby granted, free of charge" ;;
    Frameworks/Chromium\ Embedded\ Framework.framework/*) echo "Chromium Embedded Framework (CEF)|Marshall A. Greenblatt" ;;
    Frameworks/Sparkle.framework/*) echo "Sparkle|Andy Matuschak" ;;
    Resources/roar-mcp) echo "JavaScriptCore (GNU Library General Public License v2|GNU LIBRARY GENERAL PUBLIC LICENSE" ;;
    Resources/roar-dictate) echo "FluidAudio $FLUIDAUDIO_VERSION (Apache License 2.0)|Version 2.0, January 2004" ;;
    Resources/roar-mcp-modules/chrome-devtools-mcp) echo "chrome-devtools-mcp|Version 2.0, January 2004" ;;
    Resources/extensions/ubol/*) echo "GNU General Public License v3.0 (full text)|Version 3, 29 June 2007" ;;
    *) echo "" ;;
  esac
}
FLUIDAUDIO_VERSION="$(awk -F'"' '/"version"/{print $4; exit}' "$(dirname "$0")/../dictate/mac/Package.resolved")"
has() { H="$1" awk 'index($0, ENVIRON["H"]) == 1 { f = 1; exit } END { exit !f }' "$NOTICES"; }
# section <heading>: the body of the first section whose heading line starts with it (up to the next rule),
# (grep without -q: its early exit would fail the pipe under pipefail), so a licence marker shared by several sections (Apache "Version 2.0, January 2004") counts only in its own.
section() { H="$1" awk '!f && index($0, ENVIRON["H"]) == 1 { f = 1; next } f == 1 && /^=+$/ { f = 2; next } f == 2 && /^=+$/ { exit } f == 2' "$NOTICES"; }
EXPECTED="$(dirname "$0")/notices-macho-files.txt"
UNMAPPED=0 N=0
check() {  # check <kind> <relative path>
  N=$((N + 1))
  local hm h m; hm="$(heading "$2")" h="${hm%%|*}" m="${hm#*|}"
  if [[ -z "$hm" ]] || ! has "$h"; then echo "unmapped $1: $2${h:+ (no heading \"$h\")}"; UNMAPPED=$((UNMAPPED + 1))
  elif ! section "$h" | grep -F -- "$m" >/dev/null; then echo "unmapped $1: $2 (heading \"$h\" but no licence text \"$m\")"; UNMAPPED=$((UNMAPPED + 1))
  elif [[ $1 == mach-o ]] && ! grep -qxF -- "$2" "$EXPECTED"; then echo "new $1: $2 (review its licence, then add it to $EXPECTED)"; UNMAPPED=$((UNMAPPED + 1)); fi
  # roar-mcp also carries every library Bun links statically (TinyCC's LGPL-2.1 among them).
  [[ $2 == Resources/roar-mcp ]] || return 0
  while IFS=$'\t' read -r name repo ref file m; do
    h="Bun component: $name $(basename "$file")"
    has "$h" && section "$h" | grep -F -- "$m" >/dev/null || { echo "unmapped $1: $2 (no \"$h\" section with \"$m\")"; UNMAPPED=$((UNMAPPED + 1)); }
  done < <(grep -v '^#' "$(dirname "$0")/../licenses/bun-deps.tsv")
}
while IFS= read -r -d '' f; do
  [[ "$(head -c 4 "$f" | xxd -p)" =~ ^(cffaedfe|cefaedfe|feedfacf|feedface|cafebabe|bebafeca)$ ]] && check mach-o "${f#$C/}"
done < <(find "$C" -type f -size +3c -print0)
# npm packages: each folder holding a package.json (nested node_modules included).
while IFS= read -r -d '' p; do check npm "$(dirname "${p#$C/}")"; done < <(find "$C" -name package.json -print0)
# The 0.37.14 supplement must carry every Bun component (TinyCC included) section verbatim.
SUPP="$(dirname "$0")/../legal/roar-0.37.14-notices-supplement.md"
trim() { awk 'NF { f = 1 } f { b = b $0 "\n"; if (NF) { printf "%s", b; b = "" } }'; }
while IFS= read -r h; do
  # The rule is exactly 80 '=': libjpeg-turbo's licence has shorter '=' underlines of its own.
  want="$(H="$h" R="$(printf '=%.0s' {1..80})" awk '!f && index($0, ENVIRON["H"]) == 1 { f = 1; next } f == 1 && $0 == ENVIRON["R"] { f = 2; next } f == 2 && $0 == ENVIRON["R"] { exit } f == 2' "$NOTICES" | trim)"
  got="$(H="$h" awk '!f && /^### / && index($0, ENVIRON["H"]) { f = 1; next } f == 1 && /^````/ { f = 2; next } f == 2 && /^````/ { exit } f == 2' "$SUPP" | trim)"
  [[ -n "$got" && "$got" == "$want" ]] || { echo "supplement: \"$h\" $([[ -n $got ]] && echo differs from the notices || echo missing) in $SUPP"; UNMAPPED=$((UNMAPPED + 1)); }
done < <(grep -E '^Bun component: ' "$NOTICES")
CREDITS="$(dirname "$NOTICES")/CREDITS.html"
for c in ANGLE SwiftShader; do grep -qi "$c" "$CREDITS" 2>/dev/null || { echo "missing: $c in $CREDITS"; UNMAPPED=$((UNMAPPED + 1)); }; done
echo "check-notices.sh: $N items checked, $UNMAPPED unmapped"
[[ $UNMAPPED == 0 ]]
