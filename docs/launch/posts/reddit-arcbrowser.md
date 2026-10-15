# r/ArcBrowser

Check the sidebar rules and flair before posting (see README.md in this folder). Use a self-promotion flair if one exists, and say plainly that I made it.

## Title

Arc went into maintenance mode, so I built an open-source sidebar browser nobody can shelve

## Body

Disclosure: I'm the developer. It's free and MIT licensed.

I lived in Arc. In May 2025 The Browser Company put it in maintenance mode to build Dia, and that was that: a company decided my browser was done. Dia is closed source with their AI built in, which isn't what I wanted either.

So I built Roar. MIT licensed, so nobody can shelve it, and it keeps the parts of Arc I used every day:

- Vertical sidebar with spaces (⌃1–⌃9), each with its own logins
- Pinned tabs, pinned groups (nested folders included), tab groups, split view (⌘\)
- Tabs that archive themselves after 6h, 12h, 1 day or 1 week
- Command bar (⌘T), including the text of pages you've read; reader mode (⌥⌘R); copy page as Markdown
- Picture-in-picture and a floating mini window
- Chrome extensions work; uBlock Origin Lite is bundled
- Your Arc spaces and pinned tabs come over on first launch (Chrome, Edge, Firefox, Safari and Dia import too)

The other half: no built-in assistant. Roar has an MCP server, so if you use an AI agent (Claude, Cursor, etc.) you plug in your own and it works in tabs you can see. You choose which spaces it can reach. Ignore it entirely if you don't use agents.

What's missing, honestly:

- macOS only, no Windows or iOS, no sync between devices
- Early: one developer, expect rough edges
- No Boosts or Little Arc
- Some .mp4 video needs a codec build of CEF

Repo and download: https://github.com/roarbrowser/roar

If you try it, tell me which Arc feature you miss most. That decides what I build next.
