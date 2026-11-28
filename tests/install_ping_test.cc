// Standalone check for install counting (src/install_ping.h): scripts/test-install-ping.sh
#include <cstdio>
#include <string>

#include "install_ping.h"

static int failures = 0;
static void Check(bool ok, const char* what) {
  if (!ok) ++failures, std::printf("FAIL %s\n", what);
}

int main() {
  using roar::InstallPingDue;
  // What each saved ping_version owes at launch.
  Check(InstallPingDue("new", "1.37.0").name == "first_seen", "a profile that never launched owes first_seen");
  Check(InstallPingDue("fresh", "1.37.0").name == "first_seen", "first launch closed before sending: still first_seen");
  Check(InstallPingDue("1.37.0", "1.37.0").name.empty(), "same version: nothing");
  auto up = InstallPingDue("1.36.0", "1.37.0");
  Check(up.name == "update" && up.from == "1.36.0", "new version: update from the last one counted");
  auto old = InstallPingDue("", "1.37.0");
  Check(old.name == "update" && old.from == "unknown", "a profile from before counting: update from unknown");
  Check(InstallPingDue("1.38.0", "1.37.0").name == "update", "a downgrade counts as a version change too");
  Check(InstallPingDue("new", "").name.empty(), "no version known: nothing");

  // The body: only the event name, version, os, arch (and from), no id.
  std::string first = roar::InstallPingBody({"first_seen", ""}, "1.37.0", "mac", "arm64");
  Check(first == std::string("{\"type\":\"event\",\"payload\":{\"website\":\"") + roar::kInstallPingSite +
                     "\",\"hostname\":\"app.roarbrowser.app\",\"url\":\"/app\",\"name\":\"first_seen\","
                     "\"data\":{\"version\":\"1.37.0\",\"os\":\"mac\",\"arch\":\"arm64\"}}}",
        "first_seen body");
  std::string upd = roar::InstallPingBody(up, "1.37.0", "windows", "x64");
  Check(upd.find("\"name\":\"update\"") != std::string::npos && upd.find("\"from\":\"1.36.0\"") != std::string::npos &&
            upd.find("\"os\":\"windows\"") != std::string::npos,
        "update body carries from");
  Check(first.find("from") == std::string::npos, "first_seen has no from");
  for (const char* k : {"language", "screen", "referrer", "title", "id\"", "ip"})
    Check(first.find(k) == std::string::npos && upd.find(k) == std::string::npos, k);
  Check(roar::InstallPingQuote("a\"b\\c\n") == "\"a\\\"b\\\\c\"", "quoting escapes and drops control characters");

  // Which replies settle it (else the next launch tries again).
  Check(roar::InstallPingSettled(200) && roar::InstallPingSettled(204), "2xx settles");
  Check(roar::InstallPingSettled(400) && roar::InstallPingSettled(403), "a refusal settles (never retried)");
  Check(!roar::InstallPingSettled(0) && !roar::InstallPingSettled(429) && !roar::InstallPingSettled(500) &&
            !roar::InstallPingSettled(503),
        "offline, 429 and 5xx retry next launch");

  std::printf(failures ? "%d failure(s)\n" : "ok\n", failures);
  return failures ? 1 : 0;
}
