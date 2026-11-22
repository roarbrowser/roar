// Hermit service rules (src/hermit_server.h): scripts/test-hermit-server.sh. Each HermesX check in
// tests/hermes_server_test.cc has its Hermit counterpart here, plus the parts only an opencode server has.
#include "hermit_server.h"

#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <vector>

int main() {
  using namespace roar;
  int fail = 0;
  auto check = [&](bool ok, const std::string& what) { if (!ok) fail++; std::printf("%s %s\n", ok ? "ok  " : "FAIL", what.c_str()); };

  // The service's address: HermesBase's rules, since a password goes there too.
  check(HermitBase(" https://hermit.example.com/ \n") == "https://hermit.example.com", "trims spaces and trailing slashes");
  check(HermitBase("https://example.com/hermit") == "https://example.com/hermit", "keeps a proxy path");
  check(HermitBase("http://127.0.0.1:9121/oc") == "http://127.0.0.1:9121" && HermitBase("http://127.0.0.1:9121/oc/") == "http://127.0.0.1:9121",
        "the opencode address pasted in place of the service's: /oc goes");
  check(HermitBase("http://localhost") == "http://localhost", "plain http to this computer, even with no port");
  check(HermitBase("http://127.0.0.1:9121") == "http://127.0.0.1:9121", "loopback with a port");
  check(HermitBase("http://192.168.1.20:9121") == "http://192.168.1.20:9121", "plain http on a private network");
  check(HermitBase("http://box.local:9121") == "http://box.local:9121", "plain http to a .local name");
  check(HermitBase("http://hermit.example.com").empty(), "no password over plain http to a public host");
  check(HermitBase("http://8.8.8.8:9121").empty(), "nor to a public address");
  check(HermitBase("https://user@example.com").empty(), "no login in the URL");
  check(HermitBase("http://192.168.1.1@evil.example").empty(), "a private address can't front a public host");
  check(HermitBase("https://example.com/?x=1").empty(), "no query");
  check(HermitBase("https://example.com/#x").empty(), "no fragment");
  check(HermitBase("https://").empty() && HermitBase("").empty() && HermitBase("   ").empty(), "nothing to reach");
  check(HermitBase("ftp://example.com").empty() && HermitBase("file:///etc").empty() && HermitBase("example.com").empty(), "web addresses only");
  check(HermitBase("https://" + std::string(400, 'a') + ".com").empty(), "a sane length");

  check(HermitOrigin("https://example.com/hermit") == "https://example.com/", "origin drops the path");
  check(HermitOrigin("http://127.0.0.1:9121") == "http://127.0.0.1:9121/", "origin keeps the port");
  check(HermitActiveUrl("https://e.com") == "https://e.com/oc/api/session/active", "running sessions, through the service's opencode pass-through");
  check(HermitSessionsUrl("https://e.com") == "https://e.com/oc/api/session?limit=50", "the newest fifty sessions");
  check(HermitPermissionUrl("https://e.com", "ses_1") == "https://e.com/oc/api/session/ses_1/permission" &&
        HermitFormUrl("https://e.com", "ses_1") == "https://e.com/oc/api/session/ses_1/form", "a session's waiting approvals and questions");
  check(HermitJobsUrl("https://e.com") == "https://e.com/api/x/jobs", "the board");

  // The event stream: one `types` per event (a comma list is a 400 on opencode 2.3.2). Never the events 2.3.2
  // doesn't send on a real stream.
  std::string ev = HermitEventUrl("https://e.com");
  check(ev.rfind("https://e.com/oc/api/event?types=", 0) == 0, "events through the pass-through");
  check(ev.find(',') == std::string::npos && ev.find("%2C") == std::string::npos, "no comma list");
  for (const char* t : {"session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
                        "permission.asked", "permission.replied", "form.created", "form.replied", "session.created", "session.renamed",
                        "session.deleted", "session.archived"})
    check((ev + "&").find(std::string("types=") + t + "&") != std::string::npos, std::string("subscribes to ") + t);
  check(ev.find("session.idle") == std::string::npos && ev.find("session.status") == std::string::npos, "never session.idle or session.status");

  // Row ids: plain ids only, since they reach settings and Roar's other session ids.
  check(HermitIdOk("ses_dfd63047affeyXQIOw2OXnEkja") && HermitIdOk("t_1"), "opencode and board ids pass");
  check(HermitRowId("ses_ab12") == "hermit-ses_ab12", "row id");
  check(HermitCardRowId("t_1") == "hermit-card-t_1", "card row id");
  check(HermitRowId("").empty() && HermitCardRowId("").empty(), "an id is needed");
  check(HermitRowId("a/b").empty() && HermitRowId("a&x=y").empty() && HermitRowId("<b>").empty() && HermitCardRowId("t/../x").empty(), "only plain ids");

  // Where the opencode chat kind reaches the service: <service>/oc, signed in as hermit with the service's password.
  check(HermitOcBase("http://127.0.0.1:9121") == "http://127.0.0.1:9121/oc", "the chat's server address");
  check(HermitRidesOn("http://127.0.0.1:9121/oc", "http://127.0.0.1:9121") && HermitRidesOn("http://127.0.0.1:9121/oc/", "http://127.0.0.1:9121/"),
        "a chat server at the service's /oc uses the service's sign-in");
  check(HermitRidesOn("http://127.0.0.1:9121/oc", "http://127.0.0.1:9121/oc"), "whichever of the two addresses Settings holds");
  check(!HermitRidesOn("http://127.0.0.1:4096", "http://127.0.0.1:9121") && !HermitRidesOn("http://127.0.0.1:9122/oc", "http://127.0.0.1:9121"),
        "another server never gets that password");
  check(!HermitRidesOn("https://evil.example/oc", "") && !HermitRidesOn("http://127.0.0.1:9121/oc", "http://hermit.example.com"), "nor does any server while no usable service is set");
  check(HermitBasic("pw") == "Basic aGVybWl0OnB3" && HermitBasic("p") == "Basic aGVybWl0OnA=" && HermitBasic("pwx") == "Basic aGVybWl0OnB3eA==",
        "Basic hermit:<password>, padded");
  check(HermitBasic("").empty(), "no password, no header");

  // The pending rule: a turn is running from session.execution.started until it succeeds, fails or is interrupted.
  // /session/active is the truth when it was read after the newest of those.
  check(HermitTurnOf("session.execution.started", "") == kHermitTurnStarted, "started opens a turn");
  check(HermitTurnOf("session.execution.succeeded", "") == kHermitTurnEnded && HermitTurnOf("session.execution.failed", "") == kHermitTurnEnded, "succeeded or failed ends it");
  check(HermitTurnOf("session.execution.interrupted", "") == kHermitTurnEnded, "interrupted ends it too");
  check(HermitTurnOf("session.execution.interrupted", "superseded") == kHermitTurnNone, "unless a newer prompt took over");
  check(HermitTurnOf("session.idle", "") == kHermitTurnNone && HermitTurnOf("session.status", "") == kHermitTurnNone && HermitTurnOf("session.step.ended", "") == kHermitTurnNone,
        "nothing else counts (2.3.2 sends no session.idle)");
  check(HermitPending(true, kHermitTurnNone) && !HermitPending(false, kHermitTurnNone), "no newer event: /session/active says");
  check(HermitPending(false, kHermitTurnStarted) && !HermitPending(true, kHermitTurnEnded), "a newer event beats an older read");

  const double now = 1000000;
  auto ses = [&](std::string id, bool pending, double age) {
    HermitSession s; s.id = id; s.title = id; s.agent = "build"; s.pending = pending; s.ran = true; s.created = now - age; s.updated = now - age / 2; return s;
  };
  HermitSession fresh = ses("fresh", false, 30); fresh.ran = false;
  HermitSession stale = ses("stale", false, 5 * 60); stale.ran = false;
  HermitSession done = ses("done", false, 30);
  HermitSession archived = ses("archived", true, 30); archived.archived = true;
  HermitSession sub = ses("sub", true, 30); sub.parent = "ses_root";
  HermitSession asking = ses("asking", false, 600); asking.ask = HermitAskWord("permission", "bash");
  check(HermitFresh(fresh, now) && !HermitFresh(stale, now) && !HermitFresh(done, now), "new with no prompt yet: fresh for two minutes");
  check(HermitSessionShows(ses("live", true, 600), true, {}, now), "a session mid-turn shows");
  check(!HermitSessionShows(done, true, {}, now), "one whose turn ended doesn't");
  check(HermitSessionShows(fresh, true, {}, now) && !HermitSessionShows(stale, true, {}, now), "a new one shows until it has waited two minutes for a prompt");
  check(!HermitSessionShows(archived, true, {}, now), "an archived one never shows");
  check(!HermitSessionShows(sub, true, {}, now) && HermitNotChat(sub), "a subagent shows through the session it works for");
  check(HermitSessionShows(asking, true, {}, now), "one waiting on you shows, mid-turn or not");
  HermitSession worker = ses("ses_w1", true, 300);
  check(!HermitSessionShows(worker, true, {"ses_w1"}, now), "with a board, a card's worker shows through its card");
  check(HermitSessionShows(worker, false, {"ses_w1"}, now), "with none, a working worker shows");

  check(HermitTitle("Plan the trip") == "Plan the trip", "title as opencode has it");
  check(HermitTitle("") == "Untitled chat" && HermitTitle("   ") == "Untitled chat", "no title: Untitled chat");
  check(HermitTitle(" Fix it\n") == "Fix it", "trimmed");
  check(HermitTitle(std::string(200, 'x')).size() <= kHermesMaxTitle + 3, "a long title is cut");
  check(HermitTitle(std::string(119, 'x') + "éé") == std::string(119, 'x') + "…", "never inside a UTF-8 character");

  check(HermitAskWord("permission", "bash") == "Asks you to allow bash", "an approval names the tool, never what it would run");
  check(HermitAskWord("permission", "") == "Asks you to allow a step", "an approval with no tool");
  check(HermitAskWord("permission", "a\nb") == "Asks you to allow a b" && HermitAskWord("permission", std::string(100, 'x')).size() < 70, "one line, short");
  check(HermitAskWord("form", "") == "Asks you a question", "a form is a question, without its text");

  check(HermitAge(5) == "now" && HermitAge(28) == "28s" && HermitAge(8 * 60 + 5) == "8m" && HermitAge(3600 + 120) == "1h 2m" && HermitAge(7200) == "2h" && HermitAge(3 * 86400) == "3d",
        "ages as Hermes's apps write them");

  // A running card's pace: its check-in (heartbeat_at) and its worker's last step (runs[].info.step.at).
  HermitCard run; run.id = "t_1"; run.title = "Fix the login page"; run.agent = "coder"; run.status = "running"; run.run_started = now - 400; run.heartbeat = now - 5; run.session = "ses_w1";
  auto pace = [&](double checkin, double step) { HermitCard c = run; c.run_started = now - 3600; c.heartbeat = now - checkin; c.step_at = now - step; return HermitPace(c, now); };
  check(pace(5, 28).pace == "working" && pace(5, 28).text == "Working · last step 28s ago", "working");
  check(pace(5, 3).text == "Working · last step now", "a step just now");
  check(pace(5, 8 * 60).pace == "longStep" && pace(5, 8 * 60).text == "Long step · quiet 8m, still checking in", "a long step");
  check(pace(6 * 60, 30).pace == "maybeStuck" && pace(6 * 60, 30).text == "May be stuck · no check-in for 6m", "no check-in for 5 minutes");
  check(pace(30, 25 * 60).pace == "maybeStuck" && pace(30, 25 * 60).text == "May be stuck · quiet 25m", "no step for 20 minutes");
  check(pace(40 * 60, 30).pace == "stuck" && pace(40 * 60, 30).text == "Stuck · no check-in for 40m", "no check-in for 15 minutes");
  HermitCard nobeat = run; nobeat.heartbeat = 0; nobeat.run_started = now - 60;
  check(HermitPace(nobeat, now).pace == "working", "no heartbeat or step yet: its start counts for both");

  HermitCard ask = run; ask.id = "t_2"; ask.title = "Pick a colour"; ask.status = "blocked"; ask.block_kind = "needs_input"; ask.session = "";
  HermitCard wait = run; wait.id = "t_3"; wait.status = "blocked"; wait.block_kind = "dependency";
  HermitCard legacy = wait; legacy.id = "t_4"; legacy.block_kind = "";
  HermitCard review = run; review.id = "t_5"; review.status = "review";
  HermitCard bad = run; bad.id = "t/../x";
  check(HermitCardNeedsYou(ask) && HermitCardNeedsYou(legacy), "blocked for input, or with no reason given, needs you");
  check(!HermitCardNeedsYou(wait) && !HermitCardNeedsYou(review) && !HermitCardNeedsYou(run), "waiting on a card, review or running doesn't");
  const std::vector<HermitSession> with_worker = {worker};
  check(HermitCardSession(run, with_worker) && HermitCardSession(run, with_worker)->id == "ses_w1", "a card's worker is its run's session, by id");
  HermitCard none = run; none.session = "";
  check(!HermitCardSession(none, with_worker), "a run with no session yet has none: nothing is guessed");

  auto findIn = [](const std::vector<HermitRow>& rs, const std::string& id) -> const HermitRow* {
    for (auto& r : rs) if (r.id == id) return &r;
    return nullptr;
  };
  HermitSession live = ses("ses_live", true, 600); live.updated = now - 2; live.step = "bash";
  HermitSession quiet_card = ses("ses_w6", true, 3000);
  HermitCard quiet = run; quiet.id = "t_6"; quiet.title = "Quiet one"; quiet.heartbeat = now - 6 * 60; quiet.run_started = now - 3000; quiet.session = "ses_w6";
  HermitCard stuck = run; stuck.id = "t_7"; stuck.title = "Stuck one"; stuck.heartbeat = now - 40 * 60; stuck.run_started = now - 5000; stuck.session = "";
  HermitSession waiting_worker = ses("ses_w8", true, 100); waiting_worker.ask = HermitAskWord("permission", "edit");
  HermitCard approve = run; approve.id = "t_8"; approve.title = "Approve me"; approve.session = "ses_w8"; approve.run_started = now - 100;
  worker.step = "read"; worker.updated = now - 30;
  auto rows = HermitRows({live, done, fresh, stale, archived, sub, worker, quiet_card, waiting_worker, asking},
                         {run, ask, wait, review, bad, quiet, stuck, approve}, true, now);
  check(rows.size() == 8, "rows: five cards, one live, one new and one waiting session: " + std::to_string(rows.size()));
  const HermitRow* r1 = findIn(rows, "hermit-card-t_1");
  check(r1 && r1->state == "working" && r1->tone.empty() && r1->doing == "coder · Working · last step 30s ago", "a running card says how it's going: " + (r1 ? r1->doing : ""));
  check(r1 && r1->url.empty() && r1->name == "Fix the login page", "a card is watch-only: no page to open");
  const HermitRow* r2 = findIn(rows, "hermit-card-t_2");
  check(r2 && r2->state == "needs_you" && r2->doing == "coder · Asks you", "a card waiting on input asks you, without its question");
  const HermitRow* r6 = findIn(rows, "hermit-card-t_6");
  check(r6 && r6->state == "working" && r6->tone == "quiet" && r6->doing == "coder · May be stuck · no check-in for 6m", "a quiet card: amber, may be stuck");
  const HermitRow* r7 = findIn(rows, "hermit-card-t_7");
  check(r7 && r7->state == "needs_you" && r7->doing == "coder · Stuck · no check-in for 40m", "a stuck card needs you");
  const HermitRow* r8 = findIn(rows, "hermit-card-t_8");
  check(r8 && r8->state == "needs_you" && r8->doing == "coder · Asks you to allow edit", "a running card whose worker waits on an approval needs you");
  check(!findIn(rows, "hermit-card-t_3") && !findIn(rows, "hermit-card-t_5") && !findIn(rows, "hermit-card-t/../x"), "no row for a card waiting on another card, in review, or with a bad id");
  check(!findIn(rows, "hermit-ses_w1") && !findIn(rows, "hermit-ses_w6") && !findIn(rows, "hermit-ses_w8"), "worker sessions don't double their cards");
  check(!findIn(rows, "hermit-done") && !findIn(rows, "hermit-stale") && !findIn(rows, "hermit-archived") && !findIn(rows, "hermit-sub"),
        "no row for an ended turn, a new session left waiting, an archived one or a subagent");
  const HermitRow* c1 = findIn(rows, "hermit-ses_live");
  check(c1 && c1->state == "working" && c1->doing == "Live · build · Bash" && c1->name == "ses_live", "a live session: Live, its agent and the tool it's using: " + (c1 ? c1->doing : ""));
  const HermitRow* cf = findIn(rows, "hermit-fresh");
  check(cf && cf->state == "idle" && cf->doing == "New · build · No prompt yet", "a new session: idle, no prompt yet");
  const HermitRow* ca = findIn(rows, "hermit-asking");
  check(ca && ca->state == "needs_you" && ca->doing == "build · Asks you to allow bash", "a session waiting on an approval needs you");
  std::string order;
  for (auto& r : rows) order += r.id.substr(r.id.rfind('-') + 1) + " ";
  bool needs_first = true, seen_other = false;
  for (auto& r : rows) { if (r.state != "needs_you") seen_other = true; else if (seen_other) needs_first = false; }
  check(needs_first, "needs you first, then the latest move first: " + order);

  auto off = HermitRows({worker}, {run}, false, now);
  check(off.size() == 1 && off[0].id == "hermit-ses_w1" && off[0].doing == "Live · build · Read", "no board: live workers only, with what they're doing");
  HermitCard early = none; early.run_started = now - 100;
  auto alone = HermitRows({}, {early}, true, now);
  check(alone.size() == 1 && alone[0].state == "working" && alone[0].doing == "coder · Working · last step 1m ago" && alone[0].url.empty(), "a running card with no session yet");

  check(HermitStep("  bash ") == "Bash" && HermitStep("") == "" && HermitStep("a\nb") == "A b", "step: the tool, one line, capitalised");
  check(HermitStep(std::string(100, 'x')).size() <= kHermesMaxActivity + 3, "step: short");
  check(HermitWho("") == "Hermit" && HermitWho("hermit") == "hermit" && HermitWho("coder") == "coder" && HermitWho(std::string(50, 'a')) == "Hermit",
        "who: the agent, Hermit when none is named");

  // Server-sent events, fed as they arrive.
  std::string buf;
  auto f1 = HermitSseFeed(buf, "data: {\"type\":\"a\"}\n\ndata: {\"ty");
  check(f1.size() == 1 && f1[0] == "{\"type\":\"a\"}", "one whole event, the rest kept");
  auto f2 = HermitSseFeed(buf, "pe\":\"b\"}\r\n\r\n: heartbeat\n\n");
  check(f2.size() == 1 && f2[0] == "{\"type\":\"b\"}", "the rest once it ends, CRLF too; a comment is no event");
  auto f3 = HermitSseFeed(buf, "event: x\ndata:{\"a\":1}\ndata: 2\n\n");
  check(f3.size() == 1 && f3[0] == "{\"a\":1}\n2", "data lines joined");
  std::string big;
  HermitSseFeed(big, std::string(2 * 1024 * 1024, 'x'));
  check(big.empty(), "a frame too big to be ours is dropped");

  std::printf(fail ? "%d failed\n" : "all passed\n", fail);
  return fail ? 1 : 0;
}
