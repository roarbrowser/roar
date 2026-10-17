// Windows entry point. One roar.exe serves as browser and every subprocess (CEF's
// Windows model), so there is no separate helper app. Mirrors src/mac/main.mm.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

#include "include/cef_app.h"
#include "include/cef_parser.h"

#include "action_watch.h"
#include "browser_app.h"
#include "platform.h"
#include "shared.h"
#include "state.h"

namespace fs = std::filesystem;

namespace {

// Chrome style starts the global context in Local State's last-used profile, which a
// ghost or Space context can claim; space 0 must stay Default (see src/mac/main.mm).
void ResetLastUsedProfile(const fs::path& root) {
  fs::path local_state = root / "Local State";
  std::ifstream in(local_state, std::ios::binary);
  if (!in) return;
  std::stringstream ss;
  ss << in.rdbuf();
  in.close();
  CefRefPtr<CefValue> json = CefParseJSON(ss.str(), JSON_PARSER_RFC);
  auto dict = json ? json->GetDictionary() : nullptr;
  auto profile = dict ? dict->GetDictionary("profile") : nullptr;
  if (!profile || profile->GetString("last_used") == "Default") return;
  profile->SetString("last_used", "Default");
  auto active = CefListValue::Create();
  active->SetString(0, "Default");
  profile->SetList("last_active_profiles", active);
  std::ofstream(local_state, std::ios::binary) << CefWriteJSON(json, JSON_WRITER_DEFAULT).ToString();
}

}  // namespace

int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int) {
  CefMainArgs main_args(instance);
  // Subprocesses (renderer, GPU, utility) exit here.
  CefRefPtr<roar::RendererApp> renderer(new roar::RendererApp());
  int code = CefExecuteProcess(main_args, renderer, nullptr);
  if (code >= 0) return code;

  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; i < argc; ++i)
    if (!wcsncmp(argv[i], L"--instance=", 11) && argv[i][11]) _wputenv_s(L"ROAR_INSTANCE", argv[i] + 11);
  LocalFree(argv);
  roar::action_watch::PrepareMain();

  CefSettings settings;
  // TODO(windows): the sandbox needs cef_sandbox.lib linked and CefScopedSandboxInfo here.
  settings.no_sandbox = true;
  std::string data_dir = roar::State::Get().Dir();
  for (int n = 2; !roar::platform::ClaimInstance(data_dir); ++n) {
    if (getenv("ROAR_DATA_DIR") || n > 50) return 0;
    _putenv_s("ROAR_INSTANCE", std::to_string(n).c_str());
    data_dir = roar::State::Get().Dir();
  }
  if (roar::platform::CdpEnabled()) settings.remote_debugging_port = roar::platform::CdpPort();

  fs::path root = fs::u8path(data_dir);
  std::error_code ec;
  fs::remove_all(root / "Default" / "Sessions", ec);
  ResetLastUsedProfile(root);
  for (const auto& e : fs::directory_iterator(root, ec)) {
    std::string name = e.path().filename().u8string();
    if (name.rfind("Ghost-", 0) == 0) fs::remove_all(e.path(), ec);
    else if (name.rfind("Space-", 0) == 0) fs::remove_all(e.path() / "Sessions", ec);
  }
  CefString(&settings.root_cache_path) = data_dir;
  settings.persist_session_cookies = true;

  CefRefPtr<roar::BrowserApp> app(new roar::BrowserApp());
  if (!CefInitialize(main_args, settings, app.get(), nullptr)) return CefGetExitCode();
  CefRunMessageLoop();
  CefShutdown();
  return 0;
}
