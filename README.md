
<p align="center">
  <img src="resources/lion.svg" alt="Roar logo" width="160">
</p>

<h1 align="center">Roar</h1>

<p align="center">
  A fast, keyboard-first macOS browser with a vertical sidebar, spaces, and split view.<br>
  Built on CEF 154 (Chromium 154.0.8037.98). Free and open source under the MIT License.
</p>

## Build and run

```bash
./scripts/build.sh                       # fetches CEF into third_party/, builds, ad-hoc signs
open build/src/Release/Roar.app
```

Needs macOS, Xcode, `cmake` and `ninja`. Environment overrides:

- `ROAR_CDP_PORT` (default `9222`): DevTools Protocol port. Set another port if something
  else already holds 9222.
- `ROAR_DATA_DIR` (default `~/Library/Application Support/Roar`): profile and `state.json`.
- `--load-extension=<dir>`: load an unpacked Chrome extension.

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
| Spaces: separate tabs and profile per space (⌃1–⌃9, ⇧⌘[ ⇧⌘]); profiles in `Spaces/<id>` | `Controller::SwitchSpace`, `ContextFor` |
| Split view: two tabs side by side (⌘\\); picking a tab swaps the focused pane | `Controller::ToggleSplit`, `RectFor` |
| Page-text search: visible text of visited pages saved to `pages.json` (800 pages, 16 KB each) and matched in the command bar | `Controller::IndexPage`, `SuggestPageText` |

## Known limits

- `--load-extension` extensions load into the default profile only, so they don't run in other Spaces.
- Page-text search stores page text unencrypted in the data dir (mode 0600). Turn it off in Settings or run "Forget saved page text".

- No H.264/AAC: prebuilt CEF ships without proprietary codecs. WebM/VP9/AV1 play;
  many `.mp4` sources will not. Fixing it means building CEF with `proprietary_codecs`.
- Markdown extraction covers HTML pages; PDFs and Google Docs canvases are not handled.
- The bundle is ad-hoc signed; the first AppleScript call triggers a macOS Automation
  prompt.

## Contributing

Issues and pull requests are welcome. Build with `./scripts/build.sh` before sending a
change, since UI-only edits reach the app bundle only through that script.

## License

Roar is released under the [MIT License](LICENSE). The build fetches third-party code
that keeps its own license: [CEF](https://bitbucket.org/chromiumembedded/cef) (BSD) and
[uBlock Origin Lite](https://github.com/uBlockOrigin/uBOL-home) (GPLv3).
