// Persistent browser state: open tabs, archived tabs, history, settings.
// Stored as JSON in ~/Library/Application Support/Roar/state.json.
#pragma once

#include <map>
#include <string>
#include <vector>

#include "include/cef_values.h"

namespace roar {

struct SavedTab {
  std::string url;
  std::string title;
  bool pinned = false;
  double last_active = 0;  // Unix seconds.
};

struct ArchivedTab {
  std::string url;
  std::string title;
  double archived_at = 0;
};

struct HistoryEntry {
  std::string title;
  int visits = 0;
  double last_visit = 0;
};

struct LiveItem {
  std::string title;
  std::string url;
  std::string detail;  // Repository and number, e.g. "owner/repo #42".
};

struct Settings {
  double archive_after_hours = 12;  // 0 disables auto-archive.
  bool onboarded = false;
  std::string search_url = "https://www.google.com/search?q=";
  std::string github_query = "is:open is:pr author:@me";
  bool github_folder = true;
};

class State {
 public:
  static State& Get();

  void Load();
  void Save();
  std::string Dir() const;

  std::vector<SavedTab> tabs;
  int active_index = 0;
  std::vector<ArchivedTab> archive;
  std::map<std::string, HistoryEntry> history;
  std::vector<LiveItem> github_items;
  std::string github_status;  // Empty when the last refresh succeeded.
  Settings settings;

  void RecordVisit(const std::string& url, const std::string& title);
  void AddArchived(const std::string& url, const std::string& title);

 private:
  State() = default;
};

double NowSeconds();

}  // namespace roar
