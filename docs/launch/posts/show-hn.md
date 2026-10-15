# Show HN

## Title

Show HN: Roar – An open-source Mac browser with a built-in MCP server for agents

(78 chars. Fallback: "Show HN: Roar – A sidebar browser for macOS that your AI agent can drive")

URL: https://github.com/roarbrowser/roar

## First comment

Hi HN, I'm the maker of Roar. It's a macOS browser with a vertical sidebar (spaces, pinned tabs, tab groups, split view, a command bar) that ships an MCP server, so an agent like Claude Code or Cursor can use the same browser I do, logins included. MIT licensed, built on CEF 154 (Chromium 154).

Why I built it: I kept pointing agents at a separate automation Chrome, then logging in again, then losing track of what the agent had open. I wanted the agent to work in my browser, in tabs I can see, with a way to cut it off.

How it works:

- CEF binds a Chrome-style window to the first BrowserView it hosts, so Roar runs one frameless Chrome-style window per tab, attached as a macOS child window over the content area. The sidebar is an Alloy-style shell window rendering HTML from `roar://ui/`. Chrome style on the tabs is what keeps extensions, DevTools and CDP working.
- The MCP server is `Roar.app/Contents/Resources/roar-mcp.sh`, a launcher for chrome-devtools-mcp pointed at Roar's CDP port. Setup: `claude mcp add roar -- /Applications/Roar.app/Contents/Resources/roar-mcp.sh` (needs Node 22+).
- I patch Chromium's `Target.createTarget` handler so `new_page` opens a real sidebar tab in the active space instead of a stray window. You can watch the agent, take over, or close the tab.
- Two extra tools: `notify_user` puts a card in the sidebar, and `ask_user` shows buttons and returns your click to the agent.
- A dot in the sidebar shows whether the CDP port is open and how many agents are connected; one click closes the port and drops them, without restarting.
- You can choose headed (agents use this window) or headless (a hidden Roar with its own profile, started on demand).
- Roar reports the Google Chrome brand and a real window frame, and doesn't run polling scripts in pages, so it trips fewer bot checks than typical automation setups.

Other bits: separate profiles per space, Chrome extensions (uBlock Origin Lite bundled), reader mode, copy page as Markdown, import from Chrome, Edge, Firefox, Safari and Dia. Arc import is coming in the launch release.

What's rough:

- macOS only, and early. Expect bugs.
- Proprietary codecs (H.264/AAC) need a CEF built with them; the stock CEF the build script fetches plays WebM/VP9/AV1 but not many .mp4 sources.
- Reader mode and Markdown extraction cover HTML pages, not PDFs or Google Docs.
- Page-text search stores visited page text unencrypted in the data dir (you can turn it off).

I'd like feedback on the agent side most: what you'd want an agent to be able to do (or never do) in your real browser, and whether the cut-off and ask_user model feels like enough control.
