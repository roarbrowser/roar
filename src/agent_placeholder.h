#pragma once
// When a new-* stand-in session row (written by claude-ctl new before the agent reports) is dropped.
// Header-only and CEF-free: tests/placeholder_test.cc.
#include <string>

namespace roar {

// The CLIs replace their stand-in with their first hook event; one still there after 15 idle minutes
// was cancelled (at Claude's trust question, say). Hermes sends no hook event, and the dashboard poll
// shows the real chat by then, so its stand-in goes after 60 s.
inline bool PlaceholderExpired(const std::string& tool, double idle) { return idle > (tool == "hermes" ? 60 : 15 * 60); }

}  // namespace roar
