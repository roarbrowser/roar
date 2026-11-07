// Hermes server rules (src/hermes_server.h): scripts/test-hermes-server.sh.
#include "hermes_server.h"

#include <cstdio>
#include <string>
#include <vector>

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
  auto chat = [&](std::string id, bool active, double ago) {
    HermesSession s; s.profile = "default"; s.id = id; s.title = id; s.source = "desktop"; s.active = active;
    s.started = now - 3600; s.last_active = now - ago; return s;
  };
  HermesSession pinned = chat("pinned", false, 5 * 3600); pinned.pinned = true;
  HermesSession ended = chat("ended", true, 10); ended.ended = true;
  check(HermesSessionShows(chat("a", true, 10), true, now), "a working chat shows");
  check(HermesSessionShows(chat("b", false, 20 * 60), true, now), "a chat quiet for 20 minutes still shows");
  check(!HermesSessionShows(chat("c", false, 3 * 3600), true, now), "a chat quiet for hours doesn't");
  check(HermesSessionShows(pinned, true, now), "a pinned chat shows however quiet");
  check(!HermesSessionShows(ended, true, now), "an ended session never shows");

  HermesSession worker = chat("local-w1", true, 30); worker.profile = "coder"; worker.source = "kanban";
  worker.started = now - 300; worker.activity = "terminal command running (12s elapsed)";
  HermesSession dead = worker; dead.id = "local-dead"; dead.active = false; dead.last_active = now - 1800; dead.started = now - 7200;
  check(!HermesSessionShows(worker, true, now), "with a board, a worker shows through its card");
  check(HermesSessionShows(worker, false, now), "with none, a working worker shows");
  check(!HermesSessionShows(dead, false, now), "a worker that went quiet (died) doesn't linger");

  HermesCard run; run.id = "t_1"; run.title = "Fix the login page"; run.assignee = "coder"; run.status = "running"; run.run_started = now - 400; run.heartbeat = now - 5;
  HermesCard ask = run; ask.id = "t_2"; ask.title = "Pick a colour"; ask.status = "blocked"; ask.block_kind = "needs_input";
  HermesCard wait = run; wait.id = "t_3"; wait.status = "blocked"; wait.block_kind = "dependency";
  HermesCard legacy = wait; legacy.id = "t_4"; legacy.block_kind = "";
  HermesCard review = run; review.id = "t_5"; review.status = "review";
  HermesCard bad = run; bad.id = "t/../x";
  const std::vector<HermesSession> both = {dead, worker}, old_only = {dead};
  const HermesSession* w = HermesCardSession(run, both);
  check(w && w->id == "local-w1", "a card finds its worker");
  check(HermesCardSession(run, old_only) == nullptr, "not one older than its run");
  HermesCard mine = run; mine.assignee = "";
  HermesSession dworker = worker; dworker.profile = "default";
  const std::vector<HermesSession> dlist = {dworker};
  check(HermesCardSession(mine, dlist) != nullptr, "an unassigned card runs as the default profile");
  check(HermesCardNeedsYou(ask) && HermesCardNeedsYou(legacy), "blocked for input, or with no reason given, needs you");
  check(!HermesCardNeedsYou(wait) && !HermesCardNeedsYou(review) && !HermesCardNeedsYou(run), "waiting on a card, review or running doesn't");

  auto rows = HermesRows("https://h.example", {chat("s1", true, 5), worker, dead}, {run, ask, wait, review, bad}, true, now);
  auto find = [&](const std::string& id) -> const HermesRow* { for (auto& r : rows) if (r.id == id) return &r; return nullptr; };
  check(rows.size() == 3, "rows: two cards and one chat");
  const HermesRow* r1 = find("hermes-card-t_1");
  check(r1 && r1->state == "working" && r1->doing == "coder · Terminal command running (12s elapsed)", "a running card says what its worker is doing");
  check(r1 && r1->url == "https://h.example/kanban" && r1->name == "Fix the login page", "and opens the board");
  const HermesRow* r2 = find("hermes-card-t_2");
  check(r2 && r2->state == "needs_you" && r2->doing == "coder needs you", "a card waiting on input needs you, in plain words");
  check(!find("hermes-card-t_3") && !find("hermes-card-t_5"), "no row for a card waiting on another card or in review");
  check(!find("hermes-coder-local-w1") && !find("hermes-coder-local-dead"), "worker sessions don't double their cards");
  const HermesRow* s1 = find("hermes-default-s1");
  check(s1 && s1->state == "working" && s1->doing == "Desktop", "a chat row");
  auto off = HermesRows("https://h.example", {worker}, {run}, false, now);
  check(off.size() == 1 && off[0].id == "hermes-coder-local-w1" && off[0].doing == "coder · Board card · Terminal command running (12s elapsed)", "no board: sessions only, with what they're doing");
  HermesCard noworker = run; noworker.assignee = "researcher";
  auto alone = HermesRows("https://h.example", {}, {noworker}, true, now);
  check(alone.size() == 1 && alone[0].doing == "researcher · Working on it", "a running card with no session found still shows");

  check(HermesActivity("  receiving stream response ") == "Receiving stream response", "activity: trimmed and capitalised");
  check(HermesActivity("a\nb\tc") == "A b c", "activity: one line");
  check(HermesActivity(std::string(100, 'x')).size() <= kHermesMaxActivity + 3, "activity: short");
  check(HermesActivity("") == "" && HermesActivity("   ") == "", "activity: nothing stays nothing");
  check(HermesWho("") == "Hermes" && HermesWho("default") == "Hermes" && HermesWho("coder") == "coder", "who: the default profile reads as Hermes");
  check(HermesBoardUrl("https://e.com") == "https://e.com/api/plugins/kanban/board", "board url");

  check(HermesDoing("coder", "kanban") == "coder · Board card", "a worker's card");
  check(HermesDoing("default", "bluebubbles") == "iMessage", "the default profile isn't named");
  check(HermesDoing("", "oneshot") == "Terminal", "a one-shot run");
  check(HermesDoing("default", "something-new") == "Chat", "an unknown source");

  std::printf(fail ? "%d failed\n" : "all passed\n", fail);
  return fail ? 1 : 0;
}
