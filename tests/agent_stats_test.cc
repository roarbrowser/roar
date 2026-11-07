// What the agent badge counts (src/agent_stats.h): scripts/test-agent-stats.sh.
#include "agent_stats.h"

#include <cstdio>

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
  std::printf(fail ? "%d failed\n" : "all passed\n", fail);
  return fail ? 1 : 0;
}
