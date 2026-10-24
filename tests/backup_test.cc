// Standalone check for src/backup.h (no CEF): scripts/test-backup.sh runs it before the app round trip.
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

#include "backup.h"

namespace fs = std::filesystem;
using namespace roar::backup;

static int failures = 0;
static void Check(bool ok, const std::string& what) {
  if (!ok) ++failures;
  std::printf("%s %s\n", ok ? "ok  " : "FAIL", what.c_str());
}
static void Put(const fs::path& p, const std::string& s) {
  fs::create_directories(p.parent_path());
  std::ofstream(p, std::ios::binary) << s;
}
static std::string Get(const fs::path& p) {
  std::ifstream in(p, std::ios::binary);
  std::stringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

int main(int argc, char** argv) {
  Sha256 a;
  Check(a.Hex() == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "sha256 of empty");
  Sha256 b;
  std::string abc(1000, 'a');
  b.Update(abc.data(), abc.size());
  Check(b.Hex() == "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3", "sha256 of 1000 a's");

  fs::path root = fs::temp_directory_path() / ("roar-backup-test-" + std::to_string(std::rand()));
  fs::path src = root / "src", dst = root / "dst", out = argc > 1 ? fs::path(argv[1]) : root / "t.roarbackup";
  Put(src / "state.json", "{\"settings\":{\"archiveAfterHours\":3}}");
  Put(src / "pages.json", "{}");
  Put(src / "cdp-port", "9222");
  Put(src / "Default/Preferences", "{\"x\":1}");
  Put(src / "Default/Cookies", "secret-cookies");
  Put(src / "Default/Login Data", "passwords");
  Put(src / "Default/Local Extension Settings/oldid/000003.log", "vm-scripts");
  Put(src / "Default/Local Extension Settings/oldid/LOCK", "");
  Put(src / "Default/IndexedDB/chrome-extension_abc_0.indexeddb.leveldb/1.ldb", "ext-idb");
  Put(src / "Default/IndexedDB/https_example.com_0.indexeddb.leveldb/1.ldb", "site-idb");
  Put(src / "Default/Cache/data_0", "cache");
  Put(src / "Space-2/Preferences", "{\"space\":2}");
  Put(src / "Space-2/Extensions/xyz/1.0/manifest.json", "{}");

  auto r = Export(src, out, {kSettings, kExtensions}, "test", "\"extra\":1,");
  Check(r.error.empty(), "export: " + r.error);
  bool login_skipped = false, cookies_in = false, cache_in = false, site_idb = false;
  for (const auto& s : r.skipped) login_skipped |= s.path == "Default/Login Data";
  for (const auto& i : r.items) {
    cookies_in |= i.path == "Default/Cookies";
    cache_in |= i.path.find("Cache") != std::string::npos;
    site_idb |= i.path.find("https_example") != std::string::npos;
  }
  Check(r.items.size() == 6, "six files exported (" + std::to_string(r.items.size()) + ")");
  Check(login_skipped && !cookies_in && !cache_in && !site_idb, "passwords skipped; browsing data and caches left out");

  ZipReader zip(out);
  Check(zip.ok() && zip.Find("manifest.json") && zip.Find("SHA256SUMS"), "zip has manifest and sums");
  Check(zip.ReadText("manifest.json").find("\"schema\":1") != std::string::npos, "manifest schema");

  // Restore over a dir with its own stale data: replaced, except categories not restored.
  Put(dst / "state.json", "old");
  Put(dst / "Default/Preferences", "old");
  Put(dst / "Default/Cookies", "keep-me");
  Put(dst / "Default/Local Extension Settings/stale/1.log", "stale");
  Put(dst / "Space-9/Cookies", "newer-space");
  int n = 0;
  std::string err = Stage(out, dst, {kSettings, kExtensions}, {{"oldid", "newid"}}, &n);
  Check(err.empty() && n == 6, "stage: " + err + " (" + std::to_string(n) + ")");
  Check(Get(dst / "state.json") == "old", "live files untouched until launch");
  Check(ApplyPendingRestore(dst) == 6, "apply moves six files");
  Check(ApplyPendingRestore(dst) == -1, "nothing pending afterwards");
  Check(Get(dst / "state.json") == Get(src / "state.json"), "state.json restored");
  Check(Get(dst / "Space-2/Extensions/xyz/1.0/manifest.json") == "{}", "space extension restored");
  Check(Get(dst / "Default/Local Extension Settings/newid/000003.log") == "vm-scripts", "extension storage renamed");
  Check(!fs::exists(dst / "Default/Local Extension Settings/stale"), "stale extension storage removed");
  Check(Get(dst / "Space-9/Cookies") == "newer-space", "space missing from backup kept");
  Check(Get(dst / "Default/Cookies") == "keep-me", "browsing data kept when not restored");

  // A tampered file is refused before anything is staged.
  std::string bytes = Get(out);
  size_t at = bytes.find("vm-scripts");
  bytes[at] = 'X';
  Put(root / "bad.roarbackup", bytes);
  err = Stage(root / "bad.roarbackup", dst, {kSettings, kExtensions});
  Check(!err.empty() && !fs::exists(dst / kPending), "tampered backup refused");
  Check(!SafeRel("../x") && !SafeRel("/etc") && !SafeRel("a/../../b") && SafeRel("Default/Preferences"), "paths checked");

  std::error_code ec;
  fs::remove_all(root, ec);
  std::printf("%s\n", failures ? "FAILED" : "all passed");
  return failures ? 1 : 0;
}
