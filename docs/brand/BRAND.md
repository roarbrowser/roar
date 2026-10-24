# Roar brand and persona

The single source for how Roar presents itself. Agents writing copy, filling a profile,
or posting for Roar start here. Account status lives in [ACCOUNTS.md](ACCOUNTS.md).
Credentials are never stored in this repo: they are in the maintainer's password
manager, folder **"Roar brand"**, one entry per account.

## Identity

| | |
|---|---|
| Name | Roar |
| Handle | `roarbrowser` (use it everywhere; fall back to `roar_browser`, then `getroar`) |
| Tagline | The AI-native, open-source browser your agent can drive. |
| One-liner | A Chromium sidebar browser for macOS with a built-in MCP server. |
| Category | Web browser / developer tool / AI agent tooling |
| Website | https://roarbrowser.app (GitHub Pages from `docs/`; domain on Cloudflare, auto-renew off) |
| Contact email | roarbrowser@gmail.com |
| License | MIT, open source |
| Platform | macOS (Apple Silicon and Intel, Intel from 1.3) and Windows (x64) |

## Mascot and visuals

- **Mascot:** the lion. Every avatar and icon is the lion mark; no other animals.
- **Avatar:** `docs/media/roar-avatar.png` (800×800, lion on its rounded cream tile).
  Source vector: `resources/lion.svg`.
- **Colors** (from `resources/ui/roar.css`): mane orange `#ff7a00`, cream `#fff9f0` /
  `#fff1e2`, cocoa ink `#4a2e18`; dark mode cocoa `#1e140c` / `#2a1d12` with cream ink
  `#fbeedd`. Status mint for "connected" `#7aa898`.
- **Type:** rounded system face (`ui-rounded`, SF Pro Rounded) for headlines; the system
  sans for body text.
- **Banner/header images:** cream or cocoa field, lion at left, tagline in rounded type.

## Persona and voice

Roar speaks as the product, written by a solo maker who builds it in the open.

- **Plain and specific.** Say what it does: "pages your agent opens show up as tabs in
  your sidebar." No hype words (revolutionary, game-changing, supercharge).
- **First person for the maker** in launch posts and replies ("I built Roar because…");
  "Roar" in product copy.
- **Honest about limits:** early; agent-port token protection is Apple Silicon only until 1.4.
- **Competitive and factual.** Name Arc and Dia where Roar differs (open source, bring your own agent). Every comparison claim is dated, sourced and literally true; no claims about a rival's future, health or intentions. Never use their logos or screenshots, never call their product dead or abandoned, and never imply Roar is affiliated with or endorsed by anyone it names. Third-party names in the app and on the site (import buttons, modules, agent lists) stay text-only or use generic glyphs, never their logos.
- **Sentence case** everywhere; no emoji runs; one lion emoji at most, rarely.
- **Lion flavor, lightly:** an occasional "roar" pun is fine; never in error messages
  or docs.

## Profile copy (paste-ready)

- **Bio, short (≤160):** The AI-native, open-source browser your agent can drive. Chromium
  sidebar browser for macOS with a built-in MCP server. 🦁
- **Bio, long:** Roar is a free, open-source Chromium browser for macOS: a vertical
  sidebar with spaces, pinned tabs and split view for you, and a built-in MCP server so
  Claude and other agents can drive it. Pages your agent opens appear as real tabs;
  when it needs you, it asks in the sidebar.
- **Location:** The internet
- **Link:** https://github.com/roarbrowser/roar
- **Display name:** Roar
- **Pinned post (X):** the launch thread in `docs/launch/posts/x-thread.md`.

## Key messages

1. Your agent drives the browser you actually use: logins, extensions and all.
2. Pages it opens are real tabs you can watch and take over.
3. It can ask you before it acts (`ask_user`), and you can cut it off with one click.
4. A sidebar browser built for people leaving Arc: spaces, pinned tabs, split view,
   import from Arc and other browsers.
5. Free, MIT, built on Chromium.
