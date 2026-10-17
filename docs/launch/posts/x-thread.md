# X thread

1/
The Browser Company shelved Arc in May 2025 to build Dia. Closed source, with the AI they picked for you.

Roar is the other answer: an open-source sidebar browser for macOS, built on Chromium (CEF), with a built-in MCP server. Your agent, not theirs.

[VIDEO]

2/
Bring the agent you already use. One line:

claude mcp add roar -- /Applications/Roar.app/Contents/Resources/roar-mcp

It wraps chrome-devtools-mcp, so Claude, Cursor or any MCP client can open pages, read them, click, fill forms, run scripts and take screenshots, logins and all.

3/
Pages an agent opens become real tabs in your sidebar, not stray windows. Watch it work, take over, or close the tab.

4/
Agents can reach you. notify_user puts a card in the sidebar. ask_user shows buttons, waits for your click, and hands it back to the agent. Needs-you cards raise a macOS notification when Roar is in the background.

5/
You decide where agents go. Each space has its own switch; ghost tabs are always off-limits. A dot in the sidebar shows whether agents can reach the space you're in, and one click blocks them. Or run agents in a hidden headless Roar with its own profile.

6/
It's also the Arc-style browser I use all day: spaces with separate logins, pinned tabs, tab groups, tabs that archive themselves, split view, command bar, reader mode, page to Markdown, Chrome extensions with uBlock Origin Lite.

7/
Leaving Arc? Your spaces and pinned tabs come over on first launch. Chrome, Edge, Firefox, Safari and Dia import too.

macOS (Apple Silicon and Intel), early.

8/
We don't need a browser company to build a browser.

MIT licensed, so nobody can shelve it. The AI is whatever agent you already run.

9/
Free: https://roarbrowser.app
Feedback and issues welcome:
https://github.com/roarbrowser/roar
