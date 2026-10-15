#!/bin/bash
# Records the scratch Roar window while run-demo.mjs plays the story.
# Usage: scripts/demo/record.sh [extra run-demo.mjs args, e.g. --auto-answer]
# Output: docs/media/roar-demo.mov, .mp4 (H.264, 1280 wide) and .jpg poster.
# The terminal needs Screen Recording permission (System Settings > Privacy & Security).
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=docs/media; mkdir -p "$OUT"
SECS=${DEMO_SECONDS:-36}
PORT=9343

node scripts/demo/run-demo.mjs --headed "$@" &
DEMO=$!
# Shell window bounds in points: the sidebar reports them (Browser.getWindowForTarget finds no window in CEF).
for _ in $(seq 1 60); do
  RECT=$(node -e '
    const p = process.argv[1];
    const t = (await (await fetch(`http://127.0.0.1:${p}/json/list`)).json()).find((t) => t.url.startsWith("roar://ui/sidebar.html"));
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "[screenX, screenY, outerWidth, outerHeight].join()", returnByValue: true } }));
    console.log(await new Promise((r) => (ws.onmessage = (e) => r(JSON.parse(e.data).result.result.value))));
    process.exit(0);' --input-type=module "$PORT" 2>/dev/null) && break
  sleep 0.5
done
[ -n "${RECT:-}" ] || { echo "record: Roar never came up" >&2; kill $DEMO; exit 1; }
echo "record: window $RECT, ${SECS}s"
rm -f "$OUT/roar-demo.mov"
if ! screencapture -v -V "$SECS" -R "$RECT" -x "$OUT/roar-demo.mov" || [ ! -s "$OUT/roar-demo.mov" ]; then
  echo "record: screencapture failed (Screen Recording permission for this terminal?)" >&2
  wait $DEMO || true; exit 1
fi
wait $DEMO || true

if ! command -v ffmpeg >/dev/null; then echo "record: ffmpeg missing; only the .mov was made"; exit 0; fi
# ~1.6 Mbps keeps 36 s under 8 MB.
ffmpeg -loglevel error -y -i "$OUT/roar-demo.mov" -vf "scale=1280:-2,fps=30" -c:v libx264 -preset slow \
  -b:v 1600k -maxrate 1800k -bufsize 3600k -pix_fmt yuv420p -movflags +faststart -an "$OUT/roar-demo.mp4"
ffmpeg -loglevel error -y -ss 27 -i "$OUT/roar-demo.mp4" -frames:v 1 -q:v 3 "$OUT/roar-demo.jpg"
ls -lh "$OUT"/roar-demo.*
