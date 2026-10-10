#include "browser_app.h"

#include "include/cef_scheme.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_stream_resource_handler.h"

#include "controller.h"
#include "mac/platform.h"
#include "shared.h"

namespace roar {

namespace {

std::string MimeFor(const std::string& path) {
  auto ends = [&](const char* s) {
    std::string e(s);
    return path.size() >= e.size() && path.compare(path.size() - e.size(), e.size(), e) == 0;
  };
  if (ends(".html")) return "text/html";
  if (ends(".css")) return "text/css";
  if (ends(".js")) return "text/javascript";
  if (ends(".svg")) return "image/svg+xml";
  if (ends(".png")) return "image/png";
  return "application/octet-stream";
}

// Serves files from Roar.app/Contents/Resources/ui for roar://ui/<file>.
class UiSchemeFactory : public CefSchemeHandlerFactory {
 public:
  CefRefPtr<CefResourceHandler> Create(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                                       const CefString& scheme_name,
                                       CefRefPtr<CefRequest> request) override {
    std::string url = request->GetURL();
    std::string path = url.substr(std::string(kUiOrigin).size());
    path = path.substr(0, path.find_first_of("?#"));
    if (path.empty()) path = "welcome.html";
    if (path.find("..") != std::string::npos) return nullptr;
    auto stream = CefStreamReader::CreateForFile(platform::ResourcePath("ui/" + path));
    if (!stream) return nullptr;
    return new CefStreamResourceHandler(MimeFor(path), stream);
  }

 private:
  IMPLEMENT_REFCOUNTING(UiSchemeFactory);
};

}  // namespace

void BrowserApp::OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) {
  RegisterSchemes(registrar);
}

void BrowserApp::OnBeforeCommandLineProcessing(const CefString& process_type,
                                               CefRefPtr<CefCommandLine> command_line) {
  if (!process_type.empty()) return;
  // CDP clients such as chrome-devtools-mcp connect without an Origin header,
  // but allow the local DevTools front-end too.
  if (!command_line->HasSwitch("remote-allow-origins"))
    command_line->AppendSwitchWithValue("remote-allow-origins", "http://127.0.0.1");
  // Mock keychain avoids the "Chromium Safe Storage" prompt for an unsigned build.
  command_line->AppendSwitch("use-mock-keychain");
}

void BrowserApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();
  CefRegisterSchemeHandlerFactory(kScheme, "ui", new UiSchemeFactory());
  Controller::Get()->Start();
}

bool BrowserApp::OnAlreadyRunningAppRelaunch(CefRefPtr<CefCommandLine> command_line,
                                             const CefString& current_directory) {
  CefCommandLine::ArgumentList args;
  command_line->GetArguments(args);
  for (const auto& a : args) Controller::Get()->NewTab(a, true);
  if (args.empty()) Controller::Get()->Focus();
  return true;
}

}  // namespace roar
