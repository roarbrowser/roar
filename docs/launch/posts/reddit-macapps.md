# r/macapps

Roar is not on the Mac App Store. Check whether it qualifies for the main feed through the sub's "Trust or Transparency" rule (open source should count as transparency); if not, post in the monthly "The App Pile" megathread using the Problem / Comparison / Pricing format below. Verify Reddit email first: a first comment with a link from an unverified account is auto-removed.

## Title

Roar: a free, open-source sidebar browser for macOS that your own AI agent can drive

## Body

I'm the developer. Roar is free and MIT licensed.

**Problem.** Arc has been in maintenance mode since May 2025, and its successor, Dia, is closed source with The Browser Company's AI built in. I wanted an Arc-style sidebar browser whose source is open, so it can't be shelved, and I wanted my own agent to work in the same browser I use (logins included) where I can see and stop it.

**Comparison.** Against Arc and Dia: Roar is open source, and instead of a built-in assistant any MCP client drives it. Against a plain Chrome automation profile: agent pages show up as real tabs in your sidebar, with your logins.

**Pricing.** Free.

Features:

- Vertical sidebar, spaces with separate logins, pinned tabs, tab groups, split view
- Tabs that archive themselves after 6h, 12h, 1 day or 1 week
- Command bar, reader mode, page to Markdown, find, history, downloads
- Chrome extensions, uBlock Origin Lite bundled
- Import from Arc (spaces and pinned tabs), Chrome, Edge, Firefox, Safari and Dia
- Built-in MCP server: `claude mcp add roar -- /Applications/Roar.app/Contents/Resources/roar-mcp.sh`
- Agents can send you sidebar cards (`notify_user`) or ask you a question with buttons (`ask_user`)
- Agents allowed per space; ghost tabs always off-limits; one click blocks the current space
- Agent sessions: your Claude Code, Codex, Gemini CLI, Qwen Code and Copilot CLI sessions in the sidebar, showing what each is doing and which need you; reply, send a page with a prompt, or start a new one in a folder or a scratch folder
- Copied links come out clean: Outlook/Teams Safe Links unwrapped, tracking parameters removed, your own list too
- Headed or headless agent mode

Limits: macOS only (Apple Silicon), early. Signed with a Developer ID but not notarized yet, so the first launch needs Open Anyway in Privacy & Security. Some .mp4 video needs a codec build.

https://github.com/roarbrowser/roar
