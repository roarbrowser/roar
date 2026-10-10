#include "controller.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <set>

#include "include/base/cef_callback.h"
#include "include/cef_app.h"
#include "include/cef_parser.h"
#include "include/views/cef_box_layout.h"
#include "include/views/cef_display.h"
#include "include/views/cef_fill_layout.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/wrapper/cef_helpers.h"

#include "client.h"
#include "mac/platform.h"
#include "shared.h"
#include "state.h"

namespace roar {

namespace {

constexpr int kSidebarWidth = 268;
constexpr int kCommandBarWidth = 680;
constexpr int kCommandBarHeight = 440;
constexpr int kHintWidth = 420;
constexpr int kHintHeight = 44;
constexpr int kGutter = 8;
constexpr char kNewTabUrl[] = "roar://ui/newtab.html";
constexpr char kWelcomeUrl[] = "roar://ui/welcome.html";

std::string Lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
  return s;
}

bool StartsWith(const std::string& s, const std::string& p) { return s.rfind(p, 0) == 0; }

std::string ToJson(CefRefPtr<CefValue> v) { return CefWriteJSON(v, JSON_WRITER_DEFAULT); }

CefRefPtr<CefValue> Wrap(CefRefPtr<CefDictionaryValue> d) {
  auto v = CefValue::Create();
  v->SetDictionary(d);
  return v;
}

CefRefPtr<CefValue> Wrap(CefRefPtr<CefListValue> l) {
  auto v = CefValue::Create();
  v->SetList(l);
  return v;
}

std::string JsString(const std::string& s) {
  auto v = CefValue::Create();
  v->SetString(s);
  return ToJson(v);
}

// Delegate for the sidebar, command bar and hint views (Alloy style).
class UiViewDelegate : public CefBrowserViewDelegate {
 public:
  cef_runtime_style_t GetBrowserRuntimeStyle() override { return CEF_RUNTIME_STYLE_ALLOY; }

 private:
  IMPLEMENT_REFCOUNTING(UiViewDelegate);
};

// Delegate for web tabs. Chrome style keeps extensions and DevTools working.
class TabViewDelegate : public CefBrowserViewDelegate {
 public:
  cef_runtime_style_t GetBrowserRuntimeStyle() override { return CEF_RUNTIME_STYLE_CHROME; }
  bool OnGestureCommand(CefRefPtr<CefBrowserView> view,
                        cef_gesture_command_t command) override {
    return Controller::Get()->OnGesture(view, command);
  }
  bool UseFramelessWindowForPictureInPicture(CefRefPtr<CefBrowserView> view) override {
    return true;
  }
  bool AllowMoveForPictureInPicture(CefRefPtr<CefBrowserView> view) override { return true; }

 private:
  IMPLEMENT_REFCOUNTING(TabViewDelegate);
};

// Fixed-width holder for the sidebar. The height is 1 because CEF treats a
// size with a zero dimension as "no preference"; the box layout stretches it.
class FixedWidthDelegate : public CefPanelDelegate {
 public:
  explicit FixedWidthDelegate(int width) : width_(width) {}
  CefSize GetPreferredSize(CefRefPtr<CefView> view) override { return CefSize(width_, 1); }

 private:
  int width_;
  IMPLEMENT_REFCOUNTING(FixedWidthDelegate);
};

class ShellDelegate : public CefWindowDelegate {
 public:
  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override {
    Controller::Get()->OnShellDestroyed();
  }
  bool CanClose(CefRefPtr<CefWindow> window) override {
    return Controller::Get()->CanCloseShell();
  }
  void OnWindowBoundsChanged(CefRefPtr<CefWindow> window, const CefRect& bounds) override {
    Controller::Get()->Relayout();
  }
  CefRect GetInitialBounds(CefRefPtr<CefWindow> window) override {
    CefRect work = CefDisplay::GetPrimaryDisplay()->GetWorkArea();
    int w = std::min(1440, work.width - 80);
    int h = std::min(940, work.height - 60);
    return CefRect(work.x + (work.width - w) / 2, work.y + (work.height - h) / 2, w, h);
  }
  CefSize GetMinimumSize(CefRefPtr<CefView> view) override { return CefSize(720, 480); }
  bool IsFrameless(CefRefPtr<CefWindow> window) override { return true; }
  bool WithStandardWindowButtons(CefRefPtr<CefWindow> window) override { return true; }
  bool GetTitlebarHeight(CefRefPtr<CefWindow> window, float* height) override {
    *height = 44;
    return true;
  }
  cef_runtime_style_t GetWindowRuntimeStyle() override { return CEF_RUNTIME_STYLE_ALLOY; }

 private:
  IMPLEMENT_REFCOUNTING(ShellDelegate);
};

// A frameless Chrome-style window that holds exactly one tab.
class TabWindowDelegate : public CefWindowDelegate {
 public:
  TabWindowDelegate(CefRefPtr<CefBrowserView> view, CefRect bounds)
      : view_(view), bounds_(bounds) {}
  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    window->SetToFillLayout();
    window->AddChildView(view_);
    view_ = nullptr;
    Controller::Get()->OnTabWindowCreated(window);
  }
  bool CanClose(CefRefPtr<CefWindow> window) override {
    return Controller::Get()->CanCloseTabWindow(window);
  }
  void OnWindowActivationChanged(CefRefPtr<CefWindow> window, bool active) override {
    if (active) Controller::Get()->OnTabWindowActivated(window);
  }
  CefRect GetInitialBounds(CefRefPtr<CefWindow> window) override { return bounds_; }
  bool IsFrameless(CefRefPtr<CefWindow> window) override { return true; }
  bool WithStandardWindowButtons(CefRefPtr<CefWindow> window) override { return false; }
  bool CanMinimize(CefRefPtr<CefWindow> window) override { return false; }
  bool CanMaximize(CefRefPtr<CefWindow> window) override { return false; }
  cef_runtime_style_t GetWindowRuntimeStyle() override { return CEF_RUNTIME_STYLE_CHROME; }

 private:
  CefRefPtr<CefBrowserView> view_;
  CefRect bounds_;
  IMPLEMENT_REFCOUNTING(TabWindowDelegate);
};

// A frameless Alloy-style window for the command bar or the hint toast.
class PopupDelegate : public CefWindowDelegate {
 public:
  explicit PopupDelegate(CefRefPtr<CefBrowserView> view) : view_(view) {}
  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    window->SetToFillLayout();
    window->AddChildView(view_);
    view_ = nullptr;
  }
  bool CanClose(CefRefPtr<CefWindow> window) override { return true; }
  CefRect GetInitialBounds(CefRefPtr<CefWindow> window) override { return CefRect(0, 0, 400, 60); }
  bool IsFrameless(CefRefPtr<CefWindow> window) override { return true; }
  bool WithStandardWindowButtons(CefRefPtr<CefWindow> window) override { return false; }
  bool CanResize(CefRefPtr<CefWindow> window) override { return false; }
  bool CanMinimize(CefRefPtr<CefWindow> window) override { return false; }
  bool CanMaximize(CefRefPtr<CefWindow> window) override { return false; }
  cef_runtime_style_t GetWindowRuntimeStyle() override { return CEF_RUNTIME_STYLE_ALLOY; }

 private:
  CefRefPtr<CefBrowserView> view_;
  IMPLEMENT_REFCOUNTING(PopupDelegate);
};

// Reports the title of the history entry a swipe will land on.
class NeighborVisitor : public CefNavigationEntryVisitor {
 public:
  explicit NeighborVisitor(int offset) : offset_(offset) {}
  bool Visit(CefRefPtr<CefNavigationEntry> entry, bool current, int index, int total) override {
    if (current) current_ = index;
    titles_.push_back(entry->GetTitle().ToString().empty() ? entry->GetDisplayURL().ToString()
                                                           : entry->GetTitle().ToString());
    return true;
  }
  std::string Target() const {
    int i = current_ + offset_;
    return (current_ >= 0 && i >= 0 && i < static_cast<int>(titles_.size())) ? titles_[i] : "";
  }

 private:
  int offset_;
  int current_ = -1;
  std::vector<std::string> titles_;
  IMPLEMENT_REFCOUNTING(NeighborVisitor);
};

// Turns command bar text into a URL: explicit schemes pass through, things
// that look like hosts get https://, everything else becomes a search.
std::string ResolveInput(const std::string& raw) {
  std::string text = raw;
  text.erase(0, text.find_first_not_of(" \t\n"));
  text.erase(text.find_last_not_of(" \t\n") + 1);
  if (text.empty()) return "";
  static const char* kSchemes[] = {"http://", "https://", "file://", "chrome://", "roar://",
                                   "about:", "data:", "view-source:", "chrome-extension://"};
  for (const char* s : kSchemes)
    if (StartsWith(Lower(text), s)) return text;
  bool has_space = text.find(' ') != std::string::npos;
  std::string host = text.substr(0, text.find_first_of("/?#"));
  bool hostish = !has_space && (host.find('.') != std::string::npos ||
                                StartsWith(host, "localhost") ||
                                host.find(':') != std::string::npos) &&
                 host.back() != '.';
  if (hostish) return "https://" + text;
  return State::Get().settings.search_url + CefURIEncode(text, true).ToString();
}

CefRefPtr<CefBrowserView> CreateUiView(CefRefPtr<CefClient> client, const std::string& page) {
  return CefBrowserView::CreateBrowserView(client, std::string(kUiOrigin) + page,
                                           CefBrowserSettings(), nullptr, nullptr,
                                           new UiViewDelegate());
}

}  // namespace

Controller* Controller::Get() {
  static Controller* controller = new Controller();
  return controller;
}

void Controller::Start() {
  CEF_REQUIRE_UI_THREAD();
  client_ = new Client();
  State& state = State::Get();
  state.Load();
  platform::InstallMenu();

  shell_ = CefWindow::CreateTopLevelWindow(new ShellDelegate());
  shell_->SetTitle("Roar");
  CefBoxLayoutSettings box;
  box.horizontal = true;
  layout_ = shell_->SetToBoxLayout(box);
  sidebar_panel_ = CefPanel::CreatePanel(new FixedWidthDelegate(kSidebarWidth));
  sidebar_panel_->SetToFillLayout();
  sidebar_ = CreateUiView(client_, "sidebar.html");
  sidebar_panel_->AddChildView(sidebar_);
  shell_->AddChildView(sidebar_panel_);
  layout_->SetFlexForView(sidebar_panel_, 0);
  // The rest of the shell is the backdrop the tab windows sit on.
  auto backdrop = CefPanel::CreatePanel(nullptr);
  shell_->AddChildView(backdrop);
  layout_->SetFlexForView(backdrop, 1);
  shell_->Show();

  command_bar_ = CreateUiView(client_, "command.html");
  command_window_ = CefWindow::CreateTopLevelWindow(new PopupDelegate(command_bar_));
  platform::StyleWindow(command_window_->GetWindowHandle(), 14, true);
  hint_ = CreateUiView(client_, "hint.html");
  hint_window_ = CefWindow::CreateTopLevelWindow(new PopupDelegate(hint_));
  platform::StyleWindow(hint_window_->GetWindowHandle(), 22, true);
  platform::SetIgnoresMouse(hint_window_->GetWindowHandle(), true);

  for (const auto& saved : state.tabs)
    NewTab(saved.url, false, saved.pinned, saved.last_active, saved.space);
  if (!state.settings.onboarded) {
    ActivateTab(NewTab(kWelcomeUrl, false));
  } else if (tabs_.empty()) {
    ActivateTab(NewTab(kNewTabUrl, false));
  } else {
    int index = std::clamp(state.active_index, 0, static_cast<int>(tabs_.size()) - 1);
    ActivateTab(tabs_[index].id);
  }

  AutoArchiveTick();
  GitHubTick();
}

void Controller::Focus() {
  if (!shell_) return;
  shell_->Show();
  shell_->Activate();
  FocusTab(ActiveTab());
}

void Controller::Quit() {
  if (shell_) shell_->Close();
}

// ---------------------------------------------------------------------------
// Tabs

int Controller::NewTab(const std::string& url, bool activate, bool pinned, double last_active,
                       int space) {
  CEF_REQUIRE_UI_THREAD();
  Tab tab;
  tab.id = next_id_++;
  tab.space = space < 0 || !State::Get().FindSpace(space) ? State::Get().active_space : space;
  tab.url = url.empty() ? kNewTabUrl : url;
  tab.title = tab.url;
  tab.pinned = pinned;
  tab.last_active = last_active > 0 ? last_active : NowSeconds();
  if (auto it = State::Get().history.find(tab.url); it != State::Get().history.end())
    tab.title = it->second.title.empty() ? tab.url : it->second.title;
  // The browser is created with the tab's window, on first activation.
  tab.view = CreateTabView(tab.url, tab.space);
  // New tabs open beside the active one, after any pinned tabs.
  auto pos = tabs_.end();
  if (auto* active = ActiveTab(); active && !pinned && active->space == tab.space) {
    pos = std::find_if(tabs_.begin(), tabs_.end(),
                       [&](const Tab& t) { return t.id == active->id; }) + 1;
  }
  tabs_.insert(pos, tab);
  if (activate) ActivateTab(tab.id);
  PushSidebar();
  SaveSoon();
  return tab.id;
}

CefRect Controller::ContentRect() {
  CefRect r = shell_ ? shell_->GetBounds() : CefRect();
  int left = sidebar_visible_ ? kSidebarWidth : kGutter;
  int top = sidebar_visible_ ? kGutter : 40;  // Clear the traffic lights.
  return CefRect(r.x + left, r.y + top, std::max(0, r.width - left - kGutter),
                 std::max(0, r.height - top - kGutter));
}

std::vector<int> Controller::VisibleIds() {
  if (split_a_ && split_b_ && (active_id_ == split_a_ || active_id_ == split_b_))
    return {split_a_, split_b_};
  if (active_id_) return {active_id_};
  return {};
}

bool Controller::IsVisible(int id) {
  auto v = VisibleIds();
  return std::find(v.begin(), v.end(), id) != v.end();
}

// The content rect, halved with a gutter between the panes in split view.
CefRect Controller::RectFor(int id) {
  CefRect r = ContentRect();
  auto v = VisibleIds();
  if (v.size() < 2) return r;
  int half = (r.width - kGutter) / 2;
  if (id == v[0]) return CefRect(r.x, r.y, half, r.height);
  return CefRect(r.x + half + kGutter, r.y, r.width - half - kGutter, r.height);
}

// Shows the visible tabs' windows over the shell and hides every other one.
void Controller::SyncWindows() {
  if (!shell_) return;
  for (auto& t : tabs_) {
    if (t.floating) continue;
    if (IsVisible(t.id)) ShowTabWindow(&t);
    else HideTabWindow(&t);
  }
}

CefRefPtr<CefRequestContext> Controller::ContextFor(int space) {
  if (space == 0) return nullptr;  // The default profile.
  auto& ctx = contexts_[space];
  if (!ctx) {
    CefRequestContextSettings settings;
    CefString(&settings.cache_path) = State::Get().Dir() + "/Spaces/" + std::to_string(space);
    settings.persist_session_cookies = true;
    ctx = CefRequestContext::CreateContext(settings, nullptr);
  }
  return ctx;
}

CefRefPtr<CefBrowserView> Controller::CreateTabView(const std::string& url, int space) {
  return CefBrowserView::CreateBrowserView(client_, url, CefBrowserSettings(), nullptr,
                                           ContextFor(space), new TabViewDelegate());
}

void Controller::ShowTabWindow(Tab* tab) {
  if (!tab->window) {
    // OnTabWindowCreated attaches it once CEF has built the window.
    tab->window =
        CefWindow::CreateTopLevelWindow(new TabWindowDelegate(tab->view, RectFor(tab->id)));
    return;
  }
  tab->window->SetBounds(RectFor(tab->id));
  platform::AttachChild(shell_->GetWindowHandle(), tab->window->GetWindowHandle());
}

void Controller::HideTabWindow(Tab* tab) {
  if (tab && tab->window && !tab->floating)
    platform::DetachChild(shell_->GetWindowHandle(), tab->window->GetWindowHandle());
}

void Controller::OnTabWindowCreated(CefRefPtr<CefWindow> window) {
  platform::StyleWindow(window->GetWindowHandle(), 10, false);
  Tab* tab = FindTabByWindow(window);
  if (!tab || tab->floating || !IsVisible(tab->id)) return;
  window->SetBounds(RectFor(tab->id));
  window->Show();
  platform::AttachChild(shell_->GetWindowHandle(), window->GetWindowHandle());
  if (tab->id == active_id_) FocusTab(tab);
}

// Clicking into the other split pane makes that tab the active one.
void Controller::OnTabWindowActivated(CefRefPtr<CefWindow> window) {
  Tab* tab = FindTabByWindow(window);
  if (!tab || tab->floating || tab->id == active_id_ || !IsVisible(tab->id)) return;
  if (Tab* old = ActiveTab()) old->last_active = NowSeconds();
  active_id_ = tab->id;
  tab->last_active = NowSeconds();
  shell_->SetTitle(tab->title.empty() ? "Roar" : tab->title);
  PushSidebar();
  SaveSoon();
}

void Controller::FocusTab(Tab* tab) {
  if (!tab || !tab->window) return;
  tab->window->Activate();
  tab->view->RequestFocus();
  if (auto browser = tab->view->GetBrowser()) browser->GetHost()->SetFocus(true);
}

void Controller::ActivateTab(int id) {
  Tab* tab = FindTab(id);
  if (!tab || !shell_) return;
  if (tab->floating) return DockTab(id);
  if (Tab* old = ActiveTab()) old->last_active = NowSeconds();
  // In split view, a tab picked from the same space replaces the focused pane.
  bool in_split = split_a_ && (active_id_ == split_a_ || active_id_ == split_b_);
  if (in_split && id != split_a_ && id != split_b_ && ActiveTab()->space == tab->space)
    (active_id_ == split_a_ ? split_a_ : split_b_) = id;
  active_id_ = id;
  State::Get().active_space = tab->space;
  tab->last_active = NowSeconds();
  SyncWindows();
  FocusTab(tab);
  shell_->SetTitle(tab->title.empty() ? "Roar" : tab->title);
  PushSidebar();
  SaveSoon();
}

void Controller::Relayout() {
  if (!shell_) return;
  CefRect area = ContentRect();
  for (int id : VisibleIds())
    if (Tab* t = FindTab(id); t && t->window && !t->floating) t->window->SetBounds(RectFor(id));
  if (command_window_ && command_visible_) {
    int w = std::min(kCommandBarWidth, std::max(area.width - 48, 320));
    int h = command_height_ > 0 ? command_height_ : kCommandBarHeight;
    command_window_->SetBounds(CefRect(area.x + (area.width - w) / 2, area.y + 72, w, h));
  }
  if (hint_window_) {
    int w = std::min(kHintWidth, area.width - 32);
    hint_window_->SetBounds(CefRect(area.x + (area.width - w) / 2,
                                    area.y + area.height - kHintHeight - 24, w, kHintHeight));
  }
}

void Controller::CloseTab(int id) {
  auto it = std::find_if(tabs_.begin(), tabs_.end(), [&](const Tab& t) { return t.id == id; });
  if (it == tabs_.end()) return;
  Tab tab = *it;
  size_t index = it - tabs_.begin();
  tabs_.erase(it);
  if (id == split_a_ || id == split_b_) split_a_ = split_b_ = 0;
  // Removed from tabs_ first, so CanCloseTabWindow lets the window go.
  if (tab.window) {
    platform::DetachChild(shell_->GetWindowHandle(), tab.window->GetWindowHandle());
    tab.window->Close();
  }
  if (active_id_ == id) {
    active_id_ = 0;
    // Prefer the next tab in the same space, then the previous one.
    auto usable = [&](const Tab& t) { return t.space == tab.space && !t.floating; };
    Tab* next = nullptr;
    for (size_t i = index; i < tabs_.size() && !next; ++i)
      if (usable(tabs_[i])) next = &tabs_[i];
    for (size_t i = std::min(index, tabs_.size()); i-- > 0 && !next;)
      if (usable(tabs_[i])) next = &tabs_[i];
    if (next) {
      ActivateTab(next->id);
    } else {
      ActivateTab(NewTab(kNewTabUrl, false, false, 0, tab.space));
      ShowCommandBar(false);
    }
  } else {
    SyncWindows();
  }
  PushSidebar();
  SaveSoon();
}

bool Controller::CanCloseTabWindow(CefRefPtr<CefWindow> window) {
  if (closing_) return true;
  Tab* tab = FindTabByWindow(window);
  if (!tab) return true;  // Already removed by CloseTab.
  // A floating tab's close button docks it back into the shell.
  int id = tab->id;
  CefPostTask(TID_UI, base::BindOnce([](int id) {
                Controller* c = Controller::Get();
                if (Tab* t = c->FindTab(id); t && t->floating) c->DockTab(id);
                else c->CloseTab(id);
              }, id));
  return false;
}

void Controller::Navigate(int id, const std::string& url) {
  Tab* tab = FindTab(id);
  if (!tab || url.empty()) return;
  tab->url = url;
  if (auto browser = tab->view->GetBrowser()) {
    browser->GetMainFrame()->LoadURL(url);
  } else if (!tab->window) {
    // Not created yet: start it at the new address instead.
    tab->view = CreateTabView(url, tab->space);
  }
  PushSidebar();
}

void Controller::SetPinned(int id, bool pinned) {
  auto it = std::find_if(tabs_.begin(), tabs_.end(), [&](const Tab& t) { return t.id == id; });
  if (it == tabs_.end()) return;
  Tab tab = *it;
  tab.pinned = pinned;
  tabs_.erase(it);
  // Pinned tabs live together at the front of the list.
  auto end_of_pinned =
      std::find_if(tabs_.begin(), tabs_.end(), [](const Tab& t) { return !t.pinned; });
  tabs_.insert(end_of_pinned, tab);
  PushSidebar();
  SaveSoon();
}

bool Controller::ExecuteScript(int id, const std::string& code) {
  Tab* tab = FindTab(id);
  if (!tab) return false;
  auto browser = tab->view->GetBrowser();
  if (!browser) return false;
  browser->GetMainFrame()->ExecuteJavaScript(code, browser->GetMainFrame()->GetURL(), 0);
  return true;
}

Tab* Controller::FindTab(int id) {
  for (auto& t : tabs_)
    if (t.id == id) return &t;
  return nullptr;
}

Tab* Controller::FindTabByBrowser(CefRefPtr<CefBrowser> browser) {
  if (!browser) return nullptr;
  for (auto& t : tabs_) {
    auto b = t.view->GetBrowser();
    if (b && b->IsSame(browser)) return &t;
  }
  return nullptr;
}

Tab* Controller::FindTabByWindow(CefRefPtr<CefWindow> window) {
  for (auto& t : tabs_)
    if (t.window && t.window->IsSame(window)) return &t;
  return nullptr;
}

bool Controller::IsUiBrowser(CefRefPtr<CefBrowser> browser) const {
  for (const auto& view : {sidebar_, command_bar_, hint_}) {
    auto b = view ? view->GetBrowser() : nullptr;
    if (b && b->IsSame(browser)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Commands

void Controller::ShowCommandBar(bool new_tab) {
  if (!command_window_) return;
  command_new_tab_ = new_tab;
  command_visible_ = true;
  Relayout();
  std::string url;
  if (Tab* tab = ActiveTab(); tab && !new_tab && !StartsWith(tab->url, "roar://")) url = tab->url;
  command_window_->Show();
  platform::AttachChild(shell_->GetWindowHandle(), command_window_->GetWindowHandle());
  command_window_->Activate();
  if (auto browser = command_bar_->GetBrowser()) {
    browser->GetMainFrame()->ExecuteJavaScript(
        "window.roar && roar.open(" + std::string(new_tab ? "true" : "false") + "," +
            JsString(url) + ")",
        "", 0);
    command_bar_->RequestFocus();
    browser->GetHost()->SetFocus(true);
  }
}

void Controller::HideCommandBar() {
  if (!command_window_ || !command_visible_) return;
  command_visible_ = false;
  platform::DetachChild(shell_->GetWindowHandle(), command_window_->GetWindowHandle());
  FocusTab(ActiveTab());
}

void Controller::ShowHint(const std::string& text) {
  if (!hint_window_ || text.empty()) return;
  Relayout();
  if (auto browser = hint_->GetBrowser())
    browser->GetMainFrame()->ExecuteJavaScript("window.roar && roar.show(" + JsString(text) + ")",
                                               "", 0);
  platform::AttachChild(shell_->GetWindowHandle(), hint_window_->GetWindowHandle());
  int generation = ++hint_generation_;
  CefPostDelayedTask(TID_UI, base::BindOnce([](int gen) {
                       auto* c = Controller::Get();
                       if (c->hint_generation_ == gen && c->hint_window_ && c->shell_)
                         platform::DetachChild(c->shell_->GetWindowHandle(),
                                               c->hint_window_->GetWindowHandle());
                     }, generation),
                     2200);
}

void Controller::ArchiveTab(int id) {
  Tab* tab = FindTab(id);
  if (!tab) return;
  State::Get().AddArchived(tab->url, tab->title);
  CloseTab(id);
}

void Controller::CleanTabs() {
  std::vector<int> ids;
  for (const auto& t : tabs_)
    if (!t.pinned && !IsVisible(t.id) && !t.floating && t.space == State::Get().active_space)
      ids.push_back(t.id);
  for (int id : ids) ArchiveTab(id);
  ShowHint(ids.empty() ? "Nothing to clean up"
                       : "Archived " + std::to_string(ids.size()) +
                             (ids.size() == 1 ? " tab" : " tabs"));
}

void Controller::AutoArchiveTick() {
  double hours = State::Get().settings.archive_after_hours;
  if (hours > 0) {
    double cutoff = NowSeconds() - hours * 3600;
    std::vector<int> ids;
    for (const auto& t : tabs_)
      if (!t.pinned && !IsVisible(t.id) && !t.floating && t.last_active < cutoff)
        ids.push_back(t.id);
    for (int id : ids) ArchiveTab(id);
  }
  PushSidebar();  // Refreshes the cooling bars.
  CefPostDelayedTask(TID_UI, base::BindOnce([] { Controller::Get()->AutoArchiveTick(); }),
                     60 * 1000);
}

void Controller::RestoreArchived(size_t index) {
  auto& archive = State::Get().archive;
  if (index >= archive.size()) return;
  ArchivedTab item = archive[index];
  archive.erase(archive.begin() + index);
  NewTab(item.url, true);
}

void Controller::ExtractActive(bool save) {
  Tab* tab = ActiveTab();
  if (!tab || !tab->view->GetBrowser()) return;
  if (!StartsWith(tab->url, "http")) {
    ShowHint("Open a web page first");
    return;
  }
  std::string nonce = platform::RandomToken();
  extracts_[nonce] = {tab->id, save};
  std::string script = platform::ReadResource("ui/extract.js");
  ExecuteScript(tab->id, script + "\n;window.__roarExtract && window.__roarExtract(" +
                             JsString(nonce) + ");");
}

void Controller::PictureInPicture() {
  Tab* tab = ActiveTab();
  auto browser = tab ? tab->view->GetBrowser() : nullptr;
  if (!browser) return;
  // Runtime.evaluate with userGesture satisfies the API's activation rule.
  static const char kScript[] = R"JS((async () => {
    // Look in the page and any same-origin frames.
    const docs = [document];
    for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch {} }
    for (const d of docs) if (d.pictureInPictureElement) { await d.exitPictureInPicture(); return 'exit'; }
    const videos = docs.flatMap(d => [...d.querySelectorAll('video')]).filter(v => v.readyState > 0);
    if (!videos.length) return 'none';
    const area = v => { const r = v.getBoundingClientRect(); return r.width * r.height; };
    const pick = videos.find(v => !v.paused) || videos.sort((a, b) => area(b) - area(a))[0];
    await pick.requestPictureInPicture();
    return 'enter';
  })())JS";
  auto params = CefDictionaryValue::Create();
  params->SetString("expression", kScript);
  params->SetBool("userGesture", true);
  params->SetBool("awaitPromise", true);
  browser->GetHost()->ExecuteDevToolsMethod(0, "Runtime.evaluate", params);
}

void Controller::FloatActiveTab() {
  Tab* tab = ActiveTab();
  if (!tab || !tab->window) return;
  bool others = std::any_of(tabs_.begin(), tabs_.end(), [&](const Tab& t) {
    return t.id != tab->id && !t.floating && t.space == tab->space;
  });
  int space = tab->space;
  int id = tab->id;
  platform::DetachChild(shell_->GetWindowHandle(), tab->window->GetWindowHandle());
  tab->floating = true;
  if (id == split_a_ || id == split_b_) split_a_ = split_b_ = 0;
  CefRect work = CefDisplay::GetDisplayMatchingBounds(shell_->GetBounds(), false)->GetWorkArea();
  tab->window->SetBounds(CefRect(work.x + work.width - 504, work.y + work.height - 344, 480, 320));
  platform::SetFloating(tab->window->GetWindowHandle(), true, tab->title);
  tab->window->Show();
  // Show something else in the shell.
  if (others) {
    for (const auto& t : tabs_)
      if (t.id != id && !t.floating && t.space == space) {
        ActivateTab(t.id);
        break;
      }
  } else {
    ActivateTab(NewTab(kNewTabUrl, false, false, 0, space));
  }
  ShowHint("Floating. Close the mini window to bring it back.");
}

void Controller::DockTab(int id) {
  Tab* tab = FindTab(id);
  if (!tab || !tab->floating) return;
  tab->floating = false;
  platform::SetFloating(tab->window->GetWindowHandle(), false, "");
  ActivateTab(id);
}

void Controller::Back() {
  if (Tab* t = ActiveTab(); t && t->view->GetBrowser()) t->view->GetBrowser()->GoBack();
}

void Controller::Forward() {
  if (Tab* t = ActiveTab(); t && t->view->GetBrowser()) t->view->GetBrowser()->GoForward();
}

void Controller::Reload() {
  if (Tab* t = ActiveTab(); t && t->view->GetBrowser()) t->view->GetBrowser()->Reload();
}

void Controller::OpenSettings() {
  for (const auto& t : tabs_)
    if (StartsWith(t.url, kWelcomeUrl)) return ActivateTab(t.id);
  NewTab(kWelcomeUrl, true);
}

void Controller::ToggleSidebar() {
  sidebar_visible_ = !sidebar_visible_;
  sidebar_panel_->SetVisible(sidebar_visible_);
  shell_->Layout();
  Relayout();
}

void Controller::RefreshGitHub() {
  State& state = State::Get();
  if (!state.settings.github_folder) return;
  platform::SearchGitHub(state.settings.github_query, [](std::string json, std::string error) {
    State& s = State::Get();
    s.github_status = error;
    if (error.empty()) {
      s.github_items.clear();
      auto root = CefParseJSON(json, JSON_PARSER_RFC);
      auto items = root && root->GetType() == VTYPE_DICTIONARY
                       ? root->GetDictionary()->GetList("items")
                       : nullptr;
      for (size_t i = 0; items && i < items->GetSize(); ++i) {
        auto it = items->GetDictionary(i);
        std::string repo = it->GetString("repository_url").ToString();
        repo = repo.substr(repo.find("/repos/") == std::string::npos ? 0 : repo.find("/repos/") + 7);
        int number = it->GetType("number") == VTYPE_INT ? it->GetInt("number")
                                                         : static_cast<int>(it->GetDouble("number"));
        s.github_items.push_back({it->GetString("title").ToString(),
                                  it->GetString("html_url").ToString(),
                                  repo + " #" + std::to_string(number)});
      }
    }
    Controller::Get()->PushSidebar();
  });
}

void Controller::GitHubTick() {
  RefreshGitHub();
  CefPostDelayedTask(TID_UI, base::BindOnce([] { Controller::Get()->GitHubTick(); }), 10 * 60 * 1000);
}

void Controller::SwitchSpace(int id) {
  State& state = State::Get();
  Space* space = state.FindSpace(id);
  if (!space) return;
  std::string name = space->name;
  HideCommandBar();
  Tab* best = nullptr;
  for (auto& t : tabs_)
    if (t.space == id && !t.floating && (!best || t.last_active > best->last_active)) best = &t;
  state.active_space = id;
  if (best) ActivateTab(best->id);
  else ActivateTab(NewTab(kNewTabUrl, false, false, 0, id));
  ShowHint(name);
}

void Controller::CycleSpace(int step) {
  const auto& spaces = State::Get().spaces;
  int n = static_cast<int>(spaces.size());
  for (int i = 0; i < n; ++i)
    if (spaces[i].id == State::Get().active_space)
      return SwitchSpace(spaces[((i + step) % n + n) % n].id);
}

int Controller::AddSpace(const std::string& name) {
  State& state = State::Get();
  int id = 0;
  for (const auto& s : state.spaces) id = std::max(id, s.id);
  ++id;
  state.spaces.push_back({id, name.empty() ? "Space " + std::to_string(state.spaces.size() + 1)
                                           : name});
  SaveSoon();
  SwitchSpace(id);
  return id;
}

void Controller::RenameSpace(int id, const std::string& name) {
  if (Space* s = State::Get().FindSpace(id); s && !name.empty()) {
    s->name = name.substr(0, 40);
    PushSidebar();
    SaveSoon();
  }
}

// Archives the space's tabs and forgets the space. Its profile stays on disk.
void Controller::RemoveSpace(int id) {
  State& state = State::Get();
  if (id == 0 || !state.FindSpace(id)) return;  // Space 0 is the default profile.
  if (state.active_space == id) SwitchSpace(0);
  std::vector<int> ids;
  for (const auto& t : tabs_)
    if (t.space == id) ids.push_back(t.id);
  for (int tab_id : ids) {
    if (Tab* t = FindTab(tab_id); t && t->floating) t->floating = false;
    ArchiveTab(tab_id);
  }
  state.spaces.erase(std::remove_if(state.spaces.begin(), state.spaces.end(),
                                    [&](const Space& s) { return s.id == id; }),
                     state.spaces.end());
  PushSidebar();
  SaveSoon();
}

void Controller::ToggleSplit() {
  Tab* tab = ActiveTab();
  if (!tab) return;
  int id = tab->id;
  if (split_a_ && (id == split_a_ || id == split_b_)) {
    split_a_ = split_b_ = 0;
    SyncWindows();
    FocusTab(ActiveTab());
    PushSidebar();
    return;
  }
  // Pair with the most recently used other tab in this space.
  Tab* other = nullptr;
  for (auto& t : tabs_)
    if (t.id != id && t.space == tab->space && !t.floating &&
        (!other || t.last_active > other->last_active))
      other = &t;
  int other_id = other ? other->id : NewTab(kNewTabUrl, false, false, 0, tab->space);
  split_a_ = id;
  split_b_ = other_id;
  SyncWindows();
  FocusTab(ActiveTab());
  PushSidebar();
}

void Controller::IndexPage(Tab* tab) {
  if (!State::Get().settings.index_pages || !StartsWith(tab->url, "http")) return;
  if (indexes_.size() > 200) indexes_.clear();  // Pages that never answered.
  std::string nonce = platform::RandomToken();
  indexes_[nonce] = tab->id;
  // Waits a moment so client-rendered pages have their text.
  ExecuteScript(tab->id, "(function(n){setTimeout(function(){try{"
                         "var t=(document.body&&document.body.innerText)||'';"
                         "window.roarQuery&&window.roarQuery({request:JSON.stringify("
                         "{cmd:'index.result',nonce:n,title:document.title,"
                         "text:t.replace(/\\s+/g,' ').slice(0,20000)})});"
                         "}catch(e){}},1500);})(" + JsString(nonce) + ");");
}

void Controller::SavePagesSoon() {
  if (pages_save_pending_ || closing_) return;
  pages_save_pending_ = true;
  CefPostDelayedTask(TID_UI, base::BindOnce([] {
                       Controller::Get()->pages_save_pending_ = false;
                       State::Get().SavePages();
                     }),
                     10 * 1000);
}

void Controller::RunCommand(const std::string& id) {
  if (id == "quit") Quit();
  else if (id == "clean") CleanTabs();
  else if (id == "copyMarkdown") ExtractActive(false);
  else if (id == "saveMarkdown") ExtractActive(true);
  else if (id == "pip") PictureInPicture();
  else if (id == "float") FloatActiveTab();
  else if (id == "back") Back();
  else if (id == "forward") Forward();
  else if (id == "reload") Reload();
  else if (id == "settings") OpenSettings();
  else if (id == "sidebar") ToggleSidebar();
  else if (id == "github") RefreshGitHub();
  else if (id == "extensions") NewTab("chrome://extensions", true);
  else if (id == "newTab") ShowCommandBar(true);
  else if (id == "closeTab") CloseTab(active_id_);
  else if (id == "reopen") { if (!State::Get().archive.empty()) RestoreArchived(0); }
  else if (id == "pin") { if (Tab* t = ActiveTab()) SetPinned(t->id, !t->pinned); }
  else if (id == "split") ToggleSplit();
  else if (id == "newSpace") AddSpace("");
  else if (id == "nextSpace") CycleSpace(1);
  else if (id == "prevSpace") CycleSpace(-1);
  else if (id == "forgetPages") {
    State::Get().pages.clear();
    State::Get().SavePages();
    ShowHint("Forgot saved page text");
  }
  else if (id == "devtools") {
    if (Tab* t = ActiveTab(); t && t->view->GetBrowser())
      t->view->GetBrowser()->GetHost()->ShowDevTools(CefWindowInfo(), nullptr, CefBrowserSettings(),
                                                     CefPoint());
  }
}

// ---------------------------------------------------------------------------
// State for the UI

std::string Controller::StateJson() {
  State& state = State::Get();
  double now = NowSeconds();
  auto root = CefDictionaryValue::Create();
  auto tabs = CefListValue::Create();
  size_t shown = 0;
  for (size_t i = 0; i < tabs_.size(); ++i) {
    const Tab& t = tabs_[i];
    if (t.space != state.active_space) continue;
    auto d = CefDictionaryValue::Create();
    d->SetInt("id", t.id);
    d->SetString("title", t.title);
    d->SetString("url", t.url);
    d->SetString("favicon", t.favicon);
    d->SetBool("pinned", t.pinned);
    d->SetBool("active", t.id == active_id_);
    d->SetBool("loading", t.loading);
    d->SetBool("floating", t.floating);
    d->SetBool("split", split_a_ && (t.id == split_a_ || t.id == split_b_));
    d->SetDouble("idleSeconds", t.id == active_id_ ? 0 : std::max(0.0, now - t.last_active));
    tabs->SetDictionary(shown++, d);
  }
  root->SetList("tabs", tabs);
  auto spaces = CefListValue::Create();
  for (size_t i = 0; i < state.spaces.size(); ++i) {
    auto d = CefDictionaryValue::Create();
    d->SetInt("id", state.spaces[i].id);
    d->SetString("name", state.spaces[i].name);
    d->SetInt("tabCount", static_cast<int>(std::count_if(
        tabs_.begin(), tabs_.end(), [&](const Tab& t) { return t.space == state.spaces[i].id; })));
    spaces->SetDictionary(i, d);
  }
  root->SetList("spaces", spaces);
  root->SetInt("activeSpace", state.active_space);
  root->SetBool("split", split_a_ && IsVisible(split_a_));
  auto archive = CefListValue::Create();
  for (size_t i = 0; i < std::min<size_t>(state.archive.size(), 60); ++i) {
    auto d = CefDictionaryValue::Create();
    d->SetString("title", state.archive[i].title);
    d->SetString("url", state.archive[i].url);
    d->SetDouble("archivedAt", state.archive[i].archived_at);
    archive->SetDictionary(i, d);
  }
  root->SetList("archive", archive);
  root->SetInt("archiveCount", static_cast<int>(state.archive.size()));
  auto gh = CefDictionaryValue::Create();
  gh->SetBool("enabled", state.settings.github_folder);
  gh->SetString("status", state.github_status);
  gh->SetString("query", state.settings.github_query);
  auto items = CefListValue::Create();
  for (size_t i = 0; i < state.github_items.size(); ++i) {
    auto d = CefDictionaryValue::Create();
    d->SetString("title", state.github_items[i].title);
    d->SetString("url", state.github_items[i].url);
    d->SetString("detail", state.github_items[i].detail);
    items->SetDictionary(i, d);
  }
  gh->SetList("items", items);
  root->SetDictionary("github", gh);
  auto settings = CefDictionaryValue::Create();
  settings->SetDouble("archiveAfterHours", state.settings.archive_after_hours);
  settings->SetBool("onboarded", state.settings.onboarded);
  settings->SetString("searchUrl", state.settings.search_url);
  settings->SetBool("indexPages", state.settings.index_pages);
  settings->SetInt("pageCount", static_cast<int>(state.pages.size()));
  settings->SetInt("cdpPort", platform::CdpPort());
  root->SetDictionary("settings", settings);
  auto nav = CefDictionaryValue::Create();
  if (Tab* t = ActiveTab()) {
    nav->SetBool("canBack", t->can_back);
    nav->SetBool("canForward", t->can_forward);
    nav->SetString("url", t->url);
  }
  root->SetDictionary("nav", nav);
  return ToJson(Wrap(root));
}

void Controller::PushSidebar() {
  auto browser = sidebar_ ? sidebar_->GetBrowser() : nullptr;
  if (!browser) return;
  browser->GetMainFrame()->ExecuteJavaScript("window.roar && roar.render(" + StateJson() + ")", "", 0);
}

std::string Controller::Suggest(const std::string& raw) {
  std::string q = Lower(raw);
  auto list = CefListValue::Create();
  size_t n = 0;
  auto add = [&](const char* kind, int id, const std::string& title, const std::string& url,
                 const std::string& detail = "") {
    auto d = CefDictionaryValue::Create();
    d->SetString("kind", kind);
    d->SetInt("id", id);
    d->SetString("title", title);
    d->SetString("url", url);
    if (!detail.empty()) d->SetString("detail", detail);
    list->SetDictionary(n++, d);
  };
  auto space_name = [&](const Tab& t) {
    if (t.space == State::Get().active_space) return std::string();
    Space* s = State::Get().FindSpace(t.space);
    return s ? s->name : std::string();
  };
  auto matches = [&](const std::string& title, const std::string& url) {
    if (q.empty()) return true;
    std::string hay = Lower(title + " " + url);
    size_t start = 0;
    while (start < q.size()) {
      size_t end = q.find(' ', start);
      std::string word = q.substr(start, end == std::string::npos ? std::string::npos : end - start);
      if (!word.empty() && hay.find(word) == std::string::npos) return false;
      if (end == std::string::npos) break;
      start = end + 1;
    }
    return true;
  };
  for (const auto& t : tabs_) {
    if (n >= 4) break;
    if (t.id != active_id_ && !StartsWith(t.url, "roar://") && matches(t.title, t.url))
      add("tab", t.id, t.title, t.url, space_name(t));
  }
  if (!q.empty()) {
    std::set<std::string> seen;
    std::vector<std::pair<double, std::pair<std::string, std::string>>> scored;
    double now = NowSeconds();
    for (const auto& [url, e] : State::Get().history) {
      if (!matches(e.title, url)) continue;
      double days = (now - e.last_visit) / 86400;
      double score = std::log2(1 + e.visits) / (1 + days / 7);
      if (StartsWith(Lower(url), "https://" + q) || StartsWith(Lower(url), "https://www." + q))
        score += 10;
      scored.push_back({score, {e.title, url}});
    }
    std::sort(scored.begin(), scored.end(), [](auto& a, auto& b) { return a.first > b.first; });
    for (size_t i = 0; i < scored.size() && n < 8; ++i) {
      bool open = std::any_of(tabs_.begin(), tabs_.end(),
                              [&](const Tab& t) { return t.url == scored[i].second.second; });
      if (!open) {
        add("history", 0, scored[i].second.first, scored[i].second.second);
        seen.insert(scored[i].second.second);
      }
    }
    const auto& archive = State::Get().archive;
    for (size_t i = 0; i < archive.size() && n < 8; ++i)
      if (!seen.count(archive[i].url) && matches(archive[i].title, archive[i].url))
        add("archived", static_cast<int>(i), archive[i].title, archive[i].url);
    if (q.size() >= 3) SuggestPageText(q, list, n);
  }
  return ToJson(Wrap(list));
}

// Full-text matches from saved page text. Every word must appear.
void Controller::SuggestPageText(const std::string& q, CefRefPtr<CefListValue> list, size_t& n) {
  std::vector<std::string> words;
  for (size_t start = 0; start < q.size();) {
    size_t end = q.find(' ', start);
    if (end == std::string::npos) end = q.size();
    if (end > start) words.push_back(q.substr(start, end - start));
    start = end + 1;
  }
  if (words.empty()) return;
  struct Hit {
    double when;
    const std::string* url;
    size_t pos;
  };
  std::vector<Hit> hits;
  for (const auto& [url, page] : State::Get().pages) {
    std::string hay = Lower(page.text);
    size_t first = std::string::npos;
    bool all = true;
    for (const auto& w : words) {
      size_t pos = hay.find(w);
      if (pos == std::string::npos) {
        all = false;
        break;
      }
      if (first == std::string::npos) first = pos;
    }
    if (all) hits.push_back({page.indexed_at, &url, first});
  }
  std::sort(hits.begin(), hits.end(), [](const Hit& a, const Hit& b) { return a.when > b.when; });
  for (size_t i = 0; i < hits.size() && i < 4; ++i) {
    const PageText& page = State::Get().pages[*hits[i].url];
    const std::string& text = page.text;
    // A window of text around the first word, cut on UTF-8 boundaries.
    size_t start = hits[i].pos > 70 ? hits[i].pos - 70 : 0;
    size_t end = std::min(text.size(), hits[i].pos + words[0].size() + 110);
    while (start > 0 && (static_cast<unsigned char>(text[start]) & 0xC0) == 0x80) --start;
    while (end < text.size() && (static_cast<unsigned char>(text[end]) & 0xC0) == 0x80) ++end;
    std::string snippet = (start > 0 ? "…" : "") + text.substr(start, end - start) +
                          (end < text.size() ? "…" : "");
    int tab_id = 0;
    for (const auto& t : tabs_)
      if (t.url == *hits[i].url) tab_id = t.id;
    auto d = CefDictionaryValue::Create();
    d->SetString("kind", "text");
    d->SetInt("id", tab_id);
    d->SetString("title", page.title);
    d->SetString("url", *hits[i].url);
    d->SetString("detail", snippet);
    list->SetDictionary(n++, d);
  }
}

void Controller::ApplySettings(CefRefPtr<CefDictionaryValue> d) {
  Settings& s = State::Get().settings;
  bool github_changed = false;
  if (d->HasKey("archiveAfterHours")) {
    s.archive_after_hours = d->GetType("archiveAfterHours") == VTYPE_INT
                                ? d->GetInt("archiveAfterHours")
                                : d->GetDouble("archiveAfterHours");
  }
  if (d->HasKey("onboarded")) s.onboarded = d->GetBool("onboarded");
  if (d->HasKey("searchUrl")) s.search_url = d->GetString("searchUrl").ToString();
  if (d->HasKey("indexPages")) s.index_pages = d->GetBool("indexPages");
  if (d->HasKey("githubFolder")) {
    s.github_folder = d->GetBool("githubFolder");
    github_changed = true;
  }
  if (d->HasKey("githubQuery")) {
    s.github_query = d->GetString("githubQuery").ToString();
    github_changed = true;
  }
  if (github_changed) RefreshGitHub();
  PushSidebar();
  SaveSoon();
}

// ---------------------------------------------------------------------------
// Message router

bool Controller::HandleQuery(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                             const std::string& request, CefRefPtr<Callback> callback) {
  auto parsed = CefParseJSON(request, JSON_PARSER_RFC);
  if (!parsed || parsed->GetType() != VTYPE_DICTIONARY) return false;
  auto msg = parsed->GetDictionary();
  std::string cmd = msg->GetString("cmd");
  auto int_arg = [&](const char* key) {
    return msg->GetType(key) == VTYPE_INT ? msg->GetInt(key) : static_cast<int>(msg->GetDouble(key));
  };

  // Web pages can only report extraction results, and only for a nonce Roar
  // handed to that same tab.
  // Privileged commands come only from a top-level Roar page: the frame must
  // be the main frame and the browser's main frame must itself be roar://ui/.
  bool trusted = frame->IsMain() && StartsWith(frame->GetURL().ToString(), kUiOrigin) &&
                 StartsWith(browser->GetMainFrame()->GetURL().ToString(), kUiOrigin);
  if (!trusted) {
    if (cmd == "index.result") {
      auto it = indexes_.find(msg->GetString("nonce").ToString());
      Tab* tab = FindTabByBrowser(browser);
      if (it == indexes_.end() || !tab || tab->id != it->second) return false;
      indexes_.erase(it);
      if (State::Get().settings.index_pages) {
        State::Get().SetPageText(tab->url, msg->GetString("title"), msg->GetString("text"));
        SavePagesSoon();
      }
      callback->Success("");
      return true;
    }
    if (cmd != "extract.result") return false;
    auto it = extracts_.find(msg->GetString("nonce").ToString());
    Tab* tab = FindTabByBrowser(browser);
    if (it == extracts_.end() || !tab || tab->id != it->second.tab_id) return false;
    bool save = it->second.save;
    extracts_.erase(it);
    std::string markdown = msg->GetString("markdown");
    std::string title = msg->GetString("title");
    int words = int_arg("words");
    if (markdown.empty()) {
      ShowHint("Couldn't find readable text on this page");
    } else if (save) {
      std::string path = platform::SaveMarkdown(title, markdown);
      ShowHint(path.empty() ? "Couldn't save to Downloads" : "Saved " + path.substr(path.rfind('/') + 1));
    } else {
      platform::CopyText(markdown);
      ShowHint("Copied as Markdown, " + std::to_string(words) + " words");
    }
    callback->Success("");
    return true;
  }

  if (cmd == "state") {
    callback->Success(StateJson());
  } else if (cmd == "suggest") {
    callback->Success(Suggest(msg->GetString("q")));
  } else if (cmd == "open") {
    std::string url = ResolveInput(msg->GetString("text"));
    bool new_tab = msg->HasKey("newTab") ? msg->GetBool("newTab") : command_new_tab_;
    HideCommandBar();
    if (url.empty()) return callback->Success(""), true;
    Tab* tab = ActiveTab();
    if (new_tab || !tab) NewTab(url, true);
    else Navigate(tab->id, url);
    callback->Success("");
  } else if (cmd == "tab.activate") {
    HideCommandBar();
    ActivateTab(int_arg("id"));
    callback->Success("");
  } else if (cmd == "tab.close") {
    CloseTab(int_arg("id"));
    callback->Success("");
  } else if (cmd == "tab.closeSelf") {
    if (Tab* tab = FindTabByBrowser(browser)) CloseTab(tab->id);
    callback->Success("");
  } else if (cmd == "tab.pin") {
    SetPinned(int_arg("id"), msg->GetBool("pinned"));
    callback->Success("");
  } else if (cmd == "tab.dock") {
    DockTab(int_arg("id"));
    callback->Success("");
  } else if (cmd == "archive.restore") {
    HideCommandBar();
    RestoreArchived(static_cast<size_t>(int_arg("index")));
    callback->Success("");
  } else if (cmd == "archive.clear") {
    State::Get().archive.clear();
    PushSidebar();
    SaveSoon();
    callback->Success("");
  } else if (cmd == "commandbar") {
    ShowCommandBar(msg->GetBool("newTab"));
    callback->Success("");
  } else if (cmd == "commandbar.size") {
    command_height_ = std::clamp(int_arg("height"), 60, kCommandBarHeight);
    Relayout();
    callback->Success("");
  } else if (cmd == "commandbar.hide") {
    HideCommandBar();
    callback->Success("");
  } else if (cmd == "run") {
    HideCommandBar();
    RunCommand(msg->GetString("id"));
    callback->Success("");
  } else if (cmd == "settings.set") {
    ApplySettings(msg->GetDictionary("settings"));
    callback->Success(StateJson());
  } else if (cmd == "space.switch") {
    SwitchSpace(int_arg("id"));
    callback->Success("");
  } else if (cmd == "space.add") {
    AddSpace(msg->GetString("name"));
    callback->Success(StateJson());
  } else if (cmd == "space.rename") {
    RenameSpace(int_arg("id"), msg->GetString("name"));
    callback->Success(StateJson());
  } else if (cmd == "space.remove") {
    RemoveSpace(int_arg("id"));
    callback->Success(StateJson());
  } else if (cmd == "github.status") {
    platform::GitHubAuthStatus([callback](std::string status) { callback->Success(status); });
  } else {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Browser events

void Controller::OnBrowserCreated(CefRefPtr<CefBrowser> browser) {
  ++live_browsers_;
  }

void Controller::OnBrowserClosed(CefRefPtr<CefBrowser> browser) {
  --live_browsers_;
  MaybeQuit();
}

void Controller::OnTitle(CefRefPtr<CefBrowser> browser, const std::string& title) {
  Tab* tab = FindTabByBrowser(browser);
  if (!tab) return;
  tab->title = title;
  if (auto it = State::Get().history.find(tab->url); it != State::Get().history.end())
    it->second.title = title;
  if (tab->id == active_id_ && shell_) shell_->SetTitle(title);
  if (tab->floating && tab->window) platform::SetFloating(tab->window->GetWindowHandle(), true, title);
  PushSidebar();
}

void Controller::OnAddress(CefRefPtr<CefBrowser> browser, const std::string& url) {
  Tab* tab = FindTabByBrowser(browser);
  if (!tab) return;
  tab->url = url;
  PushSidebar();
  SaveSoon();
}

void Controller::OnFavicon(CefRefPtr<CefBrowser> browser, const std::string& url) {
  if (Tab* tab = FindTabByBrowser(browser)) {
    tab->favicon = url;
    PushSidebar();
  }
}

void Controller::OnLoading(CefRefPtr<CefBrowser> browser, bool loading, bool can_back,
                           bool can_forward) {
  if (IsUiBrowser(browser)) {
    if (!loading && sidebar_ && sidebar_->GetBrowser() && sidebar_->GetBrowser()->IsSame(browser))
      PushSidebar();
    return;
  }
  Tab* tab = FindTabByBrowser(browser);
  if (!tab) return;
  tab->loading = loading;
  tab->can_back = can_back;
  tab->can_forward = can_forward;
  if (!loading) {
    State::Get().RecordVisit(tab->url, tab->title);
    IndexPage(tab);
  }
  PushSidebar();
}

void Controller::OnDraggableRegions(CefRefPtr<CefBrowser> browser,
                                    const std::vector<CefDraggableRegion>& regions) {
  if (shell_ && sidebar_ && sidebar_->GetBrowser() && sidebar_->GetBrowser()->IsSame(browser))
    shell_->SetDraggableRegions(regions);
}

bool Controller::OnKey(CefRefPtr<CefBrowser> browser, const CefKeyEvent& event) {
  if (event.type != KEYEVENT_RAWKEYDOWN) return false;
  bool cmd = event.modifiers & EVENTFLAG_COMMAND_DOWN;
  bool shift = event.modifiers & EVENTFLAG_SHIFT_DOWN;
  bool alt = event.modifiers & EVENTFLAG_ALT_DOWN;
  int key = event.windows_key_code;
  if (key == 0x1B && command_visible_) {  // Escape
    HideCommandBar();
    return true;
  }
  bool ctrl = event.modifiers & EVENTFLAG_CONTROL_DOWN;
  if (ctrl && !cmd && !shift && !alt && key >= '1' && key <= '9') {
    size_t i = static_cast<size_t>(key - '1');
    if (i < State::Get().spaces.size()) SwitchSpace(State::Get().spaces[i].id);
    return true;
  }
  if (!cmd || ctrl) return false;
  if (!shift && !alt) {
    switch (key) {
      case 'T': ShowCommandBar(true); return true;
      case 'L': ShowCommandBar(false); return true;
      case 'W': CloseTab(active_id_); return true;
      case 'R': Reload(); return true;
      case 'S': ToggleSidebar(); return true;
      case 0xDB: Back(); return true;     // [
      case 0xDD: Forward(); return true;  // ]
      case 0xBC: OpenSettings(); return true;  // ,
      case 0xDC: ToggleSplit(); return true;   // backslash
      case 'D': if (Tab* t = ActiveTab()) SetPinned(t->id, !t->pinned); return true;
    }
    if (key >= '1' && key <= '9') {
      // Counts tabs in the active space only.
      std::vector<int> ids;
      for (const auto& t : tabs_)
        if (t.space == State::Get().active_space) ids.push_back(t.id);
      size_t i = key == '9' ? ids.size() - 1 : static_cast<size_t>(key - '1');
      if (i < ids.size()) ActivateTab(ids[i]);
      return true;
    }
  }
  if (shift && !alt) {
    switch (key) {
      case 'C': ExtractActive(false); return true;
      case 'K': CleanTabs(); return true;
      case 'P': PictureInPicture(); return true;
      case 'F': FloatActiveTab(); return true;
      case 'T': RunCommand("reopen"); return true;
      case 0xDB: CycleSpace(-1); return true;  // {
      case 0xDD: CycleSpace(1); return true;   // }
    }
  }
  if (alt && !shift && key == 'I') {
    RunCommand("devtools");
    return true;
  }
  return false;
}

bool Controller::OnGesture(CefRefPtr<CefBrowserView> view, cef_gesture_command_t command) {
  auto browser = view->GetBrowser();
  if (!browser) return false;
  bool back = command == CEF_GESTURE_COMMAND_BACK;
  CefRefPtr<NeighborVisitor> visitor = new NeighborVisitor(back ? -1 : 1);
  browser->GetHost()->GetNavigationEntries(visitor, false);
  std::string target = visitor->Target();
  if (!target.empty()) ShowHint((back ? "← " : "→ ") + target);
  return false;  // Let Chromium perform the navigation.
}

// ---------------------------------------------------------------------------
// Persistence and shutdown

void Controller::SaveSoon() {
  if (save_pending_ || closing_) return;
  save_pending_ = true;
  CefPostDelayedTask(TID_UI, base::BindOnce([] {
                       Controller::Get()->save_pending_ = false;
                       Controller::Get()->SaveNow();
                     }),
                     1000);
}

void Controller::SaveNow() {
  State& state = State::Get();
  state.tabs.clear();
  state.active_index = 0;
  for (const auto& t : tabs_) {
    if (t.id == active_id_) state.active_index = static_cast<int>(state.tabs.size());
    state.tabs.push_back({t.url, t.title, t.pinned, t.last_active, t.space});
  }
  state.Save();
}

bool Controller::CanCloseShell() {
  if (closing_) return true;
  closing_ = true;
  SaveNow();
  State::Get().SavePages();
  for (auto& t : tabs_)
    if (t.window) t.window->Close();
  if (command_window_) command_window_->Close();
  if (hint_window_) hint_window_->Close();
  return true;
}

void Controller::OnShellDestroyed() {
  shell_ = nullptr;
  layout_ = nullptr;
  sidebar_ = nullptr;
  sidebar_panel_ = nullptr;
  command_bar_ = nullptr;
  command_window_ = nullptr;
  hint_ = nullptr;
  hint_window_ = nullptr;
  tabs_.clear();
  MaybeQuit();
}

void Controller::MaybeQuit() {
  if (closing_ && !shell_ && live_browsers_ <= 0) CefQuitMessageLoop();
}

}  // namespace roar
