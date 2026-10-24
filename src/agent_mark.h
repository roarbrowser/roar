// Which tabs an agent opened or acted on, and whether it is acting on them now. Header-only and
// CEF-free: tests/agent_mark_test.cc.
#pragma once

namespace roar {

// An agent counts as active on a tab for this long after its last MCP command there.
constexpr double kAgentActiveSeconds = 60;

struct AgentMark {
  bool marked = false;  // Saved: an agent opened or acted on this tab, until the person clears it.
  double last = 0;      // Saved: Unix seconds of the agent's last command on the tab.
};

// An agent opened the tab or ran a command on it.
inline void TouchAgentMark(AgentMark& m, double now) { m.marked = true; m.last = now; }

// Shown with the full Agent tag and page frame: a recent command, or the agent still attached.
inline bool AgentActive(const AgentMark& m, bool attached, double now) {
  return m.marked && (attached || now - m.last < kAgentActiveSeconds);
}

// A tab opened from |opener| (a link or popup) is the agent's while the agent is active on the opener.
inline AgentMark InheritAgentMark(const AgentMark& opener, bool attached, double now) {
  AgentMark m;
  if (AgentActive(opener, attached, now)) TouchAgentMark(m, now);
  return m;
}

// The person cleared it from the tab's menu. Their own typing or navigation never does.
inline void ClearAgentMark(AgentMark& m) { m = {}; }

}  // namespace roar
