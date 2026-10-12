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
  int space = 0;
  int group = 0;
  std::string icon;  // A pinned tab's custom icon: an emoji or an image URL.
  std::string favicon;  // Last seen, so an unloaded tab still shows it after launch.
};

// A named, colored set of tabs in one space. A pinned group's tabs come back
// on launch and ignore ⌘W, like pinned tabs; an unpinned group goes away with
// its tabs.
struct TabGroup {
  int id = 0;
  std::string name;
  std::string color;
  int space = 0;
  bool pinned = false;
  bool collapsed = false;
};

// History, the archive and page text are kept per space, so one space's
// browsing never surfaces in another's suggestions.
struct ArchivedTab {
  std::string url;
  std::string title;
  double archived_at = 0;
  int space = 0;
};

struct HistoryEntry {
  std::string title;
  int visits = 0;
  double last_visit = 0;
  int space = 0;
};

struct LiveItem {
  std::string title;
  std::string url;
  std::string detail;  // Repository and number, e.g. "owner/repo #42".
  int account = 0;     // Mail only: position in GmailFeed::accounts.
};

// A Space is a named set of tabs with its own cookies and storage. Space 0
// uses the default profile; the others get a profile under Spaces/<id>.
struct Space {
  int id = 0;
  std::string name;
  std::string color;  // CSS color for the space dot and accent; empty uses the default.
  std::vector<std::string> pinned_extensions;  // Extension ids shown in the sidebar.
};

// Visible text of a page, kept for full-text search in the command bar.
struct PageText {
  std::string title;
  std::string text;
  double indexed_at = 0;
  int space = 0;
  std::string url;
};

// Key for history and pages: the URL itself in space 0 (the format before
// spaces had their own), "<space>\t<url>" elsewhere.
std::string SpaceKey(int space, const std::string& url);

struct GmailAccount {
  std::string address;
  int index = 0;  // The /mail/u/<index>/ slot Google gave this login.
  int unread = 0;
};

struct GmailFeed {
  std::vector<GmailAccount> accounts;  // Every signed-in account, in Google's order.
  std::vector<LiveItem> items;  // All accounts' unread mail.
  std::string status;  // Empty when the last refresh succeeded.
  int unread = 0;
  bool signed_out = false;  // Last refresh got 401/403.
  std::string account;  // The address the feed is for.
};

struct Settings {
  double archive_after_hours = 12;  // 0 disables auto-archive.
  bool onboarded = false;
  std::string search_url = "https://www.google.com/search?q=";
  std::string github_query = "is:open is:pr author:@me archived:false";
  bool github_folder = true;
  bool gmail_folder = true;
  bool index_pages = true;
  int sidebar_width = 268;
  int pinned_columns = 0;  // Pinned tiles per row; 0 fits as many as the width allows.
  bool pinned_centered = false;  // Centers a short last row.
};

class State {
 public:
  static State& Get();

  void Load();
  void Save();
  std::string Dir() const;
  // Chromium profile dir for a space. Chrome-style CEF only creates profiles
  // that sit directly in the root cache path, so spaces are <data>/Space-<id>.
  std::string ProfileDir(int space) const;

  std::vector<SavedTab> tabs;
  int active_index = 0;
  std::vector<ArchivedTab> archive;
  std::map<std::string, HistoryEntry> history;
  std::vector<LiveItem> github_items;
  std::string github_status;  // Empty when the last refresh succeeded.
  // Each space reads Gmail with its own profile's login.
  std::map<int, GmailFeed> gmail;
  // The space the GitHub folder belongs to: the first one it loaded in, or -1.
  int github_space = -1;
  Settings settings;
  std::vector<Space> spaces;
  int active_space = 0;
  int next_space_id = 1;
  std::vector<TabGroup> groups;
  int next_group_id = 1;
  TabGroup* FindGroup(int id);  // Never reused, so a new space never inherits an old profile.
  std::map<std::string, PageText> pages;
  // Zoom level (Chromium's logarithmic scale, 0 = 100%) per host; hosts at 100% are absent.
  std::map<std::string, double> zoom;

  void SavePages();
  void SetPageText(int space, const std::string& url, const std::string& title, const std::string& text);
  Space* FindSpace(int id);
  std::vector<std::string>& ActivePins() { return FindSpace(active_space)->pinned_extensions; }

  void RecordVisit(int space, const std::string& url, const std::string& title);
  void AddArchived(int space, const std::string& url, const std::string& title);

 private:
  State() = default;
};

double NowSeconds();

}  // namespace roar
