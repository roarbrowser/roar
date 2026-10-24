#include "browser_app.h"

#include <filesystem>
#include <fstream>
#include <sstream>

#include "include/cef_parser.h"
#include "include/cef_scheme.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_stream_resource_handler.h"

#include "action_watch.h"
#include "controller.h"
#include "ext_paths.h"
#include "platform.h"
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
  if (ends(".txt")) return "text/plain; charset=utf-8";
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
    path = CefURIDecode(path, true, static_cast<cef_uri_unescape_rule_t>(UU_SPACES | UU_PATH_SEPARATORS |
                                                                           UU_URL_SPECIAL_CHARS_EXCEPT_PATH_SEPARATORS)).ToString();
    // The license notices live beside ui/ in Resources (the app folder on Windows).
    bool notice = path == "THIRD_PARTY_NOTICES.txt" || path == "CREDITS.html";
    std::string file = platform::ResourcePath(notice ? path : "ui/" + path);
    if (!notice) {  // The decoded, canonical path must stay under ui/.
      std::error_code ec;
      auto root = std::filesystem::weakly_canonical(platform::ResourcePath("ui"), ec);
      auto real = std::filesystem::weakly_canonical(file, ec);
      auto rel = real.lexically_relative(root);
      if (ec || rel.empty() || *rel.begin() == "..") return nullptr;
    }
    auto stream = CefStreamReader::CreateForFile(file);
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


// Copies the bundled uBOL to <data>/ubol when its manifest differs, so an
// app update refreshes it. The fixed path keeps the unpacked extension id stable.
std::string StageUbol() {
  namespace fs = std::filesystem;
  fs::path src = platform::ResourcePath("extensions/ubol");
  fs::path dst = fs::path(State::Get().Dir()) / "ubol";
  std::error_code ec;
  if (ReadFile((src / "manifest.json").string()) != ReadFile((dst / "manifest.json").string())) {
    fs::remove_all(dst, ec);
    fs::create_directories(dst.parent_path(), ec);
    fs::copy(src, dst, fs::copy_options::recursive, ec);
    // A partial copy would match the manifest and be reused for good; the bundle copy must stay
    // unwritten (Chromium indexes rulesets into it, breaking the signature). Skip uBOL this launch.
    if (ec) return fs::remove_all(dst, ec), "";
  }
  return dst.string();
}

void BrowserApp::OnRegisterCustomSchemes(CefRawPtr<CefSchemeRegistrar> registrar) {
  RegisterSchemes(registrar);
}

void BrowserApp::OnBeforeCommandLineProcessing(const CefString& process_type,
                                               CefRefPtr<CefCommandLine> command_line) {
  if (!process_type.empty()) return;
  // No remote-allow-origins: CDP clients such as chrome-devtools-mcp send no Origin
  // header and connect anyway, while web pages (which always send one) are refused.
  // --headless means Roar's hidden mode, not Chrome's: Chrome's headless mode
  // has no native window the menu bar icon could bring forward. The hidden
  // windows keep rendering at full speed for CDP clients.
  if (command_line->HasSwitch("headless")) {
    command_line->RemoveSwitch("headless");
    command_line->AppendSwitch("disable-backgrounding-occluded-windows");
    command_line->AppendSwitch("disable-renderer-backgrounding");
    command_line->AppendSwitch("disable-background-timer-throttling");
  }
  // Remote debugging makes Chromium report navigator.webdriver = true, which
  // bot checks such as Cloudflare's block. Roar is a real browser, so hide it.
  command_line->AppendSwitchWithValue("disable-blink-features", "AutomationControlled");
  // Mock keychain avoids the "Chromium Safe Storage" prompt for an unsigned build.
  command_line->AppendSwitch("use-mock-keychain");
  // Private DevTools pipe for extension action state (action_watch.h).
  if (action_watch::Enabled()) command_line->AppendSwitch("remote-debugging-pipe");
  // Bundled uBlock Origin Lite: blocks ads and defuses anti-adblock scripts.
  // Chromium writes indexed rulesets into an unpacked extension's folder, so
  // load a copy from the data dir and keep the signed bundle untouched.
  // Keep any --load-extension the user passed: this switch replaces, not adds.
  std::string extensions = JoinExtensionPaths(
      {command_line->GetSwitchValue("load-extension").ToString(), StageUbol()});
  command_line->RemoveSwitch("load-extension");
  if (!extensions.empty()) command_line->AppendSwitchWithValue("load-extension", extensions);
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
