#!/usr/bin/env bash
# Codec gate: fails when a CEF framework holds FFmpeg's H.264/AAC/HEVC decoders or parsers, OpenH264,
# or (checked by dSYM symbols) Chromium's own H265Parser / VideoToolbox HEVC path; ALLOW_HEVC=1 lets that last one pass.
# Roar's Mac posture: H.264 and AAC decode only through macOS VideoToolbox/AudioToolbox.
# Usage: scripts/check-no-codecs.sh <framework binary> [CEF framework .dSYM bundle]
# RELEASE=1 makes the dSYM mandatory: the shipped framework is stripped, so without it the symbol checks
# cannot run. The dSYM's UUID must match the binary, and args.gn is read from the dir holding it
# (build-cef-codecs.sh keeps both next to the installed CEF).
set -euo pipefail
F="${1:?usage: scripts/check-no-codecs.sh <framework binary> [CEF framework .dSYM bundle]}"
DSYM="${2:-}"
die() { echo "check-no-codecs: $*" >&2; exit 1; }
[[ -f $F ]] || die "$F not found"
# ALLOW_HEVC=1 is for local builds only: shipping HEVC needs clearance, not an env override.
[[ ${RELEASE:-} == 1 && -n ${ALLOW_HEVC:-} ]] && die "RELEASE=1 refuses ALLOW_HEVC; unset it"
if [[ ${RELEASE:-} == 1 && -z $DSYM ]]; then die "RELEASE=1 needs the framework's dSYM (build-cef-codecs.sh keeps it next to the installed CEF)"; fi
DWARF= ARGS_GN=
if [[ -n $DSYM ]]; then
  [[ -d $DSYM ]] || die "dSYM $DSYM not found"
  DWARF="$(ls "$DSYM"/Contents/Resources/DWARF/* 2>/dev/null | head -1)"
  [[ -f $DWARF ]] || die "no DWARF file inside $DSYM"
  U_BIN="$(dwarfdump --uuid "$F" | awk '{print $2}' | sort)"
  U_SYM="$(dwarfdump --uuid "$DWARF" | awk '{print $2}' | sort)"
  [[ -n $U_BIN && $U_BIN == "$U_SYM" ]] || die "dSYM UUID ($U_SYM) does not match $F ($U_BIN)"
  ARGS_GN="$(dirname "$DSYM")/args.gn"
  [[ -f $ARGS_GN ]] || die "no args.gn next to $DSYM"
fi
SYMS=' _(ff_h264_decoder|ff_h264_parser|ff_aac_decoder|ff_aac_parser|ff_aac_demuxer|ff_aac_sbr_apply|ff_ps_apply|ff_hevc_decoder|ff_hevc_parser|ff_hevc_demuxer|WelsCreateSVCEncoder)$'
# Strings these leave behind work on the stripped binary; nm on the matching dSYM is the symbol-level check.
HITS="$( { strings -a "$F" | grep -E -o 'H264 Decoder|AAC decoder|CWelsH264SVCEncoder|H264DecoderImpl|x264_build|H265Parser' || true
  for B in "$F" ${DWARF:+"$DWARF"}; do nm -a "$B" 2>/dev/null | grep -E -o "$SYMS" || true; done; } | sort | uniq -c)"
[[ -z $HITS ]] || die "$(printf '%s contains FFmpeg/OpenH264 codec code (Mac builds must decode H.264/AAC through macOS):\n%s' "$F" "$HITS")"
# Without a dSYM, nm sees nothing on the stripped binary, so only the H.264/AAC strings were checked.
if [[ -n $DWARF ]]; then echo "check-no-codecs: no FFmpeg H.264/AAC/HEVC decoder or parser and no OpenH264 in $F (dSYM UUID verified)"
else echo "check-no-codecs: no H.264/AAC/OpenH264 strings in $F (no dSYM: HEVC and symbol checks not run)"; fi
# Chromium's own HEVC parser + VideoToolbox HEVC path is a separate residual, removed by
# enable_hevc_parser_and_hw_decoder=false (set in build-cef-codecs.sh).
# args.gn can be edited after the build, so the dSYM's symbols decide; args.gn only explains a hit.
if [[ -n $DWARF ]]; then
  H265="$(nm -a "$DWARF" 2>/dev/null | grep -c 'H265Parser' || true)"
  if [[ $H265 == 0 ]]; then
    echo "check-no-codecs: no H265Parser symbols in the dSYM (HEVC parser/hardware decoder disabled)"
  else
    grep -Eq '^[[:space:]]*enable_hevc_parser_and_hw_decoder[[:space:]]*=[[:space:]]*false' "$ARGS_GN" && NOTE="args.gn sets the flag but this binary predates it" || NOTE="$ARGS_GN does not set enable_hevc_parser_and_hw_decoder=false"
    [[ ${ALLOW_HEVC:-} == 1 ]] || die "$H265 H265Parser symbols in the dSYM (Chromium HEVC parser/VideoToolbox HEVC path); $NOTE. Rebuild CEF, or set ALLOW_HEVC=1 only once shipping HEVC is cleared"
    echo "check-no-codecs: WARNING: ALLOW_HEVC=1: $H265 H265Parser symbols in the dSYM; $NOTE" >&2
  fi
fi
