// CefApp for the browser process.
#pragma once

#include "include/cef_app.h"
#include "include/cef_scheme.h"

namespace roar {

// Serves roar://ui/. Each space's request context needs its own registration;
// the global one covers only space 0.
CefRefPtr<CefSchemeHandlerFactory> NewUiSchemeFactory();

class BrowserApp : public CefApp, public CefBrowserProcessHandler {
 public:
  BrowserApp() = default;

  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override;
  void OnBeforeCommandLineProcessing(const CefString& process_type,
                                     CefRefPtr<CefCommandLine> command_line) override;
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }
  void OnContextInitialized() override;
  // Windows Chrome's own UI opens (an extension's chrome.tabs.create, say) get
  // Roar's client so Controller can turn them into Roar tabs.
  CefRefPtr<CefClient> GetDefaultClient() override;
  bool OnAlreadyRunningAppRelaunch(CefRefPtr<CefCommandLine> command_line,
                                   const CefString& current_directory) override;

 private:
  IMPLEMENT_REFCOUNTING(BrowserApp);
};

}  // namespace roar
