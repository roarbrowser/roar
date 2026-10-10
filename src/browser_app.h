// CefApp for the browser process.
#pragma once

#include "include/cef_app.h"

namespace roar {

class BrowserApp : public CefApp, public CefBrowserProcessHandler {
 public:
  BrowserApp() = default;

  void OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) override;
  void OnBeforeCommandLineProcessing(const CefString& process_type,
                                     CefRefPtr<CefCommandLine> command_line) override;
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }
  void OnContextInitialized() override;
  bool OnAlreadyRunningAppRelaunch(CefRefPtr<CefCommandLine> command_line,
                                   const CefString& current_directory) override;

 private:
  IMPLEMENT_REFCOUNTING(BrowserApp);
};

}  // namespace roar
