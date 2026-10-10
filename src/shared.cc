#include "shared.h"

namespace roar {

CefMessageRouterConfig RouterConfig() {
  CefMessageRouterConfig config;
  config.js_query_function = "roarQuery";
  config.js_cancel_function = "roarQueryCancel";
  return config;
}

void RegisterSchemes(CefRawPtr<CefSchemeRegistrar> registrar) {
  registrar->AddCustomScheme(kScheme, CEF_SCHEME_OPTION_STANDARD | CEF_SCHEME_OPTION_SECURE |
                                          CEF_SCHEME_OPTION_CORS_ENABLED |
                                          CEF_SCHEME_OPTION_FETCH_ENABLED);
}

void RendererApp::OnWebKitInitialized() {
  router_ = CefMessageRouterRendererSide::Create(RouterConfig());
}

void RendererApp::OnContextCreated(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                                   CefRefPtr<CefV8Context> context) {
  router_->OnContextCreated(browser, frame, context);
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
