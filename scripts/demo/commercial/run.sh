#!/bin/bash
# One round: render the picture, then music + effects, reporting to $ROAR_AD_STATUS for the progress band.
# Usage: scripts/demo/commercial/run.sh <capture dir> <out dir> <name>
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
export ROAR_AD_STARTED=$(node -e 'console.log(Date.now())') ROAR_AD_STEPS=2
ROAR_AD_STEP=1 node "$HERE/render.mjs" "$1" "$2/$3-picture.mp4"
ROAR_AD_STEP=2 node "$HERE/audio.mjs" "$2/$3-picture.mp4" "$2/$3.mp4"
[ -n "$ROAR_AD_STATUS" ] && node -e "const f=process.argv[1],s=JSON.parse(require('fs').readFileSync(f));s.finished=true;require('fs').writeFileSync(f,JSON.stringify(s))" "$ROAR_AD_STATUS"
echo done "$2/$3.mp4"
