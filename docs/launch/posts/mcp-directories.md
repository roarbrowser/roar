# MCP directories

## Smithery

**Name:** Roar
**Repo:** https://github.com/roarbrowser/roar
**Transport:** stdio (local)
**Command:** `/Applications/Roar.app/Contents/Resources/roar-mcp.sh`
**Requirements:** macOS, Roar installed in /Applications; no Node.js needed

**Description:**
Roar is an open-source macOS browser (Chromium 154) with a built-in MCP server. The server launches chrome-devtools-mcp against Roar, so an agent can open pages, read them, click, fill forms, run scripts and take screenshots in the user's own browser, with their logins. Pages the agent opens become tabs in Roar's sidebar. Two extra tools: `notify_user` posts a card in the sidebar, and `ask_user` shows buttons and returns the user's click. Agents reach only the spaces the user allows (one click blocks the current space), or run agents in a separate headless profile. Starts Roar if it isn't running. MIT licensed.

## mcp.so

**Name:** Roar
**Category:** Browser Automation
**URL:** https://github.com/roarbrowser/roar
**Short description:** Drive the user's own macOS browser from any MCP client: real sidebar tabs, notify_user/ask_user cards, one-click cut-off.

**Install:**

```bash
claude mcp add roar -- /Applications/Roar.app/Contents/Resources/roar-mcp.sh
```

Other clients: add the same path as a stdio server command. No Node.js needed.

## awesome-mcp-servers (punkpeye) — Browser Automation

Format per current README: `- [owner/repo](url) <language> <scope> <OS> - Description.` Entries are alphabetical by owner; the list also shows a glama.ai score badge, which appears after the server is listed on glama.ai (add it then, or let the maintainers add it). 🌊 = C/C++, 🏠 = local, 🍎 = macOS.

```
- [roarbrowser/roar](https://github.com/roarbrowser/roar) 🌊 🏠 🍎 - Open-source macOS browser with a built-in MCP server: agents drive your logged-in browser in real sidebar tabs, can notify or ask you via sidebar cards, and reach only the spaces you allow.
```
