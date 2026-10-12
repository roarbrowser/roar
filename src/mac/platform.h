// macOS services the cross-platform code needs: bundle resources, the menu
// bar, the pasteboard, Downloads and the `gh` CLI.
#pragma once

#include <functional>
#include <string>
#include <vector>

namespace roar::platform {

std::string ResourcePath(const std::string& relative);
std::string ReadResource(const std::string& relative);
std::string RandomToken();
int CdpPort();

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
void StyleWindow(void* window, double corner_radius, bool shadow);
void SetIgnoresMouse(void* window, bool ignores);
bool IsLeftMouseDown();
// Follows the left mouse button across all of Roar's windows until it is
// released, calling on_move with the cursor's x in the window's coordinates.
void TrackHorizontalDrag(void* window, std::function<void(int x)> on_move);
// Turns a tab window into a titled, always-on-top mini window, or back.
void SetFloating(void* window, bool floating, const std::string& title);
void CopyText(const std::string& text);
// Asks, in a sheet on |window|, how far back to clear |what| ("history",
// "cookies"). |done| gets the cutoff in Unix seconds (0 for all time); it is
// not called if the sheet is cancelled.
// Checks for a newer CEF and, if confirmed, rebuilds and redeploys Roar in the
// background (scripts/update-cef.sh then scripts/deploy.sh).
void CheckForUpdates(void* window);
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
// Writes Markdown to ~/Downloads and returns the path, or "" on failure.
std::string SaveMarkdown(const std::string& title, const std::string& markdown);

// Runs `gh api search/issues` off the UI thread; |done| runs on the UI thread
// with the JSON body or an error message.
void SearchGitHub(const std::string& query,
                  std::function<void(std::string json, std::string error)> done);
// Reports "ok", "missing" (gh not installed) or "signed-out".
void GitHubAuthStatus(std::function<void(std::string status)> done);

}  // namespace roar::platform
