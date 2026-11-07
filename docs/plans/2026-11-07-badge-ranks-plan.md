# Badge ranks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An eight-rank lion ladder that every Roar user climbs (days of use, then agent work). It shows under "Roar" in
the sidebar footer, links to a reworked badge page (ladder, theme switch, explainer, hide switch, rank-evolving card)
and survives backup import.

**Architecture:** C++ owns the counts and the rank: `src/agent_stats.h` (CEF-free, unit-tested) gains days,
highest rank, the ladder table, seeding, merge and the old-rank migration. `src/controller_share.cc` persists them
and returns everything, ladder included, from `agent.stats`, so the sidebar and badge page read one source. Backup
classifies `agent-stats.json` as settings, and restore stages it as `agent-stats.imported.json`, which the next
load merges in instead of overwriting.

**Tech Stack:** C++17 (CEF), plain HTML/JS UI in `resources/ui`, node CDP tests against a headless scratch Roar.

**Spec:** `docs/plans/2026-11-07-badge-ranks.md`

## Global Constraints

- Ladder (exact): Cub 0d; Prowler 7d; Scout 30d; Hunter 30d+10s; Pride Guard 60d+50s; Maned 90d+200s+25h; Pride Leader 180d+500s+100h; Apex Lion 365d+1000s+250h.
- Rank shown = max(computed rank, highest ever reached). Never lower.
- Old ranks (sessions only, before this change) map by name: total ≥1000 → Apex Lion, ≥200 → Pride Leader, ≥50 → Hunter, ≥10 → Scout, else Cub.
- Days: distinct local calendar days with a counted visit. A visit counts only in a tab that is not ghost, not `driven`, not `AgentActive`, and not the first load of a tab restored at launch. Never store dates per visit, URLs or titles.
- Import merges by max per field (days, each tool's sessions, agent seconds, highest rank), earliest non-zero `since`, latest `lastDay`; never sums.
- roar:// pages can't fetch their own files: inline any art. The repo is public: nothing personal anywhere. `garden.html`'s card must not change.
- Branch `badge-ranks` → PR as roarbrowser; build `ROAR_SIGN_IDENTITY=- bash scripts/build.sh`; Keychain-touching node tests run under `~/.local/bin/gui-run`; never bring windows to the front.

## Review Focus

- **A backup taken before this change** (no `days`/`bestRank` fields) imported after it: merge treats missing fields as 0 and seeding does not rerun → `agent_stats_test` "merge: old file".
- **Agents' background Roar** (`agentHeadless`, its own profile and data dir): it must not count days or overwrite the person's stats. Task 2 checks that `Dir()` differs, and skips day counting when the instance is headless.
- **Clock going backwards or midnight across time zones:** a `lastDay` later than today must not add a day or loop → `agent_stats_test` "day: clock moved back".
- **Hide switch off, then the sidebar reloads:** the footer rank and the AI-header menu item stay hidden → `share_cards_test` "hidden survives reload".
- **Two Roar windows (ROAR_INSTANCE):** both tick stats, and the last save wins. Accept it, but the merge-on-load path must not double count → covered by "merge is idempotent".

---

### Task 1: Ladder, days, merge and migration in `agent_stats.h`

**Files:**
- Modify: `src/agent_stats.h`
- Test: `tests/agent_stats_test.cc` (run by `scripts/test-agent-stats.sh`)

**Interfaces:**
- Produces:
  - `struct AgentRank { const char* name; int days; int sessions; int hours; };`
  - `inline constexpr AgentRank kAgentRanks[8]` (values from Global Constraints, index 0 = Cub)
  - `AgentStats` gains `int days = 0; std::string last_day; bool days_seeded = false; int best_rank = 0;`
  - `int AgentRankFor(int days, int sessions, double hours)` (highest index whose every need is met)
  - `int AgentRankShown(const AgentStats&)` = max(best_rank, AgentRankFor(days, total, agent_seconds/3600))
  - `int AgentOldRank(int total_sessions)` (old mapping, returns an index into kAgentRanks)
  - `bool AgentStatsDay(AgentStats&, const std::string& today)` ("YYYY-MM-DD"; true when it added a day)
  - `void AgentStatsSeed(AgentStats&, int history_days)` (once: days = max(days, history_days); best_rank = max(best_rank, AgentOldRank(total)); days_seeded = true)
  - `void AgentStatsMerge(AgentStats& into, const AgentStats& from)`
  - `bool AgentVisitCounts(bool ghost, bool driven, bool agent_active, bool restored_first_load)`

- [ ] **Step 1: Write failing tests** in `tests/agent_stats_test.cc`:
  - `rank: ladder` — AgentRankFor(0,0,0)==0; (7,0,0)==1; (30,0,0)==2; (30,10,0)==3; (29,1000,1000)==1; (365,1000,250)==7; (365,999,250)==6.
  - `rank: never lower` — best_rank=5, days=0 → AgentRankShown==5.
  - `old rank` — AgentOldRank(9)==0, (10)==2, (50)==3, (200)==6, (1000)==7.
  - `day: counts once` — Day("2026-11-07") true, again false, Day("2026-11-08") true, days==2.
  - `day: clock moved back` — last_day "2026-11-08", Day("2026-11-07") false, days unchanged.
  - `seed: once` — total 60, Seed(12) → days 12, best_rank 3; Seed(400) again → days still 12.
  - `merge: max per field` — into {days 5, sessions{claude:3}, secs 100, best 1, since 200}, from {days 9, sessions{claude:1,codex:4}, secs 50, best 2, since 100} → days 9, claude 3, codex 4, secs 100, best 2, since 100.
  - `merge: old file` — from with zero days/best_rank leaves into unchanged.
  - `merge is idempotent` — merging the same `from` twice equals merging once.
  - `visit counts` — only (false,false,false,false) is true.
- [ ] **Step 2: Run** `bash scripts/test-agent-stats.sh`. Expected: compile errors / FAIL.
- [ ] **Step 3: Implement** the interfaces above. Merge: `since` = smaller non-zero; `last_day` = larger string; `days_seeded` = OR; `seen` = into's ids plus from's that are missing, capped at `kAgentStatsSeen`.
- [ ] **Step 4: Run** `bash scripts/test-agent-stats.sh`. Expected: all ok.
- [ ] **Step 5: Commit** `git add src/agent_stats.h tests/agent_stats_test.cc && git commit -m "Agent stats: rank ladder, days, merge and old-rank migration"`

### Task 2: Persist, count days, seed, serve `agent.stats`

**Files:**
- Modify: `src/controller_share.cc` (LoadStats/StatsDict/AgentStatsTick, `agent.stats`), `src/controller.cc:6707` (visit hook), `src/controller.h` (Tab gains `bool restored_first_load = false;`, not saved), `src/state.cc` (tabs read from state.json set it true)
- Test: `tests/share_cards_test.mjs`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `void Controller::AgentStatsVisit(const Tab& tab)` — called next to `RecordVisit`; uses `AgentVisitCounts(tab.ghost, tab.driven, AgentActive(tab.agent, tab.driven, now), tab.restored_first_load)`, then clears `restored_first_load`; skipped when the instance is headless.
  - `agent-stats.json` gains `days`, `lastDay`, `daysSeeded`, `bestRank`.
  - `agent.stats` reply adds `days`, `hours` (agent_seconds/3600, floored), `rank` (AgentRankShown), `ladder: [{name, days, sessions, hours}]` (from kAgentRanks).
  - LoadStats: if `agent-stats.imported.json` exists, parse it with the same reader, `AgentStatsMerge` into g_stats, delete it, save. If `!days_seeded`, seed from the distinct local days among `State::Get().history` `last_visit` values and save.

- [ ] **Step 1: Failing test** in `share_cards_test.mjs`, "stats: days and ladder": after start, open `http://127.0.0.1:<calendar port>/` in a new tab via sidebar `open`. `agent.stats` then has `days === 1`, `ladder.length === 8`, `ladder[3].name === 'Hunter'`, `rank === 0`. Restart Roar (existing restart helper): days still 1 (same day), and the restored tab's first load did not add anything.
- [ ] **Step 2: Failing test** "stats: imported file merges": write `agent-stats.imported.json` `{"days":40,"bestRank":3,"sessions":{"codex":12}}` into the data dir and restart. Expected: `days >= 40`, `rank >= 3`, the file is gone, `sessions.codex === 12`.
- [ ] **Step 3: Implement.** Local day string from `localtime_r` → `%Y-%m-%d`. Readers treat missing fields as 0.
- [ ] **Step 4: Build and run** `ROAR_SIGN_IDENTITY=- bash scripts/build.sh && ~/.local/bin/gui-run node tests/share_cards_test.mjs build/src/Release/Roar.app/Contents/MacOS/Roar`. Expected: all passed.
- [ ] **Step 5: Commit** `git add src/controller_share.cc src/controller.cc src/controller.h src/state.cc tests/share_cards_test.mjs && git commit -m "Count days of Roar use for the badge and merge imported stats"`

### Task 3: Backup carries the badge

**Files:**
- Modify: `src/backup.h` (Classify; ApplyPendingRestore)
- Test: `tests/backup_test.cc` (`scripts/test-backup.sh`), `tests/backup_roundtrip.mjs`

**Interfaces:**
- Produces: `Classify("agent-stats.json") == kSettings`. ApplyPendingRestore never removes a live `agent-stats.json`; it moves the staged one to `agent-stats.imported.json` (Task 2 merges it).

- [ ] **Step 1: Failing tests** in `backup_test.cc`: "classify: agent stats is settings"; "restore: agent stats is staged for merge, live file kept". Set up a dir with live `agent-stats.json` = "LIVE" and staged `files/agent-stats.json` = "OLD", plus `remove.txt` listing `agent-stats.json`. After ApplyPendingRestore: live is still "LIVE" and `agent-stats.imported.json` is "OLD".
- [ ] **Step 2: Run** `bash scripts/test-backup.sh`. Expected: FAIL.
- [ ] **Step 3: Implement** both rules in `backup.h`.
- [ ] **Step 4: Failing → passing e2e** in `backup_roundtrip.mjs`: write stats (days 40, bestRank 3), export settings, delete `agent-stats.json`, import and relaunch. Expected: `agent.stats` rank ≥ 3 and days ≥ 40. Run `bash scripts/test-backup.sh` (it runs the round trip when a build exists). Expected: all ok.
- [ ] **Step 5: Commit** `git add src/backup.h tests/backup_test.cc tests/backup_roundtrip.mjs && git commit -m "Backup: carry the badge, and merge it on import"`

### Task 4: Footer rank, hide switch and AI-header menu

**Files:**
- Modify: `src/settings.h` (`bool badge_shown = true;`, key `"badgeShown"`), `resources/ui/sidebar.html` (`.brand` at ~545; `aiHeadMenu`; CSS)
- Test: `tests/share_cards_test.mjs`

**Interfaces:**
- Consumes: `agent.stats` from Task 2.
- Produces: `#brand-rank` (button under the wordmark): text = ladder[rank].name; `title` = what's needed for the next rank ("12 days and 3 sessions to Hunter", or "Top of the pride"); click focuses an open `roar://ui/badge.html` tab, else opens one. Refreshed on sidebar load and every 60 s. Hidden when `settings.badgeShown === false`, and so is the "Agent badge" item in `aiHeadMenu`.

- [ ] **Step 1: Failing tests** in `share_cards_test.mjs`: "footer shows the rank" (`#brand-rank` text is 'Cub' on a fresh dir); "footer opens the badge" (click → a `badge.html` target; a second click opens no new target); "hidden survives reload" (`settings.set badgeShown:false`, reload the sidebar → `#brand-rank` hidden and the AI-header contextmenu has no "Agent badge" item; set it true → both back).
- [ ] **Step 2: Implement.** `next` wording joins the unmet needs: "N days", "N sessions", "N agent hours" + " to " + name.
- [ ] **Step 3: Build and run** `share_cards_test`. Expected: all passed.
- [ ] **Step 4: Commit** `git add src/settings.h resources/ui/sidebar.html tests/share_cards_test.mjs && git commit -m "Sidebar: your rank under Roar, with a switch to hide it"`

### Task 5: Badge page: ladder, explainer, theme switch, hide switch

**Files:**
- Modify: `resources/ui/badge.html`, `resources/ui/share-card.js` (theme override)
- Test: `tests/share_cards_test.mjs`

**Interfaces:**
- Consumes: `agent.stats` (rank, days, hours, ladder, sessions, since).
- Produces: `shareCard` spec option `theme: () => 'light' | 'dark'`. When present it wins over `prefers-color-scheme`, and the card redraws when it changes. Page controls: `#theme` segmented (System / Light / Dark; localStorage `badgeTheme`, wrapped in try/catch; default System); `#ladder` list, one `li[data-rank]` per rank with `.earned` or `.locked` and the unmet needs with progress (e.g. "12 of 30 days"); `#how` explainer; `#shown` switch bound to `badgeShown`.
- Copy for `#how` (exact): "Your rank grows as you use Roar. The first three ranks come from the days you browse with Roar, no AI needed. From Hunter on, they also count the agent sessions and hours Roar sees when you connect a coding agent in Settings › Agents. Everything is counted on this computer and never leaves it unless you share your card."

- [ ] **Step 1: Failing tests:** "ladder lists every rank" (8 `li`, `li[data-rank="0"].earned`, `li[data-rank="3"].locked` text includes "10 sessions"); "theme switch" (click Dark → the card's dark ink pixel, as the existing dark test reads it; click Light → light, with the system emulating dark); "page hide switch" (uncheck `#shown` → `settings.badgeShown === false`).
- [ ] **Step 2: Implement.** Remove the old `RANKS`/`rankOf`/`nextOf` from badge.html; everything comes from `agent.stats`.
- [ ] **Step 3: Build and run** `share_cards_test`. Expected: all passed, and the Savanna checks unchanged.
- [ ] **Step 4: Commit** `git add resources/ui/badge.html resources/ui/share-card.js tests/share_cards_test.mjs && git commit -m "Badge page: the ladder, how ranks work, theme and hide switches"`

### Task 6: Card art that evolves with rank (/impeccable)

**Files:**
- Modify: `resources/ui/badge.html` (card SVG builder), `resources/ui/share-card.js` only if the band needs a hook
- Test: `tests/share_cards_test.mjs`

**Interfaces:**
- Consumes: rank index; the theme from Task 5.
- Produces: `cardLook(rank) -> 'cub' | 'young' | 'maned' | 'apex'` (0-1, 2-3, 4-6, 7), with inline SVG art per look in light and dark, composed with the "Made with Roar" band. The live animation and GIF frames come from the same drawing.

- [ ] **Step 1: Design with /impeccable.** Refinement of the existing card identity: four looks, one family, each a visible step up. Render all eight ranks × two themes on a scratch page and choose before wiring.
- [ ] **Step 2: Failing test** "card evolves": for ranks 0, 2, 4 and 7 (set via `bestRank` in an imported file and a restart, or a test hook `?rank=` honored only when `ROAR_UI_CDP` is set), the PNG data differs between looks and is equal within a look in the same theme.
- [ ] **Step 3: Implement**, keeping the GIF ≤ the current size budget the test checks.
- [ ] **Step 4: Build and run** `share_cards_test`. Expected: all passed. Save CDP screenshots of all eight ranks × light/dark to `.shots/` (not committed).
- [ ] **Step 5: Commit** `git add resources/ui/badge.html resources/ui/share-card.js tests/share_cards_test.mjs && git commit -m "Badge card: art that grows with your rank"`

### Task 7: Verify and open the PR (/verification-before-completion)

- [ ] **Step 1:** `bash scripts/test-agent-stats.sh && bash scripts/test-backup.sh`, then under gui-run: `share_cards_test`, `backup_roundtrip`, `agent_cards_test`, `agent_settings_test`. Expected: all pass. Report anything flaky with its log.
- [ ] **Step 2:** Scratch-instance CDP screenshots: footer with the rank, footer hidden, the badge page light and dark, the ladder with locked ranks, and the card for each look. Push them to a `pr-shots/badge-ranks` branch.
- [ ] **Step 3:** Push `badge-ranks` and open the PR as roarbrowser-bot (base: main once PR #70 merges, else stacked on `polish-after-1.20`). Don't merge.
