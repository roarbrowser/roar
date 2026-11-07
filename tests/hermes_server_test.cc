// Hermes server rules (src/hermes_server.h): scripts/test-hermes-server.sh.
#include "hermes_server.h"

#include <cstdio>

int main() {
  using namespace roar;
  int fail = 0;
  auto check = [&](bool ok, const char* what) { if (!ok) fail++; std::printf("%s %s\n", ok ? "ok  " : "FAIL", what); };

  check(HermesBase(" https://hermes.example.com/ \n") == "https://hermes.example.com", "trims spaces and trailing slashes");
  check(HermesBase("https://example.com/hermes") == "https://example.com/hermes", "keeps a proxy path");
  check(HermesBase("http://localhost") == "http://localhost", "plain http to this computer, even with no port");
  check(HermesBase("http://127.0.0.1:9119") == "http://127.0.0.1:9119", "loopback with a port");
  check(HermesBase("http://192.168.1.20:9119") == "http://192.168.1.20:9119", "plain http on a private network");
  check(HermesBase("http://box.local:9119") == "http://box.local:9119", "plain http to a .local name");
  check(HermesBase("http://hermes.example.com").empty(), "no cookies over plain http to a public host");
  check(HermesBase("http://8.8.8.8:9119").empty(), "nor to a public address");
  check(HermesBase("https://user@example.com").empty(), "no login in the URL");
  check(HermesBase("http://192.168.1.1@evil.example").empty(), "a private address can't front a public host");
  check(HermesBase("https://example.com/?x=1").empty(), "no query");
  check(HermesBase("https://example.com/#x").empty(), "no fragment");
  check(HermesBase("https://").empty() && HermesBase("").empty() && HermesBase("   ").empty(), "nothing to reach");
  check(HermesBase("ftp://example.com").empty() && HermesBase("file:///etc").empty() && HermesBase("example.com").empty(), "web addresses only");
  check(HermesBase("https://" + std::string(400, 'a') + ".com").empty(), "a sane length");

  check(HermesOrigin("https://example.com/hermes") == "https://example.com/", "origin drops the path");
  check(HermesOrigin("http://127.0.0.1:9119") == "http://127.0.0.1:9119/", "origin keeps the port");
  check(HermesSessionsUrl("https://e.com") == "https://e.com/api/profiles/sessions?limit=60&order=recent&exclude_sources=cron", "every profile, no cron");

  check(HermesRowId("coder", "local-ab12") == "hermes-coder-local-ab12", "row id");
  check(HermesRowId("default", "20261106_215933_df4239") == "hermes-default-20261106_215933_df4239", "dated ids pass");
  check(HermesRowId("", "x").empty() && HermesRowId("x", "").empty(), "both parts needed");
  check(HermesRowId("a/b", "x").empty() && HermesRowId("x", "a&profile=y").empty() && HermesRowId("x", "<b>").empty(), "only plain ids");
  check(HermesChatUrl("https://e.com", "s1", "coder") == "https://e.com/chat?resume=s1&profile=coder", "chat link names the profile");

  const double now = 1000000;
  check(HermesShows(false, now - 60, now), "open and recent shows");
  check(!HermesShows(true, now - 60, now), "ended doesn't");
  check(!HermesShows(false, now - 7 * 3600, now), "quiet for hours doesn't");
  check(!HermesShows(false, 0, now), "no activity time doesn't");

  check(HermesDoing("coder", "kanban") == "coder · Board card", "a worker's card");
  check(HermesDoing("default", "bluebubbles") == "iMessage", "the default profile isn't named");
  check(HermesDoing("", "oneshot") == "Terminal", "a one-shot run");
  check(HermesDoing("default", "something-new") == "Chat", "an unknown source");

  std::printf(fail ? "%d failed\n" : "all passed\n", fail);
  return fail ? 1 : 0;
}
