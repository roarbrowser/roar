# r/ArcBrowser

Check the sidebar rules and flair before posting (see README.md in this folder). Use a self-promotion flair if one exists, and say plainly that I made it.

## Title

I made an open-source sidebar browser for Mac while looking for my own Arc replacement

## Body

Disclosure: I'm the developer. It's free and MIT licensed.

With Arc in maintenance mode I wanted something that kept the parts I used daily, and I wanted the source to be open so it can't be shelved. Arc was a great browser; Roar is a smaller, different project, not a clone of it.

What's there today:

- Vertical sidebar with spaces (⌃1–⌃9), each with its own profile, so logins stay separate
- Pinned tabs, tab groups as sidebar sections, split view (⌘\)
- Command bar (⌘T), reader mode (⌥⌘R), copy page as Markdown
- Auto-archive of old tabs (6h/12h/1d/1w), picture-in-picture and floating mini window
- Chrome extensions work; uBlock Origin Lite is bundled
- Imports your Arc spaces, pinned tabs and folders on first launch (also Chrome, Edge, Firefox, and Safari)
- Built on Chromium 154, so sites behave like they do in Chrome

The other half: it has a built-in MCP server, so an AI agent (Claude, Cursor, etc.) can drive the browser in tabs you can see, and you can cut it off with one click. Ignore that entirely if you don't use agents.

What's missing, honestly:

- macOS only, no Windows or iOS, no sync between devices
- Early: one developer, expect rough edges
- No Arc-style Boosts or Little Arc
- Some .mp4 video needs a codec build of CEF

Repo and download: https://github.com/roarbrowser/roar

If you try it, tell me which Arc feature you miss most. That decides what I build next.
