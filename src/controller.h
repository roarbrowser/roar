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
#include <string>
#include <vector>

#include "include/cef_browser.h"
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
  bool pinned = false;
  bool loading = false;
  bool can_back = false;
  bool can_forward = false;
  double last_active = 0;
  int space = 0;
};

class Controller {
 public:
  using Callback = CefMessageRouterBrowserSide::Callback;

  static Controller* Get();

  void Start();
  void Focus();
  void Quit();

  // Tabs. Ids are stable for the life of the process.
  // space < 0 means the active space.
  int NewTab(const std::string& url, bool activate, bool pinned = false, double last_active = 0,
             int space = -1);
  void ActivateTab(int id);
  void CloseTab(int id);
  void Navigate(int id, const std::string& url);
  void SetPinned(int id, bool pinned);
  bool ExecuteScript(int id, const std::string& code);
  const std::vector<Tab>& tabs() const { return tabs_; }
  int active_id() const { return active_id_; }

  // Commands.
  void ShowCommandBar(bool new_tab);
  void HideCommandBar();
  void CleanTabs();
  void RestoreArchived(size_t index);
  void ExtractActive(bool save);
  void PictureInPicture();
  void FloatActiveTab();
  void DockTab(int id);
  void Back();
  void Forward();
  void Reload();
  void OpenSettings();
  void ToggleSidebar();
  void RefreshGitHub();
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
  void Relayout();

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
  CefRefPtr<CefRequestContext> ContextFor(int space);
  CefRefPtr<CefBrowserView> CreateTabView(const std::string& url, int space);
  void IndexPage(Tab* tab);
  void SavePagesSoon();
  void ShowTabWindow(Tab* tab);
  void HideTabWindow(Tab* tab);
  void FocusTab(Tab* tab);
  std::string StateJson();
  std::string Suggest(const std::string& query);
  void SuggestPageText(const std::string& q, CefRefPtr<CefListValue> list, size_t& n);
  void ApplySettings(CefRefPtr<CefDictionaryValue> settings);
  void PushSidebar();
  void SaveSoon();
  void SaveNow();
  void ArchiveTab(int id);
  void AutoArchiveTick();
  void GitHubTick();
  void MaybeQuit();

  CefRefPtr<Client> client_;
  CefRefPtr<CefWindow> shell_;
  CefRefPtr<CefBoxLayout> layout_;
  CefRefPtr<CefPanel> sidebar_panel_;
  CefRefPtr<CefBrowserView> sidebar_;
  CefRefPtr<CefWindow> command_window_;
  CefRefPtr<CefBrowserView> command_bar_;
  CefRefPtr<CefWindow> hint_window_;
  CefRefPtr<CefBrowserView> hint_;
  std::vector<Tab> tabs_;
  int next_id_ = 1;
  int active_id_ = 0;
  int split_a_ = 0;  // Split view pair, left and right; 0 when not split.
  int split_b_ = 0;
  int command_height_ = 0;
  bool command_new_tab_ = true;
  bool command_visible_ = false;
  bool sidebar_visible_ = true;
  bool save_pending_ = false;
  bool pages_save_pending_ = false;
  bool closing_ = false;
  int hint_generation_ = 0;
  int live_browsers_ = 0;

  struct PendingExtract {
    int tab_id;
    bool save;
  };
  std::map<std::string, PendingExtract> extracts_;
  struct PendingIndex {
    int tab_id;
    std::string url;  // The page the nonce was issued to.
  };
  std::map<std::string, PendingIndex> indexes_;
  std::map<int, CefRefPtr<CefRequestContext>> contexts_;
};

}  // namespace roar
