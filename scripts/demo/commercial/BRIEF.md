# "A day in Roar": brief and storyboard

**Business:** Roar, a free, open-source (MIT) Chromium browser for Apple Silicon Macs. **Buyer:** developers who already use an AI agent.
**Core message:** Roar connects straight to the AI you already use (your own agent, over MCP), and that agent drives the real browser, in your signed-in tabs, woven into an ordinary day of browsing.
**CTA:** roarbrowser.app. **Length:** 45 s, 16:9, 1920x1080 at 30 fps, with voiceover (`VO.md`).
**True and shown:** spaces (Work, Personal), pinned tabs, a tab group, split view, reader mode, the ⌘T command bar searching inside open tabs; the built-in MCP server; the agent fills a form in a tab the person is signed in to (Agent badge on the tab), asks with buttons in the sidebar (`ask_user`), reports there (`notify_user`); a space with agents switched off is unreachable (`use_profile` refused, "Agents can't reach this space").
**Real assets:** every Roar UI frame and page is a screenshot of a headless scratch Roar (`capture.mjs`) driven by the real roar-mcp. Pages are fictional demo sites in `day/` served at *.example hosts (Postbox mail, Daybook calendar, Lumen wiki/board/metrics, Harbor Hall venue portal, Pantry, Northwind Air). Nothing is booked or paid.
**Composed:** desktop, menu bar and clock, window frame and traffic lights, camera, captions, the prompt bubble ("you, to your AI"), end card.
**Never claim:** a particular agent brand, speed, security certifications, user counts, or Windows/Linux support. No third-party logos, no implied affiliation (docs/brand/BRAND.md).
**Brand:** ground #1e140c, ink #fbeedd, mane #ff9a2e, sun #ffc72c, mint #7aa898; rounded system type; the lion mark.

| t (s) | Viewer sees | Job | Out |
|---|---|---|---|
| 0–3 | 8:58 AM; dimmed Roar window; "Your browser. / Your AI drives it." | Hook | Window brightens |
| 3–5.6 | Wide: Postbox inbox, pinned mail + calendar, loose tabs, module buttons in the footer | What Roar is | Push to the footer |
| 5.6–8.7 | Unread mail module: four rows, one showing Read / Move / Delete | Add-on module | Slide to the next list |
| 8.7–10.9 | Pull requests module | Add-on module | Pull back |
| 10.9–13.7 | Split view: inbox beside the onboarding spec | Split view | Push into the spec |
| 13.7–15.2 | Reader mode of the spec | Reader | Bar drops in |
| 15.4–17 | ⌘T bar: "offsite" found inside mail, calendar and spec | Command bar | Bar lifts away |
| 17.2–21.3 | "you, to your AI": book the Loft, ask before paying | Your own AI | Bubble flies to where the group appears |
| 21.3–24.4 | The agent's `new_page` calls make a "Q3 offsite" group: one tab, then two, Agent badges | AI groups its tabs | Into the venue tab |
| 24.4–27.4 | The booking form fills field by field (focus ring) | Drives signed-in tabs | Pull back |
| 27.4–30.5 | The AI section's session row; its session view split beside the form, showing progress | Watch it inside Roar | Back to the inbox |
| 30.6–33.6 | Ask card grows out of the sidebar; cursor presses Approve | Asks first | Push to the group header |
| 33.6–37.5 | `rename_item`: "Q3 offsite" becomes "Offsite: Harbor Hall booked"; then "Venue booked" card | AI renames the group; reports | Dusk falls |
| 37.6–41 | 7:40 PM, Personal space; "Agents can't reach this space"; Allow agents off | Per-space control | Window falls away |
| 41.2–45 | Lion mark, Roar, roarbrowser.app, free and open source, Apple Silicon | CTA | — |

**Module data:** the unread-mail and pull-request modules and the agent session are fed mock data in the scratch instance only (`capture.mjs` MOCK, a stand-in session file); their brand icons are swapped for plain glyphs and CLI names read "Agent". No real account is touched.

Signature transformations: the blurred hook becomes the working window; the prompt becomes the agent's tab; the question card becomes the done card; morning light becomes dusk.

**Gauntlet ledger (40 s cut):** storyboard critic round 1: stranger test PASS; REVISE (an implied enforced ask rule, "never left your inbox" chronology, three VO lines too long) — all four applied.

**Gauntlet ledger (45 s cut):** critic 3 ONE MORE PASS (blank panes beside sidebar close-ups, captions not matching VO, music not lifting on the end card, dissolves, cropped form, small ⌘T and fine print) → page dimmed in close-ups, captions = VO word for word, end-card chime (reused bed, no new music credits), faster state cuts, wider form framing, larger ⌘T and fine print. Critic 4 ONE MORE PASS: panes and captions FIXED; remaining short camera-move overlaps at 21.3/27.4/33.6 and a cut-off quote pane → camera moves shortened and form framing widened in the final render, not re-judged.

**Script and voice round (2026-10-23):** copy-that-sells diagnostic: idea not sharp (15 disconnected feature lines) → restructured around one throughline ("hand the hunt to your own AI"). Voice auditions on lines 1 and 15: Brian (deepest, but rushed the end line), Bill (higher, ad read), Alec (documentary narrator, low and unhurried) → Alec. Mix: voice +9 dB, bed duck -14 dB held across gaps under 1.6 s, effects pulled back, end card under the last line. Critics 5 and 6 ONE MORE PASS (voice buried, swells between lines) → fixed; critic 7 SHIP.

**Narration round (2026-10-23, v3):** eight flowing sentences, read by David (ElevenLabs library wildlife narrator); auditioned Connery (clips came back a fixed 3.0 s, unreliable) and Alec. The slower read sets the length to 51.4 s: film.html's WARP maps the picture's 45 s clock onto the sentences. Every line is loudness-matched; bed duck -14 dB held across gaps. Critics 8 and 9 ONE MORE PASS (bed far too low, then too high; menu overlap) → fixed; critic 10 SHIP.
