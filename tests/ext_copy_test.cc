// Standalone check for src/ext_copy.h (no CEF): scripts/test-ext-copy.sh runs it before the round trip on a real Roar.
#include <cstdio>
#include <fstream>
#include <string>

#include "ext_copy.h"

namespace fs = std::filesystem;
using namespace roar::ext_copy;

static int failures = 0;
static void Check(bool ok, const std::string& what) {
  if (!ok) ++failures;
  std::printf("%s %s\n", ok ? "ok  " : "FAIL", what.c_str());
}
static void Put(const fs::path& p, const std::string& s) {
  fs::create_directories(p.parent_path());
  std::ofstream(p, std::ios::binary) << s;
}
static std::string Get(const fs::path& p) { return ReadAll(p); }
static std::string At(const std::string& t, const std::vector<std::string>& path) {
  json::Span s = json::Find(t, path);
  return s ? t.substr(s.begin, s.end - s.begin) : "<none>";
}

static const std::string ID(32, 'a'), OTHER(32, 'b');
static std::string Prefs(const std::string& id, const std::string& value, const std::string& mac, const std::string& hash) {
  return "{\"extensions\":{\"settings\":{\"" + OTHER + "\":{\"keep\":1},\"" + id + "\":" + value + "}},\"pinned_tabs\":[],\"protection\":{\"macs\":{\"extensions\":{\"settings\":{\"" +
         OTHER + "\":\"KEEP\",\"" + id + "\":\"" + mac + "\"}" + (hash.empty() ? "" : ",\"settings_encrypted_hash\":{\"" + id + "\":\"" + hash + "\"}") + "}},\"super_mac\":\"S\"}}";
}

int main(int argc, char** argv) {
  // JSON: strings with braces, quotes and escapes must not derail the walk.
  std::string t = R"({"a":{"b":"x}{\"y","c":[1,{"d":2}],"e":{"f":3.5e2}} , "g" : true })";
  Check(At(t, {"a", "b"}) == R"("x}{\"y")", "find a string holding braces and quotes");
  Check(At(t, {"a", "c"}) == R"([1,{"d":2}])", "find an array, nested object inside");
  Check(At(t, {"a", "e", "f"}) == "3.5e2" && At(t, {"g"}) == "true", "find a number and a spaced-out member");
  Check(At(t, {"a", "z"}) == "<none>" && At(t, {"g", "x"}) == "<none>", "missing keys and non-objects find nothing");
  Check(At("{\"a\":{", {"a", "b"}) == "<none>" && At("nope", {"a"}) == "<none>" && At("", {"a"}) == "<none>", "broken JSON finds nothing");

  std::string s = R"({"a":{"b":1,"c":2}})";
  Check(json::Set(s, {"a", "b"}, "[9]") && s == R"({"a":{"b":[9],"c":2}})", "set replaces only that value");
  Check(json::Set(s, {"a", "n"}, "1") && At(s, {"a", "n"}) == "1" && At(s, {"a", "c"}) == "2", "set adds a member");
  Check(json::Set(s, {"x", "y", "z"}, "\"v\"") && At(s, {"x", "y", "z"}) == "\"v\"", "set makes the objects on the way");
  std::string e = "{}";
  Check(json::Set(e, {"p", "q"}, "1") && e == R"({"p":{"q":1}})", "set into an empty object has no stray comma");
  std::string bad = R"({"a":1})";
  Check(!json::Set(bad, {"a", "b"}, "2") && bad == R"({"a":1})", "set refuses to go through a non-object");

  std::string r = R"({"a":{"x":1,"y":2,"z":3}})";
  json::Remove(r, {"a", "y"});
  Check(r == R"({"a":{"x":1,"z":3}})", "remove a middle member");
  json::Remove(r, {"a", "z"});
  Check(r == R"({"a":{"x":1}})", "remove the last member takes its comma");
  json::Remove(r, {"a", "x"});
  Check(r == R"({"a":{}})", "remove the only member");
  json::Remove(r, {"a", "nope"});
  Check(r == R"({"a":{}})", "remove something missing changes nothing");

  Check(ValidId(ID) && !ValidId("short") && !ValidId(std::string(32, 'z')) && !ValidId(std::string(31, 'a') + "/"), "ids are 32 letters a-p");
  Check(!Valid({ID, "Default", "Default"}) && !Valid({ID, "../x", "Default"}) && !Valid({ID, "Default", "Ghost-1"}) && Valid({ID, "Default", "Space-2"}), "jobs need two different real profiles");

  fs::path dir = fs::temp_directory_path() / ("roar-ext-copy-" + std::to_string(argc) + std::to_string(reinterpret_cast<uintptr_t>(argv)));
  fs::remove_all(dir);
  auto seed = [&] {
    fs::remove_all(dir);
    Put(dir / "Default/Secure Preferences", Prefs(ID, R"({"path":"x/1_0","signed":"in"})", "MAC1", "HASH1"));
    Put(dir / "Default/Extensions" / ID / "1_0/manifest.json", "{\"version\":\"1\"}");
    Put(dir / "Default/Local Extension Settings" / ID / "000003.log", "token");
    Put(dir / "Default/Local Extension Settings" / ID / "LOCK", "");
    Put(dir / "Default/Local Extension Settings" / OTHER / "000003.log", "not this one");
    Put(dir / "Default/IndexedDB" / ("chrome-extension_" + ID + "_0.indexeddb.leveldb") / "CURRENT", "idb");
  };

  // Into a space that has its own copy, signed out and disabled.
  seed();
  Put(dir / "Space-1/Secure Preferences", Prefs(ID, R"({"path":"x/0_0","disable_reasons":[8192]})", "OLDMAC", "OLDHASH"));
  Put(dir / "Space-1/Extensions" / ID / "0_0/manifest.json", "{\"version\":\"0\"}");
  Put(dir / "Space-1/Local Extension Settings" / ID / "000001.log", "theirs");
  Put(dir / "Space-1/Sync Extension Settings" / ID / "000001.log", "stale");
  Put(dir / "Space-1/Local Extension Settings" / OTHER / "000001.log", "untouched");
  Result one = Copy(dir, {ID, "Default", "Space-1"});
  Check(one.error.empty(), "copy over an existing install works: " + one.error);
  std::string p = Get(dir / "Space-1/Secure Preferences");
  Check(At(p, {"extensions", "settings", ID}) == R"({"path":"x/1_0","signed":"in"})", "entry replaced, disable reason gone");
  Check(At(p, {"protection", "macs", "extensions", "settings", ID}) == "\"MAC1\"", "its MAC came with it");
  Check(At(p, {"protection", "macs", "extensions", "settings_encrypted_hash", ID}) == "\"HASH1\"", "its encrypted hash too");
  Check(At(p, {"extensions", "settings", OTHER}) == R"({"keep":1})" && At(p, {"protection", "macs", "extensions", "settings", OTHER}) == "\"KEEP\"", "other extensions untouched");
  Check(At(p, {"protection", "super_mac"}) == "\"S\"", "the rest of the file untouched");
  Check(Get(dir / "Space-1/Local Extension Settings" / ID / "000003.log") == "token", "its sign-in storage arrived");
  Check(!fs::exists(dir / "Space-1/Local Extension Settings" / ID / "000001.log"), "the old storage is replaced, not merged");
  Check(fs::exists(dir / "Space-1/Extensions" / ID / "1_0/manifest.json") && !fs::exists(dir / "Space-1/Extensions" / ID / "0_0"), "its files are the source's version");
  Check(fs::exists(dir / "Space-1/IndexedDB" / ("chrome-extension_" + ID + "_0.indexeddb.leveldb") / "CURRENT"), "IndexedDB arrived");
  Check(!fs::exists(dir / "Space-1/Sync Extension Settings" / ID), "storage the source doesn't have goes too");
  Check(Get(dir / "Space-1/Local Extension Settings" / OTHER / "000001.log") == "untouched" && !fs::exists(dir / "Space-1/Local Extension Settings" / OTHER / "000003.log"), "another extension's storage is left alone");
  Check(Get(dir / kReplaced / "Space-1" / ID / "Local Extension Settings" / ID / "000001.log") == "theirs", "what it replaced is kept aside");
  Check(Get(dir / "Default/Local Extension Settings" / ID / "000003.log") == "token" && fs::exists(dir / "Default/Extensions" / ID / "1_0"), "the source keeps everything");
  Check(!fs::exists(dir / kStaging), "no staging left behind");

  // Into a space that has never been opened: no folder, no prefs.
  seed();
  Check(Copy(dir, {ID, "Default", "Space-7"}).error.empty(), "copy into a space never opened");
  p = Get(dir / "Space-7/Secure Preferences");
  Check(At(p, {"extensions", "settings", ID, "signed"}) == "\"in\"" && At(p, {"protection", "macs", "extensions", "settings", ID}) == "\"MAC1\"", "its prefs are made");

  // A source without the encrypted hash must not leave the target's stale one.
  seed();
  Put(dir / "Default/Secure Preferences", Prefs(ID, "{\"v\":2}", "M2", ""));
  Put(dir / "Space-1/Secure Preferences", Prefs(ID, "{\"v\":1}", "M1", "STALE"));
  Check(Copy(dir, {ID, "Default", "Space-1"}).error.empty(), "copy from a source with no encrypted hash");
  p = Get(dir / "Space-1/Secure Preferences");
  Check(At(p, {"protection", "macs", "extensions", "settings_encrypted_hash", ID}) == "<none>", "the target's stale hash is removed");

  // Refusals change nothing.
  seed();
  Put(dir / "Space-1/Secure Preferences", "{\"mine\":1}");
  Check(!Copy(dir, {OTHER, "Default", "Space-1"}).error.empty(), "an extension not installed there fails");
  fs::remove_all(dir / "Default/Extensions" / ID);
  Check(!Copy(dir, {ID, "Default", "Space-1"}).error.empty(), "a registered extension with no files fails");
  seed();
  Put(dir / "Default/Secure Preferences", "{\"extensions\":{}}");
  Put(dir / "Space-1/Local Extension Settings" / ID / "000001.log", "theirs");
  Put(dir / "Space-1/Secure Preferences", "{\"mine\":1}");
  Check(!Copy(dir, {ID, "Default", "Space-1"}).error.empty(), "files with no prefs entry fails");
  Check(Get(dir / "Space-1/Local Extension Settings" / ID / "000001.log") == "theirs" && Get(dir / "Space-1/Secure Preferences") == "{\"mine\":1}", "and the target is left as it was");
  seed();
  Put(dir / "Space-1/Secure Preferences", "[1]");
  Put(dir / "Space-1/Local Extension Settings" / ID / "000001.log", "theirs");
  Check(!Copy(dir, {ID, "Default", "Space-1"}).error.empty() && Get(dir / "Space-1/Local Extension Settings" / ID / "000001.log") == "theirs", "unreadable target prefs: refused before any file moves");

  // A rename failing halfway is rolled back: a file where a folder must go stops it.
  seed();
  Put(dir / "Space-1/Secure Preferences", "{}");
  Put(dir / "Space-1/Local Extension Settings" / OTHER / "x", "y");
  Put(dir / "Space-1/Extensions" / ID / "0_0/manifest.json", "old");
  fs::remove_all(dir / "Space-1/IndexedDB");
  Put(dir / "Space-1/IndexedDB", "a file, not a folder");
  Result rb = Copy(dir, {ID, "Default", "Space-1"});
  Check(!rb.error.empty(), "a swap that can't finish fails");
  Check(Get(dir / "Space-1/Extensions" / ID / "0_0/manifest.json") == "old" && Get(dir / "Space-1/Secure Preferences") == "{}", "and is rolled back");

  // The queue.
  seed();
  Check(ApplyPending(dir) == -1, "nothing queued: nothing runs");
  Check(Queue(dir, {{ID, "Default", "Space-1"}, {ID, "Default", "Space-2"}, {ID, "Default", "Default"}}), "queue writes");
  Check(Queue(dir, {{ID, "Default", "Space-1"}}) && Get(dir / kPending) == Line({ID, "Default", "Space-1"}) + Line({ID, "Default", "Space-2"}), "queue skips bad and repeated jobs");
  Put(dir / kPending, Get(dir / kPending) + Line({OTHER, "Default", "Space-3"}) + "garbage\n" + OTHER + "\t../..\tSpace-1\n");
  Check(ApplyPending(dir) == 2, "apply copies the good jobs");
  Check(!fs::exists(dir / kPending), "the queue is gone, so a crash can't repeat it");
  auto results = TakeResults(dir);
  Check(results.size() == 4 && results[0].error.empty() && results[1].error.empty() && !results[2].error.empty() && !results[3].error.empty(), "results say which worked");
  Check(results[0].job.id == ID && results[1].job.to == "Space-2", "results name the extension and space");
  Check(TakeResults(dir).empty(), "results are read once");

  // localStorage can't move: the copy says so.
  seed();
  Put(dir / "Default/Local Storage/leveldb/000003.log", "x_chrome-extension://" + ID + "\0key");
  Check(Copy(dir, {ID, "Default", "Space-1"}).note == "local", "leftover localStorage is reported");
  Check(Copy(dir, {ID, "Default", "Space-2"}).error.empty(), "and doesn't stop the copy");

  // The swap can't reach outside the data dir, whatever the queue says.
  seed();
  Put(dir / kPending, std::string(ID + "\tDefault\t../evil\n"));
  ApplyPending(dir);
  Check(!fs::exists(dir.parent_path() / "evil"), "a path in the queue goes nowhere");

  fs::remove_all(dir);
  std::printf("%s\n", failures ? "FAILED" : "ok");
  return failures ? 1 : 0;
}
