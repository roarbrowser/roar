// What the agent badge counts. Header-only and CEF-free so tests/agent_stats_test.cc checks it standalone; reading,
// saving and the share commands are in controller_share.cc. Ids and numbers only, never a prompt or a title.
#pragma once

#include <algorithm>
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

}  // namespace roar
