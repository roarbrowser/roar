#include "client.h"

#include "include/cef_parser.h"
#include "include/wrapper/cef_helpers.h"

#include "controller.h"
#include "shared.h"
#include "state.h"

#include <set>

namespace roar {

namespace {

class QueryHandler : public CefMessageRouterBrowserSide::Handler {
 public:
  bool OnQuery(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame, int64_t query_id,
               const CefString& request, bool persistent,
               CefRefPtr<Callback> callback) override {
    return Controller::Get()->HandleQuery(browser, frame, request, callback);
  }
};

}  // namespace

Client::Client() {
  router_ = CefMessageRouterBrowserSide::Create(RouterConfig());
  handler_ = std::make_unique<QueryHandler>();
  router_->AddHandler(handler_.get(), false);
}

bool Client::OnProcessMessageReceived(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                                      CefProcessId source_process,
                                      CefRefPtr<CefProcessMessage> message) {
  return router_->OnProcessMessageReceived(browser, frame, source_process, message);
}

// A Gmail tab running mail-act.js asks for a real click (Gmail ignores scripted
// ones): "__roar_click__ <x> <y>" in CSS pixels.
bool Client::OnConsoleMessage(CefRefPtr<CefBrowser> browser, cef_log_severity_t level, const CefString& message,
                              const CefString& source, int line) {
  static const std::string kPrefix = "__roar_click__ ";
  std::string text = message.ToString();
  if (text.rfind(kPrefix, 0) != 0) return false;
  double x = 0, y = 0;
  if (sscanf(text.c_str() + kPrefix.size(), "%lf %lf", &x, &y) == 2) Controller::Get()->OnMailClick(browser, x, y);
  return true;
}

void Client::OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title) {
  Controller::Get()->OnTitle(browser, title);
}

void Client::OnAddressChange(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                             const CefString& url) {
  if (frame->IsMain()) Controller::Get()->OnAddress(browser, url);
}

void Client::OnFaviconURLChange(CefRefPtr<CefBrowser> browser,
                                const std::vector<CefString>& icon_urls) {
  Controller::Get()->OnFavicon(browser, icon_urls.empty() ? "" : icon_urls[0].ToString());
}

void Client::OnDraggableRegionsChanged(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                                       const std::vector<CefDraggableRegion>& regions) {
  Controller::Get()->OnDraggableRegions(browser, regions);
}

void Client::OnBeforeContextMenu(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                                 CefRefPtr<CefContextMenuParams> params,
                                 CefRefPtr<CefMenuModel> model) {
  Controller::Get()->BuildContextMenu(browser, params, model);
}

bool Client::OnContextMenuCommand(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                                  CefRefPtr<CefContextMenuParams> params, int command_id,
                                  EventFlags event_flags) {
  return Controller::Get()->OnContextMenuCommand(browser, params, command_id);
}

bool Client::OnBeforeDownload(CefRefPtr<CefBrowser> browser, CefRefPtr<CefDownloadItem> item,
                              const CefString& suggested_name,
                              CefRefPtr<CefBeforeDownloadCallback> callback) {
  return Controller::Get()->OnBeforeDownload(browser, item, suggested_name, callback);
}

void Client::OnDownloadUpdated(CefRefPtr<CefBrowser> browser, CefRefPtr<CefDownloadItem> item,
                               CefRefPtr<CefDownloadItemCallback> callback) {
  Controller::Get()->OnDownloadUpdated(item, callback);
}

void Client::OnFindResult(CefRefPtr<CefBrowser> browser, int identifier, int count,
                          const CefRect& selectionRect, int activeMatchOrdinal,
                          bool finalUpdate) {
  Controller::Get()->OnFindResult(browser, identifier, count, activeMatchOrdinal);
}

bool Client::OnAutoResize(CefRefPtr<CefBrowser> browser, const CefSize& new_size) {
  return Controller::Get()->OnExtensionPopupResize(browser, new_size);
}

bool Client::OnPreKeyEvent(CefRefPtr<CefBrowser> browser, const CefKeyEvent& event,
                           CefEventHandle os_event, bool* is_keyboard_shortcut) {
  return Controller::Get()->OnKey(browser, event);
}

namespace {
bool IsDuckDuckGoResults(const std::string& url) {
  for (const char* prefix : {"https://duckduckgo.com/?", "https://www.duckduckgo.com/?",
                             "https://html.duckduckgo.com/", "https://lite.duckduckgo.com/"})
    if (url.rfind(prefix, 0) == 0) return true;
  return false;
}
}  // namespace

bool Client::OnBeforePopup(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                           int popup_id, const CefString& target_url,
                           const CefString& target_frame_name,
                           WindowOpenDisposition target_disposition, bool user_gesture,
                           const CefPopupFeatures& popupFeatures, CefWindowInfo& windowInfo,
                           CefRefPtr<CefClient>& client, CefBrowserSettings& settings,
                           CefRefPtr<CefDictionaryValue>& extra_info,
                           bool* no_javascript_access) {
  // A DuckDuckGo result opens in place, even with DuckDuckGo's "open in new tab"
  // setting on; ⌘-click still asks for a background tab.
  if (target_disposition == CEF_WOD_NEW_FOREGROUND_TAB && frame && frame->IsMain() &&
      IsDuckDuckGoResults(frame->GetURL())) {
    frame->LoadURL(target_url);
    return true;
  }
  switch (target_disposition) {
    case CEF_WOD_NEW_FOREGROUND_TAB:
    case CEF_WOD_NEW_BACKGROUND_TAB:
    case CEF_WOD_NEW_WINDOW:
    case CEF_WOD_SINGLETON_TAB:
    {
      // Links from a ghost tab open as ghost tabs.
      Controller::Get()->NewTabFrom(browser, target_url,
                                    target_disposition != CEF_WOD_NEW_BACKGROUND_TAB);
    }
      return true;
    default:
      // Scripted popups (sign-in flows, document picture-in-picture) keep
      // their opener and get a default window.
      return false;
  }
}

void Client::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  Controller::Get()->OnBrowserCreated(browser);
}

void Client::OnBeforeClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  router_->OnBeforeClose(browser);
  Controller::Get()->OnBrowserClosed(browser);
}

void Client::OnLoadingStateChange(CefRefPtr<CefBrowser> browser, bool isLoading, bool canGoBack,
                                  bool canGoForward) {
  Controller::Get()->OnLoading(browser, isLoading, canGoBack, canGoForward);
}

bool Client::OnBeforeBrowse(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                            CefRefPtr<CefRequest> request, bool user_gesture, bool is_redirect) {
  router_->OnBeforeBrowse(browser, frame);
  CefURLParts parts;
  std::string url = request->GetURL();
  if (CefParseURL(url, parts)) {
    static const std::set<std::string> kBrowserSchemes = {
        "http", "https", "file", "about", "data", "blob", "javascript", "chrome",
        "chrome-extension", "devtools", "roar", "view-source", "ws", "wss", "ftp", "filesystem"};
    std::string scheme = CefString(&parts.scheme).ToString();
    if (!kBrowserSchemes.count(scheme)) {
      // Chromium only shows ERR_UNKNOWN_URL_SCHEME; ask before handing it to a Mac app.
      if (user_gesture || is_redirect || frame->IsMain()) Controller::Get()->OpenExternal(url);
      // A popup opened only to hand off a link (Outlook's "Edit in Excel desktop
      // app") would stay a blank window.
      std::string current = frame->GetURL();
      if (frame->IsMain() && browser->IsPopup() &&
          (current.empty() || current.rfind("about:blank", 0) == 0))
        browser->GetHost()->CloseBrowser(true);
      return true;
    }
  }
  return false;
}

void Client::OnRenderProcessTerminated(CefRefPtr<CefBrowser> browser, TerminationStatus status,
                                       int error_code, const CefString& error_string) {
  router_->OnRenderProcessTerminated(browser);
}

}  // namespace roar
