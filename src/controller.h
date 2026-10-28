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

#include "agent_mark.h"
#include "start_tab.h"
#include "agent_queue.h"
#include "dictation.h"
#include "notify_prefs.h"
#include <memory>
#include <functional>
#include <deque>
#include <filesystem>
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
  std::string name;  // Given in Roar (agent.rename); shown instead of title when set.
  std::string favicon;
  std::string icon;  // Custom icon for a pinned tab: an emoji or an image URL.
  bool pinned = false;
  std::string home_url;  // A pinned tab's pinned address: saved, and Cmd-W returns to it.
  bool loading = false;
  bool can_back = false;
  bool can_forward = false;
  double last_active = 0;
  int space = 0;
  int win = 0;  // The Win (shell window) that owns it; kept tabs list in every window's sidebar.
  std::string folder;  // "mail" or "github": the space's one tab for that sidebar group's links.
  std::string folder_item;  // The folder link it opened; the sidebar shows the tab in its place.
  int group = 0;
  int opener = 0;  // The tab whose link opened this one; not saved.
  // Ghost tab: an in-memory profile shared by all ghost tabs, never saved,
  // archived or recorded in history. Shown in every space.
  bool ghost = false;
  bool driven = false;   // An outside CDP client (an agent) is attached to its page.
  AgentMark agent;       // Saved: an agent opened or acted on it (agent_mark.h).
  bool agent_active = false;  // AgentActive, refreshed by PollDriven.
  std::string ask_llm;  // The AI site an Ask opened it for ("Claude"): listed under AI; saved with the tab.
  std::string mcp_owner;  // The roar-mcp connection that opened it (agent.space claim); not saved.
  bool audible = false;  // A media element is playing sound (MediaWatcher in controller.cc).
  bool muted = false;
  std::string reader_origin;  // The article's address while the tab shows Reader mode.
  std::string reader_markdown;
  std::string reader_title;
};

// One shell window: its sidebar and the tab it shows. Each window has its own active tab and
// space; spaces' profiles (CefRequestContext) are shared, so cookies are live across windows.
// The command bar, find bar, hint and extension popup are single and follow the focused window.
struct Win {
  int id = 0;
  CefRefPtr<CefWindow> shell;
  CefRefPtr<CefBoxLayout> layout;
  CefRefPtr<CefPanel> sidebar_panel;
  CefRefPtr<CefView> sidebar_button;  // Windows only: shows a collapsed sidebar.
  CefRefPtr<CefBrowserView> sidebar;
  int active_id = 0;
  int space = 0;  // Its active space while another window is focused (State::active_space is the focused one's).
  bool sidebar_visible = true;
  bool closing = false;  // Its shell is closing: its tabs go without picking a successor.
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
  bool ghost = false;  // From a ghost tab: dropped from the list when the session ends.
  CefRefPtr<CefDownloadItemCallback> control;  // Set while in progress.
};

class Controller {
 public:
  using Callback = CefMessageRouterBrowserSide::Callback;

  static Controller* Get();
  CefRefPtr<CefClient> client();

  void Start();
  void Focus();
  // ⌘N: another shell window in this process, in the focused window's space.
  void NewWindow();
  void OnShellActivated(CefRefPtr<CefWindow> shell);
  void OnShellResized(CefRefPtr<CefWindow> shell);
  size_t window_count() const { return wins_.size(); }
  // Roar went to the background: paint the visible tabs onto the shell window,
  // so window previews that capture only it (Vorssaint) show the page.
  void PaintPreview();
  void ClearPreview();
  void OnPreviewShot(int tab_id, const std::string& jpeg);
  void Quit();
  // Sparkle's install-and-relaunch: unpinned tabs that a relaunch would drop, and saving the
  // session with an update-restore marker for `build` so the next launch reopens them.
  int UpdateRestoreCount() const;
  void PrepareUpdateRestore(const std::string& build);

  // Tabs. Ids are stable for the life of the process.
  // space < 0 means the active space.
  int NewTab(const std::string& url, bool activate, bool pinned = false, double last_active = 0,
             int space = -1, bool ghost = false, int opener = 0);
  // Opens a CDP Target.createTarget page as a tab; returns its browser id, or 0.
  int OpenTargetTab(const std::string& url);
  int last_target_tab_ = 0;
  std::map<std::string, std::set<int>> driving_;  // Agent name -> tabs roar-mcp says it acts on (agent.drive).  // The tab CDP createTarget opened last (agent.front).
  // Whether remote CDP clients may see this browser (Roar's DevTools filter).
  bool AgentMayReach(int browser_id, const std::string& profile_path);
  // Where a connection's pages open by default: the active space, else the first
  // that allows agents; -1 when none does. Never shared between connections.
  int AgentSpace();
  // A link opened in a new tab: beside its opener, in the opener's space and group.
  int NewTabFrom(CefRefPtr<CefBrowser> opener, const std::string& url, bool activate);
  int SpaceOfProfile(CefRefPtr<CefBrowser> browser);  // -1 when its profile matches no space.
  bool AdoptPopup(CefRefPtr<CefBrowser> opener, CefRefPtr<CefBrowserView> popup);
  void ReloadBrowser(CefRefPtr<CefBrowser> browser, bool ignore_cache);
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
  // AppleScript `execute javascript`: refuses Roar pages, ghost tabs and spaces with agents off.
  bool ExecuteScriptFromApp(int id, const std::string& code);
  const std::vector<Tab>& tabs() const { return tabs_; }
  int active_id() const { return win_->active_id; }

  // Commands.
  void ShowCommandBar(bool new_tab, bool ghost = false);
  void HideCommandBar();
  void CleanTabs();
  void ClearArchive();
  void RestoreArchived(size_t index);
  // |target| is "copy", "save", or an LLM id from kLlms to open the page in.
  void ExtractActive(const std::string& target, int tab_id = 0, const std::string& prompt = "");
  void PictureInPicture();
  void FloatActiveTab();
  void SetFaviconData(int tab_id, const std::string& url, const std::string& data);
  void DockTab(int id);
  void Back();
  void Forward();
  void Reload(bool ignore_cache = false);
  void OpenSettings();
  void ToggleSidebar();
  // `attempt` counts retries after a network failure (launch can beat the network).
  void RefreshGitHub(int attempt = 0);
  void RefreshGmail();
  void RefreshGmail(int space, int attempt = 0);
  void RefreshOutlook(int space);
  void FetchOutlookMail(int space, const std::string& host);
  void ImportBrowser(const std::string& browser);
  void ImportArc();
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
  void PushSidebarNow();
  void ShowHint(const std::string& text);
  // Dictation (controller_dictation.cc): every entry point checks DictationAllowed first.
  void DictationToggle();
  void DictationLoad();
  void DictationOff();
  void DictationRemoveModel();
  void OnDictationLine(int generation, const std::string& line);
  CefRefPtr<CefDictionaryValue> DictationJson();
  // Offers to hand a non-web URL to the app that handles its scheme.
  void OpenExternal(const std::string& url);
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
  std::string HistoryJson(const std::string& query, size_t limit = 500);
  void BuildContextMenu(CefRefPtr<CefBrowser> browser, CefRefPtr<CefContextMenuParams> params,
                        CefRefPtr<CefMenuModel> model);
  bool OnContextMenuCommand(CefRefPtr<CefBrowser> browser, CefRefPtr<CefContextMenuParams> params,
                            int command_id);
  void OpenInSplit(const std::string& url);

  // Client and window callbacks.
  void OnBrowserCreated(CefRefPtr<CefBrowser> browser);
  void OnBrowserClosed(CefRefPtr<CefBrowser> browser);
  void OnTitle(CefRefPtr<CefBrowser> browser, const std::string& title);
  void OnAddress(CefRefPtr<CefBrowser> browser, const std::string& url);
  void AdoptStray(CefRefPtr<CefBrowser> browser, const std::string& url);
  void OnFavicon(CefRefPtr<CefBrowser> browser, const std::string& url);
  void OnLoading(CefRefPtr<CefBrowser> browser, bool loading, bool can_back, bool can_forward);
  // A real left click at CSS-pixel (x, y) in a Gmail tab, for mail-act.js.
  void OnMailClick(CefRefPtr<CefBrowser> browser, double x, double y);
  // What mail-act.js did (or why it did nothing), shown as a hint.
  void OnMailResult(CefRefPtr<CefBrowser> browser, const std::string& text);
  void OnOutlookMail(CefRefPtr<CefBrowser> browser, const std::string& json);
  // otp-fill.js in a tab: "<nonce> ask" (a code field got focus) or "<nonce> pick" (its suggestion was clicked).
  void OnOtp(CefRefPtr<CefBrowser> browser, const std::string& line);
  // Hidden per-account Gmail pages (MailPageClient): created, finished loading, closed.
  void OnMailPageCreated(const std::string& key, CefRefPtr<CefBrowser> browser);
  void OnMailPageLoaded(CefRefPtr<CefBrowser> browser);
  void OnMailPageClosed(CefRefPtr<CefBrowser> browser);
  void OnDraggableRegions(CefRefPtr<CefBrowser> browser,
                          const std::vector<CefDraggableRegion>& regions);
  bool OnKey(CefRefPtr<CefBrowser> browser, const CefKeyEvent& event);
  bool OnGesture(CefRefPtr<CefBrowserView> view, cef_gesture_command_t command);
  void CancelChat(int browser_id);
  bool HandleQuery(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                   const std::string& request, CefRefPtr<Callback> callback);
  // Settings > Backup's backup.* commands (controller_backup.cc).
  bool HandleBackup(CefRefPtr<CefBrowser> browser, CefRefPtr<CefDictionaryValue> msg, CefRefPtr<Callback> callback);
  bool CanCloseShell(CefRefPtr<CefWindow> shell);
  void OnShellDestroyed(CefRefPtr<CefWindow> shell);
  bool CanCloseTabWindow(CefRefPtr<CefWindow> window);
  void OnTabWindowCreated(CefRefPtr<CefWindow> window);
  void OnTabWindowActivated(CefRefPtr<CefWindow> window);
  void OnTabWindowMoved(CefRefPtr<CefWindow> window, const CefRect& bounds);
  void SnapTabWindow(int id);
  // Fails closed: a browser Roar can't place in the global or a space
  // profile (a ghost tab's popup, say) counts as ghost.
  bool IsGhostBrowser(CefRefPtr<CefBrowser> browser);
  void ReloadSpace(int space);
  void Relayout();
  void ApplySidebarWidth();
  void PollDriven();
  void PollSidebarDragEnd();

 private:
  Controller() = default;

  Tab* FindTab(int id);
  Tab* FindTabByBrowser(CefRefPtr<CefBrowser> browser);
  Tab* FindTabByWindow(CefRefPtr<CefWindow> window);
  Tab* ActiveTab() { return FindTab(win_->active_id); }
  // Windows. win_ is the focused one; every per-window member (shell, sidebar, active tab) is read
  // through it, so code that acts for another window switches win_ with a WinScope.
  Win* FindWin(int id);
  Win* WinOfShell(CefRefPtr<CefWindow> shell);
  Win* WinOfSidebar(CefRefPtr<CefBrowser> browser);
  Win* WinOf(const Tab& tab);  // Its owner, or the focused window when that's gone.
  void UseWin(Win* w);  // Makes |w| the focused window (swaps State::active_space).
  void Focused(Win* w);  // UseWin, and records |w| as the window the person is in.
  // Acts as |w| for its lifetime, then returns to the window before, or to the one the person
  // focused meanwhile. A null |w| does nothing.
  struct WinScope {
    WinScope(Controller* c, Win* w) : c(c), prev(c->win_->id), focus(c->focused_win_), set(w) { if (w) c->UseWin(w); }
    ~WinScope() {
      if (!set) return;
      Win* to = c->FindWin(c->focused_win_ != focus ? c->focused_win_ : prev);
      if (!to) to = c->FindWin(c->focused_win_);
      if (to) c->UseWin(to);
    }
    Controller* c;
    int prev, focus;
    Win* set;
  };
  Win* MakeWin(int space);  // Builds and shows a shell window.
  void ApplySidebarWidthHere();  // ApplySidebarWidth for win_ alone.
  void CloseWinTabs(Win* w);  // Its kept tabs move to another window; the rest are archived.
  std::vector<int> VisibleIdsOf(Win* w);
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
  // Keys the tab only while Roar is the active app, unless |force| (the person asked to show Roar).
  void FocusTab(Tab* tab, bool force = false);
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
  // Claude Code sessions reported by the roar-mcp claude-hook (<data>/claude-sessions/*.json).
  void ClaudeTick();
  CefRefPtr<CefListValue> claude_ = CefListValue::Create();
  std::string claude_sig_;
  std::map<std::string, std::string> claude_states_;  // Session id -> last state, for its notification.
  std::set<std::string> claude_acked_;  // Sessions answered since their state last changed.
  std::set<std::string> claude_seen_;   // Sessions viewed in their full view since; they no longer count on the Dock badge.
  bool claude_hooks_ = false;
  CefRefPtr<CefListValue> chats_;  // Saved chats for the sidebar (ChatIndex), read from chats.json on first use.
  roar::AttachQueue claude_attach_;  // Tabs to attach to sessions New/Chat just started, by folder.
  // Starts the chosen agent CLI in |dir| (claude-ctl new); queues |tab| to attach once it reports,
  // and opens its full view when |open_view|. |done| gets claude-ctl's reply.
  void AgentStart(const std::string& dir, const std::string& prompt, std::vector<int> tabs, bool open_view,
                  std::function<void(const std::string&)> done = nullptr);
  void AgentScratch(const std::string& prompt, std::vector<int> tabs, bool open_view,
                    std::function<void(const std::string&)> done = nullptr);  // AgentStart in a new <data>/scratch folder.  // Any agent CLI's hooks installed.
  std::string agent_hooks_;  // roar-mcp agent-hooks status output: "<tool> <state>" lines.
  void SetAgentHooks(const std::string& out);
  // A CLI whose hooks are installed (current or outdated). Before the first status, every CLI counts.
  bool AgentConnected(const std::string& tool) const;
  // A sidebar card when a set-up CLI isn't connected or its hooks point at another Roar; snoozable.
  void CheckAgentHooks();
  int hook_card_ = 0;
  bool hooks_repaired_ = false;  // Outdated hooks were repointed at this Roar once this run.
  std::string agentmd_cache_;  // agentmd.list's last walk, for the sidebar's recent files.
  double agentmd_cache_at_ = 0;
  void MaybeQuit();

  CefRefPtr<Client> client_;
  std::vector<std::unique_ptr<Win>> wins_;
  Win none_;  // win_ before the first window and after the last one closes: a null shell.
  Win* win_ = &none_;
  int next_win_ = 1;
  int focused_win_ = 0;  // The window the person last activated.
  bool quitting_ = false;  // Quit: closing a shell quits instead of closing one window.
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
  std::set<int> stray_seen_;  // Browsers outside Roar whose first address was seen.
  std::vector<CefRefPtr<CefBrowser>> strays_held_;  // Strays a CDP client was attached to; PollDriven retries them.
  // Alerts agents sent through the MCP server (notify_user / ask_user), this session only.
  struct AgentAlert {
    int id = 0;
    std::string title, body, level, url, agent;
    int space = -1;        // The agent's space at the time; Open puts the URL there.
    std::string key;       // ask_user's id from the MCP server, for agent.expire.
    std::string session;   // The agent session a done card came from (hook cards); Reply types into it.
    int pid = 0;           // notify_user's agent pid; the sidebar matches it to a session's term.pid.
    std::string owner;     // The roar-mcp connection's pid: its cards go when it ends, and its newer card supersedes them.
    std::string chat;      // The agent's folder name, when the sidebar finds no session for |pid|.
    double until = 0;      // When the card clears itself; 0: it waits (ask_user, Roar's own cards).
    bool auto_done = false;  // A done card the sidebar clears after auto_secs on screen (Settings > Notifications).
    int auto_secs = 0;
    std::vector<std::string> choices;
    double time = 0;
    CefRefPtr<Callback> answer;  // ask_user waits on this until the user picks.
    std::function<void(const std::string&)> on_answer;  // Roar's own cards (default browser).
  };
  std::vector<AgentAlert> agent_alerts_;
  int next_alert_id_ = 1;
  void ResolveAlert(int id, const std::string& result);
  void CapDoneCard(int id);
 public:
  static bool UiCdpForTests();
  void PaneNav(int tab, bool forward);
  bool ForeignUiNavigation(CefRefPtr<CefBrowser> browser, const std::string& url);
 private:
  // Split view pairs: each pair of tabs shows side by side whenever either is active.
  struct SplitPair { int a = 0, b = 0; bool stacked = false; double ratio = 0.5; };
  std::vector<SplitPair> splits_;
  SplitPair* SplitOf(int id);
  void SetSplitRatio(double ratio);
  bool Pair(int a, int b, bool stacked);  // Takes both tabs out of any other pair first.
  void Unsplit(int id);  // Separates the pair holding |id|; 0 = the pair on screen.
  void SyncDivider();
  void SyncPaneNav(Tab* tab);
  void AskDefaultBrowser();
  void TimeAlert(AgentAlert& a, const NotifyPref& p);  // Sets how |a| clears itself (NotifyTiming).
 public:
  // An opt-in notification of |type| (notify_prefs.h): a sidebar card, and a macOS one while Roar is in the background.
  void Notice(const std::string& type, const std::string& title, const std::string& body);
 private:
  void SyncAlertBadge();
  void ClaudeAlert(CefRefPtr<CefDictionaryValue> d);
  std::map<std::string, int> claude_cards_;  // Session id -> its needs-you/done sidebar card.
  // One roar-mcp connection's space for its next createTarget (agent.space); used once.
  bool sidebar_push_pending_ = false;
  std::map<std::string, std::pair<std::filesystem::file_time_type, CefRefPtr<CefDictionaryValue>>> claude_files_;  // ClaudeTick: session file -> mtime, parsed.
  std::map<std::string, std::string> mcp_tokens_;  // roar-mcp owner pid -> the token it got from agent.hello.
  std::map<std::string, int> claude_idle_gen_;  // Per session, bumped on every state change: a stale close-pages timer does nothing.
  std::string cdp_token_;  // This launch's CDP token (<data>/cdp-token); agent.hello must present it.
  struct TargetClaim { std::string owner; int space = -1; double expires = 0; std::string group; } target_claim_;  // group: tab group name, made if missing.
  int AgentGroup(int space, const std::string& name);  // The space's group of that name, made unpinned if missing.
  void ReleaseAgentPages(const std::string& owner);  // Closes the tabs that connection opened.
  bool cdp_on_ = false;                 // Whether the CDP HTTP port is listening now.
  std::unique_ptr<DictationEngine> dictation_;  // roar-dictate, started on first use.
  int dictation_gen_ = 0;               // Lines from an engine that was since stopped are dropped.
  bool dictation_ready_ = false, dictation_want_start_ = false;
  std::string dictation_state_ = "idle", dictation_detail_;  // idle, downloading, preparing, loading, listening, transcribing, error
  double dictation_progress_ = 0;
  void DictationEnsure();
  void DictationSet(const std::string& state, const std::string& detail = "");
  void (*cdp_http_)(int port) = nullptr;  // Roar's CEF patch: opens (port) or closes (0) it live.
  void SetCdp(bool on);
  int gmail_refresh_gen_ = 0;  // Debounces refreshes while the mail tab navigates.
  int command_height_ = 0;
  bool command_new_tab_ = true;
  bool command_ghost_ = false;  // The command bar opens a ghost tab.
  bool command_visible_ = false;
  bool sidebar_drag_poll_ = false;
  bool save_pending_ = false;
  bool pages_save_pending_ = false;
  bool closing_ = false;
  int hint_generation_ = 0;
  int live_browsers_ = 0;
  std::map<int, CefRefPtr<CefBrowser>> browsers_;  // Every live browser, Roar's or not.

  struct PendingExtract {
    int tab_id;
    std::string target;
    std::string prompt;  // claude: typed after the page's @-mention, then Enter.
  };
  std::map<std::string, PendingExtract> extracts_;
  std::map<int, std::string> mail_acts_;  // Tab id -> Gmail action (delete/read/move) to run once its thread loads.
  // One off-screen Gmail inbox per "<space> /mail/u/N": delete and mark read run there,
  // one action at a time, so the user's tabs never change.
  struct MailPage {
    CefRefPtr<CefBrowser> browser;
    bool created = false, loading = true, busy = false;
    std::deque<std::string> queue;  // "<action> <ids>"
    double last = 0;                // Last use; idle pages close after kMailPageIdleSecs.
    double run_at = 0;              // When the running action started.
  };
  std::map<std::string, MailPage> mail_pages_;
  friend void CloseIdleMailPage(const std::string& key);
  MailPage* MailPageOf(CefRefPtr<CefBrowser> browser);
  void WarmMailPage(int space, const std::string& account);
  void RunMailPage(MailPage& page);
  std::map<int, std::string> llm_fills_;
  std::string next_ask_llm_;  // The AI name the next NewTab is an Ask for (ExtractActive sets it).
  std::map<std::string, CefRefPtr<Callback>> chat_tabs_;  // "chat:<nonce>" extract target -> chat.tab query.  // Tab id -> text to put in its chat box.
  struct PendingIndex {
    int tab_id;
    std::string url;  // The page the nonce was issued to.
  };
  std::map<std::string, PendingIndex> indexes_;
  std::map<int, CefRefPtr<CefRequestContext>> contexts_;
  std::set<int> ready_spaces_;  // Spaces whose profile has finished loading.
  StartTab start_tab_;  // The launch start tab, until used (start_tab.h).
};

}  // namespace roar
