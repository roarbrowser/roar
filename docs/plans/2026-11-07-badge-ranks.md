# Agent badge: a rank ladder for every Roar user

Status: design, approved approach and ladder (2026-11-07).

## Intent

The badge becomes the person's identity in Roar: something they show off (the shared card) and a sense of progress
every Roar user feels, with or without AI. One rank, shown under the Roar wordmark in the sidebar footer, opening a
badge page that shows the whole ladder: what's earned, what's next and what each step needs.

## Goals

- One lion-themed ladder of eight ranks. The early ranks come from using Roar; the later ones need agent work too.
- The rank appears under "Roar" in the footer and links to the badge page.
- The badge page:
  - has a light/dark switch of its own;
  - explains how ranks are earned, in plain words, for someone with no AI set up;
  - shows every rank: earned ones lit, future ones locked, each with what it needs and the person's progress;
  - has a switch that hides the rank from the footer and "Agent badge" from the AI header's right-click menu.
- The card art changes as the rank rises, and is designed to sit with the "Made with Roar" band.
- The rank and its counts survive Settings › Backup export and import.

## Non-goals

- No server, accounts or leaderboard. Counts stay on this computer, as today.
- No rewards or unlocked features: the rank is identity only.
- No new counting of what people browse. "Days" is only whether Roar was used on a day.

## Anti-goals (a failure even if it works)

- Anyone's rank going down after the update, or after an import.
- The footer nagging: no badges, dots or prompts. The rank is a quiet line.
- Anything that reveals browsing (sites, titles) on the card, the page or in the stats file.

## The ladder

| # | Rank | Needs (all of) |
|---|---|---|
| 1 | Cub | Start using Roar |
| 2 | Prowler | 7 days |
| 3 | Scout | 30 days |
| 4 | Hunter | 30 days, 10 agent sessions |
| 5 | Pride Guard | 60 days, 50 sessions |
| 6 | Maned | 90 days, 200 sessions, 25 agent hours |
| 7 | Pride Leader | 180 days, 500 sessions, 100 hours |
| 8 | Apex Lion | 365 days, 1,000 sessions, 250 hours |

- Days: distinct local calendar days on which at least one non-ghost page opened.
- Sessions and hours: what `agent_stats.h` already counts (sessions summed over tools; agent hours from `agent_seconds`).
- No demotion: Roar stores the highest rank ever reached and shows the higher of that and the computed rank.
- Card art: four looks, grouped cub (1-2), young lion (3-4), maned lion (5-7) and apex (8), each a clear step up.

## Approaches considered

1. **One ladder, mixed requirements** (picked). One identity. Early ranks are reachable without AI; the agent ranks stay
   earned by agent work, so the shared card keeps saying what Roar is for. "What's needed" reads as concrete steps.
2. One ladder, points. Simple to show, but "340 more points" says nothing about what to do, and heavy browsing alone
   could reach the top, which weakens the card's message.
3. Two ladders (Roar and agent). Clear, but splits the identity; the footer and card would have to pick one or show both.

## Decided

- The ladder is one data table shared by the sidebar footer and the badge page (one JS file both load, plus the rank
  thresholds checked in C++ tests if rank is computed there; the builder picks where).
- Days are counted in the same local file as the agent counts (`agent-stats.json`), as a count plus the last counted
  day, never a list of dates or URLs. On the first launch after the update, Roar seeds the day count from history:
  the number of distinct local days among `history.json`'s `last_visit` values. That's a lower bound, since only each
  URL's last visit is kept, which is fine: no-demotion and normal counting take it from there. Seeding runs once.
  Ghost tabs never count.
- Highest rank reached is stored in the same file.
- Backup: `agent-stats.json` joins the "settings" part of Settings › Backup (`src/backup.h` classification). Import
  restores it, and because of no-demotion, an import never lowers the shown rank below what this computer held.
- Footer: "Roar" with the rank on a second small line; on hover, the rank line shows what's next ("12 days to
  Hunter"). Click opens `roar://ui/badge.html` (focuses an open badge tab instead of opening another).
- Hide switch: a new setting (default: shown) in `src/settings.h`, toggled on the badge page. Off: no footer rank, no
  "Agent badge" in the AI header menu. The page stays reachable from Settings › Agents › More.
- Light/dark switch on the badge page: System, Light or Dark; defaults to System; remembered. Card exports (copy, PNG,
  GIF) follow what's on screen, as today.
- Cub with no agents: the page says plainly that the first three ranks come from using Roar and the rest need an agent,
  with a link to Settings › Agents. No nagging anywhere else.

## Calls made after review (the builder's open questions)

- **Upgrade from today's ranks.** Today's badge shows a rank computed in `badge.html` from sessions only (Cub 0,
  Scout 10, Hunter 50, Pride Leader 200, Apex Lion 1000); nothing is stored. On the first launch after the update, the
  old rank is written as "highest reached", mapped by name (old Hunter → new Hunter, and so on). Someone with 60
  sessions and a thin history seed stays Hunter; they don't land on Scout.
- **Import merges, it doesn't replace.** Importing a backup into a computer that already has counts keeps the higher
  value of each field: days, each tool's sessions, agent seconds, highest rank, and the earliest `since`. Counts never
  add up across machines, so restoring your own backup never double-counts. A backup from before this change, which
  has no day count or seeded mark, merges like any other, and seeding never runs twice.
- **What makes a day.** A day counts when the person uses Roar: a page they load in a normal tab. Pages that agents
  open (CDP or MCP, and pages in the agents' background profile), tabs Roar restores at launch, and ghost tabs don't
  count. A machine that only runs scheduled agent jobs doesn't collect days.

## Constraints

- roar:// pages can't fetch their own files, and SVG drawn to a canvas can't load any: inline the card art.
- The repo is public: nothing personal in any file, test or screenshot.
- `garden.html` shares `share-card.js`; its card must not change.
- Work goes on a branch through a PR as roarbrowser; build with `scripts/build.sh`; test on a headless scratch
  instance; never bring windows to the front.
- Windows builds use the same UI files; nothing here may depend on Mac-only code.

## Left to the builder

- Where rank is computed (C++ in `agent_stats.h` with tests, or JS from the counts), as long as the footer and page agree.
- How days are detected (on page load in a non-ghost tab, or on Roar's own activity tick), as long as a day counts once.
- The card art itself (designed with /impeccable), its animation, and the badge page layout.
- Test shapes: extend `agent_stats_test` and `share_cards_test`, plus a backup round trip (export, wipe, import,
  rank unchanged).
