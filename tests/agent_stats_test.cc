// What the agent badge counts (src/agent_stats.h): scripts/test-agent-stats.sh.
#include "agent_stats.h"

#include <cstdio>
#include <string>

int main() {
  using namespace roar;
  int fail = 0;
  auto check = [&](bool ok, const char* what) { if (!ok) fail++; std::printf("%s %s\n", ok ? "ok  " : "FAIL", what); };
  AgentStats s;
  check(AgentStatsSee(s, "codex", "codex-1", 100) && s.since == 100 && s.sessions["codex"] == 1, "a new session counts, and starts the clock");
  check(!AgentStatsSee(s, "codex", "codex-1", 101) && s.sessions["codex"] == 1, "seen again, it doesn't");
  check(AgentStatsSee(s, "", "abc", 102) && s.sessions["claude"] == 1 && s.since == 100, "no tool is a Claude Code session; the clock keeps its start");
  check(!AgentStatsSee(s, "claude", "new-1", 103) && !AgentStatsSee(s, "hermes", "hermes-signin", 103) && !AgentStatsSee(s, "claude", "", 103), "stand-ins and the sign-in row aren't sessions");
  check(AgentStatsTotal(s) == 2, "the total adds every tool");
  AgentStatsWork(s, 2, 2);
  check(s.agent_seconds == 4, "two busy sessions count twice");
  AgentStatsWork(s, 1, 3600);
  check(s.agent_seconds == 4 + kAgentStatsMaxStep, "waking from sleep isn't an hour of work");
  double was = s.agent_seconds;
  AgentStatsWork(s, 0, 2); AgentStatsWork(s, 2, -5);
  check(s.agent_seconds == was, "nothing busy, or a clock going back, adds nothing");
  for (size_t i = 0; i < kAgentStatsSeen + 5; ++i) AgentStatsSee(s, "gemini", "g" + std::to_string(i), 200);
  check(s.seen.size() == kAgentStatsSeen, "the seen list stays bounded");
  check(s.sessions["gemini"] == static_cast<int>(kAgentStatsSeen + 5), "and the counts keep going");

  // The rank ladder (docs/plans/2026-11-07-badge-ranks.md).
  check(AgentRankFor(0, 0, 0) == 0 && AgentRankFor(7, 0, 0) == 1 && AgentRankFor(30, 0, 0) == 2 && AgentRankFor(30, 10, 0) == 3,
        "rank: ladder, days first, then sessions");
  check(AgentRankFor(29, 1000, 1000) == 1, "rank: agent work alone doesn't skip the days");
  check(AgentRankFor(365, 1000, 250) == 7 && AgentRankFor(365, 999, 250) == 6, "rank: Apex needs every number");
  check(std::string(kAgentRanks[3].name) == "Hunter" && std::string(kAgentRanks[7].name) == "Apex Lion", "rank: names");
  { AgentStats r; r.best_rank = 5; check(AgentRankShown(r) == 5, "rank: never lower than the best reached"); }
  check(AgentOldRank(9) == 0 && AgentOldRank(10) == 2 && AgentOldRank(50) == 3 && AgentOldRank(200) == 6 && AgentOldRank(1000) == 7,
        "old rank: today's names carry over");
  { AgentStats d;
    check(AgentStatsDay(d, "2026-11-07") && !AgentStatsDay(d, "2026-11-07") && AgentStatsDay(d, "2026-11-08") && d.days == 2, "day: counts once");
    check(!AgentStatsDay(d, "2026-11-07") && d.days == 2 && d.last_day == "2026-11-08", "day: clock moved back adds nothing"); }
  { AgentStats f;  // A clock set far ahead once must not stop the count until that date comes round.
    AgentStatsDay(f, "2027-06-01");
    check(!AgentStatsDay(f, "2026-11-07") && f.last_day == "2026-11-07" && AgentStatsDay(f, "2026-11-08") && f.days == 2, "day: a date far ahead is let go"); }
  check(AgentDayNumber("2026-11-08") - AgentDayNumber("2026-11-07") == 1 && AgentDayNumber("2027-01-01") - AgentDayNumber("2026-12-31") == 1, "day numbers");
  { AgentStats into, from;  // The day mark follows the side whose days won.
    into.days = 9; into.last_day = "2026-11-07"; from.days = 3; from.last_day = "2027-06-01";
    AgentStatsMerge(into, from);
    check(into.last_day == "2026-11-07", "merge: a losing side's day mark doesn't come along"); }
  { AgentStats e; e.sessions["claude"] = 60;
    AgentStatsSeed(e, 12);
    check(e.days == 12 && e.best_rank == 3 && e.days_seeded, "seed: days from history, old rank kept");
    AgentStatsSeed(e, 400);
    check(e.days == 12, "seed: once"); }
  { AgentStats into, from;
    into.days = 5; into.sessions["claude"] = 3; into.agent_seconds = 100; into.best_rank = 1; into.since = 200; into.last_day = "2026-11-01";
    from.days = 9; from.sessions["claude"] = 1; from.sessions["codex"] = 4; from.agent_seconds = 50; from.best_rank = 2; from.since = 100; from.last_day = "2026-11-05";
    AgentStatsMerge(into, from);
    check(into.days == 9 && into.sessions["claude"] == 3 && into.sessions["codex"] == 4 && into.agent_seconds == 100 && into.best_rank == 2 &&
          into.since == 100 && into.last_day == "2026-11-05", "merge: max per field, earliest start");
    AgentStats again = into;
    AgentStatsMerge(again, from);
    check(again.days == into.days && again.sessions == into.sessions && again.agent_seconds == into.agent_seconds && again.best_rank == into.best_rank,
          "merge is idempotent");
    AgentStats old;  // A backup from before days and ranks existed.
    old.sessions["claude"] = 2; old.since = 0;
    AgentStats kept = into;
    AgentStatsMerge(kept, old);
    check(kept.days == into.days && kept.best_rank == into.best_rank && kept.since == into.since, "merge: old file changes nothing it lacks"); }
  check(AgentVisitCounts(false, false, false, false) && !AgentVisitCounts(true, false, false, false) && !AgentVisitCounts(false, true, false, false) &&
        !AgentVisitCounts(false, false, true, false) && !AgentVisitCounts(false, false, false, true), "visit counts: only the person's own pages");
  std::printf(fail ? "%d failed\n" : "all passed\n", fail);
  return fail ? 1 : 0;
}
