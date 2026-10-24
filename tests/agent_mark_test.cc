// AgentMark (src/agent_mark.h): scripts/test-agent-mark.sh.
#include "agent_mark.h"

#include <cstdio>

int main() {
  int fail = 0;
  auto check = [&](bool ok, const char* what) { if (!ok) fail++; std::printf("%s %s\n", ok ? "ok  " : "FAIL", what); };
  const double t0 = 1000, n = roar::kAgentActiveSeconds;
  roar::AgentMark m;
  check(!m.marked && !roar::AgentActive(m, false, t0), "a person's tab is unmarked");
  check(!roar::AgentActive(m, true, t0), "an attached CDP client alone never marks a tab");

  roar::TouchAgentMark(m, t0);  // new_page opened it
  check(m.marked && roar::AgentActive(m, false, t0 + 1), "opened by an agent: marked and active");
  check(roar::AgentActive(m, false, t0 + n - 1), "still active just inside the window");
  check(m.marked && !roar::AgentActive(m, false, t0 + n + 1), "inactive after the window, still marked");
  check(roar::AgentActive(m, true, t0 + 10 * n), "an attached agent session keeps it active");
  roar::TouchAgentMark(m, t0 + 5 * n);
  check(roar::AgentActive(m, false, t0 + 5 * n + 1), "a new command makes it active again");

  roar::ClearAgentMark(m);
  check(!m.marked && !roar::AgentActive(m, true, t0 + 5 * n + 1), "cleared: unmarked, never active");

  roar::AgentMark existing;  // the person's own tab, then the agent navigates/clicks in it
  roar::TouchAgentMark(existing, t0);
  check(existing.marked && roar::AgentActive(existing, false, t0), "agent touching an existing tab marks it");

  roar::AgentMark saved{true, t0};  // restored from state.json the next day
  check(saved.marked && !roar::AgentActive(saved, false, t0 + 86400), "restored mark survives, inactive");

  check(roar::InheritAgentMark(existing, false, t0 + 1).marked, "a link the active agent opens is marked");
  check(!roar::InheritAgentMark(existing, false, t0 + n + 1).marked, "a link opened later by the person is not");
  check(!roar::InheritAgentMark(roar::AgentMark{}, false, t0).marked, "links from a person's tab are not");
  return fail ? 1 : 0;
}
