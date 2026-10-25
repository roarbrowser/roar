// OS services the cross-platform code needs (src/mac, src/win): bundle resources, the menu
// bar, the pasteboard, Downloads and the `gh` CLI.
#pragma once

#include <functional>
#include <string>
#include <vector>

namespace roar::platform {

std::string ResourcePath(const std::string& relative);
std::string ReadResource(const std::string& relative);
std::string RandomToken();
// Several Roars can run at once. Each extra one is named (--instance=<name>,
// ROAR_INSTANCE), keeps its data in "Roar-<name>" beside the main data dir and
// takes the first free CDP port from 9333; the main one keeps 9222.
std::string InstanceName();
int CdpPort();
// Whether this launch starts listening on CdpPort(): ROAR_CDP_PORT, headless, or the cdpEnabled setting.
bool CdpEnabled();
// Reopens this app bundle once this process has exited; call before quitting.
// |wipe_dir| (the data dir, for Reset Roar) is deleted once this process has exited.
void RelaunchAfterExit(const std::string& wipe_dir = "");
// Open TCP connections to this process's CDP port: one per connected agent/CDP client.
int CdpClientCount();
// A macOS notification (asks for permission the first time). A non-empty |id| replaces an
// earlier one with the same id, and Unnotify(id) takes it out of Notification Center.
void Notify(const std::string& title, const std::string& body, const std::string& id = "");
void Unnotify(const std::string& id);
// The Dock icon's badge; 0 clears it.
void SetDockBadge(int count);
bool AppActive();
// Whether Roar opens http(s) links from other apps; MakeDefaultBrowser asks macOS to switch (it confirms with the user).
bool IsDefaultBrowser();
void MakeDefaultBrowser(std::function<void()> done);
// Locks |dir| for this process and writes the CDP port to <dir>/cdp-port.
// False when another Roar already runs from |dir|.
bool ClaimInstance(const std::string& dir);
// Starts a new Roar process under the lowest unused instance name.
void LaunchInstance();

void InstallMenu();
// Launched with --headless: Roar runs hidden with a menu bar icon instead of a
// Dock icon. Chrome's own headless mode has no window to bring forward later.
bool Headless();
void InstallStatusItem();
void HideApp();
// Safari's Bookmarks.plist as {"bookmarks": [node...], "readingList": [{title, url}]},
// or "" when it can't be read (Roar lacks Full Disk Access).
std::string SafariBookmarksJson();
// Chromium's id for an unpacked extension loaded from |path|.
std::string UnpackedExtensionId(const std::string& path);
// Shows a "Show sidebar" button beside the traffic lights while the sidebar is hidden.
void SetSidebarButton(void* window, bool visible);

// Window plumbing. |window| arguments are CefWindow::GetWindowHandle() values.
void AttachChild(void* parent, void* child);  // Shows |child| above |parent|.
void DetachChild(void* parent, void* child);  // Hides |child|.
// Shows |jpeg| in |parent| under the area |child| covers, for window previews
// that capture |parent| alone. ClearBackdrop removes every such image.
void AddBackdrop(void* parent, void* child, const std::string& jpeg);
void ClearBackdrop(void* parent);
void StyleWindow(void* window, double corner_radius, bool shadow);
void SetIgnoresMouse(void* window, bool ignores);
bool IsLeftMouseDown();
// Follows the left mouse button across all of Roar's windows until it is
// released, calling on_move with the cursor's x in the window's coordinates.
void TrackHorizontalDrag(void* window, std::function<void(int x)> on_move);
// The split view's divider: a strip of the shell window (screen rect, top-left origin, like CefRect)
// that shows a resize cursor and reports drags in screen coordinates. reset fires on a double-click.
// An empty rect hides it.
void SetSplitDivider(void* window, int x, int y, int w, int h, bool stacked,
                     std::function<void(int sx, int sy)> on_drag, std::function<void()> reset,
                     std::function<void(int step)> on_key);
// ‹ › buttons pinned to |window|'s top-left corner (a split pane); press(forward) on a click.
// A native child panel: CEF overlay views on Chrome-style windows stopped every mouse click.
void SetPaneNav(void* window, bool show, std::function<void(bool forward)> press);
// A mint frame with an "Agent" tag around a tab window an agent is driving; hidden from capture.
// Its panel uses NSWindowSharingNone, so screenshots, recordings and screen sharing leave it out.
void SetDrivenFrame(void* tab_window, bool show);
// Turns a tab window into a titled, always-on-top mini window, or back.
void SetFloating(void* window, bool floating, const std::string& title);
// Keeps an extension popup or window above Roar's tab windows while Roar is active.
void KeepAbove(void* window);
void CopyText(const std::string& text);
// Asks, in a sheet on |window|, how far back to clear |what| ("history",
// "cookies"). |done| gets the cutoff in Unix seconds (0 for all time); it is
// not called if the sheet is cancelled.
// Checks for a newer CEF and, if confirmed, rebuilds and redeploys Roar in the
// background (scripts/update-cef.sh then scripts/deploy.sh).
void UpdateChromium(void* window);
// Sparkle: checks the appcast for a newer Roar release and shows its update UI.
void CheckForUpdates();
// Zips Roar's logs and version info (home path and URLs removed) and starts an email to support with it.
void SendDiagnostics();
// The running app's CFBundleVersion (Sparkle compares builds by it).
std::string BundleBuild();
// Moves |path| to the user's Trash (Finder's Put Back works); false when it couldn't.
bool MoveToTrash(const std::string& path);
// Sparkle's own saved choices: check daily, and download+install without asking. Both false, and
// setting does nothing, when the updater isn't running (test and headless instances).
bool UpdaterRunning();
bool AutoUpdateChecks();
bool AutoUpdateDownloads();
void SetAutoUpdate(bool checks, bool downloads);
void ChooseLookback(void* window, const std::string& what, std::function<void(double since)> done);
// A path in ~/Downloads for |name| that doesn't exist yet ("name (1).ext" and so on).
std::string UniqueDownloadPath(const std::string& name);
// Pops a native menu at the mouse; an empty title is a separator, a leading '-'
// a disabled label. `done` gets the clicked index (never called if dismissed).
void PopupMenu(const std::vector<std::string>& titles, std::function<void(int index)> done);
// Asks whether to save `name`, a file type that can run code, from `host`.
void ConfirmDownload(void* window, const std::string& name, const std::string& host,
                     std::function<void(bool allow)> done);
// Adds com.apple.quarantine to a finished download unless Chromium already did.
void QuarantineDownload(const std::string& path, const std::string& url);
void RevealInFinder(const std::string& path);
// Opens System Settings at Privacy & Security > Full Disk Access.
void OpenFullDiskAccessSettings();
// Asks whether to open `url` (a non-web scheme) in the app registered for it, then
// opens it. Returns false, without asking, when no app handles the scheme.
bool OpenInApp(void* window, const std::string& url);
// Writes Markdown to ~/Downloads and returns the path, or "" on failure.
std::string SaveMarkdown(const std::string& title, const std::string& markdown);
// Model chat API keys: generic passwords in the login Keychain, service "Roar model chat", one per
// provider id. SecretSet with an empty value deletes. SecretHas never reads the value.
std::string SecretGet(const std::string& account);
bool SecretSet(const std::string& account, const std::string& value);
bool SecretHas(const std::string& account);

// Runs `gh api search/issues` off the UI thread; |done| runs on the UI thread
// with the JSON body or an error message.
void SearchGitHub(const std::string& query,
                  std::function<void(std::string json, std::string error)> done);
// Reports "ok", "missing" (gh not installed) or "signed-out".
void GitHubAuthStatus(std::function<void(std::string status)> done);
// Fetches the gh-signed-in user's contributions calendar off the UI thread; |done| runs on
// the UI thread with GardenJson's output, or "" when signed out or the fetch failed.
// ROAR_GARDEN_MOCK=<http base> (tests only) fetches <base>/users/mock/contributions instead.
void GitHubContributions(std::function<void(std::string json)> done);
// Runs `claude mcp add --scope user roar -- <server>` off the UI thread; false
// when the Claude Code CLI is missing or the command failed.
// $HOME when set and non-empty, else the account home.
std::string HomeDir();
void ClaudeMcpAdd(const std::string& server, std::function<void(bool ok)> done);
// Runs the bundled roar-mcp with args off the UI thread; done(stdout) on the UI thread.
// A macOS folder chooser; done("") when cancelled.
void ChooseFolder(std::function<void(const std::string& path)> done);
void RoarMcp(std::vector<std::string> args, std::function<void(const std::string& out)> done);
// Runs |exe| with |args| as argv (no shell) in |cwd| and its own process group, with Roar's own
// environment (HOME untouched) except PATH = |path|. Writes |input| to its stdin, then streams stdout
// to on_out and ends with on_exit(status, stderr tail), both on the UI thread. status: the exit code,
// -1 when it couldn't start, -2 when it ran past |timeout_s| and was killed. Returns the pid, 0 on failure.
int SpawnStream(const std::string& exe, const std::vector<std::string>& args, const std::string& cwd,
                const std::string& path, const std::string& input, int timeout_s,
                std::function<void(const std::string& chunk)> on_out,
                std::function<void(int status, const std::string& err)> on_exit);
// Stops a SpawnStream child and its process group (TERM, then KILL after 2s). No-op once it has exited.
void KillStream(int pid);

}  // namespace roar::platform
