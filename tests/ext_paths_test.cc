// Standalone check for JoinExtensionPaths: scripts/test-ext-paths.sh
#include <cstdio>
#include <fstream>

#include "ext_paths.h"

namespace fs = std::filesystem;
static int failures = 0;
static void Check(std::initializer_list<std::string> in, const std::string& want) {
  std::string got = roar::JoinExtensionPaths(in);
  if (got != want) { ++failures; std::printf("FAIL want '%s' got '%s'\n", want.c_str(), got.c_str()); }
}

int main() {
  fs::path dir = fs::temp_directory_path() / "roar-ext-paths-test";
  fs::remove_all(dir);
  fs::create_directories(dir / "a");
  fs::create_directories(dir / "nomanifest");
  std::ofstream(dir / "a" / "manifest.json") << "{}";
  std::string a = (dir / "a").string(), none = (dir / "nomanifest").string();
  Check({"", a}, a);                          // no user switch
  Check({",", ""}, "");                       // nothing valid: no switch at all
  Check({a + ",," + none, a}, a);             // blanks, missing manifest, duplicate
  Check({(dir / "gone").string(), a}, a);     // missing folder
  fs::remove_all(dir);
  auto above = [](bool want, bool tab, bool ui, const char* url) {
    if (roar::KeepAboveTabs(tab, ui, url) != want) { ++failures; std::printf("FAIL KeepAboveTabs %s\n", url); }
  };
  above(true, false, false, "chrome-extension://abc/popup/index.html");  // Bitwarden pop-out
  above(false, true, false, "chrome-extension://abc/options.html");      // options page opened as a tab
  above(false, true, false, "https://example.com/");                     // agent background tab
  above(false, false, false, "https://accounts.example.com/");           // web popup window
  above(false, false, true, "chrome-extension://abc/x.html");            // Roar UI
  std::printf(failures ? "%d failed\n" : "ok\n", failures);
  return failures != 0;
}
