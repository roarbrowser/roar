#include "browser_app.h"

#include <filesystem>
#include <fstream>
#include <sstream>

#include "include/cef_scheme.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_stream_resource_handler.h"

#include "controller.h"
#include "mac/platform.h"
#include "shared.h"
#include "state.h"

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
    // Refuse to be framed, so a web page cannot embed (and clickjack) Roar UI.
    CefResponse::HeaderMap headers;
    headers.insert({"Content-Security-Policy", "frame-ancestors 'none'"});
    headers.insert({"X-Frame-Options", "DENY"});
    return new CefStreamResourceHandler(200, "OK", MimeFor(path), headers, stream);
  }

 private:
  IMPLEMENT_REFCOUNTING(UiSchemeFactory);
};

}  // namespace

CefRefPtr<CefSchemeHandlerFactory> NewUiSchemeFactory() { return new UiSchemeFactory(); }

namespace {

std::string Slurp(const std::filesystem::path& p) {
  std::ifstream in(p);
  std::stringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

}  // namespace

// Copies the bundled uBOL to <data>/ubol when its manifest differs, so an
// app update refreshes it. The fixed path keeps the unpacked extension id stable.
std::string StageUbol() {
  namespace fs = std::filesystem;
  fs::path src = platform::ResourcePath("extensions/ubol");
  fs::path dst = fs::path(State::Get().Dir()) / "ubol";
  std::error_code ec;
  if (Slurp(src / "manifest.json") != Slurp(dst / "manifest.json")) {
    fs::remove_all(dst, ec);
    fs::create_directories(dst.parent_path(), ec);
    fs::copy(src, dst, fs::copy_options::recursive, ec);
    if (ec) return src.string();
  }
  return dst.string();
}

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
  // Bundled uBlock Origin Lite: blocks ads and defuses anti-adblock scripts.
  // Chromium writes indexed rulesets into an unpacked extension's folder, so
  // load a copy from the data dir and keep the signed bundle untouched.
  command_line->AppendSwitchWithValue("load-extension", StageUbol());
}

void BrowserApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();
  CefRegisterSchemeHandlerFactory(kScheme, "ui", NewUiSchemeFactory());
  Controller::Get()->Start();
}

CefRefPtr<CefClient> BrowserApp::GetDefaultClient() { return Controller::Get()->client(); }

bool BrowserApp::OnAlreadyRunningAppRelaunch(CefRefPtr<CefCommandLine> command_line,
                                             const CefString& current_directory) {
  CefCommandLine::ArgumentList args;
  command_line->GetArguments(args);
  for (const auto& a : args) Controller::Get()->NewTab(a, true);
  if (args.empty()) Controller::Get()->Focus();
  return true;
}

}  // namespace roar
