<p align="center">
  <img src="resources/lion.svg" alt="Roar logo" width="140">
</p>

<h1 align="center">Roar</h1>

<p align="center"><strong>The AI-native, open-source browser your agent can drive.</strong></p>

<p align="center">
  A Chromium sidebar browser for macOS, with a built-in MCP server so Claude, Cursor or any
  MCP client can browse in the same window you do, logins and all.
</p>

<p align="center">
  <a href="https://github.com/roarbrowser/roar/releases/latest"><b>Download for macOS</b></a>
  &nbsp;·&nbsp; Apple Silicon &nbsp;·&nbsp; Free, MIT licensed
</p>

<br>

| You get | Your agent gets |
|---|---|
| A vertical sidebar with spaces, each with its own logins | One command to connect: `claude mcp add roar …` |
| Split view, a command bar and Reader mode | Pages it opens appear as tabs you can watch or take over |
| Tabs that archive themselves when you stop using them | A way to ask you a question or ping you when it's done |
| Chrome extensions, with uBlock Origin Lite built in | Only the spaces you allow; ghost tabs are always off-limits |
| Import from Arc, Chrome, Safari, Firefox or Edge | Chrome's look to sites, so fewer bot checks |

## Install

1. Download the latest `Roar-<version>.dmg` from [Releases](https://github.com/roarbrowser/roar/releases/latest) and drag Roar to Applications.
2. Releases aren't notarized yet. If macOS blocks the first launch, open System Settings › Privacy & Security and click **Open Anyway**.
3. On first launch Roar offers to bring over your Arc spaces and pinned tabs. Updates arrive through Roar › **Check for Updates…**

Connect your agent (needs Node.js 22+):

```bash
claude mcp add roar -- /Applications/Roar.app/Contents/Resources/roar-mcp.sh
```

Other MCP clients take the same command as a stdio server.

## Coming from Dia or legacy Arc?

*We don't need a browser company to build a browser.*

Arc is in maintenance mode. Roar keeps the parts you liked and brings them over on first launch.

| In Arc | In Roar |
|---|---|
| Spaces with their own profiles | Spaces, each with its own logins (⌃1–⌃9) |
| Pinned tabs and folders | Pinned tabs and pinned groups, nested folders included |
| Tabs that archive themselves | The same, after 6h, 12h, 1 day or 1 week |
| Split view | Split view (⌘\\), or drag one tab onto another |
| Command bar | Command bar (⌘T), including the text of pages you've read |

Not here yet: Boosts, Little Arc and sync between devices.

## Built for agents

The MCP server (`roar-mcp.sh`, a launcher for
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)) lets an agent
open pages, read them, click, fill forms, run scripts and take screenshots. It starts Roar
if it isn't running. Settings > "Your AI agent drives Roar" picks which Roar agents get: this
one, so you see what they do (the default), or a hidden headless Roar with its own profile
(`~/.roar-headless`, port 9444) that the server starts on demand.

- **Agents can reach you.** Two extra tools put cards in the sidebar: `notify_user` (info,
  done, or needs-you, with an optional Open link) and `ask_user`, which shows buttons and hands
  your click back to the agent. Needs-you cards also raise a macOS notification and a Dock
  badge while Roar is in the background. Cards last for the session.
- **Agent pages are real tabs.** `new_page` opens a tab in your active space's sidebar,
  not a stray window, so you can watch, take over, or close what the agent is doing.
- **Agents per profile.** Right-click a space (or use Settings) to allow or block agents in
  it. Blocked spaces and ghost tabs are hidden from CDP entirely, so agents can't list or
  attach to them; with several spaces allowed, the agent asks you which to use (or calls
  `use_profile`), and its new pages open there.
- **One click to cut it off.** The dot under the settings icon shows whether agents can
  reach the current space (hover for the port, connected agents and allowed spaces); click
  it to allow or block agents in this space. Settings > "Allow agents to connect" closes
  the CDP port entirely, without restarting.
- **Looks like Chrome to sites.** Roar reports the Google Chrome brand and a real window
  frame, and doesn't run polling scripts in pages, so it trips fewer bot checks.
- **Also scriptable:** AppleScript (`open url`, `execute javascript`, `get URL of every tab`)
  and raw CDP on `127.0.0.1:9222`.

## For browsing

**Tabs that stay tidy**
- A vertical sidebar with pinned tabs (⌘D), pinned groups and tab groups; drag to reorder.
- Each tab has a thin bar that shrinks while you ignore it; when it runs out the tab moves to
  Archived (after 6h, 12h, 1 day or 1 week, or never). ⇧⌘K archives now, ⇧⌘T brings one back.
- ⌃Tab switches tabs most recently used first; ⌘1–⌘9 jumps straight to one.
- A speaker on tabs playing audio; click it to mute.

**Spaces and privacy**
- Spaces keep separate tabs and a separate profile (logins, cookies, extensions): ⌃1–⌃9 or ⇧⌘[ ⇧⌘].
- Ghost tabs (⇧⌘N) use a throwaway profile per session that Roar deletes on its next launch.
- Copy Link Address unwraps Outlook Safe Links and `.mcas.ms` wrappers.
- uBlock Origin Lite is built in; other Chrome extensions install as usual.

**Getting around**
- One command bar (⌘T, ⌘L) for addresses, search, open tabs, history and the text of pages
  you've visited. Type `>` for commands.
- Split view (⌘\\), or drag a tab onto another: left half for side by side, right half for top and bottom.
- Reader mode (⌥⌘R), find in page (⌘F), per-site zoom, swipe back and forward.
- Picture-in-picture for video (⇧⌘P), or float any tab in a mini window (⇧⌘F).
- New windows (⌘N) start with your spaces and pinned tabs.

**Small things that add up**
- Copy any page as Markdown (⇧⌘C) or save it to Downloads.
- Unread Gmail in the sidebar, with Read, Move and Delete per message.
- Your open GitHub pull requests as a live folder (via `gh`).
- Sign-in popups open as sidebar tabs, not stray windows.
- A history page (⌘Y) with search and a day-by-day view; Reopen All Tabs from Last Session.

<details>
<summary><b>Keyboard shortcuts</b></summary>

| Shortcut | Action |
|---|---|
| ⌘T / ⌘L | Command bar: new tab / current tab |
| ⌘N / ⇧⌘N | New window / ghost tab |
| ⌘D | Pin tab |
| ⇧⌘K / ⇧⌘T | Archive tabs now / reopen archived tab |
| ⌃Tab / ⌃⇧Tab | Next / previous tab, most recent first |
| ⌘1–⌘9 | Jump to tab |
| ⌃1–⌃9, ⇧⌘[ / ⇧⌘] | Switch space |
| ⌘\\ | Split view |
| ⌥⌘R | Reader mode |
| ⇧⌘C | Copy page as Markdown |
| ⇧⌘P / ⇧⌘F | Picture-in-picture / float tab |
| ⌘F, ⌘G / ⇧⌘G | Find, next / previous |
| ⌘+ / ⌘− / ⌘0 | Zoom |
| ⌘Y / ⇧⌘J | History / downloads |
| ⌥⌘B / ⌥⌘I | Toggle sidebar / DevTools |

</details>

## For developers

<details>
<summary><b>Build from source</b></summary>

```bash
./scripts/build.sh                       # fetches CEF into third_party/, builds, signs (Developer ID or Apple Development identity if present, else ad-hoc)
open build/src/Release/Roar.app
./scripts/update-cef.sh                  # move to the newest stable CEF/Chromium and rebuild (--check to only report)
```

Needs macOS, Xcode, `cmake` and `ninja`. Environment overrides:

- `ROAR_CDP_PORT` (default `9222`): DevTools Protocol port; setting it also forces the port on.
  The port is on by default; Settings > "Allow agents to connect" opens or closes it while
  Roar runs.
- `ROAR_DATA_DIR` (default `~/Library/Application Support/Roar`): profile and `state.json`.
- `--load-extension=<dir>`: load an unpacked Chrome extension. It loads into every Space's profile, alongside the bundled uBlock Origin Lite.

</details>

<details>
<summary><b>How it works</b></summary>


CEF binds a Chrome-style window to the first Chrome-style BrowserView it hosts, so
Roar uses a frameless Alloy shell window for the sidebar and one frameless Chrome-style
window per tab, attached as a macOS child window over the content area. The command bar
and toast are small Alloy child windows. Chrome style on tabs is what keeps extensions,
DevTools and CDP working. See `src/controller.h`.

The UI is HTML in `resources/ui`, served from `roar://ui/`, and talks to C++ through the
CEF message router (`window.roarQuery`). Web pages may only send `extract.result` or `index.result` with a
nonce Roar issued to that tab.

</details>

## Known limits

- Page-text search stores page text unencrypted in the data dir (mode 0600). Turn it off in Settings, or clear it with "Forget saved text" there ("Forget saved page text" in the command bar).
- H.264 and AAC need a CEF built with proprietary codecs. The stock CEF that `scripts/build.sh` fetches plays WebM, VP9 and AV1 but not many `.mp4` sources;
  `scripts/build-cef-codecs.sh` builds one that does, with Roar's Chromium patches (hours for a first build, about 30 minutes incremental; the checkout needs about 100 GB).
- The tab sound indicator follows `<audio>` and `<video>` elements on the page itself, not Web Audio or media inside cross-origin iframes.
- Markdown extraction and Reader mode cover HTML pages; PDFs and Google Docs canvases are not handled.
- Release builds are ad-hoc signed (not yet notarized), so macOS asks you to confirm the first launch; the first AppleScript call triggers a macOS Automation
  prompt.

## Contributing

Issues and pull requests are welcome. Build with `./scripts/build.sh` before sending a
change, since UI-only edits reach the app bundle only through that script.

## License

Roar is released under the [MIT License](LICENSE). The build fetches third-party code
that keeps its own license: [CEF](https://bitbucket.org/chromiumembedded/cef) (BSD) and
[uBlock Origin Lite](https://github.com/uBlockOrigin/uBOL-home) (GPLv3).
