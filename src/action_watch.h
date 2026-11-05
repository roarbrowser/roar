// Live toolbar state (icon and badge) of extension actions.
//
// CEF exposes no API for an extension's per-tab action state, so Roar reads it
// over a private DevTools pipe (--remote-debugging-pipe on fds 3 and 4): it
// attaches to each extension's service worker, wraps chrome.action.setIcon to
// remember the icons it sets, and asks for the icon and badge of the active tab.
#pragma once

#include <functional>
#include <set>
#include <string>
#include <vector>

namespace roar::action_watch {

// Call in main before CefInitialize. Returns false if fds 3/4 are taken.
bool PrepareMain();
bool Enabled();
// UI thread, once the context exists. on_change gets StateJson().
void Start(std::function<void(const std::string&)> on_change);
// Re-reads every worker's state when the active tab's URL changes.
void SetActiveUrl(const std::string& url);
// Whether a DevTools client (not Roar's pipe) is attached to a page showing
// url. cb runs on the UI thread; false when the pipe is off.
void IsPageAttached(const std::string& url, std::function<void(bool)> cb);
// URLs of the page targets an outside CDP client is attached to.
void AttachedPageUrls(std::function<void(std::set<std::string>)> cb);
// Asks uBOL whether url's site (its registrable domain) is excluded from
// filtering ("get"), or flips that ("toggle"), in every running uBOL worker.
// cb gets {"site":"…","excluded":bool} as JSON, or "null" without uBOL.
// Only the uBOL worker in `context` (the tab's CDP browserContextId) is asked.
void UbolSite(const std::string& what, const std::string& url, const std::string& context,
              std::function<void(std::string)> cb);
// Evaluates expression (it may return a promise) in extension ext's worker in `context`
// (a CDP browserContextId); cb gets the result as JSON, or "null" without that worker.
void CallWorker(const std::string& ext, const std::string& context, const std::string& expression,
                std::function<void(std::string)> cb);
// Evaluates expression in one worker's session, like CallWorker.
void CallSession(const std::string& session, const std::string& expression, std::function<void(std::string)> cb);
// The sessions of every running worker of extension ext.
std::vector<std::string> WorkerSessions(const std::string& ext);
// cb gets a worker's session when one attaches, and when it logs "__roar_tweaks_share__".
void OnShareSignal(std::function<void(const std::string& ext, const std::string& session)> cb);
// {"<extension id>": {"icon": "data:…" | null, "badge": "3", "color": "rgba(…)"}}
std::string StateJson();

}  // namespace roar::action_watch
