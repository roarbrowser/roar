# X thread

1/
Roar: the open-source browser your AI agent can drive.

A sidebar browser for macOS with a built-in MCP server. You browse; Claude, Cursor or any MCP client can use the same browser, logins and all.

[VIDEO]

2/
Setup is one line:

claude mcp add roar -- /Applications/Roar.app/Contents/Resources/roar-mcp.sh

It wraps chrome-devtools-mcp, so agents can open pages, read them, click, fill forms, run scripts and take screenshots.

3/
Pages an agent opens become real tabs in your sidebar, not stray windows. Watch it work, take over, or close the tab.

4/
Agents can reach you. notify_user puts a card in the sidebar. ask_user shows buttons, waits for your click, and returns it to the agent. Needs-you cards raise a macOS notification when Roar is in the background.

5/
You stay in control. A dot in the sidebar shows the CDP port and how many agents are connected. One click closes it and drops them all. Or run agents in a hidden headless Roar with its own profile.

6/
It's also a browser I use all day: spaces with separate profiles, pinned tabs, tab groups, split view, command bar, reader mode, page to Markdown, Chrome extensions with uBlock Origin Lite.

7/
Import from Chrome, Edge, Firefox, Safari and Dia. Arc import is coming in the launch release.

Built on CEF / Chromium 154. macOS only, early.

8/
Free and MIT licensed. Feedback and issues welcome:
https://github.com/roarbrowser/roar
