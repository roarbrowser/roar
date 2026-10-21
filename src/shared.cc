#include "shared.h"

namespace roar {

CefMessageRouterConfig RouterConfig() {
  CefMessageRouterConfig config;
  config.js_query_function = "roarQuery";
  config.js_cancel_function = "roarQueryCancel";
  return config;
}

// The Chrome Web Store nags non-Google Chromium builds with "Switch to Chrome?".
// Spoofing the brand hints doesn't stop it, so Roar dismisses the nag instead.
bool IsWebStore(const std::string& url) {
  return url.rfind("https://chromewebstore.google.com/", 0) == 0;
}

void RegisterSchemes(CefRawPtr<CefSchemeRegistrar> registrar) {
  // No CORS or fetch access: web pages have no business reading Roar's UI.
  registrar->AddCustomScheme(kScheme, CEF_SCHEME_OPTION_STANDARD | CEF_SCHEME_OPTION_SECURE);
}

void RendererApp::OnWebKitInitialized() {
  router_ = CefMessageRouterRendererSide::Create(RouterConfig());
}

void RendererApp::OnContextCreated(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                                   CefRefPtr<CefV8Context> context) {
  router_->OnContextCreated(browser, frame, context);
  if (!frame->IsMain() || !IsWebStore(frame->GetURL().ToString())) return;
  frame->ExecuteJavaScript(
      "new MutationObserver(() => {"
      " for (const d of document.querySelectorAll('[role=dialog]'))"
      "  if (d.innerText.startsWith('Switch to Chrome?'))"
      "   [...d.querySelectorAll('button')].find((b) => b.innerText.trim() === 'No thanks')?.click();"
      " for (const e of document.querySelectorAll('div'))"
      "  if (!e.children.length && e.textContent.startsWith('Switch to Chrome to install')) e.style.display = 'none';"
      "}).observe(document, {childList: true, subtree: true});",
      frame->GetURL(), 0);
}

void RendererApp::OnContextReleased(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                                    CefRefPtr<CefV8Context> context) {
  router_->OnContextReleased(browser, frame, context);
}

bool RendererApp::OnProcessMessageReceived(CefRefPtr<CefBrowser> browser,
                                           CefRefPtr<CefFrame> frame,
                                           CefProcessId source_process,
                                           CefRefPtr<CefProcessMessage> message) {
  return router_->OnProcessMessageReceived(browser, frame, source_process, message);
}

}  // namespace roar
