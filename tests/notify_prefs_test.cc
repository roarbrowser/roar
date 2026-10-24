// Standalone check for per-type notification prefs (src/notify_prefs.h): scripts/test-notify-prefs.sh
#include <cstdio>
#include <string>

#include "notify_prefs.h"

static int failures = 0;
static void check(bool ok, const char* what) { if (!ok) ++failures, std::printf("FAIL %s\n", what); }

int main() {
  using namespace roar;
  // Migration: a default install keeps today's behavior.
  Settings d;
  std::string m = NotifyMigrate(d);
  NotifyPref p = NotifyGet(m, "sessionDone");
  check(p.on && p.dismiss == 45 && p.mac, "default sessionDone: on, 45 s, macOS");
  p = NotifyGet(m, "sessionNeeds");
  check(p.on && p.dismiss == 120 && p.mac, "default sessionNeeds: on, 2 min, macOS");
  check(!NotifyGet(m, "download").on && !NotifyGet(m, "update").on && !NotifyGet(m, "error").on && !NotifyGet(m, "dictation").on, "new types are opt in");
  for (const auto& t : NotifyTypes()) check(m.find(std::string(t.id) + ":") != std::string::npos, "migration writes every type");

  // Migration: the four old switches carry over.
  Settings s;
  s.claude_alert_done = false;
  s.auto_dismiss_done = false;
  s.claude_alert_needs = false;
  s.claude_alert_system = false;
  m = NotifyMigrate(s);
  p = NotifyGet(m, "sessionDone");
  check(!p.on && p.dismiss == 30 && !p.mac, "sessionDone off, auto-dismiss off keeps the old 30 s, no macOS");
  p = NotifyGet(m, "sessionNeeds");
  check(!p.on && !p.mac, "sessionNeeds off, no macOS");
  check(NotifyGet(m, "agentDone").dismiss == 30 && NotifyGet(m, "agentDone").on, "auto-dismiss off: agent done cards keep 30 s too");
  s.claude_alert_done = true;
  s.claude_alert_system = true;
  p = NotifyGet(NotifyMigrate(s), "sessionDone");
  check(p.on && p.mac && p.dismiss == 30, "mixed switches migrate independently");

  // Parsing: missing, malformed and saved entries.
  check(NotifyGet("", "sessionDone").on && NotifyGet("", "sessionDone").dismiss == 45, "empty prefs give defaults");
  check(NotifyGet("download:1:5:1", "download").on && NotifyGet("download:1:5:1", "download").dismiss == 5, "saved entry wins");
  check(!NotifyGet("download:1:5:1x", "download").on, "malformed entry falls back to the default");
  check(!NotifyGet("download:1:-5:1", "download").on, "negative seconds are rejected");
  check(NotifyGet("downloadX:1:5:1", "download").dismiss == 15, "ids match whole");
  check(NotifyGet("a:0:0:0,error:1:120:0,b", "error").dismiss == 120, "entries in a list");

  // Dismiss timing per type and level.
  for (int secs : {0, 5, 15, 30, 45, 120}) {
    NotifyPref q{true, secs, false};
    CardTiming done = NotifyTiming(q, "done"), info = NotifyTiming(q, "info"), needs = NotifyTiming(q, "needs_you");
    check(done.secs == secs && info.secs == secs && needs.secs == secs, "secs carried through");
    check(done.screen == (secs > 0) && !info.screen && !needs.screen, "only done cards count screen time");
  }
  check(NotifyTiming({true, 45, false}, "info", 300).secs == 300, "ROAR_ALERT_TTL overrides a timer");
  check(NotifyTiming({true, 45, false}, "done", 300).secs == 45, "but not screen time");
  check(NotifyTiming({true, 0, false}, "info", 300).secs == 0, "and never stays never");

  std::printf(failures ? "%d failure(s)\n" : "ok\n", failures);
  return failures ? 1 : 0;
}
