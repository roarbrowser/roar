// Builds the --load-extension value. Chromium shows a blocking "Failed to load
// extension from: ." alert for any entry without a readable manifest (a blank
// entry or a missing folder, e.g. a bundle whose uBOL copy was a dangling symlink).
#pragma once

#include <cstdio>
#include <filesystem>
#include <sstream>
#include <string>

namespace roar {

// Joins the comma-separated lists in `parts`, keeping only folders with a
// manifest.json and dropping duplicates; skipped entries are logged to stderr.
inline std::string JoinExtensionPaths(std::initializer_list<std::string> parts) {
  std::string out;
  for (const std::string& part : parts) {
    std::stringstream ss(part);
    std::string p;
    while (std::getline(ss, p, ',')) {
      std::error_code ec;
      if (p.empty() || !std::filesystem::is_regular_file(std::filesystem::path(p) / "manifest.json", ec)) {
        if (!p.empty()) std::fprintf(stderr, "roar: skipping extension without manifest: %s\n", p.c_str());
        continue;
      }
      if (("," + out + ",").find("," + p + ",") != std::string::npos) continue;
      out += (out.empty() ? "" : ",") + p;
    }
  }
  return out;
}

// Whether a window Roar didn't make for a tab must sit above the tab windows:
// an extension's own window (Bitwarden's unlock or passkey pop-out). Tab windows
// are children of the shell, so any tab focus orders the shell group over a
// plain window. Agent tabs are Roar tabs, so this never raises them.
inline bool KeepAboveTabs(bool roar_tab, bool ui_page, const std::string& url) {
  return !roar_tab && !ui_page && url.rfind("chrome-extension://", 0) == 0;
}

}  // namespace roar
