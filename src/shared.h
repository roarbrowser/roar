// Code shared by the browser process and the helper processes.
#pragma once

#include "include/cef_app.h"
#include "include/wrapper/cef_message_router.h"

namespace roar {

// Internal UI is served from roar://ui/<file>.
inline constexpr char kScheme[] = "roar";
inline constexpr char kUiOrigin[] = "roar://ui/";

CefMessageRouterConfig RouterConfig();
void RegisterSchemes(CefRawPtr<CefSchemeRegistrar> registrar);

// CefApp used by helper processes: scheme registration plus the renderer side
// of the message router, which exposes window.roarQuery to every frame.
class RendererApp : public CefApp, public CefRenderProcessHandler {
 public:
  RendererApp() = default;

  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override {
    RegisterSchemes(registrar);
  }
  CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override { return this; }

  void OnWebKitInitialized() override;
  void OnContextCreated(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                        CefRefPtr<CefV8Context> context) override;
  void OnContextReleased(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                         CefRefPtr<CefV8Context> context) override;
  bool OnProcessMessageReceived(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                                CefProcessId source_process,
                                CefRefPtr<CefProcessMessage> message) override;

 private:
  CefRefPtr<CefMessageRouterRendererSide> router_;
  IMPLEMENT_REFCOUNTING(RendererApp);
};

}  // namespace roar
