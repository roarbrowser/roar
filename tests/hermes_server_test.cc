// Hermes server rules (src/hermes_server.h): scripts/test-hermes-server.sh.
#include "hermes_server.h"

#include <cstdio>
#include <string>
#include <vector>

int main() {
  using namespace roar;
  int fail = 0;
  auto check = [&](bool ok, const std::string& what) { if (!ok) fail++; std::printf("%s %s\n", ok ? "ok  " : "FAIL", what.c_str()); };

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
  check(HermesSessionsUrl("https://e.com") == "https://e.com/api/profiles/sessions?limit=60&order=recent&exclude_sources=cron,api_server,tool",
        "every profile, no cron, no API helper calls, no tool runs");
  check(HermesNewestUrl("https://e.com", "s1", "coder") == "https://e.com/api/sessions/s1/messages?profile=coder&limit=3&order=latest&inline_images=false",
        "a session's newest messages, on its profile, without images");

  check(HermesRowId("coder", "local-ab12") == "hermes-coder-local-ab12", "row id");
  check(HermesRowId("default", "20261106_215933_df4239") == "hermes-default-20261106_215933_df4239", "dated ids pass");
  check(HermesRowId("", "x").empty() && HermesRowId("x", "").empty(), "both parts needed");
  check(HermesRowId("a/b", "x").empty() && HermesRowId("x", "a&profile=y").empty() && HermesRowId("x", "<b>").empty(), "only plain ids");
  check(HermesChatUrl("https://e.com", "s1", "coder") == "https://e.com/chat?resume=s1&profile=coder", "chat link names the profile");

  // Live, as Hermes's own apps say it: a turn is running, so the newest message is not a finished reply.
  check(HermesPending("user", false) && HermesPending("tool", false) && HermesPending("assistant", true), "your message, a tool's result or a step called: a turn is running");
  check(!HermesPending("assistant", false), "a finished reply ends the turn");
  check(!HermesPending("system", false) && !HermesPending("", false), "nothing else counts");

  const double now = 1000000;
  auto chat = [&](std::string id, bool pending, double ago) {
    HermesSession s; s.profile = "default"; s.id = id; s.title = id; s.source = "desktop"; s.active = ago < 300; s.pending = pending;
    s.started = now - 3600; s.last_active = now - ago; return s;
  };
  HermesSession ended = chat("ended", true, 10); ended.ended = true; ended.end_reason = "user_exit";
  HermesSession reaped = chat("reaped", true, 10); reaped.ended = true; reaped.end_reason = "ws_orphan_reap";
  HermesSession pinned = chat("pinned", false, 5 * 3600); pinned.pinned = true;
  HermesSession helper = chat("helper", true, 5); helper.source = "api_server";
  HermesSession tool = chat("tool", true, 5); tool.source = "tool";
  HermesSession cron = chat("cron", true, 5); cron.source = "cron";
  HermesSession sub = chat("sub", true, 5); sub.title = "Subagent: read the logs";
  check(HermesMayBeLive(chat("a", false, 30), now), "a chat that moved in the last two minutes is asked about");
  check(!HermesMayBeLive(chat("b", true, 3 * 60), now), "one quiet for three minutes isn't: its turn stopped");
  check(!HermesMayBeLive(ended, now) && HermesMayBeLive(reaped, now), "ended never; a chat whose window went away still counts");
  check(!HermesMayBeLive(helper, now) && !HermesMayBeLive(tool, now) && !HermesMayBeLive(cron, now) && !HermesMayBeLive(sub, now),
        "API helper calls, tool runs, scheduled jobs and subagents are never chats");
  check(HermesSessionShows(chat("c", true, 30), true, now), "a chat mid-turn shows");
  check(!HermesSessionShows(chat("d", false, 30), true, now), "one that just answered doesn't");
  check(!HermesSessionShows(chat("e", true, 5 * 60), true, now), "nor one whose turn went silent");
  check(!HermesSessionShows(pinned, true, now), "pinned or recent isn't live");
  check(!HermesSessionShows(helper, true, now), "nor is a helper call mid-turn");

  HermesSession worker = chat("local-w1", true, 30); worker.profile = "coder"; worker.source = "kanban";
  worker.started = now - 300; worker.activity = "terminal command running (12s elapsed)";
  HermesSession dead = worker; dead.id = "local-dead"; dead.active = false; dead.last_active = now - 1800; dead.started = now - 7200;
  check(!HermesSessionShows(worker, true, now), "with a board, a worker shows through its card");
  check(HermesSessionShows(worker, false, now), "with none, a working worker shows");
  check(!HermesSessionShows(dead, false, now), "a worker that went quiet (died) doesn't linger");

  check(HermesTitle("Plan the trip") == "Plan the trip", "title as Hermes has it");
  check(HermesTitle("") == "Untitled chat" && HermesTitle("   ") == "Untitled chat", "no title: Untitled chat");
  check(HermesTitle("[You are replying to Sam] Dinner plans") == "Dinner plans", "an iMessage reply's prefix goes");
  check(HermesTitle(std::string(200, 'x')).size() <= 120 + 3, "a long title is cut");
  check(HermesTitle(std::string(119, 'x') + "éé") == std::string(119, 'x') + "…", "never inside a UTF-8 character");

  check(HermesSourceWord("desktop") == "Chat" && HermesSourceWord("tui") == "Chat" && HermesSourceWord("local") == "Chat", "chat apps say Chat");
  check(HermesSourceWord("bluebubbles") == "iMessage" && HermesSourceWord("cli") == "Terminal" && HermesSourceWord("oneshot") == "One-shot", "Hermes's words");
  check(HermesSourceWord("telegram") == "Telegram" && HermesSourceWord("api") == "API" && HermesSourceWord("kanban") == "Board card", "and the rest");
  check(HermesSourceWord("discord") == "Discord" && HermesSourceWord("") == "Chat", "an unknown source by its own name");

  check(HermesAge(5) == "now" && HermesAge(28) == "28s" && HermesAge(8 * 60 + 5) == "8m" && HermesAge(3600 + 120) == "1h 2m" && HermesAge(7200) == "2h" && HermesAge(3 * 86400) == "3d",
        "ages as Hermes's apps write them");

  // A running card's pace, from its check-in (the board's heartbeat) and its worker's last step.
  HermesCard run; run.id = "t_1"; run.title = "Fix the login page"; run.assignee = "coder"; run.status = "running"; run.run_started = now - 400; run.heartbeat = now - 5;
  auto pace = [&](double checkin, double step) { HermesCard c = run; c.run_started = now - 3600; c.heartbeat = now - checkin; return HermesPace(c, now - step, now); };
  check(pace(5, 28).pace == "working" && pace(5, 28).text == "Working · last step 28s ago", "working");
  check(pace(5, 3).text == "Working · last step now", "a step just now");
  check(pace(5, 8 * 60).pace == "longStep" && pace(5, 8 * 60).text == "Long step · quiet 8m, still checking in", "a long step");
  check(pace(6 * 60, 30).pace == "maybeStuck" && pace(6 * 60, 30).text == "May be stuck · no check-in for 6m", "no check-in for 5 minutes");
  check(pace(30, 25 * 60).pace == "maybeStuck" && pace(30, 25 * 60).text == "May be stuck · quiet 25m", "no step for 20 minutes");
  check(pace(40 * 60, 30).pace == "stuck" && pace(40 * 60, 30).text == "Stuck · no check-in for 40m", "no check-in for 15 minutes");
  HermesCard nobeat = run; nobeat.heartbeat = 0; nobeat.run_started = now - 60;
  check(HermesPace(nobeat, 0, now).pace == "working", "no heartbeat or step yet: its start counts for both");

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

  HermesSession s1 = chat("s1", true, 2); s1.activity = "receiving stream response";
  HermesSession idle = chat("idle", false, 20);
  HermesCard quiet = run; quiet.id = "t_6"; quiet.title = "Quiet one"; quiet.heartbeat = now - 6 * 60; quiet.run_started = now - 3000;
  HermesCard stuck = run; stuck.id = "t_7"; stuck.title = "Stuck one"; stuck.heartbeat = now - 40 * 60; stuck.run_started = now - 5000;
  auto rows = HermesRows("https://h.example", {s1, idle, worker, dead, helper}, {run, ask, wait, review, bad, quiet, stuck}, true, now);
  auto find = [&](const std::string& id) -> const HermesRow* { for (auto& r : rows) if (r.id == id) return &r; return nullptr; };
  check(rows.size() == 5, "rows: four cards and one live chat");
  const HermesRow* r1 = find("hermes-card-t_1");
  check(r1 && r1->state == "working" && r1->tone.empty() && r1->doing == "coder · Working · last step 30s ago", "a running card says how it's going, as Hermes's apps do");
  check(r1 && r1->url == "https://h.example/kanban" && r1->name == "Fix the login page", "and opens the board");
  const HermesRow* r2 = find("hermes-card-t_2");
  check(r2 && r2->state == "needs_you" && r2->doing == "coder · Asks you", "a card waiting on input asks you");
  const HermesRow* r6 = find("hermes-card-t_6");
  check(r6 && r6->state == "working" && r6->tone == "quiet" && r6->doing == "coder · May be stuck · no check-in for 6m", "a quiet card: amber, may be stuck");
  const HermesRow* r7 = find("hermes-card-t_7");
  check(r7 && r7->state == "needs_you" && r7->doing == "coder · Stuck · no check-in for 40m", "a stuck card needs you, as in Hermes's Needs you");
  check(!find("hermes-card-t_3") && !find("hermes-card-t_5"), "no row for a card waiting on another card or in review");
  check(!find("hermes-coder-local-w1") && !find("hermes-coder-local-dead"), "worker sessions don't double their cards");
  check(!find("hermes-default-idle") && !find("hermes-default-helper"), "no row for a chat that answered, or a helper call");
  const HermesRow* c1 = find("hermes-default-s1");
  check(c1 && c1->state == "working" && c1->doing == "Live · Hermes · Chat · Receiving stream response" && c1->name == "s1", "a live chat: Live, who, where and what it's doing");
  // Needs you first, then the latest move first (Needs you, then Working now).
  std::string order;
  for (auto& r : rows) order += r.id.substr(r.id.rfind('-') + 1) + " ";
  check(order == "t_2 t_7 s1 t_1 t_6 ", "needs you first, then the latest move first: " + order);

  auto off = HermesRows("https://h.example", {worker}, {run}, false, now);
  check(off.size() == 1 && off[0].id == "hermes-coder-local-w1" && off[0].doing == "Live · coder · Board card · Terminal command running (12s elapsed)", "no board: live workers only, with what they're doing");
  HermesCard noworker = run; noworker.assignee = "researcher"; noworker.run_started = now - 100;
  auto alone = HermesRows("https://h.example", {}, {noworker}, true, now);
  check(alone.size() == 1 && alone[0].doing == "researcher · Working · last step 1m ago" && alone[0].state == "working", "a running card with no session found: its start is its last step");
  HermesSession untitled = chat("untitled", true, 5); untitled.title = "";
  auto named = HermesRows("https://h.example", {untitled}, {}, true, now);
  check(named.size() == 1 && named[0].name == "Untitled chat", "an untitled chat");

  check(HermesActivity("  receiving stream response ") == "Receiving stream response", "activity: trimmed and capitalised");
  check(HermesActivity("a\nb\tc") == "A b c", "activity: one line");
  check(HermesActivity(std::string(100, 'x')).size() <= kHermesMaxActivity + 3, "activity: short");
  check(HermesActivity("") == "" && HermesActivity("   ") == "", "activity: nothing stays nothing");
  check(HermesWho("") == "Hermes" && HermesWho("default") == "Hermes" && HermesWho("coder") == "coder", "who: the default profile reads as Hermes");
  check(HermesBoardUrl("https://e.com") == "https://e.com/api/plugins/kanban/board", "board url");

  std::printf(fail ? "%d failed\n" : "all passed\n", fail);
  return fail ? 1 : 0;
}
