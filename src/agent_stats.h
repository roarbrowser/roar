// What the agent badge counts. Header-only and CEF-free so tests/agent_stats_test.cc checks it standalone; reading,
// saving and the share commands are in controller_share.cc. Ids and numbers only, never a prompt or a title.
#pragma once

#include <algorithm>
#include <cstdio>
#include <deque>
#include <map>
#include <string>

namespace roar {

constexpr size_t kAgentStatsSeen = 2000;     // Long enough that a live session never counts twice.
constexpr double kAgentStatsMaxStep = 10;    // A Mac waking from sleep is not hours of work.

struct AgentStats {
  double since = 0;                  // Epoch seconds of the first count.
  std::map<std::string, int> sessions;  // Per tool.
  double agent_seconds = 0;          // Summed over sessions, so two at once count twice.
  std::deque<std::string> seen;      // Session ids already counted, oldest first.
  int days = 0;                      // Local days with a page the person opened (AgentStatsDay).
  std::string last_day;              // The last day counted, "YYYY-MM-DD". No other dates are kept.
  bool days_seeded = false;          // Past days were taken from history once (AgentStatsSeed).
  int best_rank = 0;                 // Highest rank reached: the shown rank never goes below it.
};

// Stand-ins for a session that hasn't reported yet, and rows that aren't sessions at all.
inline bool AgentStatsCounts(const std::string& id) {
  return !id.empty() && id.rfind("new-", 0) != 0 && id != "hermes-signin";
}

// Counts a session the first time it's seen. True when that changed anything.
inline bool AgentStatsSee(AgentStats& s, const std::string& tool, const std::string& id, double now) {
  if (!AgentStatsCounts(id) || std::find(s.seen.rbegin(), s.seen.rend(), id) != s.seen.rend()) return false;
  if (s.since <= 0) s.since = now;
  s.sessions[tool.empty() ? "claude" : tool]++;
  s.seen.push_back(id);
  while (s.seen.size() > kAgentStatsSeen) s.seen.pop_front();
  return true;
}

// `working` sessions were busy for the `step` seconds since the last look.
inline void AgentStatsWork(AgentStats& s, int working, double step) {
  if (working > 0 && step > 0) s.agent_seconds += working * std::min(step, kAgentStatsMaxStep);
}

inline int AgentStatsTotal(const AgentStats& s) {
  int total = 0;
  for (const auto& [tool, n] : s.sessions) total += n;
  return total;
}

// ---- The rank ladder (docs/plans/2026-11-07-badge-ranks.md) ----
// Days of Roar use first, then agent work. A rank needs all of its numbers.
struct AgentRank {
  const char* name;
  int days;
  int sessions;
  int hours;
};
inline constexpr AgentRank kAgentRanks[] = {
    {"Cub", 0, 0, 0},           {"Prowler", 7, 0, 0},       {"Scout", 30, 0, 0},           {"Hunter", 30, 10, 0},
    {"Pride Guard", 60, 50, 0}, {"Maned", 90, 200, 25},     {"Pride Leader", 180, 500, 100}, {"Apex Lion", 365, 1000, 250},
};
inline constexpr int kAgentRankCount = sizeof(kAgentRanks) / sizeof(kAgentRanks[0]);

inline int AgentRankFor(int days, int sessions, double hours) {
  int rank = 0;
  for (int i = 0; i < kAgentRankCount; ++i)
    if (days >= kAgentRanks[i].days && sessions >= kAgentRanks[i].sessions && hours >= kAgentRanks[i].hours) rank = i;
    else break;
  return rank;
}

// Never lower than the best rank reached (no demotion after an update or an import).
inline int AgentRankShown(const AgentStats& s) {
  return std::max(s.best_rank, AgentRankFor(s.days, AgentStatsTotal(s), s.agent_seconds / 3600));
}

// The rank before days existed (sessions only), mapped onto the same names.
inline int AgentOldRank(int total_sessions) {
  return total_sessions >= 1000 ? 7 : total_sessions >= 200 ? 6 : total_sessions >= 50 ? 3 : total_sessions >= 10 ? 2 : 0;
}

// Days since 1970-01-01 for a "YYYY-MM-DD" (civil calendar, H. Hinnant's days_from_civil); 0 when it isn't one.
inline int AgentDayNumber(const std::string& ymd) {
  int y = 0, m = 0, d = 0;
  if (ymd.size() != 10 || std::sscanf(ymd.c_str(), "%4d-%2d-%2d", &y, &m, &d) != 3 || m < 1 || m > 12 || d < 1 || d > 31) return 0;
  y -= m <= 2;
  const int era = (y >= 0 ? y : y - 399) / 400, yoe = y - era * 400, doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  return era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
}

// |today| is a local "YYYY-MM-DD". A day counts once; a clock moved back adds nothing. A day mark more than two days
// ahead of today came from a clock set wrong (or a backup from one): let it go rather than wait for that date.
inline bool AgentStatsDay(AgentStats& s, const std::string& today) {
  if (today.empty()) return false;
  if (today <= s.last_day) {
    if (AgentDayNumber(s.last_day) - AgentDayNumber(today) > 2) s.last_day = today;
    return false;
  }
  s.last_day = today;
  s.days++;
  return true;
}

// Once, on the first launch with days: past days from history, and today's rank kept.
inline void AgentStatsSeed(AgentStats& s, int history_days) {
  if (s.days_seeded) return;
  s.days = std::max(s.days, history_days);
  s.best_rank = std::max(s.best_rank, AgentOldRank(AgentStatsTotal(s)));
  s.days_seeded = true;
}

// An imported backup: the higher of each count, the earliest start. Never sums, so restoring your own backup is safe.
inline void AgentStatsMerge(AgentStats& into, const AgentStats& from) {
  for (const auto& [tool, n] : from.sessions) into.sessions[tool] = std::max(into.sessions[tool], n);
  into.agent_seconds = std::max(into.agent_seconds, from.agent_seconds);
  into.best_rank = std::max(into.best_rank, from.best_rank);
  if (from.since > 0 && (into.since <= 0 || from.since < into.since)) into.since = from.since;
  if (from.days > into.days || (from.days == into.days && from.last_day > into.last_day)) into.last_day = from.last_day;  // The mark follows the days that win.
  into.days = std::max(into.days, from.days);
  into.days_seeded = into.days_seeded || from.days_seeded;
  for (const auto& id : from.seen)
    if (std::find(into.seen.begin(), into.seen.end(), id) == into.seen.end()) into.seen.push_back(id);
  while (into.seen.size() > kAgentStatsSeen) into.seen.pop_front();
}

// A page load is the person using Roar: not a ghost tab, not an agent's, not a tab restored at launch.
inline bool AgentVisitCounts(bool ghost, bool driven, bool agent_active, bool restored_first_load) {
  return !ghost && !driven && !agent_active && !restored_first_load;
}

}  // namespace roar
