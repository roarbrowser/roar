#!/usr/bin/env bash
# Re-vendors the licence files listed in licenses/bun-deps.tsv (run after bumping BUN_VERSION and the refs).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/licenses/bun-deps"
mkdir -p "$OUT"
grep -v '^#' "$ROOT/licenses/bun-deps.tsv" | while IFS=$'\t' read -r name repo ref file marker; do
  dest="$OUT/$name-$(basename "$file")"
  gh api "repos/$repo/contents/$file?ref=$ref" -H "Accept: application/vnd.github.raw" >"$dest"
  # picohttpparser ships no licence file; its licence is the header comment.
  [[ $name == picohttpparser ]] && sed -i '' '/\*\//q' "$dest"
  grep -qF -- "$marker" "$dest" || { echo "fetch-bun-licenses.sh: marker \"$marker\" not in $dest" >&2; exit 1; }
done
