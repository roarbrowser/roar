# Windows port

Status: a Windows build path exists (CMake branch, `src/win/`, `scripts/*.ps1`) but has
**never been compiled or run on Windows**. Everything below marked "written" is code that
exists and is believed correct; "TODO(windows)" items are stubs in the source. The macOS
build is unchanged in behaviour.

## Layout

| Piece | macOS | Windows |
|---|---|---|
| Platform interface | `src/platform.h` (shared) | same header |
| Implementation | `src/mac/platform.mm`, `scripting.mm` | `src/win/platform.cc` |
| Entry point | `src/mac/main.mm` (NSApplication + CefAppProtocol) | `src/win/main.cc` (`wWinMain`) |
| Subprocesses | `Roar Helper*.app` bundles (`mac/helper_main.cc`) | the same `Roar.exe` (`CefExecuteProcess` first) |
| CMake | `src/CMakeLists.txt` | `src/win/CMakeLists.txt`, included when `OS_WINDOWS` |
| Build | `scripts/build.sh` | `scripts/build.ps1` (+ `scripts/fetch-cef.ps1`) |
| Output | `build/src/Release/Roar.app` | `build\src\Release\Roar.exe` with `libcef.dll`, CEF resources, `ui\`, `extensions\ubol\`, `roar-mcp.exe` beside it |
| Data dir | `~/Library/Application Support/Roar[-<instance>]` | `%APPDATA%\Roar[-<instance>]` (`State::Dir`, `MainDir` in `src/state.cc`) |

`platform::ResourcePath` is the bundle's `Contents/Resources` on macOS and the exe's folder on Windows.

## Build on Windows

Prerequisites: Visual Studio 2022 (Desktop C++), CMake 3.21+, Ninja, bun, and SQLite3 as a
CMake package (vcpkg: `vcpkg install sqlite3:x64-windows-static`).

```powershell
# From an "x64 Native Tools Command Prompt for VS 2022" running PowerShell:
$env:ROAR_CMAKE_ARGS = "-DCMAKE_TOOLCHAIN_FILE=<vcpkg>\scripts\buildsystems\vcpkg.cmake -DVCPKG_TARGET_TRIPLET=x64-windows-static"
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

`fetch-cef.ps1` pins the same CEF version as `fetch-cef.sh` (stock `windows64_minimal`,
SHA-1 from the CDN). That build has **no proprietary codecs and none of Roar's CEF patches**
(see "CEF patches" below).

## macOS dependencies and their Windows equivalents

### Platform layer (`src/platform.h`)

| Function | macOS | Windows | State |
|---|---|---|---|
| `ResourcePath` / `ReadResource` | NSBundle resources | exe dir (`GetModuleFileNameW`) | written |
| `RandomToken` | `SecRandomCopyBytes` | `BCryptGenRandom` | written |
| `InstanceName` / `CdpPort` / `CdpEnabled` | env + socket bind + state.json | same logic, Winsock bind | written (`cdpOpen` read by substring) |
| `ClaimInstance` (instance lock) | `flock(<data>/instance.lock)` | named mutex `Local\Roar-instance-<data dir>`, held for the process lifetime; writes `cdp-port` | written |
| `LaunchInstance` | `open -n Roar.app --args --instance=N` | `CreateProcessW(self, --instance=N)` | written |
| `RelaunchAfterExit` | `nohup sh -c 'while kill -0 …; open -n'` | detached `cmd /c powershell Wait-Process; Start-Process` | written |
| `CdpClientCount` | `proc_pidinfo` socket walk | `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_CONNECTIONS)` | written |
| `Notify` / `Unnotify` | UserNotifications | WinRT `ToastNotificationManager`; needs an AppUserModelID set by an installer Start-menu shortcut | TODO (logs via `OutputDebugString`) |
| `SetDockBadge` | Dock tile badge | `ITaskbarList3::SetOverlayIcon` with a drawn count | TODO |
| `AppActive` | `NSApp.isActive` | foreground window's pid == ours | written |
| `IsDefaultBrowser` / `MakeDefaultBrowser` | LaunchServices | reads `UrlAssociations\https\UserChoice` ProgId `RoarHTML`; opens `ms-settings:defaultapps` (Windows 10+ forbids setting it programmatically). Needs installer registration under `HKCU\Software\Clients\StartMenuInternet\Roar` + `RegisteredApplications` | written, registration TODO |
| `InstallMenu` | NSMenu bar | none needed: shortcuts already go through `Controller::OnKey`. An app menu on the shell window's system menu would restore Check for Updates/New Instance | TODO |
| `Headless` / `InstallStatusItem` / `HideApp` | accessory policy, NSStatusItem | `--headless` check; tray icon via `Shell_NotifyIconW`; `ShowWindow(SW_HIDE)` | tray TODO |
| `SafariBookmarksJson` | Bookmarks.plist | no Safari: returns "" | written |
| `UnpackedExtensionId` | SHA-256 of UTF-8 path | SHA-256 of the **UTF-16LE** path (Chromium's Windows rule) | written |
| `SetSidebarButton` | button beside traffic lights | caption button / small child HWND | TODO |
| `AttachChild` / `DetachChild` | NSWindow child windows | owned popups (`GWLP_HWNDPARENT`) + `ShowWindow` | written, needs testing with Chrome-style CEF windows |
| `AddBackdrop` / `ClearBackdrop` | CALayer image | layered child HWND with the decoded JPEG (WIC) | TODO |
| `StyleWindow` | corner radius, shadow, Transient, AX subrole | `WS_EX_TOOLWINDOW` (one taskbar button) + DWM corner preference | written |
| `SetIgnoresMouse` | `ignoresMouseEvents` | `WS_EX_LAYERED | WS_EX_TRANSPARENT` | written |
| `IsLeftMouseDown` / `TrackHorizontalDrag` | NSEvent local loop | `GetAsyncKeyState` + 16 ms polling on the UI thread | written |
| `SetSplitDivider` | NSView with resize cursor | thin child HWND with `IDC_SIZEWE/NS`, `SetCapture` | TODO (split view can't be resized by drag) |
| `SetFloating` | titled, floating NSWindow | `WS_CAPTION` + `HWND_TOPMOST` | written |
| `CopyText` | NSPasteboard | `CF_UNICODETEXT` clipboard | written |
| `CheckForUpdates` | Sparkle | WinSparkle (reads the same appcast format) | TODO |
| `UpdateChromium` | runs `update-cef.sh` + `deploy.sh` | message box; a `update-cef.ps1` would be needed | TODO |
| `ChooseLookback` | NSAlert sheet with popup | popup menu of four ranges | written |
| `ConfirmDownload` / `OpenInApp` | NSAlert sheets | `MessageBoxW`; `AssocQueryStringW(ASSOCF_IS_PROTOCOL)` finds the handler | written |
| `QuarantineDownload` | `com.apple.quarantine` xattr | Mark of the Web: `:Zone.Identifier` stream, `ZoneId=3` | written |
| `PopupMenu` | NSMenu | `TrackPopupMenu(TPM_RETURNCMD)` | written |
| `UniqueDownloadPath` / `SaveMarkdown` / `RevealInFinder` | ~/Downloads, Finder | `FOLDERID_Downloads`, `explorer /select,` | written |
| `SearchGitHub` / `GitHubAuthStatus` / `ClaudeMcpAdd` / `RoarMcp` | NSTask + GCD | `CreateProcessW` (hidden, piped) on a `std::thread`, result posted to `TID_UI` | written |
| `HomeDir` | `$HOME` | `%USERPROFILE%` | written |
| `ChooseFolder` | NSOpenPanel | `IFileOpenDialog` + `FOS_PICKFOLDERS` | written |

### Not in the platform interface

| Item | Where | Windows plan | State |
|---|---|---|---|
| AppleScript dictionary (`scripting.mm`, `Roar.sdef`) | macOS only | none; CDP and the MCP server cover automation. A COM/named-pipe API only if someone asks | dropped |
| GetURL Apple event (links from other apps), Dock menu, reopen | `main.mm` | URL arrives as argv: a second launch should forward it to the running instance (`WM_COPYDATA` to the shell window, or a named pipe) before `ClaimInstance` gives it a new instance | TODO; today a second launch becomes instance 2 |
| Activate/resign (window previews) | `main.mm` delegate | `WM_ACTIVATEAPP` on the shell window | TODO |
| `--remote-debugging-pipe` on fds 3/4 (`action_watch.cc`) | `pipe`/`dup2` | Chromium on Windows takes `--remote-debugging-io-pipes=<in>,<out>` handle values; create inheritable pipes, pass the handles | TODO; `PrepareMain` returns false, so extension toolbar badges stay off |
| CEF patch symbols (`controller.cc`) | `dlsym` on the framework image | `GetProcAddress(GetModuleHandle("libcef.dll"))`; the patched libcef must export them | written; exports TODO |
| `kill(pid, 0)` liveness | `controller.cc` | `OpenProcess` + `WaitForSingleObject(0)` | written |
| `mkstemp`/`fsync`/`rename` (`atomic_write.h`) | POSIX | `_mktemp_s` + `_O_EXCL` + `_commit` + `MoveFileExA(REPLACE_EXISTING)` | written (narrow paths) |
| `O_NOFOLLOW` config writes (`agent_connect.cc`) | POSIX | `_wsopen_s(_O_EXCL)` | written |
| `getpwuid`, `mkdir`, `chmod` (`state.cc`) | POSIX | `%USERPROFILE%`, `_mkdir`, `_chmod` | written |
| Import paths (`library.cc`) | `~/Library/Application Support/...` | Chrome/Edge under `%LOCALAPPDATA%\…\User Data`, Firefox under `%APPDATA%\Mozilla\Firefox` | written; Arc (`arc_import.cc`) and Dia paths TODO |
| MCP client config paths (`agent_connect.cc` table) | `Library/Application Support/Code/User`, Claude desktop, Cline, … | `%APPDATA%\Code\User`, `%APPDATA%\Claude\claude_desktop_config.json`, … | TODO: the table is macOS-relative |
| Agent-file scanner skip list (`controller.cc AgentMdList`) | skips `Library` | also skip `AppData` | TODO |
| TCC / `NS*UsageDescription` (`Info.plist.in`) | silent kills without the key | Windows asks per capability (camera/mic/location) through its own privacy settings; nothing to declare for a Win32 app. An `app.manifest` (DPI awareness, `supportedOS`) should be added via CEF's `ADD_WINDOWS_MANIFEST` | manifest TODO |
| Sandbox | `cef_sandbox_mac`, helper bundles | link `cef_sandbox.lib`, `CefScopedSandboxInfo` in `wWinMain` | TODO (`no_sandbox = true`) |
| Codesigning (`build.sh`, `release.sh`) | `codesign`, Developer ID, notarization | Authenticode with `signtool` (an OV/EV cert, or Azure Trusted Signing); unsigned builds hit SmartScreen | TODO |
| Packaging (`release.sh` → DMG, Sparkle appcast) | DMG + Sparkle | MSIX or an Inno Setup/WiX installer that also registers the browser, the AUMID shortcut and the `roar:` handler; WinSparkle appcast | TODO |
| `scripts/deploy.sh`, `update-cef.sh`, `build-cef-codecs.sh`, `release.sh`, `fetch-sparkle.sh` | bash, `ditto`, `osascript`, `lipo` | no Windows versions yet; `build.ps1` and `fetch-cef.ps1` only | TODO |

### CEF patches (`scripts/cef-patches/`)

The macOS build uses a self-compiled CEF with Roar's patches (Target.createTarget hook,
live CDP toggle `roar_devtools_http`, per-space target filter, UA-CH brand, outer window
rect) and proprietary codecs. The patches are Chromium-side and mostly platform-neutral, but
building CEF for Windows is its own job (`automate-git.py` on a Windows host, ~100 GB, VS
2022 + Windows SDK, the GN args in `scripts/build-cef-codecs.sh`; Windows would also need
Media Foundation versions of `roar_platform_codecs.patch`, which covers macOS only). The exported `roar_*` functions also need `__declspec(dllexport)`
or a `.def` entry so `GetProcAddress` finds them. Until then the Windows build runs on stock
CEF, and every `sym(...)` in `Controller::Start` returns null: MCP `new_page` opens a plain
Chrome window, the CDP toggle can't close the port live, and spaces with agents off are
still visible to CDP clients. **That last one is a privacy gap; don't ship without the
filter patch.**

### Agent sessions (`mcp/claude-hook.mjs`, `mcp/roar-mcp.mjs`)

| Item | macOS | Windows | State |
|---|---|---|---|
| Session dir | `~/Library/Application Support/Roar/claude-sessions` | `%APPDATA%\Roar\claude-sessions` | written |
| CLI lookup | PATH split on `:`; bare names | PATH split on `;`; `.exe` and npm `.cmd` shims | written |
| Start a session (`claude-ctl new`) | cmux, else tmux, else Terminal via `osascript` | `wt.exe -w new new-tab --title <project> -d <dir> -- <cli> <args>` (`;` escaped for wt); without Windows Terminal the CLI is spawned detached in its own console (`cmd /d /c` for `.cmd` shims, which refuse prompts containing cmd metacharacters) | written |
| Live screen / send keys / focus | tmux `capture-pane`/`send-keys`, cmux, AppleScript tab search | none yet: needs Roar to host the CLI in a ConPTY (`CreatePseudoConsole`) or a wt extension; `ctl` returns the existing "no live view" errors | TODO |
| Terminal identification (`where`) | `ps`, `__CFBundleIdentifier`, TERM_PROGRAM | `WT_SESSION` exists but wt has no API to focus a given tab | TODO |
| Hook commands in CLI configs | `"<path>/roar-mcp" agent-hook …` | same, `roar-mcp.exe`; the `OURS` matcher already accepts a quoted path | written |
| `roar-mcp` launching Roar | `open -a Roar.app`, `pgrep` | spawns `Roar.exe` beside `roar-mcp.exe` | written |
| `roar-mcp.sh` shim | bash | not shipped; configs point at `roar-mcp.exe` directly | n/a |

## What has been verified

- macOS: `scripts/build.sh` builds, and every `scripts/test-*.sh` passes, after these changes.
- Windows: nothing has been compiled, linked or run. Expect a round of compile fixes
  (MSVC warnings as errors from CEF's flags, `windows.h` macro clashes, missing includes).

## Next steps on a Windows machine

1. Run `scripts\build.ps1`; fix compile and link errors (`src/win/*`, the `_WIN32` branches in
   `atomic_write.h`, `state.cc`, `controller.cc`, `agent_connect.cc`, `action_watch.cc`,
   `library.cc`).
2. Smoke test headless with a scratch data dir: `$env:ROAR_DATA_DIR="$env:TEMP\roar-test";
   Roar.exe --headless=new`, CDP on `ROAR_CDP_PORT`.
3. Check window plumbing first (`AttachChild`, `StyleWindow`, tab switching via
   `Controller::SyncWindows`): Chrome-style CEF windows on Windows are top-level HWNDs, and
   owned-window z-order is the riskiest assumption here.
4. Check `Controller::OnKey` maps Cmd shortcuts to Ctrl on Windows.
5. Wire `--remote-debugging-io-pipes` for `action_watch`.
6. Build CEF with Roar's patches and codecs for Windows; export the `roar_*` symbols.
7. Then the TODO stubs: notifications (AUMID), tray icon, split divider, backdrop, WinSparkle,
   an installer that registers the browser, Authenticode signing, ConPTY agent sessions.
