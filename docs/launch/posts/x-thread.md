# X thread

1/
Roar: the AI-native, open-source browser your agent can drive.

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
You stay in control. Each space has its own switch for agents, and a dot in the sidebar shows who's connected; one click blocks agents from the space you're in. Or run agents in a hidden headless Roar with its own profile.

6/
It's also a browser I use all day: spaces with separate profiles, pinned tabs, tab groups, split view, command bar, reader mode, page to Markdown, Chrome extensions with uBlock Origin Lite.

7/
Import from Arc (spaces, pinned tabs, folders), Chrome, Edge, Firefox, and Safari.

Built on CEF / Chromium 154. macOS only, early.

8/
We don't need a browser company to build a browser.

Roar is open source, and the AI is whatever agent you already use.

9/
Free and MIT licensed. Feedback and issues welcome:
https://github.com/roarbrowser/roar
