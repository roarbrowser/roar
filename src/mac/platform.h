// macOS services the cross-platform code needs: bundle resources, the menu
// bar, the pasteboard, Downloads and the `gh` CLI.
#pragma once

#include <functional>
#include <string>

namespace roar::platform {

std::string ResourcePath(const std::string& relative);
std::string ReadResource(const std::string& relative);
std::string RandomToken();
int CdpPort();

void InstallMenu();

// Window plumbing. |window| arguments are CefWindow::GetWindowHandle() values.
void AttachChild(void* parent, void* child);  // Shows |child| above |parent|.
void DetachChild(void* parent, void* child);  // Hides |child|.
void StyleWindow(void* window, double corner_radius, bool shadow);
void SetIgnoresMouse(void* window, bool ignores);
// Turns a tab window into a titled, always-on-top mini window, or back.
void SetFloating(void* window, bool floating, const std::string& title);
void CopyText(const std::string& text);
// Writes Markdown to ~/Downloads and returns the path, or "" on failure.
std::string SaveMarkdown(const std::string& title, const std::string& markdown);

// Runs `gh api search/issues` off the UI thread; |done| runs on the UI thread
// with the JSON body or an error message.
void SearchGitHub(const std::string& query,
                  std::function<void(std::string json, std::string error)> done);
// Reports "ok", "missing" (gh not installed) or "signed-out".
void GitHubAuthStatus(std::function<void(std::string status)> done);

}  // namespace roar::platform
