# r/macapps

Roar is not on the Mac App Store. Check whether it qualifies for the main feed through the sub's "Trust or Transparency" rule (open source should count as transparency); if not, post in the monthly "The App Pile" megathread using the Problem / Comparison / Pricing format below. Verify Reddit email first: a first comment with a link from an unverified account is auto-removed.

## Title

Roar: a free, open-source sidebar browser for macOS that AI agents can drive

## Body

I'm the developer. Roar is free and MIT licensed.

**Problem.** I wanted an Arc-style sidebar browser that is open source, and I wanted my AI agent to work in the same browser I use (logins included) where I can see and stop it.

**Comparison.** Compared with Arc (now in maintenance mode) and closed-source AI browsers, Roar is open source and lets any MCP client drive it rather than a built-in assistant. Compared with a plain Chrome automation profile, agent pages show up as real tabs in your sidebar.

**Pricing.** Free. No account.

Features:

- Vertical sidebar, spaces with separate profiles, pinned tabs, tab groups, split view
- Command bar, reader mode, page to Markdown, find, history, downloads
- Chrome extensions, uBlock Origin Lite bundled
- Import from Arc, Chrome, Edge, Firefox, and Safari
- Built-in MCP server: `claude mcp add roar -- /Applications/Roar.app/Contents/Resources/roar-mcp.sh`
- Agents can send you sidebar cards (`notify_user`) or ask you a question with buttons (`ask_user`)
- One click on the CDP dot disconnects every agent
- Headed or headless agent mode
- Built on CEF / Chromium 154

Limits: macOS only, early, some .mp4 video needs a codec build.

https://github.com/roarbrowser/roar
