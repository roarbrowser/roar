
<p align="center">
  <img src="resources/lion.svg" alt="Roar logo" width="160">
</p>

<h1 align="center">Roar</h1>

<p align="center">
  An AI-first Chromium browser for macOS: a sidebar browser you use, with a built-in MCP server<br>
  so your agent can use it too. Built on CEF 154 (Chromium 154.0.8037.98). Free and open source under the MIT License.
</p>

## Built for agents

Roar is a browser you and your AI agent share. It ships an MCP server
(`Roar.app/Contents/Resources/roar-mcp.sh`, a launcher for
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)), so Claude,
Cursor or any MCP client can open pages, read them, click, fill forms, run scripts and take
screenshots in the same browser, logins and all.

```bash
claude mcp add roar -- /Applications/Roar.app/Contents/Resources/roar-mcp.sh
```

Other clients take the same command as a stdio server. It needs Node.js (`npx`), starts Roar
if it isn't running, and prefers a headless Roar on port 9444 when one is up.

- **Agent pages are real tabs.** `new_page` opens a tab in your active space's sidebar,
  not a stray window, so you can watch, take over, or close what the agent is doing.
- **One click to cut it off.** The dot under the settings icon shows whether the CDP port is
  open (`CDP: 9222 open` on hover); click it to close the port and drop every connected
  agent, or reopen it, without restarting.
- **Looks like Chrome to sites.** Roar reports the Google Chrome brand and a real window
  frame, and doesn't run polling scripts in pages, so it trips fewer bot checks.
- **Also scriptable:** AppleScript (`open url`, `execute javascript`, `get URL of every tab`)
  and raw CDP on `127.0.0.1:9222`.

## Build and run

```bash
./scripts/build.sh                       # fetches CEF into third_party/, builds, ad-hoc signs
open build/src/Release/Roar.app
./scripts/update-cef.sh                  # move to the newest stable CEF/Chromium and rebuild (--check to only report)
```

Needs macOS, Xcode, `cmake` and `ninja`. Environment overrides:

- `ROAR_CDP_PORT` (default `9222`): DevTools Protocol port; setting it also forces the port on.
  The port is on by default; the CDP indicator at the bottom right of the sidebar opens or
  closes it while Roar runs (Settings > Automation tools does the same).
- `ROAR_DATA_DIR` (default `~/Library/Application Support/Roar`): profile and `state.json`.
- `--load-extension=<dir>`: load an unpacked Chrome extension. It loads into every Space's profile, alongside the bundled uBlock Origin Lite.

## Architecture

CEF binds a Chrome-style window to the first Chrome-style BrowserView it hosts, so
Roar uses a frameless Alloy shell window for the sidebar and one frameless Chrome-style
window per tab, attached as a macOS child window over the content area. The command bar
and toast are small Alloy child windows. Chrome style on tabs is what keeps extensions,
DevTools and CDP working. See `src/controller.h`.

The UI is HTML in `resources/ui`, served from `roar://ui/`, and talks to C++ through the
CEF message router (`window.roarQuery`). Web pages may only send `extract.result` with a
nonce Roar issued to that tab.

## Features

| Feature | Where |
|---|---|
| Command bar (⌘T new tab, ⌘L current tab, `>` for commands) | `ui/command.html`, `Controller::Suggest` |
| Page to Markdown (⇧⌘C copy, "Save page as Markdown" to ~/Downloads) | `ui/extract.js` |
| Clean Tabs: cooling bars, auto-archive after 6h/12h/1d/1w, ⇧⌘K | `Controller::AutoArchiveTick` |
| Live folder: your open pull requests via `gh` | `platform::SearchGitHub` |
| Swipe navigation with a "← Back to …" toast | `Controller::OnGesture` |
| Video picture-in-picture (⇧⌘P), float tab in a mini window (⇧⌘F) | `Controller::PictureInPicture`, `FloatActiveTab` |
| AppleScript (`open url`, `execute javascript`, `close tab`, …) and CDP | `resources/Roar.sdef`, `mac/scripting.mm` |
| Onboarding and settings | `ui/welcome.html` |
| Spaces: separate tabs and profile per space (⌃1–⌃9, ⇧⌘[ ⇧⌘]); profiles in `Space-<id>` | `Controller::SwitchSpace`, `ContextFor` |
| Split view: two tabs side by side (⌘\\); picking a tab swaps the focused pane | `Controller::ToggleSplit`, `RectFor` |
| Page-text search: visible text of visited pages saved to `pages.json` (800 pages, 16 KB each) and matched in the command bar | `Controller::IndexPage`, `SuggestPageText` |
| Find in page (⌘F, ⌘G / ⇧⌘G): match count, ↵ / ⇧↵ for next and previous, esc closes | `ui/find.html`, `Controller::ShowFind` |
| Zoom (⌘+, ⌘−, ⌘0): per host, with a zoom toast, kept in `state.json` | `Controller::ZoomStep`, `ApplyZoom` |
| Print (⌘P) | `Controller::Print` |
| Downloads: saved to ~/Downloads, a list with progress, cancel and Show in Finder (⇧⌘J), and a sidebar button while there are downloads | `Controller::OnBeforeDownload`, `ui/downloads.html` |
| History page (⌘Y): day rail, search, filter by site, keyboard navigation, remove entries | `ui/history.html`, `Controller::HistoryJson` |
| Reopen All Tabs from Last Session (History menu), per space | `State::last_session` |
| Popups (sign-in flows, `window.open`) open as sidebar tabs that keep `window.opener` | `Controller::AdoptPopup` |
| Tab groups as their own sidebar sections; Close All Tabs in a space | `ui/sidebar.html`, `closeSpaceTabs` |
| Unread Gmail in the sidebar: multi-select delete, Select all, account links | `ui/mail-act.js`, `Controller::RefreshGmail` |
| MCP server for AI agents; live CDP open/close dot | `resources/roar-mcp.sh`, `Controller::SetCdp` |
| Tab sound: a speaker on sidebar tabs that are playing audio, click to mute or unmute | `Controller::ToggleMute`, `MediaWatcher` |
| Page context menu: Open Link in Split View, Open Link in Space…, Copy Page as Markdown | `Controller::BuildContextMenu` |
| Reader mode (⌥⌘R): a cleaned article view built from the Markdown extractor | `ui/reader.html`, `Controller::ToggleReader` |
| Tab switcher (⌃Tab, ⌃⇧Tab): most recently used first, within the current space | `Controller::CycleTabs` |
| Permission prompts (camera, microphone, location, notifications): Chromium's own prompts, remembered per site in each space's profile | Chrome-style windows |

## Known limits

- Page-text search stores page text unencrypted in the data dir (mode 0600). Turn it off in Settings or run "Forget saved page text".
- H.264 and AAC need a CEF built with proprietary codecs. The stock CEF that `scripts/build.sh` fetches plays WebM, VP9 and AV1 but not many `.mp4` sources;
  `scripts/build-cef-codecs.sh` builds a CEF that does (hours of compiling and about 100 GB of disk).
- The tab sound indicator follows `<audio>` and `<video>` elements on the page itself, not Web Audio or media inside cross-origin iframes.
- Markdown extraction and Reader mode cover HTML pages; PDFs and Google Docs canvases are not handled.
- The bundle is ad-hoc signed; the first AppleScript call triggers a macOS Automation
  prompt.

## Contributing

Issues and pull requests are welcome. Build with `./scripts/build.sh` before sending a
change, since UI-only edits reach the app bundle only through that script.

## License

Roar is released under the [MIT License](LICENSE). The build fetches third-party code
that keeps its own license: [CEF](https://bitbucket.org/chromiumembedded/cef) (BSD) and
[uBlock Origin Lite](https://github.com/uBlockOrigin/uBOL-home) (GPLv3).
