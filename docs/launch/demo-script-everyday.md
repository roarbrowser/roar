# Roar: "It works where you can see it" (everyday cut)

**Logline:** You ask your AI assistant to plan a rainy Saturday. It opens real tabs in a space you let it use, and you watch it work. It tells you what it found and asks before doing more. It can't see your personal space or your private tabs.

**Runtime:** about 52 s, landscape 16:9. A 1:1 crop must also work, so captions stay in the centre-safe area.

**Landing-page label:** "For everyone". The technical cut is labelled "For developers". One cut is picked at random on load, and only one plays at a time.

**Mood and music:** original warm acoustic-electronic music at about 90 BPM, with soft plucks and light brushes. The first 1.5 s is silent. A gentle swell starts at the ask card (shot 6) and resolves on the end card. Captions carry the whole story, so the film works with the sound off.

## The user's prompt (caption)

> **You → Claude**
> "Rainy Saturday in Chicago. Find 3 museums and check their hours."

This is a styled chat bubble, not a copy of the Claude app. It uses Roar's colours, a small "You → Claude" label and no Anthropic UI.

## Shot table

| # | Time | On screen | What really happens (exact) | Caption bubble | Camera |
|---|---|---|---|---|---|
| 1 | 0–4s | Prompt bubble over the dimmed, empty "Saturday" space in the sidebar. | Nothing. Caption only. `use_profile {name:"Saturday"}` already ran off camera, so no "Which profile?" card appears. | Prompt (above) | Bubble centred, sidebar dimmed behind it |
| 2 | 4–8s | The bubble lifts away. A tab slides into "Saturday" by itself and its favicon loads. | `new_page {url:"https://www.artic.edu/visit"}` | "I asked Claude to plan Saturday." | Sidebar fills the frame, then pulls back to the window by 8s |
| 3 | 8–15s | Two more tabs land, and each page renders in the active tab. | `new_page {url:"https://www.fieldmuseum.org/visit"}`, then `new_page {url:"<Shedd visit URL pinned in dry run>"}`. Fallback: https://www.msichicago.org | "It opens real tabs. Right here." | Sidebar rows, then the full window |
| 4 | 15–22s | The Field Museum tab comes forward and the page scrolls to its hours. The synthetic cursor then scrolls a little more by hand. | `select_page {pageId:<field>}`, `take_snapshot`, then `click {uid:<"Hours" link>}` if the page has one, otherwise `evaluate_script` with `scrollIntoView({block:'center'})` on the hours heading. Nothing is drawn on the page. The hand scroll is CDP `Input.dispatchMouseEvent` type `mouseWheel` on the tab. | "Watch it work. Jump in anytime." | Slow 1.5–2× zoom onto the hours text as it really appears |
| 5 | 22–28s | A "done" card appears at the top of the sidebar, with the page still visible behind it. | `notify_user {level:"done", title:"3 museums found", body:"<hours copied verbatim from the three snapshots on shoot day>"}` | "It tells you what it found." | Zoom on the card, then a cut to the page showing the same hours |
| 6 | 28–35s | A question card with Yes / Not now buttons. The cursor clicks Yes and a 4th tab lands. | `ask_user {question:"Open the Field Museum's map for your visit?", choices:["Yes","Not now"]}` waits for the click, a real CDP mouse press/release on the card in `sidebar.html`. It returns "Yes", then `new_page {url:"<real map/floor-plan URL found in dry run>"}`. If there is no map page, the question becomes "Open the Shedd's visit page?" with a checked URL. | "It asks first. You decide." | Card at 1.5×, cursor-follow, then the sidebar |
| 7 | 35–42s | The cursor clicks the "Personal" space, which shows its one tab (Wikipedia: Rain). A panel on the right lists what the assistant can see: the 4 Saturday page titles and nothing from Personal. | A real sidebar click over CDP. Then `list_pages` from a separate MCP session that does **not** run with `ROAR_UI_CDP=1` (see production notes). The panel shows the page titles that came back, labelled "What Claude can see (titles only)". | "Your personal space? Off limits." | Split: sidebar left, list panel right |
| 8 | 42–46s | Hold on the sidebar's Ghost group, where a private tab (weather.gov) sits. `list_pages` runs again and the panel is unchanged. | The ghost tab was opened off camera before the take. `list_pages` is re-run live. | "Private tabs stay invisible to it." | Zoom on the Ghost row, panel stays |
| 9 | 46–52s | End card. | Nothing | "Your browser. Your AI. You stay in charge." | Static, URL held for at least 3 s |

Two rules for shot 8: the ghost tab is never described as part of Personal, and no caption says anything about deleting it.

## End card

- **Roar**
- "Your browser. Your AI. You stay in charge."
- "Free for Mac · github.com/roarbrowser/roar"
- Small print: "Works with Claude Desktop and other apps that support MCP."

## Credits and disclosure

These lines stay on the end card in small print for at least 3 s:

> The prompt is shown as a caption; the AI app's window isn't filmed. The assistant's requests were sent by a script standing in for Claude, written to match the prompt. Every action in Roar is real, on public sites with no sign-ins, filmed [shoot date]. Hours as shown that day. Roar's own pages removed from the page list. Sped up where marked.

Any compressed wait gets a "2×" corner tag. The cut is never called "unedited".

## Agent app: Claude Desktop, not Muse

The story names **Claude Desktop**. Three reasons:

- Roar already supports it: spec `claude-desktop` in `src/agent_connect.cc` writes `mcpServers` into `~/Library/Application Support/Claude/claude_desktop_config.json`, and Settings shows a one-click Connect for it.
- Meta's consumer Muse app runs its tools on Meta's own cloud VM. From there it can only reach remote streamable-HTTP MCP servers, and Roar's server is local (stdio, talking to CDP on 127.0.0.1). So Muse cannot drive Roar.
- Muse Code (the CLI) has an `mcp_servers` block in `~/.config/muse/settings.json`, but the only examples I found are remote `url` entries. I found no confirmed stdio entry, and Muse isn't installed here to test.

Naming Muse would break the no-misleading rule. It appears nowhere on screen or in the credits.

## Muse support spec

**Not yet.** Don't add a Muse row until a real install or Meta's own docs confirm a local stdio entry and its exact keys. When they do, it is one row in `Specs()` in `src/agent_connect.cc`:

- id `"muse"`, name `"Muse Code"`, `Format::kJson`
- config `.config/muse/settings.json`, detected by the `.config/muse` folder
- key `{"mcp_servers"}`
- a new `MuseEntry`, probably `command`, `args` and `enabled: true`

The JSON merge has to keep `schema_version` and any existing servers. No `welcome.html` change is needed, because `renderAgents` builds the list from that data.

If Muse turns out to support remote servers only, leave it off the list. A copy-only row that can never connect would mislead. The consumer Muse app can't be supported at all unless Roar ships a remote MCP endpoint, which is out of scope.

## Features in and out

**In:**
- Assistant pages appearing as sidebar tabs (`new_page`)
- Hand scroll ("jump in anytime")
- The `notify_user` done card, quoting what the pages said
- The `ask_user` round trip that leads to a real 4th tab
- A space with Allow agents off, hidden from `list_pages` (`AgentMayReach`)
- The ghost tab hidden from the assistant
- Claude Desktop as the named app

**Out:**
- **Claude Code panel, terminals, MCP/CDP jargon:** the panel is switched off in this cut.
- **Muse:** not supported.
- **Bookings, tickets, prices:** none of it would be real.
- **Auto-archive, reader mode, ad blocking:** they don't serve this story, and we have no honest numbers for them.
- **Split view, PiP, native menus, macOS notifications, the default-browser prompt:** native windows that can't be filmed, or that never show when Roar runs headless.
- **Command bar:** a separate window that may not be captured.
- **Arc import:** would need someone's real data.
- **Settings Connect shot:** optional. Film it only if Claude Desktop is really detected on the scratch machine.

## Production notes (capture script)

1. **Two Roar connections for honesty.** Film the UI from a headless scratch Roar run with `ROAR_UI_CDP=1` and a fresh `ROAR_DATA_DIR`. With that switch on, `list_pages` also returns Roar's own `roar://ui/*` pages. So for the shot 7–8 panel, either:
   - run `list_pages` from a second identical scratch setup without `ROAR_UI_CDP=1`, or
   - filter `roar://` entries out of the panel. The credits line already says Roar's own pages were removed.

   Never invent entries.
2. **Turn the Claude Code panel off.** Set the `claudeSidebar` setting to false in the scratch instance's settings before launch. Headless or test instances never install the hooks anyway.
3. **Off-camera setup, in this order:**
   - Create "Personal" (Allow agents off) with the tab https://en.wikipedia.org/wiki/Rain.
   - Create "Saturday" (Allow agents on).
   - Open a ghost tab on https://www.weather.gov. The ghost command opens the command bar, so drive it from there or through AppleScript, then confirm the Ghost row shows in the `sidebar.html` screencast.
   - Call `use_profile {name:"Saturday"}`.
   - Start a **fresh** roar-mcp session after Personal is set to agents-off, so no earlier attachment can leak into `list_pages`.
4. **Neutral client name.** Set roar-mcp's `clientInfo.name` to "Claude" only together with the credits line about a stand-in script. Otherwise use a neutral name such as "Assistant", which avoids an undisclosed "Claude" label on the cards.
5. **Script the calls in on-screen order.** The tab count in shot 7 depends on shot 6 having already run.
6. **Gates for the dry run (cut or swap the shot if one fails):**
   - All 3 museum URLs, and the Shedd path, load headless without a bot check.
   - Each page shows hours in its text. Write Saturday-specific captions only if the page shows Saturday hours.
   - The real map or plan URL exists.
   - `list_pages` leaves out the Personal and ghost tabs. If Personal still shows, keep only the ghost half.
   - The ask card's buttons respond to the CDP click.
7. **Rewrite on shoot day.** Build the `notify_user` body from that day's snapshot text. Never ship an example string.
8. **Footage sources:** only CDP `Page.startScreencast` of `sidebar.html` and the active tab, composited with a synthetic cursor, zooms and bubbles. No windows open on screen and no focus is taken.
9. **No staging.** No outlines or highlights injected into pages. Zooms are done in the edit only.
10. **Landing page.** Pick a cut at random on load, show one `<video>` with its label ("For everyone" / "For developers"), and preload only the chosen file.

---

I didn't dry-run any shot or load the museum pages. Whether `list_pages` hides an agents-off space in a live run, and whether the ghost row appears in the sidebar screencast, both still need testing. The Muse findings come from secondhand sources.