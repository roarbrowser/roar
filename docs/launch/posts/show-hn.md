# Show HN

## Title

Show HN: Roar – An open-source Mac browser with a built-in MCP server for agents

(78 chars. Fallback: "Show HN: Roar – A sidebar browser for macOS that your AI agent can drive")

URL: https://github.com/roarbrowser/roar

## First comment

Hi HN, I'm the maker of Roar. It's a macOS browser with a vertical sidebar (spaces, pinned tabs, tab groups, split view, a command bar) that ships an MCP server, so an agent like Claude Code or Cursor can use the same browser I do, logins included. MIT licensed, built on CEF (Chromium).

Why I built it: I kept pointing agents at a separate automation Chrome, then logging in again, then losing track of what the agent had open. I wanted the agent to work in my browser, in tabs I can see, with a way to cut it off. The other push: I used Arc, and The Browser Company [put it in maintenance mode in May 2025](https://browsercompany.substack.com/p/letter-to-arc-members-2025) to build Dia, which is closed source and ships its own AI. I wanted a sidebar browser whose source is open and where the agent is mine.

How it works:

- CEF binds a Chrome-style window to the first BrowserView it hosts, so Roar runs one frameless Chrome-style window per tab, attached as a macOS child window over the content area. The sidebar is an Alloy-style shell window rendering HTML from `roar://ui/`. Chrome style on the tabs is what keeps extensions, DevTools and CDP working.
- The MCP server is `Roar.app/Contents/Resources/roar-mcp`, a self-contained build of chrome-devtools-mcp pointed at Roar's CDP port (no Node.js needed). The welcome page has a one-click Connect for Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI and others, or by hand: `claude mcp add roar -- /Applications/Roar.app/Contents/Resources/roar-mcp`.
- I patch Chromium's `Target.createTarget` handler so `new_page` opens a real sidebar tab in the active space instead of a stray window. You can watch the agent, take over, or close the tab.
- Two extra tools: `notify_user` puts a card in the sidebar, and `ask_user` shows buttons and returns your click to the agent.
- Agents are allowed per space. Blocked spaces and ghost tabs are hidden from CDP entirely (I patch Chromium's target discovery and `/json/list` with a per-profile filter). A dot in the sidebar shows whether agents can reach the current space; one click blocks them. A setting closes the CDP port entirely, without restarting.
- You can choose headed (agents use this window) or headless (a hidden Roar with its own profile, started on demand).
- Roar is Chromium-based, so sites that work in Chrome generally work in Roar. Use agents on sites whose terms allow automated access.

Other bits: separate profiles per space, Chrome extensions (uBlock Origin Lite bundled), reader mode, copy page as Markdown, tabs that archive themselves, import from Arc (spaces and pinned tabs), Chrome, Edge, Firefox, Safari and Dia. Your terminal agent sessions (Claude Code, Codex, Gemini CLI, Qwen Code, Copilot CLI) also show in the sidebar with what each is doing and which need you; you can reply, send a page, or split a session next to a tab.

What's rough:

- macOS 13+ on Apple Silicon and Intel (Intel from 1.3), and early. Expect bugs.
- If you build from source, proprietary codecs (H.264/AAC) need a CEF built with them; the stock CEF the build script fetches plays WebM/VP9/AV1 but not many .mp4 sources.
- Reader mode and Markdown extraction cover HTML pages, not PDFs or Google Docs.
- Page-text search stores visited page text unencrypted in the data dir (you can turn it off).

I'd like feedback on the agent side most: what you'd want an agent to be able to do (or never do) in your real browser, and whether the cut-off and ask_user model feels like enough control.

## Prepared replies

**"How is this different from Dia?"**
Dia is closed source and comes with The Browser Company's AI built in; Arc, its predecessor, has been in maintenance mode since May 2025. Roar is MIT licensed, so the code stays open and anyone can fork it, and it has no built-in assistant: the AI is whatever agent you already run (Claude, Cursor, anything that speaks MCP), driving the same browser you're logged into.

Roar is independent and not affiliated with or endorsed by The Browser Company, Apple, Google, Anthropic, OpenAI, Microsoft/GitHub, Anysphere (Cursor), Alibaba (Qwen) or the uBlock Origin project. Product names are trademarks of their owners.
