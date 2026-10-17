// Windows implementation of src/platform.h. Untested: written on macOS without a
// Windows compiler; see docs/windows-port.md for what still needs a Windows machine.
// Strings in the interface are UTF-8; everything crossing into Win32 goes through W().
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <bcrypt.h>
#include <iphlpapi.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shobjidl.h>
#include <tcpmib.h>

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <thread>

#include "platform.h"

#include "include/base/cef_callback.h"
#include "include/cef_parser.h"
#include "include/cef_task.h"
#include "include/wrapper/cef_closure_task.h"

#include "controller.h"
#include "state.h"

namespace fs = std::filesystem;

namespace roar::platform {
namespace {

std::wstring W(const std::string& s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), n);
  return w;
}

std::string U(const std::wstring& w) {
  if (w.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
  return s;
}

HWND Hwnd(void* handle) { return static_cast<HWND>(handle); }

void OnUi(base::OnceClosure closure) { CefPostTask(TID_UI, std::move(closure)); }

std::string ExeDir() {
  wchar_t path[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, path, MAX_PATH);
  return U(fs::path(std::wstring(path, n)).parent_path().wstring());
}

std::string KnownFolder(REFKNOWNFOLDERID id) {
  PWSTR p = nullptr;
  std::string out;
  if (SUCCEEDED(SHGetKnownFolderPath(id, 0, nullptr, &p))) out = U(p);
  CoTaskMemFree(p);
  return out;
}

// Quotes one argument for CreateProcess the way CommandLineToArgvW parses it back.
std::wstring Quote(const std::wstring& arg) {
  if (!arg.empty() && arg.find_first_of(L" \t\"") == std::wstring::npos) return arg;
  std::wstring q = L"\"";
  for (size_t i = 0;; ++i) {
    size_t slashes = 0;
    while (i < arg.size() && arg[i] == L'\\') ++i, ++slashes;
    if (i == arg.size()) { q.append(slashes * 2, L'\\'); break; }
    if (arg[i] == L'"') q.append(slashes * 2 + 1, L'\\');
    else q.append(slashes, L'\\');
    q.push_back(arg[i]);
  }
  return q + L"\"";
}

// Runs |exe| with |args| hidden, waits, and returns its exit code (-1 if it never started).
int RunTool(const std::string& exe, const std::vector<std::string>& args, std::string* out, std::string* err) {
  SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, TRUE};
  HANDLE out_r, out_w, err_r, err_w;
  if (!CreatePipe(&out_r, &out_w, &sa, 0)) return -1;
  if (!CreatePipe(&err_r, &err_w, &sa, 0)) { CloseHandle(out_r); CloseHandle(out_w); return -1; }
  SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(err_r, HANDLE_FLAG_INHERIT, 0);
  std::wstring cmd = Quote(W(exe));
  for (const auto& a : args) cmd += L" " + Quote(W(a));
  STARTUPINFOW si{sizeof si};
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdOutput = out_w;
  si.hStdError = err_w;
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  PROCESS_INFORMATION pi{};
  BOOL started = CreateProcessW(W(exe).c_str(), cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr,
                                nullptr, &si, &pi);
  CloseHandle(out_w);
  CloseHandle(err_w);
  auto drain = [](HANDLE h, std::string* to) {
    char buf[4096];
    DWORD n;
    while (ReadFile(h, buf, sizeof buf, &n, nullptr) && n) if (to) to->append(buf, n);
    CloseHandle(h);
  };
  std::thread e(drain, err_r, err);
  drain(out_r, out);
  e.join();
  if (!started) return -1;
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hProcess);
  CloseHandle(pi.hThread);
  return static_cast<int>(code);
}

// The first |name| (.exe/.cmd) on PATH, else "".
std::string Which(const std::string& name) {
  for (const char* ext : {".exe", ".cmd"}) {
    wchar_t found[MAX_PATH];
    if (SearchPathW(nullptr, W(name).c_str(), W(ext).c_str(), MAX_PATH, found, nullptr)) return U(found);
  }
  return "";
}

bool PortFree(int port) {
  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);
  SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
  if (s == INVALID_SOCKET) return false;
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<u_short>(port));
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  bool ok = bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof addr) == 0;
  closesocket(s);
  return ok;
}

std::string MainDataDir() { return KnownFolder(FOLDERID_RoamingAppData) + "\\Roar"; }
std::string InstanceDir(const std::string& name) { return MainDataDir() + "-" + name; }

// The instance lock is a named mutex keyed by the data dir (a mutex name can't contain '\').
std::wstring MutexName(const std::string& dir) {
  std::wstring key = W(dir);
  for (auto& c : key)
    if (c == L'\\' || c == L'/' || c == L':') c = L'_';
  return L"Local\\Roar-instance-" + key;
}

bool InstanceRunning(const std::string& dir) {
  HANDLE m = OpenMutexW(SYNCHRONIZE, FALSE, MutexName(dir).c_str());
  if (!m) return false;
  CloseHandle(m);
  return true;
}

void Spawn(const std::wstring& exe, const std::vector<std::wstring>& args) {
  std::wstring cmd = Quote(exe);
  for (const auto& a : args) cmd += L" " + Quote(a);
  STARTUPINFOW si{sizeof si};
  PROCESS_INFORMATION pi{};
  if (CreateProcessW(exe.c_str(), cmd.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
  }
}

std::wstring SelfExe() {
  wchar_t path[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, path, MAX_PATH);
  return std::wstring(path, n);
}

}  // namespace

std::string ResourcePath(const std::string& relative) { return ExeDir() + "\\" + relative; }

std::string ReadResource(const std::string& relative) {
  std::ifstream f(fs::path(W(ResourcePath(relative))), std::ios::binary);
  std::stringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

std::string RandomToken() {
  unsigned char bytes[16];
  BCryptGenRandom(nullptr, bytes, sizeof bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  std::string hex;
  char buf[3];
  for (unsigned char b : bytes) {
    snprintf(buf, sizeof buf, "%02x", b);
    hex += buf;
  }
  return hex;
}

std::string SafariBookmarksJson() { return ""; }  // No Safari on Windows.

// Chromium hashes the UTF-16LE path on Windows (extensions/common/id_util.cc).
std::string UnpackedExtensionId(const std::string& path) {
  std::wstring w = W(path);
  BCRYPT_ALG_HANDLE alg;
  unsigned char digest[32] = {};
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0) {
    BCryptHash(alg, nullptr, 0, reinterpret_cast<PUCHAR>(w.data()), static_cast<ULONG>(w.size() * 2), digest,
               sizeof digest);
    BCryptCloseAlgorithmProvider(alg, 0);
  }
  std::string id;
  for (int i = 0; i < 16; ++i) {
    id += static_cast<char>('a' + (digest[i] >> 4));
    id += static_cast<char>('a' + (digest[i] & 15));
  }
  return id;
}

std::string InstanceName() {
  const char* env = getenv("ROAR_INSTANCE");
  return env ? env : "";
}

int CdpPort() {
  static int port = [] {
    const char* env = getenv("ROAR_CDP_PORT");
    if (int p = env ? atoi(env) : 0; p > 0) return p;
    if (InstanceName().empty()) return 9222;
    for (int p = 9333; p < 9500; ++p)
      if (p != 9444 && PortFree(p)) return p;
    return 0;
  }();
  return port;
}

bool CdpEnabled() {
  static bool on = [] {
    if (getenv("ROAR_CDP_PORT") || Headless()) return true;
    std::ifstream f(fs::path(W(State::Get().Dir() + "\\state.json")), std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    // Read before CefInitialize, straight from state.json.
    // shortcut: substring match on "cdpOpen":false, upgrade to a real JSON parse if the format changes.
    std::string text = ss.str();
    return text.find("\"cdpOpen\":false") == std::string::npos;
  }();
  return on;
}

void RelaunchAfterExit(const std::string& wipe_dir) {
  // A detached cmd waits for this pid to go, then starts the same exe with the same env.
  // The dir to wipe goes in through the environment, never into the script text.
  SetEnvironmentVariableW(L"ROAR_WIPE_DIR", wipe_dir.empty() ? nullptr : W(wipe_dir).c_str());
  std::wstring script = L"/c powershell -NoProfile -Command \"Wait-Process -Id " +
                        std::to_wstring(GetCurrentProcessId()) + L" -ErrorAction SilentlyContinue; " +
                        L"if ($env:ROAR_WIPE_DIR) { Remove-Item -LiteralPath $env:ROAR_WIPE_DIR -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item Env:ROAR_WIPE_DIR }; " +
                        L"Start-Process -FilePath '" +
                        SelfExe() + L"'\"";
  STARTUPINFOW si{sizeof si};
  PROCESS_INFORMATION pi{};
  wchar_t cmd_exe[MAX_PATH];
  GetEnvironmentVariableW(L"ComSpec", cmd_exe, MAX_PATH);
  std::wstring line = Quote(cmd_exe) + L" " + script;
  if (CreateProcessW(cmd_exe, line.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW | DETACHED_PROCESS, nullptr,
                     nullptr, &si, &pi)) {
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
  }
}

// Established TCP connections to our CDP port, counted by owning process.
int CdpClientCount() {
  int port = CdpPort();
  ULONG size = 0;
  GetExtendedTcpTable(nullptr, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS, 0);
  std::vector<char> buf(size + 1024);
  size = static_cast<ULONG>(buf.size());
  if (GetExtendedTcpTable(buf.data(), &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS, 0) != NO_ERROR) return 0;
  auto* table = reinterpret_cast<MIB_TCPTABLE_OWNER_PID*>(buf.data());
  std::set<DWORD> clients;
  for (DWORD i = 0; i < table->dwNumEntries; ++i) {
    const auto& row = table->table[i];
    if (row.dwState == MIB_TCP_STATE_ESTAB && ntohs(static_cast<u_short>(row.dwRemotePort)) == port &&
        row.dwOwningPid != GetCurrentProcessId())
      clients.insert(row.dwOwningPid);
  }
  return static_cast<int>(clients.size());
}

// TODO(windows): toast notifications need an AppUserModelID registered by the installer's
// Start-menu shortcut, then Windows.UI.Notifications (WinRT/C++). Logs until then.
void Notify(const std::string& title, const std::string& body, const std::string& id) {
  OutputDebugStringW(W("Roar notification: " + title + ": " + body + "\n").c_str());
}
void Unnotify(const std::string& id) {}

// TODO(windows): ITaskbarList3::SetOverlayIcon with a rendered count icon.
void SetDockBadge(int count) {}

bool AppActive() {
  DWORD pid = 0;
  GetWindowThreadProcessId(GetForegroundWindow(), &pid);
  return pid == GetCurrentProcessId();
}

// The installer registers ProgId "RoarHTML" (docs/windows-port.md); Windows 10+ only lets the
// person pick the default themselves, in Settings.
bool IsDefaultBrowser() {
  wchar_t prog[64];
  DWORD size = sizeof prog;
  if (RegGetValueW(HKEY_CURRENT_USER,
                   L"Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
                   L"ProgId", RRF_RT_REG_SZ, nullptr, prog, &size) != ERROR_SUCCESS)
    return false;
  return wcscmp(prog, L"RoarHTML") == 0;
}

void MakeDefaultBrowser(std::function<void()> done) {
  ShellExecuteW(nullptr, L"open", L"ms-settings:defaultapps?registeredAppUser=Roar", nullptr, nullptr, SW_SHOWNORMAL);
  if (done) done();
}

bool ClaimInstance(const std::string& dir) {
  std::error_code ec;
  fs::create_directories(fs::path(W(dir)), ec);
  // Never closed: the mutex lives as long as this process, like the macOS flock.
  HANDLE m = CreateMutexW(nullptr, TRUE, MutexName(dir).c_str());
  if (!m || GetLastError() == ERROR_ALREADY_EXISTS) {
    if (m) CloseHandle(m);
    return false;
  }
  std::ofstream(fs::path(W(dir + "\\cdp-port"))) << CdpPort() << "\n";
  return true;
}

void LaunchInstance() {
  std::string name;
  for (int n = 2;; ++n)
    if (!InstanceRunning(InstanceDir(name = std::to_string(n)))) break;
  Spawn(SelfExe(), {L"--instance=" + W(name)});
}

// Windows has no global menu bar; shortcuts already go through Controller::OnKey.
// TODO(windows): an app/system menu (Check for Updates, New Instance, Settings) on the shell window.
void InstallMenu() {}

bool Headless() {
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  bool headless = false;
  for (int i = 1; i < argc; ++i)
    if (!wcscmp(argv[i], L"--headless") || !wcsncmp(argv[i], L"--headless=", 11)) headless = true;
  LocalFree(argv);
  return headless;
}

// TODO(windows): Shell_NotifyIconW tray icon with Show/Quit (the macOS menu bar item).
void InstallStatusItem() {}

void HideApp() {
  EnumThreadWindows(GetCurrentThreadId(), [](HWND w, LPARAM) { ShowWindow(w, SW_HIDE); return TRUE; }, 0);
}

// TODO(windows): the "Show sidebar" caption button; the sidebar shortcut still works.
void SetSidebarButton(void* window, bool visible) {}

// Tab windows are owned (not child) top-level windows so CEF's Chrome-style
// windows keep their own HWND; ownership keeps them above the shell and out of Alt-Tab.
void AttachChild(void* parent, void* child) {
  SetWindowLongPtrW(Hwnd(child), GWLP_HWNDPARENT, reinterpret_cast<LONG_PTR>(Hwnd(parent)));
  ShowWindow(Hwnd(child), SW_SHOWNOACTIVATE);
}

void DetachChild(void* parent, void* child) { ShowWindow(Hwnd(child), SW_HIDE); }

// TODO(windows): a layered child holding the decoded JPEG (window previews).
void AddBackdrop(void* parent, void* child, const std::string& jpeg) {}
void ClearBackdrop(void* parent) {}

void StyleWindow(void* window, double corner_radius, bool shadow) {
  HWND w = Hwnd(window);
  LONG_PTR ex = GetWindowLongPtrW(w, GWL_EXSTYLE);
  SetWindowLongPtrW(w, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW);  // One taskbar button.
  // Windows 11 rounds corners itself (DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2).
  using SetAttr = HRESULT(WINAPI*)(HWND, DWORD, LPCVOID, DWORD);
  if (HMODULE dwm = LoadLibraryW(L"dwmapi.dll"))
    if (auto set = reinterpret_cast<SetAttr>(GetProcAddress(dwm, "DwmSetWindowAttribute"))) {
      int pref = corner_radius > 0 ? 2 : 1;
      set(w, 33, &pref, sizeof pref);
    }
}

void SetIgnoresMouse(void* window, bool ignores) {
  HWND w = Hwnd(window);
  LONG_PTR ex = GetWindowLongPtrW(w, GWL_EXSTYLE);
  SetWindowLongPtrW(w, GWL_EXSTYLE, ignores ? ex | WS_EX_LAYERED | WS_EX_TRANSPARENT : ex & ~WS_EX_TRANSPARENT);
}

bool IsLeftMouseDown() {
  int button = GetSystemMetrics(SM_SWAPBUTTON) ? VK_RBUTTON : VK_LBUTTON;
  return GetAsyncKeyState(button) & 0x8000;
}

// Polls the cursor until the button is released (the macOS version runs a local event loop).
void TrackHorizontalDrag(void* window, std::function<void(int x)> on_move) {
  HWND w = Hwnd(window);
  struct Poll {
    static void Tick(HWND w, std::function<void(int)> cb, int last) {
      if (!IsLeftMouseDown()) return;
      POINT p;
      GetCursorPos(&p);
      ScreenToClient(w, &p);
      if (p.x != last) cb(p.x);
      CefPostDelayedTask(TID_UI, base::BindOnce(&Poll::Tick, w, cb, static_cast<int>(p.x)), 16);
    }
  };
  Poll::Tick(w, std::move(on_move), INT_MIN);
}

// TODO(windows): a thin child HWND with IDC_SIZEWE/IDC_SIZENS that reports drags.
void SetSplitDivider(void* window, int x, int y, int w, int h, bool stacked,
                     std::function<void(int sx, int sy)> on_drag, std::function<void()> reset) {}

void SetFloating(void* window, bool floating, const std::string& title) {
  HWND w = Hwnd(window);
  SetWindowTextW(w, W(title).c_str());
  LONG_PTR style = GetWindowLongPtrW(w, GWL_STYLE);
  SetWindowLongPtrW(w, GWL_STYLE, floating ? style | WS_CAPTION | WS_THICKFRAME : style & ~(WS_CAPTION | WS_THICKFRAME));
  SetWindowPos(w, floating ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
}

void CopyText(const std::string& text) {
  std::wstring w = W(text);
  if (!OpenClipboard(nullptr)) return;
  EmptyClipboard();
  if (HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, (w.size() + 1) * sizeof(wchar_t))) {
    memcpy(GlobalLock(mem), w.c_str(), (w.size() + 1) * sizeof(wchar_t));
    GlobalUnlock(mem);
    if (!SetClipboardData(CF_UNICODETEXT, mem)) GlobalFree(mem);
  }
  CloseClipboard();
}

// TODO(windows): WinSparkle (same appcast format as Sparkle) once releases ship a Windows build.
void CheckForUpdates() {}

// TODO(windows): scripts/update-cef.ps1 does not exist yet; rebuilding Chromium in place is macOS-only.
void UpdateChromium(void* window) {
  MessageBoxW(Hwnd(window), L"Updating Chromium from a checkout is not available on Windows yet.", L"Roar",
              MB_OK | MB_ICONINFORMATION);
}

void ChooseLookback(void* window, const std::string& what, std::function<void(double since)> done) {
  // A native list dialog needs a resource template; four choices fit a popup menu.
  const double now = static_cast<double>(time(nullptr));
  PopupMenu({"-Clear " + what + " from…", "", "The last hour", "Today", "The last 7 days", "All time"},
            [=](int i) {
              const double back[] = {3600, 86400, 7 * 86400, 0};
              if (i >= 2 && i <= 5) done(back[i - 2] ? now - back[i - 2] : 0);
            });
}

void ConfirmDownload(void* window, const std::string& name, const std::string& host,
                     std::function<void(bool allow)> done) {
  std::wstring text = W("“" + name + "” from " + host + " can run code on this computer. Keep it?");
  done(MessageBoxW(Hwnd(window), text.c_str(), L"Roar", MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2) == IDYES);
}

// The Mark of the Web: an NTFS Zone.Identifier stream, Windows' com.apple.quarantine.
void QuarantineDownload(const std::string& path, const std::string& url) {
  std::wstring ads = W(path) + L":Zone.Identifier";
  if (GetFileAttributesW(ads.c_str()) != INVALID_FILE_ATTRIBUTES) return;  // Chromium already wrote it.
  std::ofstream f(fs::path(ads), std::ios::binary);
  f << "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=" << url << "\r\n";
}

void PopupMenu(const std::vector<std::string>& titles, std::function<void(int index)> done) {
  HMENU menu = CreatePopupMenu();
  for (size_t i = 0; i < titles.size(); ++i) {
    const std::string& t = titles[i];
    if (t.empty()) AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    else if (t[0] == '-') AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, W(t.substr(1)).c_str());
    else AppendMenuW(menu, MF_STRING, i + 1, W(t).c_str());
  }
  POINT p;
  GetCursorPos(&p);
  HWND owner = GetForegroundWindow();
  int picked = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_NONOTIFY, p.x, p.y, 0, owner, nullptr);
  DestroyMenu(menu);
  if (picked > 0) done(picked - 1);
}

std::string UniqueDownloadPath(const std::string& name) {
  fs::path dir = fs::path(W(KnownFolder(FOLDERID_Downloads)));
  fs::path file = fs::path(W(name));
  fs::path stem = file.stem(), ext = file.extension();
  fs::path p = dir / file;
  std::error_code ec;
  auto taken = [&](const fs::path& q) { return fs::exists(q, ec) || fs::exists(q.wstring() + L".crdownload", ec); };
  for (int i = 1; taken(p); ++i) p = dir / (stem.wstring() + L" (" + std::to_wstring(i) + L")" + ext.wstring());
  return U(p.wstring());
}

void RevealInFinder(const std::string& path) {
  if (GetFileAttributesW(W(path).c_str()) == INVALID_FILE_ATTRIBUTES) return;
  std::wstring args = L"/select," + Quote(W(path));
  ShellExecuteW(nullptr, L"open", L"explorer.exe", args.c_str(), nullptr, SW_SHOWNORMAL);
}

bool OpenInApp(void* window, const std::string& url) {
  size_t colon = url.find(':');
  if (colon == std::string::npos) return false;
  std::wstring scheme = W(url.substr(0, colon));
  wchar_t app[MAX_PATH];
  DWORD size = MAX_PATH;
  if (FAILED(AssocQueryStringW(ASSOCF_IS_PROTOCOL, ASSOCSTR_FRIENDLYAPPNAME, scheme.c_str(), nullptr, app, &size)))
    return false;
  std::wstring text = L"Open “" + std::wstring(app) + L"”?\nThis page wants to open an app on your computer.";
  if (MessageBoxW(Hwnd(window), text.c_str(), L"Roar", MB_OKCANCEL | MB_ICONQUESTION) == IDOK)
    ShellExecuteW(nullptr, L"open", W(url).c_str(), nullptr, nullptr, SW_SHOWNORMAL);
  return true;
}

std::string SaveMarkdown(const std::string& title, const std::string& markdown) {
  std::string name = title.empty() ? "page" : title;
  for (char& c : name)
    if (strchr("/\\:*?\"<>|\n\r\t", c)) c = ' ';
  while (!name.empty() && name.back() == ' ') name.pop_back();
  while (!name.empty() && name.front() == ' ') name.erase(0, 1);
  if (name.size() > 80) name.resize(80);
  fs::path dir = fs::path(W(KnownFolder(FOLDERID_Downloads)));
  fs::path p = dir / (W(name) + L".md");
  std::error_code ec;
  for (int i = 2; fs::exists(p, ec); ++i) p = dir / (W(name) + L" " + std::to_wstring(i) + L".md");
  std::ofstream f(p, std::ios::binary);
  if (!(f << markdown)) return "";
  return U(p.wstring());
}

void SearchGitHub(const std::string& query, std::function<void(std::string json, std::string error)> done) {
  std::string gh = Which("gh");
  if (gh.empty()) return done("", "Install the GitHub CLI (gh) to see pull requests here.");
  std::thread([=] {
    std::string out, err;
    int status = RunTool(gh, {"api", "-X", "GET", "search/issues", "-f", "q=" + query, "-f", "per_page=25"}, &out, &err);
    std::string error;
    if (status != 0)
      error = err.find("auth login") != std::string::npos || err.find("not logged") != std::string::npos
                  ? "Run `gh auth login` to connect GitHub."
                  : "GitHub search failed: " + err;
    OnUi(base::BindOnce([](std::function<void(std::string, std::string)> cb, std::string j, std::string e) { cb(j, e); },
                        done, status == 0 ? out : "", error));
  }).detach();
}

void GitHubAuthStatus(std::function<void(std::string status)> done) {
  std::string gh = Which("gh");
  if (gh.empty()) return done("missing");
  std::thread([=] {
    int status = RunTool(gh, {"auth", "status", "--hostname", "github.com"}, nullptr, nullptr);
    OnUi(base::BindOnce([](std::function<void(std::string)> cb, std::string r) { cb(r); }, done,
                        std::string(status == 0 ? "ok" : "signed-out")));
  }).detach();
}

std::string HomeDir() {
  const char* h = getenv("USERPROFILE");
  return h && *h ? h : KnownFolder(FOLDERID_Profile);
}

void ChooseFolder(std::function<void(const std::string& path)> done) {
  std::string picked;
  IFileOpenDialog* dlg = nullptr;
  if (SUCCEEDED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg)))) {
    DWORD opts;
    dlg->GetOptions(&opts);
    dlg->SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
    dlg->SetOkButtonLabel(L"Start agent here");
    IShellItem* item = nullptr;
    if (SUCCEEDED(dlg->Show(GetForegroundWindow())) && SUCCEEDED(dlg->GetResult(&item))) {
      PWSTR p = nullptr;
      if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &p))) picked = U(p);
      CoTaskMemFree(p);
      item->Release();
    }
    dlg->Release();
  }
  done(picked);
}

void RoarMcp(std::vector<std::string> args, std::function<void(const std::string& out)> done) {
  std::string exe = ResourcePath("roar-mcp.exe");
  std::thread([=] {
    std::string out;
    RunTool(exe, args, &out, nullptr);
    OnUi(base::BindOnce([](std::function<void(const std::string&)> cb, std::string o) { cb(o); }, done, out));
  }).detach();
}

void ClaudeMcpAdd(const std::string& server, std::function<void(bool ok)> done) {
  std::string claude = Which("claude");
  for (const std::string& p : {HomeDir() + "\\.local\\bin\\claude.exe", HomeDir() + "\\.claude\\local\\claude.exe"})
    if (claude.empty() && GetFileAttributesW(W(p).c_str()) != INVALID_FILE_ATTRIBUTES) claude = p;
  if (claude.empty()) return done(false);
  std::thread([=] {
    RunTool(claude, {"mcp", "remove", "--scope", "user", "roar"}, nullptr, nullptr);
    int status = RunTool(claude, {"mcp", "add", "--scope", "user", "roar", "--", server}, nullptr, nullptr);
    OnUi(base::BindOnce([](std::function<void(bool)> cb, bool ok) { cb(ok); }, done, status == 0));
  }).detach();
}

}  // namespace roar::platform
