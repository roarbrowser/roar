# Demo video (30 seconds)

An agent plans a lion safari in Roar: it opens pages that land as sidebar tabs, reports
what it found, asks before booking, and one click answers. Everything runs through the
bundled MCP server (`roar-mcp.sh`) against a scratch Roar; nothing is really booked.

## Shot list

| Time | On screen | MCP call |
|------|-----------|----------|
| 0–3 s | Empty scratch Roar, sidebar visible | `initialize` (client "claude") |
| 3–7 s | "Lion" (Wikipedia) appears as a sidebar tab | `new_page` |
| 7–11 s | "Serengeti National Park" tab | `new_page` |
| 11–15 s | github.com/roarbrowser/roar tab | `new_page` |
| 15–19 s | Green "done" card: *Found 3 flights under $400* (JFK → JRO, $386), with Open | `notify_user` level `done` |
| 19–26 s | Question card: *Book the 8:05 AM flight for $386?* [Book it] [Not yet] | `ask_user` |
| ~26 s | Click **Book it**; card resolves | (user click) |
| 26–30 s | *Booked. Confirmation sent to your email.* | `notify_user` level `done` |

## Running it

Needs Node 22+ and a built `build/src/Release/Roar.app` (`bash scripts/build.sh`).
The scratch Roar uses CDP port 9343 and a fresh data dir under `demo-run/` in the
temp dir (pass another path as the last argument). It never touches port 9222 or
`/Applications/Roar.app`.

- **Unattended check** (headless, no window): `node scripts/demo/run-demo.mjs --auto-answer`.
  Prints each MCP tool result and exits 0 when every step succeeded. `--auto-answer`
  implies `--headless`; add `--headed` to see it.
- **Manual run:** `node scripts/demo/run-demo.mjs --headed` and click **Book it** yourself.
  Add `--keep` to leave Roar open afterwards.
- **Recording** (maintainer, on a clean desktop): `scripts/demo/record.sh` (add
  `--auto-answer` to click for you; it still runs headed). It records the Roar window
  for `DEMO_SECONDS` (default 36) with `screencapture -v -R`, then writes
  `docs/media/roar-demo.mov`, `roar-demo.mp4` (H.264, 1280 wide, ~7 MB max) and
  `roar-demo.jpg` (poster at 27 s, the booked card). The terminal needs Screen Recording
  permission. Recording takes the screen region, so whatever covers Roar is recorded too.

## Clean recording tips

- Set the display to 1440x900 (or a scaled mode near it) and Roar's window to fill it.
- Dark mode on; Do Not Disturb on; hide the Dock and desktop icons.
- Quit or hide other apps so nothing overlaps the Roar window.
- Do a dry run first: the first page loads warm the cache so tabs fill in quickly.
- A manual click on **Book it** looks more natural than `--auto-answer`; click within
  ~5 s of the card appearing to keep the cut near 30 s.
