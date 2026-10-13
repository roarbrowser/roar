#include "controller.h"

#include "action_watch.h"
#include "link_clean.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <filesystem>
#include <fstream>
#include <functional>
#include <sstream>
#include <set>
#include <unistd.h>

#include "include/cef_command_ids.h"
#include "include/base/cef_callback.h"
#include "include/cef_app.h"
#include "include/cef_parser.h"
#include "include/cef_urlrequest.h"
#include "include/cef_xml_reader.h"
#include "include/views/cef_box_layout.h"
#include "include/views/cef_display.h"
#include "include/views/cef_fill_layout.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/wrapper/cef_helpers.h"

#include "browser_app.h"
#include "library.h"
#include "client.h"
#include "mac/platform.h"
#include "shared.h"
#include "state.h"

namespace roar {

namespace {

// contexts_ key of the profile ghost tabs share.
constexpr int kGhostContext = -1;
// A direct child of the root cache path, as Chrome-style CEF requires.
std::string GhostDir(int session) { return State::Get().Dir() + "/Ghost-" + std::to_string(session); }
constexpr int kSidebarMin = 200;
constexpr int kSidebarMax = 480;
int SidebarWidth() {
  return std::clamp(State::Get().settings.sidebar_width, kSidebarMin, kSidebarMax);
}
constexpr int kCommandBarWidth = 680;
constexpr int kCommandBarHeight = 440;
constexpr int kHintWidth = 420;
constexpr int kHintHeight = 44;
constexpr int kGutter = 8;
constexpr char kNewTabUrl[] = "roar://ui/newtab.html";
constexpr char kWelcomeUrl[] = "roar://ui/welcome.html";
constexpr char kBookmarksUrl[] = "roar://ui/bookmarks.html";
constexpr char kHistoryUrl[] = "roar://ui/history.html";
constexpr char kDownloadsUrl[] = "roar://ui/downloads.html";
constexpr char kReaderUrl[] = "roar://ui/reader.html";
constexpr int kFindWidth = 400;
constexpr int kFindHeight = 46;
// Page zoom steps, as Chrome offers them. Chromium's level is log base 1.2 of the factor.
constexpr double kZoomFactors[] = {0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1,
                                   1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0};
constexpr int kZoomActual = 7;
// Custom context menu ids (CefContextMenuHandler); user ids start at MENU_ID_USER_FIRST.
constexpr int kMenuSplit = MENU_ID_USER_FIRST;
constexpr int kMenuMarkdown = MENU_ID_USER_FIRST + 1;
constexpr int kMenuSpaceRoot = MENU_ID_USER_FIRST + 2;
constexpr int kMenuSpaceBase = MENU_ID_USER_FIRST + 10;  // + index into State::spaces.

std::string Lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
  return s;
}

bool StartsWith(const std::string& s, const std::string& p) { return s.rfind(p, 0) == 0; }

// Host of an http(s) address, or "" for anything else.
std::string HttpHost(const std::string& url) {
  if (!StartsWith(url, "http://") && !StartsWith(url, "https://")) return "";
  CefURLParts parts;
  if (!CefParseURL(url, parts)) return "";
  return Lower(CefString(&parts.host).ToString());
}

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

// An extension's action popup: sizes itself to its page like Chrome's bubble.
// Pages that size to their window (Bitwarden) report no width, hence the floor.
// The popup lives in its own focused window, so "the active tab in the current
// window" is the popup itself, both for the popup page and for the extension's
// service worker (Violentmonkey: "cannot run userscripts in this page"). A shim
// in both answers that query with the Roar tab underneath instead: matched by
// URL, else the most recently used tab in another window (an extension without
// the tabs permission sees no URLs). Chrome won't inject DevTools scripts into
// extension pages, so the popup starts blank, a breakpoint pauses it on the
// extension's first line and the shim goes in there; the worker is reached by
// attaching to it from the popup's DevTools session once the page runs.
class ExtensionPopupViewDelegate : public CefBrowserViewDelegate {
 public:
  ExtensionPopupViewDelegate(const std::string& url, const std::string& tab_url)
      : url_(url), tab_url_(tab_url) {}
  cef_runtime_style_t GetBrowserRuntimeStyle() override { return CEF_RUNTIME_STYLE_CHROME; }
  void OnBrowserCreated(CefRefPtr<CefBrowserView> view, CefRefPtr<CefBrowser> browser) override {
    auto host = browser->GetHost();
    registration_ = host->AddDevToolsMessageObserver(new ShimInstaller(url_, tab_url_));
    host->ExecuteDevToolsMethod(ShimInstaller::kEnable, "Debugger.enable", nullptr);
  }

 private:
  // Steps: enable the debugger, patch the worker if it is awake, set the
  // breakpoint, load the page, patch it when it pauses, then patch the worker
  // again in case the page just woke it. Fixed ids, because a result can
  // arrive before ExecuteDevToolsMethod returns.
  class ShimInstaller : public CefDevToolsMessageObserver {
   public:
    enum { kEnable = 1 << 20, kTargets, kAttach, kWorkerEval, kBreakpoint, kEval, kDisable, kResume };
    ShimInstaller(const std::string& url, const std::string& tab_url) : url_(url) {
      static const char kShim[] = R"JS((() => {
  const tabs = globalThis.chrome && chrome.tabs;
  if (!tabs || !tabs.query || tabs.query.roar) return;
  const want = %s, self = chrome.runtime.getURL(''), query = tabs.query.bind(tabs);
  const underneath = async res => {
    if (!res.length || !(res[0].url || res[0].pendingUrl || '').startsWith(self)) return res;
    const others = (await query({})).filter(t => t.windowId !== res[0].windowId)
                       .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const hit = others.find(t => want && (t.url === want || t.pendingUrl === want)) || others[0];
    return hit ? [hit] : res;
  };
  tabs.query = (info, cb) => {
    let p = query(info);
    if (info && info.active && (info.currentWindow || info.lastFocusedWindow)) p = p.then(underneath);
    if (typeof cb !== 'function') return p;
    p.then(cb);
  };
  tabs.query.roar = true;
})())JS";
      auto quoted = CefValue::Create();
      quoted->SetString(tab_url);
      shim_ = kShim;
      shim_.replace(shim_.find("%s"), 2, ToJson(quoted));
      // chrome-extension://<id>/, for finding this extension's worker.
      origin_ = url.substr(0, url.find('/', strlen("chrome-extension://")) + 1);
    }
    void OnDevToolsEvent(CefRefPtr<CefBrowser> browser, const CefString& method,
                         const void* params, size_t params_size) override {
      if (method != "Debugger.paused") return;
      auto host = browser->GetHost();
      if (paused_) {
        Send(host, kResume, "Debugger.resume", nullptr);
        return;
      }
      paused_ = true;
      auto event = CefParseJSON(params, params_size, JSON_PARSER_RFC);
      auto frames = event && event->GetDictionary() ? event->GetDictionary()->GetList("callFrames")
                                                    : nullptr;
      if (!frames || !frames->GetSize()) return Finish(host);
      auto eval = CefDictionaryValue::Create();
      eval->SetString("callFrameId", frames->GetDictionary(0)->GetString("callFrameId"));
      // Also wake the worker, so it can be patched before the page runs: a
      // worker the page woke itself answered the page before its patch landed.
      eval->SetString("expression", shim_ + ";chrome.runtime.sendMessage({ roarWake: true }).catch(() => {})");
      Send(host, kEval, "Debugger.evaluateOnCallFrame", eval);
    }
    void OnDevToolsMethodResult(CefRefPtr<CefBrowser> browser, int message_id, bool success,
                                const void* result, size_t result_size) override {
      auto host = browser->GetHost();
      auto value = success ? CefParseJSON(result, result_size, JSON_PARSER_RFC) : nullptr;
      auto dict = value ? value->GetDictionary() : nullptr;
      auto kind = kinds_.find(message_id);
      if (kind == kinds_.end()) return;
      int step = kind->second;
      kinds_.erase(kind);
      switch (step) {
        case kEnable:
          Send(host, kTargets, "Target.getTargets", nullptr);
          break;
        case kTargets:
          if (waking_) {
            // The page is paused; wait for the worker it just woke (up to ~2 s).
            if (AttachWorker(host, dict)) break;
            if (++polls_ < 40) {
              PollTargets(host, 50);
            } else {
              waking_ = false;
              Finish(host);
            }
            break;
          }
          if (!AttachWorker(host, dict) && !loaded_) SetBreakpoint(host);
          break;
        case kAttach:
          // Results on a flattened session don't come back here; messages are
          // handled in order, so the worker is patched before the page runs.
          if (dict) EvalInWorker(host, dict->GetString("sessionId"));
          if (waking_) {
            waking_ = false;
            Finish(host);
          } else if (!loaded_) {
            SetBreakpoint(host);
          }
          break;
        case kBreakpoint:
          // Load the extension page only once the breakpoint is in place.
          loaded_ = true;
          browser->GetMainFrame()->LoadURL(url_);
          break;
        case kEval:
          // Posted: a call made from inside a result callback can be dropped.
          waking_ = true;
          PollTargets(host, 0);
          break;
      }
    }

   private:
    // CEF renumbers a message id that isn't above every id it has seen, so
    // repeated steps can't reuse fixed ids: let it pick and remember the step.
    // Ids rise from kEnable and are recorded before sending, since a result
    // can arrive before ExecuteDevToolsMethod returns.
    void Send(CefRefPtr<CefBrowserHost> host, int step, const char* method, CefRefPtr<CefDictionaryValue> params) {
      int id = ++next_id_;
      kinds_[id] = step;
      host->ExecuteDevToolsMethod(id, method, params);
    }
    void PollTargets(CefRefPtr<CefBrowserHost> host, int64_t delay_ms) {
      CefPostDelayedTask(TID_UI, base::BindOnce([](CefRefPtr<ShimInstaller> self, CefRefPtr<CefBrowserHost> h) {
        self->Send(h, kTargets, "Target.getTargets", nullptr);
      }, CefRefPtr<ShimInstaller>(this), host), delay_ms);
    }
    void SetBreakpoint(CefRefPtr<CefBrowserHost> host) {
      auto params = CefDictionaryValue::Create();
      params->SetString("urlRegex", "^chrome-extension://");
      params->SetInt("lineNumber", 0);
      Send(host, kBreakpoint, "Debugger.setBreakpointByUrl", params);
    }
    bool AttachWorker(CefRefPtr<CefBrowserHost> host, CefRefPtr<CefDictionaryValue> targets) {
      auto infos = targets ? targets->GetList("targetInfos") : nullptr;
      for (size_t i = 0; infos && i < infos->GetSize(); ++i) {
        auto info = infos->GetDictionary(i);
        if (info->GetString("type").ToString() != "service_worker" ||
            !StartsWith(info->GetString("url").ToString(), origin_))
          continue;
        auto attach = CefDictionaryValue::Create();
        attach->SetString("targetId", info->GetString("targetId"));
        attach->SetBool("flatten", true);
        Send(host, kAttach, "Target.attachToTarget", attach);
        return true;
      }
      return false;
    }
    // Flattened sessions are addressed by a sessionId on the raw message.
    void EvalInWorker(CefRefPtr<CefBrowserHost> host, const CefString& session) {
      auto params = CefDictionaryValue::Create();
      params->SetString("expression", shim_);
      auto message = CefDictionaryValue::Create();
      message->SetInt("id", ++next_id_);  // Unregistered: its result goes to the worker session.
      message->SetString("method", "Runtime.evaluate");
      message->SetString("sessionId", session);
      message->SetDictionary("params", params);
      auto wrapped = CefValue::Create();
      wrapped->SetDictionary(message);
      std::string json = ToJson(wrapped);
      host->SendDevToolsMessage(json.data(), json.size());
    }
    // Disabling the debugger drops the breakpoint and resumes the page.
    // Auto-resize starts only now: sized while blank, the popup stays too big.
    // Posted, like PollTargets: called from a result callback, the calls can be dropped.
    void Finish(CefRefPtr<CefBrowserHost> host) {
      CefPostTask(TID_UI, base::BindOnce([](CefRefPtr<ShimInstaller> self, CefRefPtr<CefBrowserHost> host) {
        host->SetAutoResizeEnabled(true, CefSize(360, 120), CefSize(800, 600));
        self->Send(host, kDisable, "Debugger.disable", nullptr);
        self->Send(host, kTargets, "Target.getTargets", nullptr);
      }, CefRefPtr<ShimInstaller>(this), host));
    }
    std::string url_, shim_, origin_;
    bool paused_ = false, loaded_ = false, waking_ = false;
    int polls_ = 0;
    std::map<int, int> kinds_ = {{kEnable, kEnable}};  // DevTools message id -> step.
    int next_id_ = kEnable + 100;
    IMPLEMENT_REFCOUNTING(ShimInstaller);
  };
  std::string url_, tab_url_;
  CefRefPtr<CefRegistration> registration_;
  IMPLEMENT_REFCOUNTING(ExtensionPopupViewDelegate);
};

// Fixed-width holder for the sidebar. The height is 1 because CEF treats a
// size with a zero dimension as "no preference"; the box layout stretches it.
// Sized from settings, so a drag of the sidebar edge only needs a relayout.
class SidebarPanelDelegate : public CefPanelDelegate {
 public:
  CefSize GetPreferredSize(CefRefPtr<CefView> view) override { return CefSize(SidebarWidth(), 1); }

 private:
  IMPLEMENT_REFCOUNTING(SidebarPanelDelegate);
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
    return CefDisplay::GetPrimaryDisplay()->GetWorkArea();
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

// A frameless Chrome-style window for an extension popup; it closes when it
// loses focus, as Chrome's does.
class ExtensionPopupDelegate : public CefWindowDelegate {
 public:
  ExtensionPopupDelegate(CefRefPtr<CefBrowserView> view, CefRect bounds)
      : view_(view), bounds_(bounds) {}
  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    window->SetToFillLayout();
    window->AddChildView(view_);
    view_ = nullptr;
  }
  void OnWindowActivationChanged(CefRefPtr<CefWindow> window, bool active) override {
    if (active) seen_active_ = true;
    else if (seen_active_) Controller::Get()->CloseExtensionPopup();
  }
  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override {
    Controller::Get()->OnExtensionPopupDestroyed(window);
  }
  bool CanClose(CefRefPtr<CefWindow> window) override { return true; }
  CefRect GetInitialBounds(CefRefPtr<CefWindow> window) override { return bounds_; }
  bool IsFrameless(CefRefPtr<CefWindow> window) override { return true; }
  bool WithStandardWindowButtons(CefRefPtr<CefWindow> window) override { return false; }
  bool CanResize(CefRefPtr<CefWindow> window) override { return false; }
  bool CanMinimize(CefRefPtr<CefWindow> window) override { return false; }
  bool CanMaximize(CefRefPtr<CefWindow> window) override { return false; }
  cef_runtime_style_t GetWindowRuntimeStyle() override { return CEF_RUNTIME_STYLE_CHROME; }

 private:
  CefRefPtr<CefBrowserView> view_;
  CefRect bounds_;
  bool seen_active_ = false;
  IMPLEMENT_REFCOUNTING(ExtensionPopupDelegate);
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

CefRefPtr<CefDictionaryValue> ReadJsonFile(const std::string& path) {
  std::ifstream in(path);
  if (!in) return nullptr;
  std::stringstream ss;
  ss << in.rdbuf();
  auto v = CefParseJSON(ss.str(), JSON_PARSER_RFC);
  return v && v->GetType() == VTYPE_DICTIONARY ? v->GetDictionary() : nullptr;
}

// Gmail's unread-inbox Atom feed, read with the space's own Gmail cookies;
// /mail/u/<n>/ picks the n-th signed-in account.
constexpr char kGmailFeed[] = "https://mail.google.com/mail/feed/atom";
constexpr int kGmailMaxAccounts = 6;
std::string GmailFeedUrl(int index) {
  return "https://mail.google.com/mail/u/" + std::to_string(index) + "/feed/atom";
}

void ParseGmailFeed(const std::string& xml, GmailFeed& feed) {
  feed.items.clear();
  feed.unread = 0;
  auto stream = CefStreamReader::CreateForData(const_cast<char*>(xml.data()), xml.size());
  auto reader = CefXmlReader::Create(stream, XML_ENCODING_NONE, kGmailFeed);
  if (!reader) return;
  LiveItem item;
  bool in_entry = false, in_author = false;
  while (reader->MoveToNextNode()) {
    if (reader->GetType() == XML_NODE_ELEMENT_END) {
      std::string name = reader->GetLocalName();
      if (name == "author") in_author = false;
      if (name == "entry" && in_entry) {
        if (item.title.empty()) item.title = "(no subject)";
        feed.items.push_back(item);
        in_entry = false;
      }
      continue;
    }
    if (reader->GetType() != XML_NODE_ELEMENT_START) continue;
    std::string name = reader->GetLocalName();
    if (name == "entry") {
      item = LiveItem{};
      in_entry = true;
    } else if (name == "fullcount") {
      feed.unread = std::atoi(reader->GetInnerXml().ToString().c_str());
    } else if (!in_entry) {
      // "Gmail - Inbox for name@example.com"
      if (name == "title") {
        std::string t = reader->GetInnerXml().ToString();
        size_t at = t.rfind(" for ");
        feed.account = at == std::string::npos ? "" : t.substr(at + 5);
      }
      continue;
    } else if (name == "author") {
      in_author = true;
    } else if (name == "title") {
      item.title = reader->GetInnerXml().ToString();
    } else if (name == "link") {
      item.url = reader->GetAttribute("href").ToString();
    } else if (name == "name" && in_author) {
      item.detail = reader->GetInnerXml().ToString();
    }
  }
}

void StartGmailFetch(int space, int index, int attempt, GmailFeed so_far);

// Fetches account `index`, then the next one, until Google runs out of logins
// (401, or a slot that repeats an address already seen).
class GmailFetch : public CefURLRequestClient {
 public:
  GmailFetch(int space, int index, int attempt, GmailFeed so_far)
      : space_(space), index_(index), attempt_(attempt), so_far_(std::move(so_far)) {}
  void OnRequestComplete(CefRefPtr<CefURLRequest> request) override {
    if (!State::Get().FindSpace(space_)) return;  // Removed while loading.
    GmailFeed& feed = State::Get().gmail[space_];
    int code = request->GetResponse() ? request->GetResponse()->GetStatus() : 0;
    if (request->GetRequestStatus() == UR_SUCCESS && code == 200) {
      GmailFeed one;
      ParseGmailFeed(body_, one);
      bool seen = std::any_of(so_far_.accounts.begin(), so_far_.accounts.end(),
                              [&](const GmailAccount& a) { return a.address == one.account; });
      if (!seen && !one.account.empty()) {
        for (auto& item : one.items) item.account = static_cast<int>(so_far_.accounts.size());
        so_far_.accounts.push_back({one.account, index_, one.unread});
        so_far_.items.insert(so_far_.items.end(), one.items.begin(), one.items.end());
        so_far_.unread += one.unread;
        if (so_far_.account.empty()) so_far_.account = one.account;
        if (index_ + 1 < kGmailMaxAccounts) return StartGmailFetch(space_, index_ + 1, 0, std::move(so_far_));
      }
      feed = std::move(so_far_);
    } else if (index_ > 0) {
      feed = std::move(so_far_);  // Past the last account.
    } else if (code == 401 || code == 403) {
      feed = GmailFeed{};
      feed.status = "Sign in to Gmail in this space to see mail here.";
      feed.signed_out = true;
    } else {
      feed.status = code ? "Gmail returned " + std::to_string(code) + "."
                         : "Couldn't reach Gmail.";
      // At launch the network or the space's profile may not be ready yet.
      if (attempt_ < 3)
        CefPostDelayedTask(TID_UI, base::BindOnce([](int space, int attempt) {
          Controller::Get()->RefreshGmail(space, attempt);
        }, space_, attempt_ + 1), 20 * 1000);
    }
    Controller::Get()->PushSidebar();
  }
  void OnUploadProgress(CefRefPtr<CefURLRequest>, int64_t, int64_t) override {}
  void OnDownloadProgress(CefRefPtr<CefURLRequest>, int64_t, int64_t) override {}
  void OnDownloadData(CefRefPtr<CefURLRequest>, const void* data, size_t size) override {
    body_.append(static_cast<const char*>(data), size);
  }
  bool GetAuthCredentials(bool, const CefString&, int, const CefString&, const CefString&,
                          CefRefPtr<CefAuthCallback>) override {
    return false;
  }

 private:
  int space_;
  int index_;
  int attempt_;
  GmailFeed so_far_;
  std::string body_;
  IMPLEMENT_REFCOUNTING(GmailFetch);
};

void StartGmailFetch(int space, int index, int attempt, GmailFeed so_far) {
  auto request = CefRequest::Create();
  request->SetURL(GmailFeedUrl(index));
  request->SetFirstPartyForCookies("https://mail.google.com/");
  request->SetFlags(UR_FLAG_ALLOW_STORED_CREDENTIALS | UR_FLAG_DISABLE_CACHE);
  auto context = Controller::Get()->ContextFor(space);
  CefURLRequest::Create(request, new GmailFetch(space, index, attempt, std::move(so_far)),
                        context ? context : CefRequestContext::GetGlobalContext());
}

// Tells the controller when a space's profile has finished loading.
// Roar leaves passwords and form fill to a password manager extension; turn
// Chromium's own off. Prebuilt CEF ships them, so they can only be disabled per profile.
void DisablePasswordManager(CefRefPtr<CefRequestContext> ctx) {
  for (const char* pref : {"credentials_enable_service", "credentials_enable_autosignin",
                           "autofill.profile_enabled", "autofill.credit_card_enabled"}) {
    auto v = CefValue::Create();
    v->SetBool(false);
    CefString error;
    if (ctx->CanSetPreference(pref)) ctx->SetPreference(pref, v, error);
  }
}

class SpaceContextHandler : public CefRequestContextHandler {
 public:
  explicit SpaceContextHandler(int space) : space_(space) {}
  void OnRequestContextInitialized(CefRefPtr<CefRequestContext> ctx) override {
    DisablePasswordManager(ctx);
    CefPostTask(TID_UI, base::BindOnce([](int s) { Controller::Get()->OnSpaceReady(s); }, space_));
  }

 private:
  int space_;
  IMPLEMENT_REFCOUNTING(SpaceContextHandler);
};

// Tells the controller when a tab's media starts or stops making sound. Chrome-style
// CEF never calls CefAudioHandler, so this follows the DevTools Media domain: any
// player event triggers a look at the page's media elements, repeated every 2s
// while something plays so a mute or a stream that ends is noticed.
class MediaWatcher : public CefDevToolsMessageObserver {
 public:
  static void Attach(CefRefPtr<CefBrowser> browser, CefRefPtr<CefRegistration>* registration) {
    CefRefPtr<MediaWatcher> watcher = new MediaWatcher();
    *registration = browser->GetHost()->AddDevToolsMessageObserver(watcher);
    browser->GetHost()->ExecuteDevToolsMethod(0, "Media.enable", nullptr);
  }
  void OnDevToolsEvent(CefRefPtr<CefBrowser> browser, const CefString& method, const void* params,
                       size_t params_size) override {
    if (method.ToString().rfind("Media.player", 0) == 0) Schedule(browser, 300);
  }
  void OnDevToolsMethodResult(CefRefPtr<CefBrowser> browser, int message_id, bool success,
                              const void* result, size_t result_size) override {
    if (message_id != check_id_) return;
    check_id_ = 0;
    auto value = success ? CefParseJSON(result, result_size, JSON_PARSER_RFC) : nullptr;
    auto dict = value && value->GetType() == VTYPE_DICTIONARY ? value->GetDictionary() : nullptr;
    auto inner = dict ? dict->GetDictionary("result") : nullptr;
    bool audible = inner && inner->GetType("value") == VTYPE_BOOL && inner->GetBool("value");
    Controller::Get()->OnAudible(browser, audible);
    if (audible) Schedule(browser, 2000);
  }

 private:
  void Schedule(CefRefPtr<CefBrowser> browser, int delay_ms) {
    if (scheduled_) return;
    scheduled_ = true;
    CefPostDelayedTask(TID_UI, base::BindOnce(&MediaWatcher::Check, CefRefPtr<MediaWatcher>(this), browser),
                       delay_ms);
  }
  void Check(CefRefPtr<CefBrowser> browser) {
    scheduled_ = false;
    static const char kProbe[] = R"JS((() => {
      for (const m of document.querySelectorAll('audio,video'))
        if (!m.paused && !m.ended && !m.muted && m.volume > 0 && m.readyState > 2 &&
            (m.tagName === 'AUDIO' || m.webkitAudioDecodedByteCount > 0)) return true;
      return false;
    })())JS";
    auto params = CefDictionaryValue::Create();
    params->SetString("expression", kProbe);
    params->SetBool("returnByValue", true);
    check_id_ = browser->GetHost()->ExecuteDevToolsMethod(0, "Runtime.evaluate", params);
  }
  bool scheduled_ = false;
  int check_id_ = 0;
  IMPLEMENT_REFCOUNTING(MediaWatcher);
};

}  // namespace

Controller* Controller::Get() {
  static Controller* controller = new Controller();
  return controller;
}

void Controller::Start() {
  CEF_REQUIRE_UI_THREAD();
  client_ = new Client();
  action_watch::Start([](const std::string& json) { Controller::Get()->PushActions(json); });
  // Roar's CEF patch (scripts/cef-patches) routes CDP Target.createTarget here,
  // so MCP new_page opens a Roar tab instead of a bare Chrome window.
  // The CEF loader opens the framework RTLD_LOCAL, so look in its own image.
  using Hook = int (*)(const char*);
  for (uint32_t i = 0; i < _dyld_image_count(); ++i) {
    if (!strstr(_dyld_get_image_name(i), "/Chromium Embedded Framework")) continue;
    void* lib = dlopen(_dyld_get_image_name(i), RTLD_LAZY | RTLD_NOLOAD);
    if (auto set = reinterpret_cast<void (*)(Hook)>(lib ? dlsym(lib, "roar_set_create_target_hook") : nullptr))
      set([](const char* url) { return Controller::Get()->OpenTargetTab(url); });
    break;
  }
  State& state = State::Get();
  state.Load();
  platform::InstallMenu();
  if (platform::Headless()) platform::InstallStatusItem();
  DisablePasswordManager(CefRequestContext::GetGlobalContext());

  shell_ = CefWindow::CreateTopLevelWindow(new ShellDelegate());
  shell_->SetTitle("Roar");
  CefBoxLayoutSettings box;
  box.horizontal = true;
  layout_ = shell_->SetToBoxLayout(box);
  sidebar_panel_ = CefPanel::CreatePanel(new SidebarPanelDelegate());
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
  ApplySidebarWidth();

  command_bar_ = CreateUiView(client_, "command.html");
  command_window_ = CefWindow::CreateTopLevelWindow(new PopupDelegate(command_bar_));
  platform::StyleWindow(command_window_->GetWindowHandle(), 14, true);
  hint_ = CreateUiView(client_, "hint.html");
  hint_window_ = CefWindow::CreateTopLevelWindow(new PopupDelegate(hint_));
  platform::StyleWindow(hint_window_->GetWindowHandle(), 22, true);
  platform::SetIgnoresMouse(hint_window_->GetWindowHandle(), true);
  find_ = CreateUiView(client_, "find.html");
  find_window_ = CefWindow::CreateTopLevelWindow(new PopupDelegate(find_));
  platform::StyleWindow(find_window_->GetWindowHandle(), 12, true);

  // Only pinned tabs and pinned groups come back on launch; the rest start
  // fresh, and unpinned groups go with their tabs.
  state.groups.erase(std::remove_if(state.groups.begin(), state.groups.end(),
                                    [](const TabGroup& g) { return !g.pinned; }),
                     state.groups.end());
  for (const auto& saved : state.tabs) {
    bool in_group = state.FindGroup(saved.group);
    if (!saved.pinned && !in_group) continue;
    int id = NewTab(saved.url, false, saved.pinned && !in_group, saved.last_active, saved.space);
    if (in_group) FindTab(id)->group = saved.group;
    FindTab(id)->icon = saved.icon;
    FindTab(id)->favicon = saved.favicon;
  }
  if (!state.settings.onboarded) {
    ActivateTab(NewTab(kWelcomeUrl, false));
  } else {
    ActivateTab(NewTab(kNewTabUrl, false));
  }

  if (platform::Headless()) platform::HideApp();
  AutoArchiveTick();
  GitHubTick();
  GmailOpenTick();
}

void Controller::Focus() {
  if (!shell_) return;
  shell_->Show();
  shell_->Activate();
  FocusTab(ActiveTab());
}

void Controller::Quit() {
  // A second Quit while one is under way (or with no shell) quits outright.
  if (shell_ && !closing_) shell_->Close();
  else CefQuitMessageLoop();
}

// ---------------------------------------------------------------------------
// Tabs

int Controller::NewTab(const std::string& raw_url, bool activate, bool pinned, double last_active,
                       int space, bool ghost, int opener) {
  CEF_REQUIRE_UI_THREAD();
  // Every way into a new tab (links from Outlook and Teams, popups, the
  // command line) passes here, so Safe Links and .mcas.ms hosts are undone once.
  const std::string url = State::Get().settings.clean_links ? CleanLink(raw_url) : raw_url;
  Tab tab;
  tab.id = next_id_++;
  tab.space = space < 0 || !State::Get().FindSpace(space) ? State::Get().active_space : space;
  tab.url = url.empty() ? kNewTabUrl : url;
  tab.title = tab.url;
  tab.ghost = ghost;
  tab.pinned = pinned && !ghost;
  if (tab.pinned) tab.home_url = tab.url;
  tab.last_active = last_active > 0 ? last_active : NowSeconds();
  if (auto it = State::Get().history.find(SpaceKey(tab.space, tab.url));
      it != State::Get().history.end())
    tab.title = it->second.title.empty() ? tab.url : it->second.title;
  // The browser is created with the tab's window, on first activation.
  tab.view = CreateTabView(tab.url, tab.space, ghost);
  // A link's tab joins its opener's group and opens after it and the tabs it
  // already opened, in order; other new tabs open beside the active one.
  auto pos = tabs_.end();
  Tab* from = opener ? FindTab(opener) : nullptr;
  if (from && from->space != tab.space) from = nullptr;
  if (from) {
    tab.opener = from->id;
    if (from->group && !ghost) tab.group = from->group;
    pos = std::find_if(tabs_.begin(), tabs_.end(), [&](const Tab& t) { return t.id == from->id; }) + 1;
    while (pos != tabs_.end() && pos->opener == tab.opener) ++pos;
  } else if (auto* active = ActiveTab(); active && !tab.pinned && active->space == tab.space) {
    pos = std::find_if(tabs_.begin(), tabs_.end(),
                       [&](const Tab& t) { return t.id == active->id; }) + 1;
  }
  tabs_.insert(pos, tab);
  if (activate) ActivateTab(tab.id);
  PushSidebar();
  SaveSoon();
  return tab.id;
}

int Controller::OpenTargetTab(const std::string& url) {
  if (!shell_) return 0;
  int id = NewTab(url, true);
  // The tab's browser exists once its window does; without one (a space whose
  // profile is still loading) let Chrome open the page instead.
  Tab* tab = FindTab(id);
  auto browser = tab && tab->view ? tab->view->GetBrowser() : nullptr;
  if (browser) return browser->GetIdentifier();
  CloseTab(id);
  return 0;
}

int Controller::NewTabFrom(CefRefPtr<CefBrowser> opener, const std::string& url, bool activate) {
  Tab* from = FindTabByBrowser(opener);
  return NewTab(url, activate, false, 0, from ? from->space : -1, IsGhostBrowser(opener),
                from ? from->id : 0);
}

CefRect Controller::ContentRect() {
  CefRect r = shell_ ? shell_->GetBounds() : CefRect();
  int left = sidebar_visible_ ? SidebarWidth() : kGutter;
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
    if (space == kGhostContext) {
      // A throwaway profile per ghost session. CEF's in-memory profile is one
      // shared incognito profile that keeps its cookies until Roar quits.
      CefString(&settings.cache_path) = GhostDir(++ghost_session_);
    } else {
      CefString(&settings.cache_path) = State::Get().ProfileDir(space);
      settings.persist_session_cookies = true;
    }
    ctx = CefRequestContext::CreateContext(settings, new SpaceContextHandler(space));
    ctx->RegisterSchemeHandlerFactory(kScheme, "ui", NewUiSchemeFactory());
  }
  return ctx;
}

void Controller::OnSpaceReady(int space) {
  ready_spaces_.insert(space);
  for (auto& t : tabs_)
    if ((t.ghost ? kGhostContext : t.space) == space && !t.view) t.view = CreateTabView(t.url, t.space, t.ghost);
  SyncWindows();
  if (Tab* t = ActiveTab(); t && (t->ghost ? kGhostContext : t->space) == space) FocusTab(t);
}

// Ends the ghost session once its last tab closes: the next ghost tab starts
// with no cookies, logins or cache.
void Controller::EndGhostSession() {
  std::erase_if(downloads_, [](const Download& d) { return d.ghost; });
  PushSidebar();
  auto it = contexts_.find(kGhostContext);
  if (it == contexts_.end()) return;
  contexts_.erase(it);
  ready_spaces_.erase(kGhostContext);
  // Chromium may still hold files open; deleting on macOS unlinks them anyway,
  // and launch removes any Ghost-* left behind.
  std::error_code ec;
  std::filesystem::remove_all(GhostDir(ghost_session_), ec);
}

CefRefPtr<CefBrowserView> Controller::CreateTabView(const std::string& url, int space, bool ghost) {
  if (ghost) space = kGhostContext;
  // A space's profile loads asynchronously and CEF returns no view until it
  // has; OnSpaceReady creates the view for tabs left pending here.
  if (space != 0 && !ready_spaces_.count(space)) {
    ContextFor(space);
    return nullptr;
  }
  return CefBrowserView::CreateBrowserView(client_, url, CefBrowserSettings(), nullptr,
                                           ContextFor(space), new TabViewDelegate());
}

void Controller::ShowTabWindow(Tab* tab) {
  if (!tab->view) return;  // Its space's profile is still loading.
  if (!tab->window) {
    // OnTabWindowCreated attaches it once CEF has built the window.
    tab->window =
        CefWindow::CreateTopLevelWindow(new TabWindowDelegate(tab->view, RectFor(tab->id)));
    // CEF may build the window before returning, when tab->window was still unset
    // and OnTabWindowCreated could not match it to this tab.
    if (tab->window->GetChildViewCount() > 0) OnTabWindowCreated(tab->window);
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
  if (!tab || !tab->window || !tab->view) return;
  tab->window->Activate();
  tab->view->RequestFocus();
  if (auto browser = (tab->view ? tab->view->GetBrowser() : nullptr)) browser->GetHost()->SetFocus(true);
}

void Controller::ActivateTab(int id) {
  Tab* tab = FindTab(id);
  if (!tab || !shell_) return;
  if (tab->floating) return DockTab(id);
  if (find_visible_ && find_tab_ != id) HideFind(false);
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
  if (find_window_ && find_visible_)
    find_window_->SetBounds(CefRect(area.x + std::max(0, area.width - kFindWidth - 16), area.y + 12,
                                    kFindWidth, kFindHeight));
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
  if (find_visible_ && find_tab_ == id) HideFind(false);
  if (id == split_a_ || id == split_b_) split_a_ = split_b_ = 0;
  if (tab.group) DropGroupIfEmpty(tab.group);
  if (tab.ghost && std::none_of(tabs_.begin(), tabs_.end(), [](const Tab& t) { return t.ghost; }))
    EndGhostSession();
  // Reading a PR or message changes the list; refetch once it's closed.
  if (!tab.folder.empty()) {
    std::string folder = tab.folder;
    CefPostDelayedTask(TID_UI, base::BindOnce([](std::string folder) {
      if (folder == "mail") Controller::Get()->RefreshGmail();
      else Controller::Get()->RefreshGitHub();
    }, folder), 30 * 1000);
  }
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
  if (auto browser = (tab->view ? tab->view->GetBrowser() : nullptr)) {
    browser->GetMainFrame()->LoadURL(url);
  } else if (!tab->window) {
    // Not created yet: start it at the new address instead.
    tab->view = CreateTabView(url, tab->space, tab->ghost);
  }
  PushSidebar();
}

void Controller::SetPinned(int id, bool pinned) {
  auto it = std::find_if(tabs_.begin(), tabs_.end(), [&](const Tab& t) { return t.id == id; });
  if (it == tabs_.end() || it->ghost) return;
  Tab tab = *it;
  tab.pinned = pinned;
  tab.home_url = pinned ? tab.url : "";
  int old_group = tab.group;
  if (pinned) tab.group = 0;
  tabs_.erase(it);
  // Pinned tabs live together at the front of the list.
  auto end_of_pinned =
      std::find_if(tabs_.begin(), tabs_.end(), [](const Tab& t) { return !t.pinned; });
  tabs_.insert(end_of_pinned, tab);
  if (pinned && old_group) DropGroupIfEmpty(old_group);
  PushSidebar();
  SaveSoon();
}

bool Controller::IsKept(const Tab& tab) {
  if (tab.pinned) return true;
  TabGroup* g = State::Get().FindGroup(tab.group);
  return g && g->pinned;
}

void Controller::CloseActiveUnlessKept() {
  Tab* tab = ActiveTab();
  if (!tab) return;
  if (tab->pinned && !tab->home_url.empty()) {
    // Pinned tabs stay in the sidebar: Cmd-W sends one back to its pinned
    // address and moves on, as if it had closed.
    if (tab->view && tab->view->GetBrowser()) tab->view->GetBrowser()->GetMainFrame()->LoadURL(tab->home_url);
    tab->url = tab->home_url;
    int id = tab->id, space = tab->space;
    auto it = std::find_if(tabs_.begin(), tabs_.end(), [&](const Tab& t) { return t.id == id; });
    size_t index = it - tabs_.begin();
    auto usable = [&](const Tab& t) { return t.id != id && t.space == space && !t.floating && !t.pinned; };
    Tab* next = nullptr;
    for (size_t i = index + 1; i < tabs_.size() && !next; ++i)
      if (usable(tabs_[i])) next = &tabs_[i];
    for (size_t i = index; i-- > 0 && !next;)
      if (usable(tabs_[i])) next = &tabs_[i];
    if (next) ActivateTab(next->id);
    else ActivateTab(NewTab(kNewTabUrl, false, false, 0, space));
    PushSidebar();
    SaveSoon();
    return;
  }
  if (IsKept(*tab)) return Reload();  // Tabs in pinned groups stay open; Cmd-W refreshes them.
  CloseTab(tab->id);
}

void Controller::SetGroup(int id, int group) {
  Tab* tab = FindTab(id);
  if (tab && tab->ghost) return;
  State& state = State::Get();
  TabGroup* g = state.FindGroup(group);
  if (!tab || (group && (!g || g->space != tab->space))) return;
  int old = tab->group;
  tab->group = group;
  if (group) tab->pinned = false;  // The group decides.
  tab->folder.clear();
  if (old && old != group) DropGroupIfEmpty(old);
  PushSidebar();
  SaveSoon();
}

// An unpinned group lasts only as long as its tabs.
void Controller::DropGroupIfEmpty(int group) {
  State& state = State::Get();
  TabGroup* g = state.FindGroup(group);
  if (!g || g->pinned) return;
  if (std::any_of(tabs_.begin(), tabs_.end(), [&](const Tab& t) { return t.group == group; })) return;
  state.groups.erase(std::remove_if(state.groups.begin(), state.groups.end(),
                                    [&](const TabGroup& x) { return x.id == group; }),
                     state.groups.end());
}

bool Controller::ExecuteScript(int id, const std::string& code) {
  Tab* tab = FindTab(id);
  if (!tab) return false;
  auto browser = (tab->view ? tab->view->GetBrowser() : nullptr);
  if (!browser) return false;
  browser->GetMainFrame()->ExecuteJavaScript(code, browser->GetMainFrame()->GetURL(), 0);
  return true;
}

Tab* Controller::FindTab(int id) {
  for (auto& t : tabs_)
    if (t.id == id) return &t;
  return nullptr;
}

CefRefPtr<CefClient> Controller::client() { return client_; }

bool Controller::IsGhostBrowser(CefRefPtr<CefBrowser> browser) {
  if (Tab* t = FindTabByBrowser(browser)) return t->ghost;
  auto ctx = browser ? browser->GetHost()->GetRequestContext() : nullptr;
  if (!ctx) return true;
  if (ctx->IsSharingWith(CefRequestContext::GetGlobalContext())) return false;
  for (const auto& [space, c] : contexts_)
    if (space != kGhostContext && c && ctx->IsSharingWith(c)) return false;
  return true;
}

Tab* Controller::FindTabByBrowser(CefRefPtr<CefBrowser> browser) {
  if (!browser) return nullptr;
  for (auto& t : tabs_) {
    auto b = (t.view ? t.view->GetBrowser() : nullptr);
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
  for (const auto& view : {sidebar_, command_bar_, hint_, find_}) {
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
  // Cmd-T from a ghost tab opens another ghost tab, never a regular one.
  Tab* active = ActiveTab();
  command_ghost_ = new_tab && active && active->ghost;
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
  if (tab->ghost) return CloseTab(id);
  State::Get().AddArchived(tab->space, tab->url, tab->title);
  CloseTab(id);
}

void Controller::CleanTabs() {
  std::vector<int> ids;
  for (const auto& t : tabs_)
    if (!IsKept(t) && !IsVisible(t.id) && !t.floating && t.space == State::Get().active_space)
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
      if (!IsKept(t) && !IsVisible(t.id) && !t.floating && t.last_active < cutoff)
        ids.push_back(t.id);
    for (int id : ids) ArchiveTab(id);
  }
  PushSidebar();  // Refreshes the cooling bars.
  CefPostDelayedTask(TID_UI, base::BindOnce([] { Controller::Get()->AutoArchiveTick(); }),
                     60 * 1000);
}

// Clears the active space's archive; other spaces keep theirs.
void Controller::ClearArchive() {
  auto& archive = State::Get().archive;
  int space = State::Get().active_space;
  archive.erase(std::remove_if(archive.begin(), archive.end(),
                               [&](const ArchivedTab& a) { return a.space == space; }),
                archive.end());
}

void Controller::RestoreArchived(size_t index) {
  auto& archive = State::Get().archive;
  if (index >= archive.size()) return;
  ArchivedTab item = archive[index];
  archive.erase(archive.begin() + index);
  NewTab(item.url, true, false, 0, item.space);
}

// Chat apps "Ask <name> about page" opens, by command id suffix.
struct Llm {
  const char* id;
  const char* name;
  const char* url;
};
constexpr Llm kLlms[] = {
    {"chatgpt", "ChatGPT", "https://chatgpt.com/"},
    {"claude", "Claude", "https://claude.ai/new"},
    {"gemini", "Gemini", "https://gemini.google.com/app"},
    {"perplexity", "Perplexity", "https://www.perplexity.ai/"},
};
constexpr size_t kLlmMaxChars = 100000;

void Controller::ExtractActive(const std::string& target, int tab_id) {
  Tab* tab = tab_id ? FindTab(tab_id) : ActiveTab();
  if (!tab || !(tab->view ? tab->view->GetBrowser() : nullptr)) return;
  if (!StartsWith(tab->url, "http")) {
    ShowHint("Open a web page first");
    return;
  }
  std::string nonce = platform::RandomToken();
  extracts_[nonce] = {tab->id, target};
  std::string script = platform::ReadResource("ui/extract.js");
  ExecuteScript(tab->id, script + "\n;window.__roarExtract && window.__roarExtract(" +
                             JsString(nonce) + ");");
}

void Controller::PictureInPicture() {
  Tab* tab = ActiveTab();
  auto browser = tab ? (tab->view ? tab->view->GetBrowser() : nullptr) : nullptr;
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
  if (Tab* t = ActiveTab(); t && (t->view ? t->view->GetBrowser() : nullptr)) (t->view ? t->view->GetBrowser() : nullptr)->GoBack();
}

void Controller::Forward() {
  if (Tab* t = ActiveTab(); t && (t->view ? t->view->GetBrowser() : nullptr)) (t->view ? t->view->GetBrowser() : nullptr)->GoForward();
}

// Reloads every open, non-ghost tab in |space|.
void Controller::ReloadSpace(int space) {
  for (auto& t : tabs_)
    if (!t.ghost && t.space == space && t.view && t.view->GetBrowser()) t.view->GetBrowser()->Reload();
}

void Controller::Reload(bool ignore_cache) {
  CefRefPtr<CefBrowser> b;
  if (Tab* t = ActiveTab(); t && t->view) b = t->view->GetBrowser();
  if (!b) return;
  if (ignore_cache) b->ReloadIgnoreCache();
  else b->Reload();
}

// Reuses a tab already showing |url| in this space.
void Controller::OpenUiPage(const std::string& url) {
  for (const auto& t : tabs_)
    if (StartsWith(t.url, url) && t.space == State::Get().active_space) return ActivateTab(t.id);
  NewTab(url, true);
}

void Controller::OpenSettings() {
  // Reuse a settings tab in this space; jumping to another space's copy looked like nothing happened.
  for (const auto& t : tabs_)
    if (StartsWith(t.url, kWelcomeUrl) && t.space == State::Get().active_space) return ActivateTab(t.id);
  NewTab(kWelcomeUrl, true);
}

// The box layout caches the panel's preferred size, so invalidate the whole
// shell; the sidebar page then needs a nudge to pick up its new width.
void Controller::ApplySidebarWidth() {
  sidebar_panel_->InvalidateLayout();
  shell_->InvalidateLayout();
  shell_->Layout();
  // The box layout can still keep the cached width (as after a mouse drag), so
  // size the panel directly.
  if (sidebar_visible_) {
    CefRect r = sidebar_panel_->GetBounds();
    if (r.width != SidebarWidth()) sidebar_panel_->SetBounds(CefRect(r.x, r.y, SidebarWidth(), r.height));
  }
  if (auto b = sidebar_->GetBrowser()) b->GetHost()->WasResized();
  Relayout();
}

void Controller::PollSidebarDragEnd() {
  if (platform::IsLeftMouseDown()) {
    CefPostDelayedTask(TID_UI, base::BindOnce([] { Controller::Get()->PollSidebarDragEnd(); }), 50);
    return;
  }
  sidebar_drag_poll_ = false;
  ApplySidebarWidth();
  SaveSoon();
}

void Controller::ToggleSidebar() {
  sidebar_visible_ = !sidebar_visible_;
  sidebar_panel_->SetVisible(sidebar_visible_);
  platform::SetSidebarButton(shell_->GetWindowHandle(), !sidebar_visible_);
  shell_->Layout();
  Relayout();
}

void Controller::RefreshGitHub(int attempt) {
  State& state = State::Get();
  if (!state.settings.github_folder) return;
  int space = state.active_space;
  platform::SearchGitHub(state.settings.github_query, [space, attempt](std::string json, std::string error) {
    State& s = State::Get();
    // At launch the network may not be up yet; a missing gh won't fix itself.
    if (!error.empty() && attempt < 3 && error.find("Install the GitHub CLI") == std::string::npos)
      CefPostDelayedTask(TID_UI, base::BindOnce([](int attempt) { Controller::Get()->RefreshGitHub(attempt); },
                                                attempt + 1), 20 * 1000);
    s.github_status = error;
    if (error.empty()) {
      if (s.github_space < 0) s.github_space = space;  // Belongs to the space it first loaded in.
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

void Controller::RefreshGmail() { RefreshGmail(State::Get().active_space); }

void Controller::RefreshGmail(int space, int attempt) {
  if (!State::Get().settings.gmail_folder) return;
  StartGmailFetch(space, 0, attempt, GmailFeed{});
}

// Polls the sidebar's live folders: pull requests and unread mail.
void Controller::GitHubTick() {
  RefreshGitHub();
  // Every space's mail stays current, not just the active one (and all are checked at launch).
  std::set<int> spaces;
  for (const auto& sp : State::Get().spaces) spaces.insert(sp.id);
  for (int space : spaces) RefreshGmail(space);
  CefPostDelayedTask(TID_UI, base::BindOnce([] { Controller::Get()->GitHubTick(); }), 10 * 60 * 1000);
}

// While a space has a Gmail tab open, keep its unread mail current every 20 s.
void Controller::GmailOpenTick() {
  std::set<int> spaces;
  for (const auto& t : tabs_)
    if (!t.ghost && StartsWith(t.url, "https://mail.google.com/")) spaces.insert(t.space);
  for (int space : spaces) RefreshGmail(space);
  CefPostDelayedTask(TID_UI, base::BindOnce([] { Controller::Get()->GmailOpenTick(); }), 20 * 1000);
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
  RefreshGmail();  // This space's own Gmail login.
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
  int id = state.next_space_id++;
  state.spaces.push_back({id, name.empty() ? "Space " + std::to_string(state.spaces.size() + 1)
                                           : name});
  SaveSoon();
  SwitchSpace(id);
  return id;
}

// Mirrors Dia: one space per Dia profile (Dia's first profile is space 0),
// then a Web Store tab in that space for each extension it lacks. Installing
// needs a click on Chromium's own confirm dialog, so Roar stops at the page.
// Pulls bookmarks, pinned tabs, the reading list and Web Store extensions from
// another browser. The default profile lands in space 0; each other profile in
// the space of the same name, created if needed.
void Controller::ImportBrowser(const std::string& browser) {
  std::string error;
  std::string label = library::BrowserName(browser);
  auto profiles = library::ReadBrowser(browser, &error);
  if (profiles.empty()) return ShowHint(label + ": " + (error.empty() ? "nothing found" : error));

  State& state = State::Get();
  int extensions = 0, bookmarks = 0, pinned = 0, reading = 0;
  std::function<int(CefRefPtr<CefListValue>)> count = [&](CefRefPtr<CefListValue> list) {
    int n = 0;
    for (size_t i = 0; list && i < list->GetSize(); ++i) {
      auto d = list->GetDictionary(i);
      n += d->HasKey("children") ? count(d->GetList("children")) : 1;
    }
    return n;
  };
  for (auto& p : profiles) {
    int space = -1;
    if (p.is_default) {
      space = 0;
    } else {
      for (const auto& s : state.spaces)
        if (s.name == p.name) space = s.id;
      if (space < 0) {
        space = state.next_space_id++;
        state.spaces.push_back({space, p.name.substr(0, 40), "", {}});
      }
    }
    std::string roar_profile = state.ProfileDir(space);
    for (const auto& id : p.extensions) {
      if (std::filesystem::is_directory(roar_profile + "/Extensions/" + id)) continue;
      std::string url = "https://chromewebstore.google.com/detail/" + id;
      if (std::any_of(tabs_.begin(), tabs_.end(), [&](const Tab& t) {
            return t.space == space && StartsWith(t.url, url);
          }))
        continue;
      NewTab(url, false, false, 0, space);
      ++extensions;
    }
    if (int n = count(p.bookmarks)) {
      library::PutFolder(space, "Imported from " + label, p.bookmarks);
      bookmarks += n;
    }
    for (const auto& [title, url] : p.pinned) {
      if (std::any_of(tabs_.begin(), tabs_.end(), [&](const Tab& t) {
            return t.space == space && t.pinned && t.url == url;
          }))
        continue;
      NewTab(url, false, true, 0, space);
      ++pinned;
    }
    for (const auto& [title, url] : p.reading_list) reading += library::AddReadLater(space, title, url);
  }
  library::Save();
  PushSidebar();
  SaveSoon();
  std::vector<std::string> parts;
  if (bookmarks) parts.push_back(std::to_string(bookmarks) + " bookmarks");
  if (pinned) parts.push_back(std::to_string(pinned) + " pinned tabs");
  if (reading) parts.push_back(std::to_string(reading) + " to read later");
  if (extensions) parts.push_back(std::to_string(extensions) + " extensions to add");
  std::string summary;
  for (size_t i = 0; i < parts.size(); ++i) summary += (i ? ", " : "") + parts[i];
  ShowHint(label + ": " + (summary.empty() ? "nothing new" : summary));
}

// The active space's bookmarks and Read Later list.
std::string Controller::LibraryJson() {
  auto v = CefValue::Create();
  v->SetDictionary(library::ForSpace(State::Get().active_space)->Copy(false));
  return CefWriteJSON(v, JSON_WRITER_DEFAULT).ToString();
}

void Controller::SaveToLibrary(bool read_later) {
  Tab* tab = ActiveTab();
  if (!tab || StartsWith(tab->url, "roar:")) return ShowHint("Nothing to save");
  int space = State::Get().active_space;
  bool added = read_later ? library::AddReadLater(space, tab->title, tab->url)
                          : library::AddBookmark(space, tab->title, tab->url);
  if (added) library::Save();
  ShowHint(!added ? "Already saved" : read_later ? "Added to Read Later" : "Bookmarked");
}

// Extensions installed in the active space's profile, plus the bundled ones.
std::string Controller::ExtensionsJson() {
  namespace fs = std::filesystem;
  State& state = State::Get();
  std::string profile = state.ProfileDir(state.active_space);
  auto list = CefListValue::Create();
  auto add = [&](const std::string& id, const fs::path& dir) {
    auto manifest = ReadJsonFile((dir / "manifest.json").string());
    if (!manifest) return;
    std::string name = manifest->GetString("name").ToString();
    if (StartsWith(name, "__MSG_")) {
      std::string key = name.substr(6, name.size() - 8);
      std::string locale = manifest->GetString("default_locale").ToString();
      for (const std::string& l : {std::string("en"), std::string("en_US"), locale}) {
        auto msgs = ReadJsonFile((dir / "_locales" / l / "messages.json").string());
        CefDictionaryValue::KeyList keys;
        if (!msgs || !msgs->GetKeys(keys)) continue;
        for (const auto& k : keys) {
          std::string a = k.ToString(), b = key;
          std::transform(a.begin(), a.end(), a.begin(), ::tolower);
          std::transform(b.begin(), b.end(), b.begin(), ::tolower);
          if (a == b) name = msgs->GetDictionary(k)->GetString("message").ToString();
        }
        if (!StartsWith(name, "__MSG_")) break;
      }
    }
    std::string ext_id = id.empty() ? platform::UnpackedExtensionId(dir.string()) : id;
    auto action = manifest->GetDictionary("action");
    if (!action) action = manifest->GetDictionary("browser_action");
    std::string popup = action ? action->GetString("default_popup").ToString() : "";
    std::string options = manifest->GetString("options_page").ToString();
    if (auto ui = manifest->GetDictionary("options_ui")) options = ui->GetString("page").ToString();
    // The largest icon up to 64px, from the toolbar icon first.
    std::string icon;
    int best = 0;
    for (auto icons : {action ? action->GetDictionary("default_icon") : nullptr, manifest->GetDictionary("icons")}) {
      CefDictionaryValue::KeyList sizes;
      if (!icons || !icons->GetKeys(sizes)) continue;
      for (const auto& k : sizes) {
        int px = std::atoi(k.ToString().c_str());
        if (px <= 64 && px > best) best = px, icon = icons->GetString(k).ToString();
      }
      if (!icon.empty()) break;
    }
    std::string icon_data;
    if (!icon.empty()) {
      std::ifstream in(dir / icon, std::ios::binary);
      std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
      if (!bytes.empty())
        icon_data = "data:image/png;base64," + CefBase64Encode(bytes.data(), bytes.size()).ToString();
    }
    const auto& pins = state.ActivePins();
    std::string base = "chrome-extension://" + ext_id + "/";
    auto d = CefDictionaryValue::Create();
    d->SetString("id", ext_id);
    d->SetString("name", name);
    d->SetString("version", manifest->GetString("version"));
    d->SetString("icon", icon_data);
    d->SetString("open", !popup.empty() ? base + popup : !options.empty() ? base + options
                                                       : "chrome://extensions/?id=" + ext_id);
    d->SetBool("popup", !popup.empty());
    d->SetBool("pinned", std::find(pins.begin(), pins.end(), ext_id) != pins.end());
    list->SetDictionary(list->GetSize(), d);
  };
  std::error_code ec;
  for (const auto& e : fs::directory_iterator(profile + "/Extensions", ec)) {
    if (!e.is_directory() || e.path().filename() == "Temp") continue;
    fs::path newest;
    for (const auto& v : fs::directory_iterator(e.path(), ec))
      if (v.is_directory() && (newest.empty() || v.path() > newest)) newest = v.path();
    if (!newest.empty()) add(e.path().filename().string(), newest);
  }
  add("", fs::path(state.Dir()) / "ubol");
  auto v = CefValue::Create();
  v->SetList(list);
  return CefWriteJSON(v, JSON_WRITER_DEFAULT).ToString();
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
  state.groups.erase(std::remove_if(state.groups.begin(), state.groups.end(),
                                    [&](const TabGroup& g) { return g.space == id; }),
                     state.groups.end());
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
  indexes_[nonce] = {tab->id, tab->url};
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
  else if (id == "copyMarkdown") ExtractActive("copy");
  else if (id == "saveMarkdown") ExtractActive("save");
  else if (StartsWith(id, "askLlm:")) ExtractActive(id.substr(7));
  else if (id == "find") ShowFind();
  else if (id == "zoomIn") ZoomStep(1);
  else if (id == "zoomOut") ZoomStep(-1);
  else if (id == "zoomReset") ZoomStep(0);
  else if (id == "print") Print();
  else if (id == "reader") ToggleReader();
  else if (id == "mute") ToggleMute(active_id_);
  else if (id == "downloads") OpenUiPage(kDownloadsUrl);
  else if (id == "history") OpenUiPage(kHistoryUrl);
  else if (id == "pip") PictureInPicture();
  else if (id == "float") FloatActiveTab();
  else if (id == "back") Back();
  else if (id == "forward") Forward();
  else if (id == "reload") Reload();
  else if (id == "settings") OpenSettings();
  else if (id == "checkUpdates") platform::CheckForUpdates(shell_ ? shell_->GetWindowHandle() : nullptr);
  else if (id == "sidebar") ToggleSidebar();
  else if (id == "github") RefreshGitHub();
  else if (id == "gmail") RefreshGmail();
  else if (id == "importDia") ImportBrowser("dia");
  else if (StartsWith(id, "import:")) ImportBrowser(id.substr(7));
  else if (id == "bookmarkAdd") SaveToLibrary(false);
  else if (id == "readLaterAdd") SaveToLibrary(true);
  else if (id == "bookmarks") OpenUiPage(kBookmarksUrl);
  else if (StartsWith(id, "open:")) NewTab(id.substr(5), true);
  else if (id == "extensions") NewTab("chrome://extensions", true);
  else if (id == "extensionStore") NewTab("https://chromewebstore.google.com/category/extensions", true);
  else if (StartsWith(id, "extensionPin:")) {
    auto& pins = State::Get().ActivePins();
    std::string ext = id.substr(13);
    if (auto it = std::find(pins.begin(), pins.end(), ext); it != pins.end()) pins.erase(it);
    else pins.push_back(ext);
    PushSidebar();
    SaveSoon();
  }
  else if (StartsWith(id, "extension:")) NewTab("chrome://extensions/?id=" + id.substr(10), true);
  else if (id == "newTab") ShowCommandBar(true);
  else if (id == "newGhostTab") ShowCommandBar(true), command_ghost_ = true;
  else if (id == "closeTab") CloseActiveUnlessKept();
  else if (StartsWith(id, "restore:")) RestoreArchived(std::atoi(id.c_str() + 8));
  else if (id == "reopen") {
    const auto& archive = State::Get().archive;
    for (size_t i = 0; i < archive.size(); ++i)
      if (archive[i].space == State::Get().active_space) {
        RestoreArchived(i);
        break;
      }
  }
  else if (id == "clearArchive") {
    ClearArchive();
    PushSidebar();
    SaveSoon();
  }
  else if (id == "pin") { if (Tab* t = ActiveTab()) SetPinned(t->id, !t->pinned); }
  else if (id == "split") ToggleSplit();
  else if (id == "newSpace") AddSpace("");
  else if (id == "nextSpace") CycleSpace(1);
  else if (id == "prevSpace") CycleSpace(-1);
  else if (id == "clearHistory" || id == "clearCookies") {
    if (!shell_) return;
    platform::ChooseLookback(shell_->GetWindowHandle(), id == "clearHistory" ? "history" : "cookies",
                             [id](double since) {
                               Controller::Get()->RunCommand(id + ":" + std::to_string(static_cast<long long>(since)));
                             });
  }
  else if (StartsWith(id, "clearHistory:")) {
    // History and saved page text since the cutoff (Unix seconds, 0 for all),
    // in the active space only; other spaces keep theirs.
    double since = std::atof(id.c_str() + 13);
    State& state = State::Get();
    int space = state.active_space;
    auto in_space = [&](const std::string& key) {
      size_t tab = key.find('\t');
      return tab == std::string::npos ? space == 0 : std::atoi(key.c_str()) == space;
    };
    std::erase_if(state.history, [&](const auto& kv) { return in_space(kv.first) && kv.second.last_visit >= since; });
    std::erase_if(state.pages, [&](const auto& kv) { return in_space(kv.first) && kv.second.indexed_at >= since; });
    state.Save();
    state.SavePages();
    ReloadSpace(space);
    PushSidebar();
    ShowHint("Cleared history in this space");
  }
  else if (StartsWith(id, "clearCookies:")) {
    // Cookies created since the cutoff, in the active space. Never the ghost
    // context: touching it after its tabs close crashes CEF.
    double since = std::atof(id.c_str() + 13);
    int space = State::Get().active_space;
    auto ctx = space == 0 ? CefRequestContext::GetGlobalContext() : ContextFor(space);
    auto cookies = ctx ? ctx->GetCookieManager(nullptr) : nullptr;
    if (!cookies) return;
    if (since <= 0) {
      cookies->DeleteCookies("", "", nullptr);
    } else {
      class Visitor : public CefCookieVisitor {
       public:
        explicit Visitor(double since) : since_(since) {}
        bool Visit(const CefCookie& cookie, int, int, bool& remove) override {
          CefTime created;
          cef_time_from_basetime(cookie.creation, &created);
          double t = 0;
          cef_time_to_doublet(&created, &t);
          remove = t >= since_;
          return true;
        }
       private:
        double since_;
        IMPLEMENT_REFCOUNTING(Visitor);
      };
      cookies->VisitAllCookies(new Visitor(since));
    }
    // Pages pick up the signed-out state once the deletion lands.
    CefPostDelayedTask(TID_UI, base::BindOnce([](int space) { Controller::Get()->ReloadSpace(space); }, space), 500);
    ShowHint("Cleared cookies in this space");
  }
  else if (id == "gmailMenu") {
    // One section per signed-in account, then sign-out (Google can't sign out
    // just one of several accounts, so it covers all of them).
    const GmailFeed& feed = State::Get().gmail[State::Get().active_space];
    std::vector<std::string> items;
    std::vector<std::string> urls;  // Parallel to items; empty for labels and sign-out.
    for (const auto& a : feed.accounts) {
      items.push_back("-" + a.address);
      urls.push_back("");
      items.push_back("    Open Inbox" + (a.unread ? " (" + std::to_string(a.unread) + " unread)" : std::string()));
      urls.push_back("https://mail.google.com/mail/u/" + std::to_string(a.index) + "/#inbox");
      items.push_back("");
      urls.push_back("");
    }
    items.push_back(feed.accounts.size() > 1 ? "Sign Out of All Accounts in This Space"
                                             : "Sign Out of Gmail in This Space");
    urls.push_back("");
    platform::PopupMenu(items, [urls](int i) {
      if (urls[i].empty()) Controller::Get()->RunCommand("gmailSignOut");
      else Controller::Get()->ActivateTab(Controller::Get()->NewTab(urls[i], false));
    });
  }
  else if (id == "gmailSignOut") {
    // Signs this space out of Google by dropping its google.com cookies; other
    // spaces keep their own logins.
    int space = State::Get().active_space;
    auto ctx = space == 0 ? CefRequestContext::GetGlobalContext() : ContextFor(space);
    auto cookies = ctx ? ctx->GetCookieManager(nullptr) : nullptr;
    if (!cookies) return;
    class Visitor : public CefCookieVisitor {
     public:
      bool Visit(const CefCookie& cookie, int, int, bool& remove) override {
        std::string domain = CefString(&cookie.domain).ToString();
        remove = domain == "google.com" || domain.ends_with(".google.com");
        return true;
      }
      IMPLEMENT_REFCOUNTING(Visitor);
    };
    cookies->VisitAllCookies(new Visitor());
    std::string account = State::Get().gmail[space].account;
    CefPostDelayedTask(TID_UI, base::BindOnce([](int space) {
      Controller::Get()->RefreshGmail(space);
      Controller::Get()->ReloadSpace(space);
    }, space), 500);
    ShowHint(account.empty() ? "Signed out of Gmail in this space" : "Signed out " + account + " in this space");
  }
  else if (id == "forgetPages") {
    State::Get().pages.clear();
    State::Get().SavePages();
    ShowHint("Forgot saved page text");
  }
  else if (id == "devtools") {
    if (Tab* t = ActiveTab(); t && (t->view ? t->view->GetBrowser() : nullptr))
      (t->view ? t->view->GetBrowser() : nullptr)->GetHost()->ShowDevTools(CefWindowInfo(), nullptr, CefBrowserSettings(),
                                                     CefPoint());
  }
}

// ---------------------------------------------------------------------------
// Find, zoom, print, Reader mode, audio, tab cycling

void Controller::ShowFind() {
  Tab* tab = ActiveTab();
  if (!find_window_ || !tab || !(tab->view ? tab->view->GetBrowser() : nullptr)) return;
  HideCommandBar();
  if (find_visible_ && find_tab_ != tab->id) HideFind(false);
  find_tab_ = tab->id;
  find_visible_ = true;
  Relayout();
  find_window_->Show();
  platform::AttachChild(shell_->GetWindowHandle(), find_window_->GetWindowHandle());
  find_window_->Activate();
  if (auto browser = find_->GetBrowser()) {
    browser->GetMainFrame()->ExecuteJavaScript("window.roar && roar.open(" + JsString(find_text_) + ")",
                                               "", 0);
    find_->RequestFocus();
    browser->GetHost()->SetFocus(true);
  }
}

void Controller::HideFind(bool refocus) {
  if (!find_window_ || !find_visible_) return;
  find_visible_ = false;
  if (Tab* t = FindTab(find_tab_); t && t->view && t->view->GetBrowser())
    t->view->GetBrowser()->GetHost()->StopFinding(true);
  find_count_ = find_active_ = 0;
  if (shell_) platform::DetachChild(shell_->GetWindowHandle(), find_window_->GetWindowHandle());
  if (refocus) FocusTab(ActiveTab());
}

// ⌘G and ⇧⌘G: step through the last search, opening the bar if it is closed.
void Controller::FindNext(bool forward) {
  if (find_text_.empty()) return ShowFind();
  Tab* t = ActiveTab();
  auto b = t && t->view ? t->view->GetBrowser() : nullptr;
  if (!b) return;
  if (!find_visible_) ShowFind();
  b->GetHost()->Find(find_text_, forward, false, true);
}

void Controller::OnFindResult(CefRefPtr<CefBrowser> browser, int identifier, int count, int active) {
  Tab* t = FindTab(find_tab_);
  auto b = t && t->view ? t->view->GetBrowser() : nullptr;
  if (!find_visible_ || !b || !b->IsSame(browser)) return;
  if (count >= 0) find_count_ = count;
  if (active > 0) find_active_ = active;
  // A new search highlights every match but selects none; step onto the first.
  if (find_fresh_ && find_count_ > 0 && active == 0) {
    find_fresh_ = false;
    b->GetHost()->Find(find_text_, true, false, true);
  }
  if (find_count_ == 0) find_active_ = 0;
  if (auto fb = find_ ? find_->GetBrowser() : nullptr)
    fb->GetMainFrame()->ExecuteJavaScript("window.roar && roar.result(" + std::to_string(find_active_) +
                                              "," + std::to_string(find_count_) + ")",
                                          "", 0);
}

// ⌘+, ⌘− and ⌘0: step through Chrome's zoom levels for this tab's host, keep the
// choice in state.json and apply it again whenever that host loads.
void Controller::ZoomStep(int direction) {
  Tab* tab = ActiveTab();
  auto browser = tab && tab->view ? tab->view->GetBrowser() : nullptr;
  std::string host = tab ? HttpHost(tab->url) : "";
  if (!browser || host.empty()) return ShowHint("Zoom works on web pages");
  constexpr int n = sizeof(kZoomFactors) / sizeof(kZoomFactors[0]);
  double factor = std::pow(1.2, browser->GetHost()->GetZoomLevel());
  int nearest = 0;
  for (int i = 1; i < n; ++i)
    if (std::fabs(kZoomFactors[i] - factor) < std::fabs(kZoomFactors[nearest] - factor)) nearest = i;
  int index = direction == 0 ? kZoomActual : std::clamp(nearest + direction, 0, n - 1);
  double level = index == kZoomActual ? 0 : std::log(kZoomFactors[index]) / std::log(1.2);
  for (auto& t : tabs_)
    if (HttpHost(t.url) == host && t.ghost == tab->ghost && t.view && t.view->GetBrowser())
      t.view->GetBrowser()->GetHost()->SetZoomLevel(level);
  if (!tab->ghost) {  // A ghost tab's zoom must not leave its host name on disk.
    if (index == kZoomActual) State::Get().zoom.erase(host);
    else State::Get().zoom[host] = level;
    SaveSoon();
  }
  ShowHint("Zoom " + std::to_string(static_cast<int>(std::lround(kZoomFactors[index] * 100))) + "%");
}

void Controller::ApplyZoom(CefRefPtr<CefBrowser> browser, const std::string& url) {
  Tab* tab = FindTabByBrowser(browser);
  std::string host = HttpHost(url);
  if (!tab || tab->ghost || host.empty()) return;
  auto it = State::Get().zoom.find(host);
  double level = it == State::Get().zoom.end() ? 0 : it->second;
  if (std::fabs(browser->GetHost()->GetZoomLevel() - level) > 0.001)
    browser->GetHost()->SetZoomLevel(level);
}

void Controller::Print() {
  Tab* tab = ActiveTab();
  auto browser = tab && tab->view ? tab->view->GetBrowser() : nullptr;
  if (!browser) return;
  HideCommandBar();
  browser->GetHost()->Print();
}

// Reader mode: extract.js pulls the article, roar://ui/reader.html renders it in
// the same tab. Toggling again returns to the article's own address.
void Controller::ToggleReader() {
  Tab* tab = ActiveTab();
  if (!tab) return;
  if (StartsWith(tab->url, kReaderUrl)) {
    if (!tab->reader_origin.empty()) Navigate(tab->id, tab->reader_origin);
    return;
  }
  ExtractActive("reader");
}

void Controller::ToggleMute(int id) {
  Tab* tab = FindTab(id);
  auto browser = tab && tab->view ? tab->view->GetBrowser() : nullptr;
  if (!browser) return;
  bool muted = !browser->GetHost()->IsAudioMuted();
  browser->GetHost()->SetAudioMuted(muted);
  tab->muted = muted;
  PushSidebar();
  ShowHint(muted ? "Tab muted" : "Tab unmuted");
}

void Controller::OnAudible(CefRefPtr<CefBrowser> browser, bool audible) {
  Tab* tab = FindTabByBrowser(browser);
  if (!tab || tab->audible == audible) return;
  tab->audible = audible;
  PushSidebar();
}

// ⌃Tab walks the space's tabs from most to least recently used; ⌃⇧Tab goes the
// other way. The order is frozen while presses keep coming (we only see key
// downs, so a pause ends the run), and tabs passed on the way don't count as used.
void Controller::CycleTabs(int step) {
  double now = NowSeconds();
  Tab* current = ActiveTab();
  if (!current) return;
  if (cycle_order_.empty() || now - cycle_at_ > 1.2) {
    std::vector<const Tab*> list;
    for (const auto& t : tabs_)
      if ((t.space == State::Get().active_space || t.ghost) && !t.floating) list.push_back(&t);
    std::stable_sort(list.begin(), list.end(),
                     [&](const Tab* a, const Tab* b) {
                       if (a->id == current->id || b->id == current->id) return a->id == current->id && b->id != current->id;
                       return a->last_active > b->last_active;
                     });
    cycle_order_.clear();
    cycle_saved_.clear();
    for (const Tab* t : list) {
      cycle_order_.push_back(t->id);
      cycle_saved_[t->id] = t->last_active;
    }
    cycle_index_ = 0;
  }
  cycle_at_ = now;
  std::erase_if(cycle_order_, [&](int id) { return !FindTab(id); });
  int n = static_cast<int>(cycle_order_.size());
  if (n < 2) return;
  cycle_index_ = static_cast<size_t>(((static_cast<int>(cycle_index_) + step) % n + n) % n);
  int target = cycle_order_[cycle_index_];
  int start = cycle_order_[0];
  ActivateTab(target);
  for (const auto& [id, saved] : cycle_saved_)
    if (Tab* t = FindTab(id); t && id != target) t->last_active = id == start ? now - 1 : saved;
  if (Tab* t = FindTab(target)) ShowHint(t->title.empty() ? HttpHost(t->url) : t->title);
}

// ---------------------------------------------------------------------------
// Downloads

bool Controller::OnBeforeDownload(CefRefPtr<CefBrowser> browser, CefRefPtr<CefDownloadItem> item,
                                  const std::string& suggested_name,
                                  CefRefPtr<CefBeforeDownloadCallback> callback) {
  std::string name = suggested_name;
  for (char& c : name)
    if (c == '/' || c == '\\' || c == ':' || static_cast<unsigned char>(c) < 0x20) c = '_';
  if (name.empty() || name == "." || name == "..") name = "download";
  // Ask first for file types that run code when opened. Chromium itself already
  // asks before a page starts several downloads ("Download multiple files").
  static const std::set<std::string> kRisky = {
      "app", "command", "dmg", "pkg", "mpkg", "sh", "tool", "terminal", "workflow", "scpt",
      "applescript", "jar", "webloc", "inetloc", "fileloc", "dylib", "kext", "plugin"};
  std::string ext;
  if (size_t dot = name.rfind('.'); dot != std::string::npos) ext = name.substr(dot + 1);
  std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) { return std::tolower(c); });
  bool risky = kRisky.count(ext) > 0;
  CefRefPtr<CefDownloadItem> keep = item;
  // By profile, not tab: a popup a ghost tab opened has no Roar tab.
  auto ghost_ctx = contexts_.find(kGhostContext);
  bool ghost = browser && ghost_ctx != contexts_.end() && ghost_ctx->second &&
               browser->GetHost()->GetRequestContext()->IsSame(ghost_ctx->second);
  auto start = [this, name, keep, callback, ghost] {
    std::string path = platform::UniqueDownloadPath(name);
    Download d;
    d.id = next_download_++;
    d.item_id = static_cast<int>(keep->GetId());
    d.name = path.substr(path.rfind('/') + 1);
    d.path = path;
    d.url = keep->GetURL();
    d.total = keep->GetTotalBytes();
    d.ghost = ghost;
    downloads_.push_back(d);
    callback->Continue(path, false);
    PushSidebar();
    ShowHint("Downloading " + d.name);
  };
  if (!risky) {
    start();
    return true;
  }
  CefURLParts parts;
  std::string host;
  if (CefParseURL(item->GetURL(), parts)) host = CefString(&parts.host).ToString();
  int item_id = static_cast<int>(item->GetId());
  std::string url = item->GetURL();
  // The shell, not the tab: a sheet on the frameless tab child window never shows.
  void* window = shell_ ? shell_->GetWindowHandle() : nullptr;
  platform::ConfirmDownload(window, name, host, [this, start, item_id, url](bool allow) {
    if (allow) start();
    else denied_downloads_.insert({item_id, url});
  });
  return true;
}

void Controller::OnDownloadUpdated(CefRefPtr<CefDownloadItem> item,
                                   CefRefPtr<CefDownloadItemCallback> callback) {
  if (!item->IsValid()) return;
  std::string url = item->GetURL();
  if (denied_downloads_.count({static_cast<int>(item->GetId()), url})) {
    if (item->IsInProgress()) callback->Cancel();
    else denied_downloads_.erase({static_cast<int>(item->GetId()), url});
    return;
  }
  Download* d = nullptr;
  for (auto& x : downloads_)
    if (x.item_id == static_cast<int>(item->GetId()) && x.url == url && !x.done && !x.canceled && !x.failed)
      d = &x;
  if (!d) {
    // Untracked (finished already, or dropped with its ghost session): still
    // quarantine it, without a URL since it may have been a ghost download.
    if (item->IsComplete() && !item->GetFullPath().empty())
      platform::QuarantineDownload(item->GetFullPath(), "");
    return;
  }
  d->received = item->GetReceivedBytes();
  d->total = item->GetTotalBytes();
  d->speed = item->GetCurrentSpeed();
  bool was_done = d->done;
  d->done = item->IsComplete();
  d->canceled = item->IsCanceled();
  d->failed = item->IsInterrupted() && !d->canceled;
  d->control = item->IsInProgress() ? callback : nullptr;
  if (d->done && !item->GetFullPath().empty()) d->path = item->GetFullPath();
  if (d->done && !was_done) {
    platform::QuarantineDownload(d->path, d->ghost ? "" : d->url);  // No ghost URL on disk.
    d->name = d->path.substr(d->path.rfind('/') + 1);
    ShowHint("Downloaded " + d->name);
  } else if (d->canceled) {
    ShowHint("Canceled " + d->name);
  } else if (d->failed) {
    ShowHint("Download failed: " + d->name);
  }
  PushSidebar();
}

std::string Controller::DownloadsJson() {
  auto list = CefListValue::Create();
  for (auto it = downloads_.rbegin(); it != downloads_.rend(); ++it) {
    auto d = CefDictionaryValue::Create();
    d->SetInt("id", it->id);
    d->SetString("name", it->name);
    d->SetString("url", it->url);
    d->SetString("path", it->done ? it->path : "");
    d->SetDouble("received", static_cast<double>(it->received));
    d->SetDouble("total", static_cast<double>(it->total));
    d->SetDouble("speed", static_cast<double>(it->speed));
    d->SetString("status", it->done ? "done" : it->canceled ? "canceled" : it->failed ? "failed" : "active");
    list->SetDictionary(list->GetSize(), d);
  }
  return ToJson(Wrap(list));
}

// ---------------------------------------------------------------------------
// History page

std::string Controller::HistoryJson(const std::string& raw) {
  State& state = State::Get();
  std::vector<std::string> words;
  std::string q = Lower(raw);
  for (size_t start = 0; start < q.size();) {
    size_t end = q.find(' ', start);
    if (end == std::string::npos) end = q.size();
    if (end > start) words.push_back(q.substr(start, end - start));
    start = end + 1;
  }
  struct Row {
    std::string title, url;
    int visits;
    double when;
  };
  std::vector<Row> rows;
  for (const auto& [key, e] : state.history) {
    if (e.space != state.active_space) continue;
    std::string url = e.space == 0 ? key : key.substr(key.find('\t') + 1);
    std::string hay = Lower(e.title + " " + url);
    bool all = true;
    for (const auto& w : words)
      if (hay.find(w) == std::string::npos) all = false;
    if (all) rows.push_back({e.title, url, e.visits, e.last_visit});
  }
  std::sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) { return a.when > b.when; });
  auto list = CefListValue::Create();
  for (size_t i = 0; i < rows.size() && i < 500; ++i) {
    auto d = CefDictionaryValue::Create();
    d->SetString("title", rows[i].title);
    d->SetString("url", rows[i].url);
    d->SetInt("visits", rows[i].visits);
    d->SetDouble("lastVisit", rows[i].when);
    list->SetDictionary(i, d);
  }
  auto root = CefDictionaryValue::Create();
  root->SetList("entries", list);
  root->SetInt("total", static_cast<int>(rows.size()));
  for (const auto& s : state.spaces)
    if (s.id == state.active_space) root->SetString("space", s.name);
  return ToJson(Wrap(root));
}

// ---------------------------------------------------------------------------
// Context menu

void Controller::BuildContextMenu(CefRefPtr<CefBrowser> browser, CefRefPtr<CefContextMenuParams> params,
                                  CefRefPtr<CefMenuModel> model) {
  Tab* tab = FindTabByBrowser(browser);
  if (!tab) return;
  std::string link = params->GetLinkUrl();
  bool is_link = (params->GetTypeFlags() & CM_TYPEFLAG_LINK) && HttpHost(link) != "";
  model->AddSeparator();
  if (is_link) {
    model->AddItem(kMenuSplit, "Open Link in Split View");
    // A ghost tab's links stay in the ghost session, so it has no space to send them to.
    if (!tab->ghost) {
      const auto& spaces = State::Get().spaces;
      bool other = std::any_of(spaces.begin(), spaces.end(), [&](const Space& s) { return s.id != tab->space; });
      if (other) {
        auto sub = model->AddSubMenu(kMenuSpaceRoot, "Open Link in Space…");
        for (size_t i = 0; sub && i < spaces.size(); ++i)
          if (spaces[i].id != tab->space)
            sub->AddItem(kMenuSpaceBase + static_cast<int>(i), spaces[i].name);
      } else {
        model->AddItem(kMenuSpaceRoot, "Open Link in Space…");
        model->SetEnabled(kMenuSpaceRoot, false);
      }
    }
  }
  model->AddItem(kMenuMarkdown, "Copy Page as Markdown");
}

bool Controller::OnContextMenuCommand(CefRefPtr<CefBrowser> browser, CefRefPtr<CefContextMenuParams> params,
                                      int command_id) {
  Tab* tab = FindTabByBrowser(browser);
  if (!tab) return false;
  int tab_id = tab->id;
  bool ghost = tab->ghost;
  std::string link = params->GetLinkUrl();
  // Chrome's own "Open Link in New Tab/Window" bypasses OnBeforePopup.
  if ((command_id == IDC_CONTENT_CONTEXT_OPENLINKNEWTAB ||
       command_id == IDC_CONTENT_CONTEXT_OPENLINKNEWWINDOW) && !link.empty()) {
    NewTabFrom(browser, link, false);
    return true;
  }
  if (command_id == kMenuMarkdown) {
    ExtractActive("copy", tab_id);
    return true;
  }
  if (command_id == kMenuSplit && HttpHost(link) != "") {
    OpenInSplit(link, ghost);
    return true;
  }
  const auto& spaces = State::Get().spaces;
  int index = command_id - kMenuSpaceBase;
  if (index >= 0 && index < static_cast<int>(spaces.size()) && HttpHost(link) != "" && !ghost) {
    NewTab(link, false, false, 0, spaces[index].id);
    ShowHint("Opened in " + spaces[index].name);
    return true;
  }
  return false;
}

// Puts |url| beside the active tab. Already split: it replaces the focused pane.
void Controller::OpenInSplit(const std::string& url, bool ghost) {
  Tab* cur = ActiveTab();
  if (!cur) return;
  if (split_a_ && (cur->id == split_a_ || cur->id == split_b_)) {
    NewTab(url, true, false, 0, cur->space, ghost);
    return;
  }
  int first = cur->id;
  int second = NewTab(url, false, false, 0, cur->space, ghost);
  split_a_ = first;
  split_b_ = second;
  ActivateTab(second);
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
    if (t.space != state.active_space && !t.ghost) continue;
    auto d = CefDictionaryValue::Create();
    d->SetInt("id", t.id);
    d->SetBool("ghost", t.ghost);
    d->SetString("title", t.title);
    d->SetString("url", t.url);
    d->SetString("favicon", t.favicon);
    d->SetString("icon", t.icon);
    d->SetBool("pinned", t.pinned);
    d->SetBool("active", t.id == active_id_);
    d->SetBool("loading", t.loading);
    d->SetBool("floating", t.floating);
    d->SetString("folder", t.folder);
    d->SetString("folderItem", t.folder_item);
    d->SetInt("group", t.group);
    d->SetBool("kept", IsKept(t));
    d->SetBool("audible", t.audible);
    d->SetBool("muted", t.muted);
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
    d->SetString("color", state.spaces[i].color);
    d->SetInt("tabCount", static_cast<int>(std::count_if(
        tabs_.begin(), tabs_.end(), [&](const Tab& t) { return t.space == state.spaces[i].id; })));
    spaces->SetDictionary(i, d);
  }
  root->SetList("spaces", spaces);
  auto groups = CefListValue::Create();
  for (const auto& g : state.groups) {
    if (g.space != state.active_space) continue;
    auto d = CefDictionaryValue::Create();
    d->SetInt("id", g.id);
    d->SetString("name", g.name);
    d->SetString("color", g.color);
    d->SetBool("pinned", g.pinned);
    d->SetBool("collapsed", g.collapsed);
    groups->SetDictionary(groups->GetSize(), d);
  }
  root->SetList("groups", groups);
  root->SetInt("activeSpace", state.active_space);
  root->SetBool("split", split_a_ && IsVisible(split_a_));
  auto archive = CefListValue::Create();
  size_t archived = 0, archive_count = 0;
  for (size_t i = 0; i < state.archive.size(); ++i) {
    if (state.archive[i].space != state.active_space) continue;
    ++archive_count;
    if (archived >= 60) continue;
    auto d = CefDictionaryValue::Create();
    d->SetString("title", state.archive[i].title);
    d->SetString("url", state.archive[i].url);
    d->SetDouble("archivedAt", state.archive[i].archived_at);
    archive->SetDictionary(archived++, d);
  }
  root->SetList("archive", archive);
  root->SetInt("archiveCount", static_cast<int>(archive_count));
  auto gh = CefDictionaryValue::Create();
  gh->SetBool("enabled", state.settings.github_folder &&
                             (state.github_space < 0 || state.github_space == state.active_space));
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
  auto gm = CefDictionaryValue::Create();
  static const GmailFeed kNoMail;
  auto feed_it = state.gmail.find(state.active_space);
  const GmailFeed& feed = feed_it != state.gmail.end() ? feed_it->second : kNoMail;
  gm->SetBool("enabled", state.settings.gmail_folder);
  gm->SetString("status", feed.status);
  gm->SetInt("unread", feed.unread);
  gm->SetBool("signedOut", feed.signed_out);
  gm->SetString("account", feed.account);
  auto accounts = CefListValue::Create();
  for (size_t i = 0; i < feed.accounts.size(); ++i) {
    auto d = CefDictionaryValue::Create();
    d->SetString("address", feed.accounts[i].address);
    d->SetInt("unread", feed.accounts[i].unread);
    accounts->SetDictionary(i, d);
  }
  gm->SetList("accounts", accounts);
  auto mail = CefListValue::Create();
  for (size_t i = 0; i < feed.items.size(); ++i) {
    auto d = CefDictionaryValue::Create();
    d->SetString("title", feed.items[i].title);
    d->SetString("url", feed.items[i].url);
    d->SetString("detail", feed.items[i].detail);
    d->SetInt("account", feed.items[i].account);
    mail->SetDictionary(i, d);
  }
  gm->SetList("items", mail);
  root->SetDictionary("gmail", gm);
  auto settings = CefDictionaryValue::Create();
  settings->SetDouble("archiveAfterHours", state.settings.archive_after_hours);
  settings->SetBool("onboarded", state.settings.onboarded);
  settings->SetString("searchUrl", state.settings.search_url);
  settings->SetBool("indexPages", state.settings.index_pages);
  settings->SetInt("pinnedColumns", state.settings.pinned_columns);
  settings->SetBool("pinnedCentered", state.settings.pinned_centered);
  settings->SetBool("cleanLinks", state.settings.clean_links);
  settings->SetInt("pageCount", static_cast<int>(state.pages.size()));
  settings->SetInt("cdpPort", platform::CdpPort());
  auto pins = CefListValue::Create();
  for (size_t i = 0; i < state.ActivePins().size(); ++i) pins->SetString(i, state.ActivePins()[i]);
  settings->SetList("pinnedExtensions", pins);
  root->SetDictionary("settings", settings);
  auto nav = CefDictionaryValue::Create();
  if (Tab* t = ActiveTab()) {
    nav->SetBool("canBack", t->can_back);
    nav->SetBool("canForward", t->can_forward);
    nav->SetString("url", t->url);
  }
  root->SetDictionary("nav", nav);
  auto dl = CefDictionaryValue::Create();
  int active_downloads = 0;
  for (const auto& d : downloads_)
    if (!d.done && !d.canceled && !d.failed) ++active_downloads;
  dl->SetInt("count", static_cast<int>(downloads_.size()));
  dl->SetInt("active", active_downloads);
  root->SetDictionary("downloads", dl);
  return ToJson(Wrap(root));
}

void Controller::PushSidebar() {
  auto browser = sidebar_ ? sidebar_->GetBrowser() : nullptr;
  if (!browser) return;
  browser->GetMainFrame()->ExecuteJavaScript("window.roar && roar.render(" + StateJson() + ")", "", 0);
  Tab* tab = ActiveTab();
  action_watch::SetActiveUrl(tab ? tab->url : "");
}

void Controller::PushActions(const std::string& json) {
  auto browser = sidebar_ ? sidebar_->GetBrowser() : nullptr;
  if (browser) browser->GetMainFrame()->ExecuteJavaScript("window.roar && roar.actions && roar.actions(" + json + ")", "", 0);
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
  // Only this space's tabs: nothing from one space surfaces in another.
  for (const auto& t : tabs_) {
    if (n >= 4) break;
    if (t.space == State::Get().active_space && t.id != active_id_ &&
        !StartsWith(t.url, "roar://") && matches(t.title, t.url))
      add("tab", t.id, t.title, t.url);
  }
  if (!q.empty()) {
    std::set<std::string> seen;
    std::vector<std::pair<double, std::pair<std::string, std::string>>> scored;
    double now = NowSeconds();
    int space = State::Get().active_space;
    for (const auto& [key, e] : State::Get().history) {
      if (e.space != space) continue;
      const std::string url = e.space == 0 ? key : key.substr(key.find('\t') + 1);
      if (!matches(e.title, url)) continue;
      double days = (now - e.last_visit) / 86400;
      double score = std::log2(1 + e.visits) / (1 + days / 7);
      if (StartsWith(Lower(url), "https://" + q) || StartsWith(Lower(url), "https://www." + q))
        score += 10;
      scored.push_back({score, {e.title, url}});
    }
    std::sort(scored.begin(), scored.end(), [](auto& a, auto& b) { return a.first > b.first; });
    for (size_t i = 0; i < scored.size() && n < 8; ++i) {
      bool open = std::any_of(tabs_.begin(), tabs_.end(), [&](const Tab& t) {
        return t.space == space && t.url == scored[i].second.second;
      });
      if (!open) {
        add("history", 0, scored[i].second.first, scored[i].second.second);
        seen.insert(scored[i].second.second);
      }
    }
    const auto& archive = State::Get().archive;
    for (size_t i = 0; i < archive.size() && n < 8; ++i)
      if (archive[i].space == space && !seen.count(archive[i].url) &&
          matches(archive[i].title, archive[i].url))
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
  int space = State::Get().active_space;
  for (const auto& [key, page] : State::Get().pages) {
    if (page.space != space) continue;
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
    if (all) hits.push_back({page.indexed_at, &key, first});
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
      if (t.url == page.url && t.space == space) tab_id = t.id;
    auto d = CefDictionaryValue::Create();
    d->SetString("kind", "text");
    d->SetInt("id", tab_id);
    d->SetString("title", page.title);
    d->SetString("url", page.url);
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
  if (d->HasKey("pinnedColumns")) s.pinned_columns = std::clamp(d->GetInt("pinnedColumns"), 0, 8);
  if (d->HasKey("pinnedCentered")) s.pinned_centered = d->GetBool("pinnedCentered");
  if (d->HasKey("cleanLinks")) s.clean_links = d->GetBool("cleanLinks");
  if (d->HasKey("githubFolder")) {
    s.github_folder = d->GetBool("githubFolder");
    if (!s.github_folder) State::Get().github_space = -1;  // Re-enabling binds to that space.
    github_changed = true;
  }
  if (d->HasKey("githubQuery")) {
    s.github_query = d->GetString("githubQuery").ToString();
    github_changed = true;
  }
  if (github_changed) RefreshGitHub();
  if (d->HasKey("gmailFolder")) {
    s.gmail_folder = d->GetBool("gmailFolder");
    if (!s.gmail_folder) State::Get().gmail.clear();
    RefreshGmail();
  }
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
      if (it == indexes_.end() || !tab || tab->id != it->second.tab_id) return false;
      PendingIndex pending = it->second;
      indexes_.erase(it);
      // Store under the URL Roar issued the nonce for, and only if the tab
      // is still there, so a page can't file text under another address.
      bool same_page = frame->IsMain() && tab->url == pending.url &&
                       frame->GetURL().ToString() == pending.url;
      if (same_page && State::Get().settings.index_pages) {
        State::Get().SetPageText(tab->space, pending.url, msg->GetString("title"), msg->GetString("text"));
        SavePagesSoon();
      }
      callback->Success("");
      return true;
    }
    if (cmd != "extract.result") return false;
    auto it = extracts_.find(msg->GetString("nonce").ToString());
    Tab* tab = FindTabByBrowser(browser);
    if (it == extracts_.end() || !tab || tab->id != it->second.tab_id) return false;
    std::string target = it->second.target;
    extracts_.erase(it);
    const Llm* llm = nullptr;
    for (const auto& l : kLlms)
      if (target == l.id) llm = &l;
    std::string markdown = msg->GetString("markdown");
    std::string title = msg->GetString("title");
    int words = int_arg("words");
    if (markdown.empty()) {
      ShowHint("Couldn't find readable text on this page");
    } else if (llm) {
      std::string body = markdown;
      if (body.size() > kLlmMaxChars) {
        body.resize(kLlmMaxChars);
        // Don't leave a split UTF-8 sequence at the cut.
        while (!body.empty() && (static_cast<unsigned char>(body.back()) & 0xC0) == 0x80) body.pop_back();
        if (!body.empty() && static_cast<unsigned char>(body.back()) >= 0xC0) body.pop_back();
        body += "\n\n[Page truncated at " + std::to_string(kLlmMaxChars) + " characters]";
      }
      std::string text = "Page: " + title + "\nURL: " + tab->url + "\n\n```markdown\n" + body +
                         "\n```\n\n";
      platform::CopyText(text);
      int id = NewTab(llm->url, true, false, 0, tab->space, tab->ghost);
      llm_fills_[id] = text;
      ShowHint(std::string("Opening ") + llm->name + ", page also copied");
    } else if (target == "reader") {
      tab->reader_origin = tab->url;
      tab->reader_markdown = markdown;
      tab->reader_title = title;
      Navigate(tab->id, kReaderUrl);
    } else if (target == "save") {
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
    // Only the command bar opened by New Ghost Tab makes one.
    auto bar = command_bar_ ? command_bar_->GetBrowser() : nullptr;
    bool ghost = new_tab && command_ghost_ && bar && bar->IsSame(browser);
    command_ghost_ = false;
    HideCommandBar();
    if (url.empty()) return callback->Success(""), true;
    Tab* tab = ActiveTab();
    // A blank new tab page is reused rather than left behind.
    if (tab && tab->url == kNewTabUrl && tab->ghost == ghost) new_tab = false;
    if (new_tab || !tab) NewTab(url, true, false, 0, -1, ghost);
    else Navigate(tab->id, url);
    callback->Success("");
  } else if (cmd == "folder.open") {
    // A sidebar group's links share one tab per space, listed in that group.
    std::string url = msg->GetString("url");
    std::string folder = msg->GetString("folder");
    HideCommandBar();
    auto it = std::find_if(tabs_.begin(), tabs_.end(), [&](const Tab& t) {
      return !folder.empty() && t.folder == folder && t.space == State::Get().active_space;
    });
    if (it != tabs_.end()) {
      int id = it->id;
      it->folder_item = url;
      Navigate(id, url);
      ActivateTab(id);
    } else if (Tab* t = FindTab(NewTab(url, true))) {
      t->folder = folder;
      t->folder_item = url;
      PushSidebar();
    }
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
  } else if (cmd == "group.create") {
    State& state = State::Get();
    TabGroup g;
    g.id = state.next_group_id++;
    g.name = msg->GetString("name").ToString();
    if (g.name.empty()) g.name = "Group";
    g.color = msg->GetString("color").ToString();
    g.space = state.active_space;
    state.groups.push_back(g);
    if (msg->HasKey("tab")) SetGroup(int_arg("tab"), g.id);
    PushSidebar();
    SaveSoon();
    callback->Success(std::to_string(g.id));
  } else if (cmd == "group.update") {
    if (TabGroup* g = State::Get().FindGroup(int_arg("id"))) {
      if (msg->HasKey("name") && !msg->GetString("name").empty()) g->name = msg->GetString("name");
      if (msg->HasKey("color")) g->color = msg->GetString("color");
      if (msg->HasKey("pinned")) g->pinned = msg->GetBool("pinned");
      if (msg->HasKey("collapsed")) g->collapsed = msg->GetBool("collapsed");
      if (!g->pinned) DropGroupIfEmpty(g->id);
      PushSidebar();
      SaveSoon();
    }
    callback->Success("");
  } else if (cmd == "group.remove") {
    // Ungroups the tabs, or closes them with closeTabs.
    int id = int_arg("id");
    bool close = msg->HasKey("closeTabs") && msg->GetBool("closeTabs");
    std::vector<int> ids;
    for (auto& t : tabs_)
      if (t.group == id) ids.push_back(t.id);
    for (int tab_id : ids) {
      if (close) CloseTab(tab_id);
      else if (Tab* t = FindTab(tab_id)) t->group = 0;
    }
    auto& groups = State::Get().groups;
    groups.erase(std::remove_if(groups.begin(), groups.end(),
                                [&](const TabGroup& g) { return g.id == id; }),
                 groups.end());
    PushSidebar();
    SaveSoon();
    callback->Success("");
  } else if (cmd == "tab.group") {
    SetGroup(int_arg("id"), int_arg("group"));
    callback->Success("");
  } else if (cmd == "tab.icon") {
    std::string icon = msg->GetString("icon");
    // An emoji, an http(s) image or an uploaded image as a data: URL (kept small by the sidebar).
    bool ok = icon.empty() || icon.size() <= 32 ||
              ((StartsWith(icon, "https://") || StartsWith(icon, "http://") ||
                StartsWith(icon, "data:image/")) && icon.size() <= 200 * 1024);
    if (Tab* t = FindTab(int_arg("id")); t && ok) {
      t->icon = icon;
      PushSidebar();
      SaveSoon();
    }
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
    ClearArchive();
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
  } else if (cmd == "sidebar.width") {
    State::Get().settings.sidebar_width = std::clamp(int_arg("width"), kSidebarMin, kSidebarMax);
    ApplySidebarWidth();
    SaveSoon();
    callback->Success("");
  } else if (cmd == "sidebar.resize") {
    // The page starts the drag; native tracking follows it over the tab windows.
    // Native tracking follows the drag over the tab windows, which the page
    // cannot see; lay out once more after the release, found by polling.
    platform::TrackHorizontalDrag(shell_->GetWindowHandle(), [this](int x) {
      State::Get().settings.sidebar_width = std::clamp(x, kSidebarMin, kSidebarMax);
      ApplySidebarWidth();
      if (!sidebar_drag_poll_) {
        sidebar_drag_poll_ = true;
        PollSidebarDragEnd();
      }
    });
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
  } else if (cmd == "space.move") {
    // Reorders the footer dots, and with them ⌃1–⌃9.
    auto& spaces = State::Get().spaces;
    int id = int_arg("id");
    auto it = std::find_if(spaces.begin(), spaces.end(), [&](const Space& s) { return s.id == id; });
    if (it != spaces.end()) {
      Space moved = *it;
      spaces.erase(it);
      size_t index = std::min(static_cast<size_t>(std::max(0, int_arg("index"))), spaces.size());
      spaces.insert(spaces.begin() + index, moved);
      PushSidebar();
      SaveSoon();
    }
    callback->Success("");
  } else if (cmd == "space.rename") {
    RenameSpace(int_arg("id"), msg->GetString("name"));
    callback->Success(StateJson());
  } else if (cmd == "space.color") {
    if (Space* sp = State::Get().FindSpace(int_arg("id"))) {
      std::string color = msg->GetString("color").ToString();
      // Only #rrggbb or empty reaches CSS.
      bool ok = color.empty() || (color.size() == 7 && color[0] == '#' &&
                                  std::all_of(color.begin() + 1, color.end(), ::isxdigit));
      if (ok) sp->color = color;
      PushSidebar();
      SaveSoon();
    }
    callback->Success(StateJson());
  } else if (cmd == "library.get") {
    callback->Success(LibraryJson());
  } else if (cmd == "library.set") {
    // The organizer sends back the whole edited library for the active space.
    auto lib = library::ForSpace(State::Get().active_space);
    if (auto b = msg->GetList("bookmarks")) lib->SetList("bookmarks", b->Copy());
    if (auto r = msg->GetList("readLater")) lib->SetList("readLater", r->Copy());
    library::Save();
    callback->Success("");
  } else if (cmd == "extensions.actions") {
    callback->Success(action_watch::StateJson());
  } else if (cmd == "extensions.list") {
    callback->Success(ExtensionsJson());
  } else if (cmd == "extensions.popup") {
    ShowExtensionPopup(msg->GetString("url"), int_arg("x"), int_arg("y"));
    callback->Success("");
  } else if (cmd == "space.remove") {
    RemoveSpace(int_arg("id"));
    callback->Success(StateJson());
  } else if (cmd == "find") {
    // The find bar's own page: text, direction, and whether to step to the next match.
    Tab* t = FindTab(find_tab_);
    auto b = t && t->view ? t->view->GetBrowser() : nullptr;
    find_text_ = msg->GetString("text");
    if (b && find_text_.empty()) {
      b->GetHost()->StopFinding(true);
      find_count_ = find_active_ = 0;
      OnFindResult(b, 0, 0, 0);
    } else if (b) {
      bool next = msg->HasKey("next") && msg->GetBool("next");
      find_fresh_ = !next;
      b->GetHost()->Find(find_text_, !msg->HasKey("forward") || msg->GetBool("forward"), false, next);
    }
    callback->Success("");
  } else if (cmd == "find.close") {
    HideFind();
    callback->Success("");
  } else if (cmd == "downloads.list") {
    callback->Success(DownloadsJson());
  } else if (cmd == "downloads.cancel" || cmd == "downloads.reveal") {
    int id = int_arg("id");
    for (auto& d : downloads_) {
      if (d.id != id) continue;
      if (cmd == "downloads.cancel" && d.control) d.control->Cancel();
      if (cmd == "downloads.reveal" && d.done) platform::RevealInFinder(d.path);
    }
    callback->Success("");
  } else if (cmd == "downloads.clear") {
    std::erase_if(downloads_, [](const Download& d) { return d.done || d.canceled || d.failed; });
    PushSidebar();
    callback->Success("");
  } else if (cmd == "history.list") {
    callback->Success(HistoryJson(msg->GetString("q")));
  } else if (cmd == "history.remove") {
    State& state = State::Get();
    state.history.erase(SpaceKey(state.active_space, msg->GetString("url")));
    SaveSoon();
    callback->Success("");
  } else if (cmd == "reader.get") {
    // The Reader page asks for the article its own tab extracted.
    Tab* t = FindTabByBrowser(browser);
    auto d = CefDictionaryValue::Create();
    if (t) {
      d->SetString("markdown", t->reader_markdown);
      d->SetString("title", t->reader_title);
      d->SetString("url", t->reader_origin);
    }
    callback->Success(ToJson(Wrap(d)));
  } else if (cmd == "tab.mute") {
    ToggleMute(int_arg("id"));
    callback->Success("");
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
  browsers_[browser->GetIdentifier()] = browser;
  // Web tabs only: Roar's own pages play no sound.
  if (!IsUiBrowser(browser) && !browser->IsPopup() && !IsExtensionPopup(browser))
    MediaWatcher::Attach(browser, &media_watchers_[browser->GetIdentifier()]);
}

void Controller::OnBrowserClosed(CefRefPtr<CefBrowser> browser) {
  --live_browsers_;
  browsers_.erase(browser->GetIdentifier());
  media_watchers_.erase(browser->GetIdentifier());
  MaybeQuit();
}

void Controller::OnTitle(CefRefPtr<CefBrowser> browser, const std::string& title) {
  Tab* tab = FindTabByBrowser(browser);
  if (!tab) return;
  tab->title = title;
  if (auto it = State::Get().history.find(SpaceKey(tab->space, tab->url));
      it != State::Get().history.end())
    it->second.title = title;
  if (tab->id == active_id_ && shell_) shell_->SetTitle(title);
  if (tab->floating && tab->window) platform::SetFloating(tab->window->GetWindowHandle(), true, title);
  PushSidebar();
}

void Controller::OnAddress(CefRefPtr<CefBrowser> browser, const std::string& url) {
  Tab* tab = FindTabByBrowser(browser);
  // A window Chrome's UI opened outside Roar (an extension's chrome.tabs.create):
  // reopen its page as a Roar tab and close the stray window. Only its first
  // address decides. Pages a CDP client opened (Target.createTarget) must stay
  // put: their first reported address is often already the real URL, so ask
  // the DevTools pipe whether a client is attached before taking the page.
  if (!tab && !browser->IsPopup() && !IsExtensionPopup(browser) && !url.empty() && !StartsWith(url, "roar:") &&
      stray_seen_.insert(browser->GetIdentifier()).second && !StartsWith(url, "about:blank")) {
    bool ghost = IsGhostBrowser(browser);
    action_watch::IsPageAttached(url, [browser, url, ghost](bool attached) {
      if (attached || !browser->IsValid()) return;
      Controller::Get()->NewTab(url, true, false, 0, -1, ghost);
      browser->GetHost()->CloseBrowser(true);
    });
    return;
  }
  if (!tab) return;
  tab->url = url;
  if (!tab->reader_origin.empty() && !StartsWith(url, kReaderUrl)) {
    tab->reader_origin.clear();
    tab->reader_markdown.clear();
    tab->reader_title.clear();
  }
  ApplyZoom(browser, url);
  // Opening a message marks it read; refetch once the mail tab settles.
  if (tab->folder == "mail") {
    int gen = ++gmail_refresh_gen_;
    CefPostDelayedTask(TID_UI, base::BindOnce([](int gen) {
      Controller* c = Controller::Get();
      if (gen == c->gmail_refresh_gen_) c->RefreshGmail();
    }, gen), 2500);
  }
  PushSidebar();
  SaveSoon();
}

namespace {
// Swaps a tab's favicon URL for the image itself, fetched by the tab's own browser.
// Sites like claude.ai send Cross-Origin-Resource-Policy: same-origin, so the
// sidebar page cannot load their favicon URL directly.
class FaviconInliner : public CefDownloadImageCallback {
 public:
  FaviconInliner(int tab_id, std::string url) : tab_id_(tab_id), url_(std::move(url)) {}
  void OnDownloadImageFinished(const CefString& image_url, int http_status_code,
                               CefRefPtr<CefImage> image) override {
    if (!image || image->IsEmpty()) return;
    int w = 0, h = 0;
    auto png = image->GetAsPNG(2.0f, true, w, h);
    if (!png || !png->GetSize()) return;
    std::vector<uint8_t> bytes(png->GetSize());
    png->GetData(bytes.data(), bytes.size(), 0);
    Controller::Get()->SetFaviconData(
        tab_id_, url_, "data:image/png;base64," + CefBase64Encode(bytes.data(), bytes.size()).ToString());
  }

 private:
  int tab_id_;
  std::string url_;
  IMPLEMENT_REFCOUNTING(FaviconInliner);
};
}  // namespace

void Controller::OnFavicon(CefRefPtr<CefBrowser> browser, const std::string& url) {
  if (Tab* tab = FindTabByBrowser(browser)) {
    tab->favicon = url;
    PushSidebar();
    if (StartsWith(url, "http"))
      browser->GetHost()->DownloadImage(url, true, 32, false, new FaviconInliner(tab->id, url));
  }
}

void Controller::SetFaviconData(int tab_id, const std::string& url, const std::string& data) {
  Tab* tab = FindTab(tab_id);
  if (!tab || tab->favicon != url) return;  // The page moved on to another icon.
  tab->favicon = data;
  PushSidebar();
  SaveSoon();
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
    ApplyZoom(browser, tab->url);
    if (auto fill = llm_fills_.find(tab->id); fill != llm_fills_.end()) {
      ExecuteScript(tab->id, platform::ReadResource("ui/llm-fill.js") +
                                 "\n;window.__roarFill(" + JsString(fill->second) + ");");
      llm_fills_.erase(fill);
    }
    if (!tab->ghost) {
      State::Get().RecordVisit(tab->space, tab->url, tab->title);
      IndexPage(tab);
    }
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
  if (key == 0x1B && find_visible_ && find_ && find_->GetBrowser() &&
      find_->GetBrowser()->IsSame(browser)) {
    HideFind();
    return true;
  }
  bool ctrl = event.modifiers & EVENTFLAG_CONTROL_DOWN;
  if (ctrl && !cmd && !alt && key == 0x09) {  // ⌃Tab, ⌃⇧Tab: most recently used first
    CycleTabs(shift ? -1 : 1);
    return true;
  }
  // Keys in a floating mini window act on that tab, not the shell's active one.
  if (Tab* t = FindTabByBrowser(browser); t && t->floating && cmd && !ctrl && !alt) {
    if (!shift && (key == 'W' || key == 'R' || key == 0xDB || key == 0xDD)) {
      if (key == 'W') DockTab(t->id);
      else if (key == 'R') browser->Reload();
      else if (key == 0xDB) browser->GoBack();
      else browser->GoForward();
      return true;
    }
    if (shift && key == 'R') {
      browser->ReloadIgnoreCache();
      return true;
    }
    if (shift && key == 'F') {
      DockTab(t->id);
      return true;
    }
  }
  // ⌘W in a window Chrome opened outside Roar closes that window, not Roar's tab.
  if (cmd && !ctrl && !shift && !alt && key == 'W' && !FindTabByBrowser(browser) &&
      !IsUiBrowser(browser) && !IsExtensionPopup(browser)) {
    browser->GetHost()->CloseBrowser(false);
    return true;
  }
  if (ctrl && !cmd && !shift && !alt && key >= '1' && key <= '9') {
    size_t i = static_cast<size_t>(key - '1');
    if (i < State::Get().spaces.size()) SwitchSpace(State::Get().spaces[i].id);
    return true;
  }
  if (ctrl && !cmd && !shift && !alt && key == 'W') {
    CloseActiveUnlessKept();
    return true;
  }
  if (!cmd || ctrl) return false;
  if (!shift && !alt) {
    switch (key) {
      case 'T': ShowCommandBar(true); return true;
      case 'L': ShowCommandBar(false); return true;
      case 'W': CloseActiveUnlessKept(); return true;
      case 'R': Reload(); return true;
      case 0xDB: Back(); return true;     // [
      case 0xDD: Forward(); return true;  // ]
      case 0xBC: OpenSettings(); return true;  // ,
      case 0xDC: ToggleSplit(); return true;   // backslash
      case 'D': if (Tab* t = ActiveTab()) SetPinned(t->id, !t->pinned); return true;
      case 'F': ShowFind(); return true;
      case 'G': FindNext(true); return true;
      case 'P': Print(); return true;
      case 'Y': OpenUiPage(kHistoryUrl); return true;
      case '0': ZoomStep(0); return true;
      case 0xBB: ZoomStep(1); return true;   // =
      case 0xBD: ZoomStep(-1); return true;  // -
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
      case 'C': ExtractActive("copy"); return true;
      case 'R': Reload(true); return true;  // hard reload, bypassing the cache
      case 'K': CleanTabs(); return true;
      case 'P': PictureInPicture(); return true;
      case 'F': FloatActiveTab(); return true;
      case 'G': FindNext(false); return true;
      case 'J': OpenUiPage(kDownloadsUrl); return true;
      case 0xBB: ZoomStep(1); return true;  // ⇧= is +
      case 'T': RunCommand("reopen"); return true;
      case 'N': RunCommand("newGhostTab"); return true;
      case 0xDB: CycleSpace(-1); return true;  // {
      case 0xDD: CycleSpace(1); return true;   // }
    }
  }
  if (alt && !shift && key == 'R') {
    ToggleReader();
    return true;
  }
  if (alt && !shift && key == 'B') {  // ⌘B stays with pages (bold in editors)
    ToggleSidebar();
    return true;
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
    if (t.ghost) continue;
    if (t.id == active_id_) state.active_index = static_cast<int>(state.tabs.size());
    // Large data: favicons would bloat state.json; the page supplies them again on load.
    state.tabs.push_back({!t.reader_origin.empty() ? t.reader_origin : t.pinned && !t.home_url.empty() ? t.home_url : t.url, t.title, t.pinned, t.last_active, t.space, t.group, t.icon,
                          t.favicon.size() <= 16 * 1024 ? t.favicon : ""});
  }
  state.Save();
}

void Controller::ShowExtensionPopup(const std::string& url, int x, int y) {
  CloseExtensionPopup();
  if (!shell_ || !StartsWith(url, "chrome-extension://")) return;
  // Anchor beside the clicked button; |x|,|y| are sidebar coordinates.
  CefPoint at(x, y);
  sidebar_->ConvertPointToScreen(at);
  ext_popup_anchor_ = at;
  int space = State::Get().active_space;
  if (space != 0 && !ready_spaces_.count(space)) return;
  Tab* tab = ActiveTab();
  auto view = CefBrowserView::CreateBrowserView(
      client_, "about:blank", CefBrowserSettings(), nullptr, ContextFor(space),
      new ExtensionPopupViewDelegate(url, tab ? tab->url : ""));
  ext_popup_ = CefWindow::CreateTopLevelWindow(
      new ExtensionPopupDelegate(view, CefRect(at.x, at.y, 25, 25)));
  platform::StyleWindow(ext_popup_->GetWindowHandle(), 10, true);
  ext_popup_->Show();
  platform::AttachChild(shell_->GetWindowHandle(), ext_popup_->GetWindowHandle());
  ext_popup_->Activate();
  view->RequestFocus();
}

void Controller::CloseExtensionPopup() {
  if (!ext_popup_) return;
  auto window = ext_popup_;
  ext_popup_ = nullptr;
  if (shell_) platform::DetachChild(shell_->GetWindowHandle(), window->GetWindowHandle());
  window->Close();
}

void Controller::OnExtensionPopupDestroyed(CefRefPtr<CefWindow> window) {
  if (ext_popup_ && ext_popup_->IsSame(window)) ext_popup_ = nullptr;
}

bool Controller::IsExtensionPopup(CefRefPtr<CefBrowser> browser) {
  if (!ext_popup_) return false;
  auto view = CefBrowserView::GetForBrowser(browser);
  return view && view->GetWindow() && view->GetWindow()->IsSame(ext_popup_);
}

bool Controller::OnExtensionPopupResize(CefRefPtr<CefBrowser> browser, const CefSize& size) {
  if (!IsExtensionPopup(browser)) return false;
  // Hang down from the button, but slide up to stay on screen: pinned
  // buttons sit at the bottom of the sidebar.
  CefRect work = CefDisplay::GetDisplayNearestPoint(ext_popup_anchor_, false)->GetWorkArea();
  int x = std::min(ext_popup_anchor_.x, work.x + work.width - size.width);
  int y = std::max(work.y, std::min(ext_popup_anchor_.y, work.y + work.height - size.height));
  ext_popup_->SetBounds(CefRect(x, y, size.width, size.height));
  return true;
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
  if (find_window_) find_window_->Close();
  CloseExtensionPopup();
  // Windows Chrome opened outside Roar (a CDP client's Target.createTarget)
  // otherwise keep the process alive after the shell closes.
  auto strays = browsers_;
  for (auto& [id, b] : strays)
    if (!FindTabByBrowser(b)) b->GetHost()->CloseBrowser(true);
  // A browser that never reports closing (a stray popup, a CDP-created page, a
  // page stuck in beforeunload) would keep MaybeQuit waiting forever. State is
  // saved above, so quit regardless after a grace period.
  CefPostDelayedTask(TID_UI, base::BindOnce([] { CefQuitMessageLoop(); }), 3000);
  // A Chrome window can hold the message loop open even then; state is saved.
  CefPostDelayedTask(TID_UI, base::BindOnce([] { _exit(0); }), 8000);
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
  find_ = nullptr;
  find_window_ = nullptr;
  tabs_.clear();
  MaybeQuit();
}

void Controller::MaybeQuit() {
  if (closing_ && !shell_ && live_browsers_ <= 0) CefQuitMessageLoop();
}

void Controller::OpenExternal(const std::string& url) {
  // The shell, not the tab: a sheet on the frameless tab child window never shows.
  if (!platform::OpenInApp(shell_ ? shell_->GetWindowHandle() : nullptr, url))
    ShowHint("No app can open this link");
}

}  // namespace roar
