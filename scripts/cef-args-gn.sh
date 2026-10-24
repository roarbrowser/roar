#!/usr/bin/env bash
# Prints the GN args file describing the CEF in <cef dir>: the args.gn build-cef-codecs.sh keeps beside it,
# else licenses/cef-args.gn (exit 2: fallback, the full args.gn is unavailable for this build).
# Shared by gen-notices.sh (the notices) and release.sh (gn-args.txt in roar-cef-patches.tar.gz).
set -euo pipefail
ROOT="${ROAR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CEF_DIR="${1:-$ROOT/third_party/cef}"
if [[ -f "$CEF_DIR/args.gn" ]]; then echo "$CEF_DIR/args.gn"; else echo "$ROOT/licenses/cef-args.gn"; exit 2; fi
