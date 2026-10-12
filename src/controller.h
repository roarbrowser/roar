// Owns the Roar windows, the tabs and every user-facing command.
//
// CEF ties a Chrome-style window to the first Chrome-style BrowserView it ever
// hosts, so one window cannot switch between tabs. Roar therefore uses:
//   - a frameless Alloy-style shell window holding the sidebar;
//   - one frameless Chrome-style window per tab, attached as a macOS child
//     window over the shell's content area (only the active one is shown);
//   - small Alloy-style child windows for the command bar and the hint toast.
// Chrome style on the tabs keeps extensions, DevTools and CDP behaving like
// Chrome.
#pragma once

#include <map>
#include <set>
#include <string>
#include <vector>

#include "include/cef_browser.h"
#include "include/cef_context_menu_handler.h"
#include "include/cef_download_handler.h"
#include "include/cef_request_context.h"
#include "include/views/cef_box_layout.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_panel.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_message_router.h"

namespace roar {

class Client;

struct Tab {
  int id = 0;
  CefRefPtr<CefBrowserView> view;
  CefRefPtr<CefWindow> window;  // Created on first activation.
  bool floating = false;        // Detached into an always-on-top mini window.
  std::string url;
  std::string title;
  std::string favicon;
  std::string icon;  // Custom icon for a pinned tab: an emoji or an image URL.
  bool pinned = false;
  std::string home_url;  // A pinned tab's pinned address: saved, and Cmd-W returns to it.
  bool loading = false;
  bool can_back = false;
  bool can_forward = false;
  double last_active = 0;
  int space = 0;
  std::string folder;  // "mail" or "github": the space's one tab for that sidebar group's links.
  std::string folder_item;  // The folder link it opened; the sidebar shows the tab in its place.
  int group = 0;
  // Ghost tab: an in-memory profile shared by all ghost tabs, never saved,
  // archived or recorded in history. Shown in every space.
  bool ghost = false;
  bool audible = false;  // A media element is playing sound (MediaWatcher in controller.cc).
  bool muted = false;
  std::string reader_origin;  // The article's address while the tab shows Reader mode.
  std::string reader_markdown;
  std::string reader_title;
};

// One file saved from a page, listed on roar://ui/downloads.html.
struct Download {
  int id = 0;
  int item_id = 0;  // CEF's id, only unique within one profile.
  std::string name;
  std::string path;
  std::string url;
  int64_t received = 0;
  int64_t total = 0;  // -1 when the server didn't say.
  int64_t speed = 0;
  bool done = false;
  bool canceled = false;
  bool failed = false;
  CefRefPtr<CefDownloadItemCallback> control;  // Set while in progress.
};

class Controller {
 public:
  using Callback = CefMessageRouterBrowserSide::Callback;

  static Controller* Get();
  CefRefPtr<CefClient> client();

  void Start();
  void Focus();
  void Quit();

  // Tabs. Ids are stable for the life of the process.
  // space < 0 means the active space.
  int NewTab(const std::string& url, bool activate, bool pinned = false, double last_active = 0,
             int space = -1, bool ghost = false);
  void ActivateTab(int id);
  CefRefPtr<CefRequestContext> ContextFor(int space);
  void CloseTab(int id);
  void Navigate(int id, const std::string& url);
  void SetPinned(int id, bool pinned);
  void SetGroup(int id, int group);
  // Pinned tabs and tabs in pinned groups: restored on launch, kept by ⌘W.
  bool IsKept(const Tab& tab);
  void DropGroupIfEmpty(int group);
  void CloseActiveUnlessKept();
  bool ExecuteScript(int id, const std::string& code);
  const std::vector<Tab>& tabs() const { return tabs_; }
  int active_id() const { return active_id_; }

  // Commands.
  void ShowCommandBar(bool new_tab);
  void HideCommandBar();
  void CleanTabs();
  void ClearArchive();
  void RestoreArchived(size_t index);
  // |target| is "copy", "save", or an LLM id from kLlms to open the page in.
  void ExtractActive(const std::string& target, int tab_id = 0);
  void PictureInPicture();
  void FloatActiveTab();
  void SetFaviconData(int tab_id, const std::string& url, const std::string& data);
  void DockTab(int id);
  void Back();
  void Forward();
  void Reload();
  void OpenSettings();
  void ToggleSidebar();
  // `attempt` counts retries after a network failure (launch can beat the network).
  void RefreshGitHub(int attempt = 0);
  void RefreshGmail();
  void RefreshGmail(int space, int attempt = 0);
  void ImportBrowser(const std::string& browser);
  std::string LibraryJson();
  void SaveToLibrary(bool read_later);
  void OpenUiPage(const std::string& url);
  void OnSpaceReady(int space);
  std::string ExtensionsJson();
  void PushActions(const std::string& json);
  void ShowExtensionPopup(const std::string& url, int x, int y);
  void CloseExtensionPopup();
  void OnExtensionPopupDestroyed(CefRefPtr<CefWindow> window);
  bool IsExtensionPopup(CefRefPtr<CefBrowser> browser);
  bool OnExtensionPopupResize(CefRefPtr<CefBrowser> browser, const CefSize& size);
  void PushSidebar();
  void ShowHint(const std::string& text);
  void RunCommand(const std::string& id);

  // Spaces: named sets of tabs, each with its own profile.
  void SwitchSpace(int id);
  void CycleSpace(int step);
  int AddSpace(const std::string& name);
  void RenameSpace(int id, const std::string& name);
  void RemoveSpace(int id);

  // Split view: two tabs side by side in the shell.
  void ToggleSplit();

  // Find in page, zoom, print, Reader mode, audio, downloads, history.
  void ShowFind();
  void HideFind(bool refocus = true);
  void FindNext(bool forward);
  void OnFindResult(CefRefPtr<CefBrowser> browser, int identifier, int count, int active);
  void ZoomStep(int direction);  // +1, -1, or 0 for actual size.
  void ApplyZoom(CefRefPtr<CefBrowser> browser, const std::string& url);
  void Print();
  void ToggleReader();
  void ToggleMute(int id);
  void OnAudible(CefRefPtr<CefBrowser> browser, bool audible);
  void CycleTabs(int step);
  bool OnBeforeDownload(CefRefPtr<CefBrowser> browser, CefRefPtr<CefDownloadItem> item,
                        const std::string& suggested_name,
                        CefRefPtr<CefBeforeDownloadCallback> callback);
  void OnDownloadUpdated(CefRefPtr<CefDownloadItem> item,
                         CefRefPtr<CefDownloadItemCallback> callback);
  std::string DownloadsJson();
  std::string HistoryJson(const std::string& query);
  void BuildContextMenu(CefRefPtr<CefBrowser> browser, CefRefPtr<CefContextMenuParams> params,
                        CefRefPtr<CefMenuModel> model);
  bool OnContextMenuCommand(CefRefPtr<CefBrowser> browser, CefRefPtr<CefContextMenuParams> params,
                            int command_id);
  void OpenInSplit(const std::string& url, bool ghost);

  // Client and window callbacks.
  void OnBrowserCreated(CefRefPtr<CefBrowser> browser);
  void OnBrowserClosed(CefRefPtr<CefBrowser> browser);
  void OnTitle(CefRefPtr<CefBrowser> browser, const std::string& title);
  void OnAddress(CefRefPtr<CefBrowser> browser, const std::string& url);
  void OnFavicon(CefRefPtr<CefBrowser> browser, const std::string& url);
  void OnLoading(CefRefPtr<CefBrowser> browser, bool loading, bool can_back, bool can_forward);
  void OnDraggableRegions(CefRefPtr<CefBrowser> browser,
                          const std::vector<CefDraggableRegion>& regions);
  bool OnKey(CefRefPtr<CefBrowser> browser, const CefKeyEvent& event);
  bool OnGesture(CefRefPtr<CefBrowserView> view, cef_gesture_command_t command);
  bool HandleQuery(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                   const std::string& request, CefRefPtr<Callback> callback);
  bool CanCloseShell();
  void OnShellDestroyed();
  bool CanCloseTabWindow(CefRefPtr<CefWindow> window);
  void OnTabWindowCreated(CefRefPtr<CefWindow> window);
  void OnTabWindowActivated(CefRefPtr<CefWindow> window);
  // Fails closed: a browser Roar can't place in the global or a space
  // profile (a ghost tab's popup, say) counts as ghost.
  bool IsGhostBrowser(CefRefPtr<CefBrowser> browser);
  void ReloadSpace(int space);
  void Relayout();
  void ApplySidebarWidth();
  void PollSidebarDragEnd();

 private:
  Controller() = default;

  Tab* FindTab(int id);
  Tab* FindTabByBrowser(CefRefPtr<CefBrowser> browser);
  Tab* FindTabByWindow(CefRefPtr<CefWindow> window);
  Tab* ActiveTab() { return FindTab(active_id_); }
  bool IsUiBrowser(CefRefPtr<CefBrowser> browser) const;
  CefRect ContentRect();
  std::vector<int> VisibleIds();
  bool IsVisible(int id);
  CefRect RectFor(int id);
  void SyncWindows();
  CefRefPtr<CefBrowserView> CreateTabView(const std::string& url, int space, bool ghost = false);
  void EndGhostSession();
  void IndexPage(Tab* tab);
  void SavePagesSoon();
  void ShowTabWindow(Tab* tab);
  void HideTabWindow(Tab* tab);
  void FocusTab(Tab* tab);
  std::string StateJson();
  std::string Suggest(const std::string& query);
  void SuggestPageText(const std::string& q, CefRefPtr<CefListValue> list, size_t& n);
  void ApplySettings(CefRefPtr<CefDictionaryValue> settings);
  void SaveSoon();
  void SaveNow();
  void ArchiveTab(int id);
  void AutoArchiveTick();
  void GitHubTick();
  void GmailOpenTick();
  void MaybeQuit();

  CefRefPtr<Client> client_;
  CefRefPtr<CefWindow> shell_;
  CefRefPtr<CefBoxLayout> layout_;
  CefRefPtr<CefPanel> sidebar_panel_;
  CefRefPtr<CefBrowserView> sidebar_;
  CefRefPtr<CefWindow> command_window_;
  CefRefPtr<CefBrowserView> command_bar_;
  CefRefPtr<CefWindow> hint_window_;
  CefRefPtr<CefWindow> find_window_;
  CefRefPtr<CefBrowserView> find_;
  bool find_visible_ = false;
  int find_tab_ = 0;
  std::string find_text_;
  int find_count_ = 0;
  int find_active_ = 0;
  bool find_fresh_ = false;  // A new search that hasn't selected its first match yet.
  std::map<int, CefRefPtr<CefRegistration>> media_watchers_;  // By browser id.
  std::vector<Download> downloads_;
  int next_download_ = 1;
  std::set<std::pair<int, std::string>> denied_downloads_;  // (CEF item id, url) the user refused.
  // ⌃Tab cycling: the most-recently-used order is frozen while the presses keep coming.
  std::vector<int> cycle_order_;
  std::map<int, double> cycle_saved_;
  size_t cycle_index_ = 0;
  double cycle_at_ = 0;
  CefRefPtr<CefWindow> ext_popup_;
  CefPoint ext_popup_anchor_;
  CefRefPtr<CefBrowserView> hint_;
  std::vector<Tab> tabs_;
  int next_id_ = 1;
  int ghost_session_ = 0;  // Names the Ghost-<n> profile of the current ghost session.
  int active_id_ = 0;
  std::set<int> stray_seen_;  // Browsers outside Roar whose first address was seen.
  int gmail_refresh_gen_ = 0;  // Debounces refreshes while the mail tab navigates.
  int split_a_ = 0;  // Split view pair, left and right; 0 when not split.
  int split_b_ = 0;
  int command_height_ = 0;
  bool command_new_tab_ = true;
  bool command_ghost_ = false;  // The command bar opens a ghost tab.
  bool command_visible_ = false;
  bool sidebar_drag_poll_ = false;
  bool sidebar_visible_ = true;
  bool save_pending_ = false;
  bool pages_save_pending_ = false;
  bool closing_ = false;
  int hint_generation_ = 0;
  int live_browsers_ = 0;

  struct PendingExtract {
    int tab_id;
    std::string target;
  };
  std::map<std::string, PendingExtract> extracts_;
  std::map<int, std::string> llm_fills_;  // Tab id -> text to put in its chat box.
  struct PendingIndex {
    int tab_id;
    std::string url;  // The page the nonce was issued to.
  };
  std::map<std::string, PendingIndex> indexes_;
  std::map<int, CefRefPtr<CefRequestContext>> contexts_;
  std::set<int> ready_spaces_;  // Spaces whose profile has finished loading.
};

}  // namespace roar
