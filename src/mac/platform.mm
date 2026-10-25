#import <objc/runtime.h>
#import <Cocoa/Cocoa.h>
#import <CoreServices/CoreServices.h>
#import <QuartzCore/QuartzCore.h>
#include <CommonCrypto/CommonDigest.h>
#include <Security/Security.h>

#include <algorithm>
#include <set>
#include <fcntl.h>
#import <UserNotifications/UserNotifications.h>
#import <Sparkle/Sparkle.h>
#include <libproc.h>
#include <netinet/in.h>
#include <signal.h>
#include <spawn.h>
#include <sys/file.h>
#include <sys/wait.h>
#include <mutex>
#include <atomic>
#include <crt_externs.h>
#include <sys/socket.h>
#include <unistd.h>

#include "platform.h"

#include "include/base/cef_callback.h"
#include "include/cef_task.h"
#include "include/wrapper/cef_closure_task.h"

#include "controller.h"
#include "garden_parse.h"
#include "state.h"
#include "update_restore.h"

@interface RoarMenuTarget : NSObject <NSMenuDelegate, SPUUpdaterDelegate>
@property(nonatomic, strong) NSArray<NSString*>* commands;
- (void)run:(NSMenuItem*)sender;
@end

@implementation RoarMenuTarget
// ROAR_SPARKLE_FEED points a ROAR_SPARKLE_TEST=1 scratch instance at a local appcast.
- (NSString*)feedURLStringForUpdater:(SPUUpdater*)updater {
  const char* feed = getenv("ROAR_SPARKLE_FEED");
  const char* test = getenv("ROAR_SPARKLE_TEST");
  return feed && test && !strcmp(test, "1") ? @(feed) : nil;
}
- (void)updater:(SPUUpdater*)updater didFindValidUpdate:(SUAppcastItem*)item {
  if (getenv("ROAR_SPARKLE_TEST")) fprintf(stderr, "sparkle: found update %s\n", item.displayVersionString.UTF8String);
  roar::Controller::Get()->Notice("update", std::string("Roar ") + (item.displayVersionString.UTF8String ?: "") + " is available", "Roar > Check for Updates installs it.");
}
- (void)updaterDidNotFindUpdate:(SPUUpdater*)updater {
  if (getenv("ROAR_SPARKLE_TEST")) fprintf(stderr, "sparkle: no update\n");
}
// Install and Relaunch: offers to bring the unpinned tabs back (update_restore.h). Sparkle waits for
// `install` before it quits, so the session and marker are on disk first. Never called for a
// declined install or an install-on-quit, which therefore launch clean.
- (BOOL)updater:(SPUUpdater*)updater shouldPostponeRelaunchForUpdate:(SUAppcastItem*)item
    untilInvokingBlock:(void (^)(void))install {
  auto* c = roar::Controller::Get();
  int n = c->UpdateRestoreCount();
  std::string build = item.versionString.UTF8String ?: "";
  auto& settings = roar::State::Get().settings;
  int choice = roar::AfterUpdatesChoice(settings.after_updates);
  if (n == 0 || choice == 0) return NO;
  if (choice == 1) {
    c->PrepareUpdateRestore(build);
    return NO;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    NSAlert* alert = [[NSAlert alloc] init];
    alert.messageText = [NSString stringWithFormat:@"Restore my %d tab%@ after updating?", n, n == 1 ? @"" : @"s"];
    alert.informativeText = @"Pinned tabs and pinned groups come back either way.";
    [alert addButtonWithTitle:@"Restore"];
    [alert addButtonWithTitle:@"Don't restore"];
    alert.showsSuppressionButton = YES;
    alert.suppressionButton.title = @"Don't ask again";
    [NSApp activateIgnoringOtherApps:YES];
    bool restore = [alert runModal] == NSAlertFirstButtonReturn;
    auto& s = roar::State::Get().settings;
    if (alert.suppressionButton.state == NSControlStateValueOn)
      s.after_updates = restore ? roar::kAfterUpdatesRestore : roar::kAfterUpdatesNever;
    if (restore) roar::Controller::Get()->PrepareUpdateRestore(build);  // Saves settings too.
    else roar::State::Get().Save();
    install();
  });
  return YES;
}
- (void)run:(NSMenuItem*)sender {
  NSString* command = self.commands[sender.tag];
  roar::Controller::Get()->RunCommand(command.UTF8String);
}
- (void)runCommand:(NSMenuItem*)sender {
  roar::Controller::Get()->RunCommand([sender.representedObject UTF8String]);
}
- (void)showRoar:(id)sender {
  [NSApp activateIgnoringOtherApps:YES];
  roar::Controller::Get()->Focus();
}
- (void)hideRoar:(id)sender {
  [NSApp hide:nil];
}
- (void)quitRoar:(id)sender {
  roar::Controller::Get()->Quit();
}
// Roar menu > Uninstall Roar…: confirms, then resources/uninstall-roar.sh waits for Roar to quit
// and moves the app (and, if asked, the data) to the Trash.
- (void)uninstallRoar:(id)sender {
  NSAlert* alert = [[[NSAlert alloc] init] autorelease];  // No ARC here.
  alert.messageText = @"Uninstall Roar?";
  alert.informativeText =
      @"Roar quits, then these go to the Trash:\n• Roar\n• Its caches, logs and update settings\n"
      @"• Its entries in agent configs (Claude Code, Codex, Cursor…), backed up first\n\n"
      @"Unless you keep your data, also:\n• Your profiles: logins, cookies, tabs, spaces and settings\n"
      @"• API keys saved for model chat";
  [alert addButtonWithTitle:@"Uninstall"].hasDestructiveAction = YES;
  [alert addButtonWithTitle:@"Cancel"];
  alert.showsSuppressionButton = YES;
  alert.suppressionButton.title = @"Keep my data (logins, tabs)";
  alert.suppressionButton.state = NSControlStateValueOn;
  [NSApp activateIgnoringOtherApps:YES];
  if ([alert runModal] != NSAlertFirstButtonReturn) return;
  bool keep = alert.suppressionButton.state == NSControlStateValueOn;
  NSString* script = [NSBundle.mainBundle pathForResource:@"uninstall-roar" ofType:@"sh"];
  if (!script) return;
  NSTask* task = [[[NSTask alloc] init] autorelease];
  task.executableURL = [NSURL fileURLWithPath:@"/bin/bash"];
  task.arguments = @[ script, @"--app", NSBundle.mainBundle.bundlePath, @"--yes", keep ? @"--keep-data" : @"--remove-data",
                      @"--wait-pid", [NSString stringWithFormat:@"%d", getpid()] ];
  if (![task launchAndReturnError:nil]) return;
  roar::Controller::Get()->Quit();
}
// Roar menu > Send Diagnostics…: zips Roar's logs and version info, with the home path and URLs
// removed, and opens a Mail draft with the zip attached. Nothing is sent until the user sends it.
- (void)sendDiagnostics:(id)sender {
  NSFileManager* fm = NSFileManager.defaultManager;
  NSString* data = [NSString stringWithUTF8String:roar::State::Get().Dir().c_str()];
  NSString* dir = [NSTemporaryDirectory() stringByAppendingPathComponent:@"Roar Diagnostics"];
  [fm removeItemAtPath:dir error:nil];
  [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  NSRegularExpression* url = [NSRegularExpression regularExpressionWithPattern:@"(https?|wss?|file)://\\S+" options:0 error:nil];
  auto put = [&](NSString* name, NSString* text) {
    if (!text) return;
    text = [text stringByReplacingOccurrencesOfString:NSHomeDirectory() withString:@"~"];
    text = [url stringByReplacingMatchesInString:text options:0 range:NSMakeRange(0, text.length) withTemplate:@"<url>"];
    [text writeToFile:[dir stringByAppendingPathComponent:name] atomically:YES encoding:NSUTF8StringEncoding error:nil];
  };
  auto read = [](NSString* p) { return [NSString stringWithContentsOfFile:p encoding:NSUTF8StringEncoding error:nil]; };
  NSDictionary* info = NSBundle.mainBundle.infoDictionary;
  put(@"info.txt", [NSString stringWithFormat:@"Roar %@ (%@)\nmacOS %@\n%s\n", info[@"CFBundleShortVersionString"],
                       info[@"CFBundleVersion"], NSProcessInfo.processInfo.operatingSystemVersionString,
#if defined(__arm64__)
                       "arm64"
#else
                       "x86_64"
#endif
                       ]);
  put(@"roar.log.old", read([data stringByAppendingPathComponent:@"roar.log.old"]));
  put(@"roar.log", read([data stringByAppendingPathComponent:@"roar.log"]));
  put(@"Roar-update.log", read([NSHomeDirectory() stringByAppendingPathComponent:@"Library/Logs/Roar-update.log"]));
  NSString* zip = [NSTemporaryDirectory() stringByAppendingPathComponent:@"Roar Diagnostics.zip"];
  [fm removeItemAtPath:zip error:nil];
  NSTask* task = [NSTask launchedTaskWithLaunchPath:@"/usr/bin/ditto" arguments:@[ @"-c", @"-k", @"--keepParent", dir, zip ]];
  [task waitUntilExit];
  NSURL* file = [NSURL fileURLWithPath:zip];
  NSSharingService* mail = [NSSharingService sharingServiceNamed:NSSharingServiceNameComposeEmail];
  mail.recipients = @[ @"roarbrowser@gmail.com" ];
  mail.subject = [NSString stringWithFormat:@"Roar %@ diagnostics", info[@"CFBundleShortVersionString"]];
  NSString* body = @"What happened, and what were you doing just before?\n\n\n\n"
                      @"The attached zip holds only Roar's error log and its version and macOS version. "
                      @"Web addresses and your user folder name are removed, and no browsing history, cookies, "
                      @"passwords, tabs or page contents are included. You can open the zip to check before sending.\n";
  NSArray* items = @[ body, file ];
  if (task.terminationStatus == 0 && [mail canPerformWithItems:items]) [mail performWithItems:items];
  else [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:@[ file ]];  // No mail app: show the zip.
}
- (void)toggleSidebar:(id)sender {
  roar::Controller::Get()->RunCommand("sidebar");
}
- (void)addLibraryNodes:(NSArray*)nodes to:(NSMenu*)menu {
  for (NSDictionary* n in nodes) {
    if (![n isKindOfClass:[NSDictionary class]]) continue;
    NSString* title = [n[@"title"] length] ? n[@"title"] : (n[@"url"] ?: @"Untitled");
    if (title.length > 60) title = [[title substringToIndex:59] stringByAppendingString:@"…"];
    if ([n[@"children"] isKindOfClass:[NSArray class]]) {
      NSMenuItem* holder = [menu addItemWithTitle:title action:nil keyEquivalent:@""];
      NSMenu* sub = [[NSMenu alloc] initWithTitle:title];
      [self addLibraryNodes:n[@"children"] to:sub];
      holder.submenu = sub;
      holder.image = [NSImage imageWithSystemSymbolName:@"folder" accessibilityDescription:nil];
    } else if ([n[@"url"] isKindOfClass:[NSString class]]) {
      NSMenuItem* item = [menu addItemWithTitle:title action:@selector(runCommand:) keyEquivalent:@""];
      item.target = self;
      item.representedObject = [@"open:" stringByAppendingString:n[@"url"]];
      item.toolTip = n[@"url"];
    }
  }
}
// Rebuilds the Bookmarks menu from the active space's library each time it opens.
- (void)fillBookmarksMenu:(NSMenu*)menu {
  auto add = [&](NSString* title, NSString* command) {
    NSMenuItem* item = [menu addItemWithTitle:title action:@selector(runCommand:) keyEquivalent:@""];
    item.target = self;
    item.representedObject = command;
  };
  add(@"Bookmark This Page", @"bookmarkAdd");
  add(@"Add to Read Later", @"readLaterAdd");
  add(@"Organize Bookmarks…", @"bookmarks");
  std::string json = roar::Controller::Get()->LibraryJson();
  NSDictionary* lib = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json.data() length:json.size()]
                                                      options:0 error:nil];
  if (![lib isKindOfClass:[NSDictionary class]]) return;
  NSArray* later = lib[@"readLater"];
  if ([later isKindOfClass:[NSArray class]] && later.count) {
    [menu addItem:[NSMenuItem separatorItem]];
    NSMenuItem* holder = [menu addItemWithTitle:[NSString stringWithFormat:@"Read Later (%lu)", (unsigned long)later.count]
                                         action:nil keyEquivalent:@""];
    NSMenu* sub = [[NSMenu alloc] initWithTitle:@"Read Later"];
    [self addLibraryNodes:later to:sub];
    holder.submenu = sub;
  }
  NSArray* bookmarks = lib[@"bookmarks"];
  if ([bookmarks isKindOfClass:[NSArray class]] && bookmarks.count) {
    [menu addItem:[NSMenuItem separatorItem]];
    [self addLibraryNodes:bookmarks to:menu];
  }
}
// Rebuilds the History menu: recently closed tabs and recently visited pages.
- (void)fillHistoryMenu:(NSMenu*)menu {
  auto add = [&](NSMenu* m, NSString* title, NSString* command, NSString* tip) {
    if (title.length > 60) title = [[title substringToIndex:59] stringByAppendingString:@"…"];
    NSMenuItem* item = [m addItemWithTitle:title action:@selector(runCommand:) keyEquivalent:@""];
    item.target = self;
    item.representedObject = command;
    item.toolTip = tip;
  };
  auto ns = [](const std::string& s) { return [NSString stringWithUTF8String:s.c_str()] ?: @""; };
  add(menu, @"Back\t⌘[", @"back", nil);
  add(menu, @"Forward\t⌘]", @"forward", nil);
  add(menu, @"Reopen Closed Tab\t⇧⌘T", @"reopen", nil);
  add(menu, @"Show All History\t⌘Y", @"history", nil);
  roar::State& state = roar::State::Get();
  // Only the active space: each space is its own profile.
  int space = state.active_space;
  long last = std::count_if(state.last_session.begin(), state.last_session.end(),
                            [&](const roar::SavedTab& t) { return t.space == space; });
  if (last) add(menu, [NSString stringWithFormat:@"Reopen All Tabs from Last Session (%ld)", last], @"lastSession", nil);
  std::vector<size_t> closed;
  for (size_t i = 0; i < state.archive.size() && closed.size() < 10; ++i)
    if (state.archive[i].space == space) closed.push_back(i);
  if (!closed.empty()) {
    [menu addItem:[NSMenuItem separatorItem]];
    [menu addItemWithTitle:@"Recently Closed" action:nil keyEquivalent:@""].enabled = NO;
    for (size_t i : closed) {
      const auto& a = state.archive[i];
      add(menu, ns(a.title.empty() ? a.url : a.title), [NSString stringWithFormat:@"restore:%zu", i], ns(a.url));
    }
  }
  std::vector<std::pair<std::string, const roar::HistoryEntry*>> recent;
  std::string prefix = std::to_string(space) + "\t";
  for (const auto& [key, e] : state.history) {
    bool other = key.find('\t') != std::string::npos;
    if (space == 0 ? other : key.compare(0, prefix.size(), prefix) != 0) continue;
    recent.push_back({space == 0 ? key : key.substr(prefix.size()), &e});
  }
  std::sort(recent.begin(), recent.end(),
            [](auto& a, auto& b) { return a.second->last_visit > b.second->last_visit; });
  if (!recent.empty()) {
    [menu addItem:[NSMenuItem separatorItem]];
    [menu addItemWithTitle:@"Recently Visited" action:nil keyEquivalent:@""].enabled = NO;
    for (size_t i = 0; i < std::min<size_t>(recent.size(), 15); ++i) {
      const auto& [url, e] = recent[i];
      add(menu, ns(e->title.empty() ? url : e->title), [@"open:" stringByAppendingString:ns(url)], ns(url));
    }
  }
  [menu addItem:[NSMenuItem separatorItem]];
  add(menu, @"Clear History in This Space", @"clearHistory", nil);
  add(menu, @"Clear Cookies in This Space", @"clearCookies", nil);
}
// Rebuilds the Extensions menu from the active space's profile each time it opens.
- (void)menuNeedsUpdate:(NSMenu*)menu {
  [menu removeAllItems];
  if ([menu.title isEqual:@"Bookmarks"]) return [self fillBookmarksMenu:menu];
  if ([menu.title isEqual:@"History"]) return [self fillHistoryMenu:menu];
  NSMenu* target = menu;
  auto add = [&](NSString* title, NSString* command) {
    NSMenuItem* item = [target addItemWithTitle:title action:@selector(runCommand:) keyEquivalent:@""];
    item.target = self;
    item.representedObject = command;
  };
  add(@"Manage Extensions…", @"extensions");
  add(@"Chrome Web Store…", @"extensionStore");
  std::string json = roar::Controller::Get()->ExtensionsJson();
  NSData* data = [NSData dataWithBytes:json.data() length:json.size()];
  NSArray* list = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![list isKindOfClass:[NSArray class]] || !list.count) return;
  list = [list sortedArrayUsingComparator:^NSComparisonResult(NSDictionary* a, NSDictionary* b) {
    return [a[@"name"] localizedCaseInsensitiveCompare:b[@"name"]];
  }];
  [menu addItem:[NSMenuItem separatorItem]];
  for (NSDictionary* x in list) {
    NSMenuItem* holder = [menu addItemWithTitle:x[@"name"] action:nil keyEquivalent:@""];
    if ([x[@"pinned"] boolValue]) holder.state = NSControlStateValueOn;
    NSMenu* sub = [[NSMenu alloc] initWithTitle:x[@"name"]];
    target = sub;
    add([x[@"pinned"] boolValue] ? @"Unpin from Sidebar" : @"Pin to Sidebar",
        [@"extensionPin:" stringByAppendingString:x[@"id"]]);
    add(@"Details", [@"extension:" stringByAppendingString:x[@"id"]]);
    target = menu;
    holder.submenu = sub;
  }
}
- (void)quit:(id)sender {
  roar::Controller::Get()->Quit();
}
@end

@interface RoarMenuPick : NSObject
@property(nonatomic) NSInteger picked;
@end
@implementation RoarMenuPick
- (void)pick:(NSMenuItem*)item { self.picked = item.tag; }
@end

namespace roar::platform {

namespace {

RoarMenuTarget* g_menu_target = nil;
SPUStandardUpdaterController* g_updater = nil;

NSString* NS(const std::string& s) { return [NSString stringWithUTF8String:s.c_str()]; }

NSString* GhPath() {
  for (NSString* p in @[ @"/opt/homebrew/bin/gh", @"/usr/local/bin/gh", @"/usr/bin/gh" ])
    if ([[NSFileManager defaultManager] isExecutableFileAtPath:p]) return p;
  return nil;
}

// Runs |tool| with |args| and returns stdout, stderr text and the exit status.
int RunTool(NSString* tool, NSArray<NSString*>* args, NSString** out, NSString** err) {
  NSTask* task = [[NSTask alloc] init];
  task.executableURL = [NSURL fileURLWithPath:tool];
  task.arguments = args;
  NSPipe* outPipe = [NSPipe pipe];
  NSPipe* errPipe = [NSPipe pipe];
  task.standardOutput = outPipe;
  task.standardError = errPipe;
  NSError* launchError = nil;
  if (![task launchAndReturnError:&launchError]) {
    *err = launchError.localizedDescription;
    return -1;
  }
  NSData* outData = [outPipe.fileHandleForReading readDataToEndOfFile];
  NSData* errData = [errPipe.fileHandleForReading readDataToEndOfFile];
  [task waitUntilExit];
  *out = [[NSString alloc] initWithData:outData encoding:NSUTF8StringEncoding] ?: @"";
  *err = [[NSString alloc] initWithData:errData encoding:NSUTF8StringEncoding] ?: @"";
  return task.terminationStatus;
}

int RunGh(NSArray<NSString*>* args, NSString** out, NSString** err) { return RunTool(GhPath(), args, out, err); }

void OnUi(base::OnceClosure closure) { CefPostTask(TID_UI, std::move(closure)); }

NSWindow* Win(void* handle) {
  id obj = (__bridge id)handle;
  if ([obj isKindOfClass:[NSWindow class]]) return obj;
  if ([obj isKindOfClass:[NSView class]]) return ((NSView*)obj).window;
  return nil;
}

}  // namespace

std::string ResourcePath(const std::string& relative) {
  return std::string(NSBundle.mainBundle.resourcePath.UTF8String) + "/" + relative;
}

std::string ReadResource(const std::string& relative) {
  NSString* text = [NSString stringWithContentsOfFile:NS(ResourcePath(relative))
                                             encoding:NSUTF8StringEncoding
                                                error:nil];
  return text ? text.UTF8String : "";
}

std::string RandomToken() {
  uint8_t bytes[16];
  if (SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes) != errSecSuccess) arc4random_buf(bytes, sizeof(bytes));
  std::string hex;
  char buf[3];
  for (uint8_t b : bytes) {
    snprintf(buf, sizeof(buf), "%02x", b);
    hex += buf;
  }
  return hex;
}

namespace {

NSArray* SafariNodes(NSArray* children) {
  NSMutableArray* out = [NSMutableArray array];
  for (NSDictionary* n in children) {
    if (![n isKindOfClass:[NSDictionary class]]) continue;
    NSString* type = n[@"WebBookmarkType"];
    if ([type isEqual:@"WebBookmarkTypeLeaf"] && [n[@"URLString"] isKindOfClass:[NSString class]]) {
      NSString* title = n[@"URIDictionary"][@"title"] ?: n[@"URLString"];
      [out addObject:@{@"title" : title, @"url" : n[@"URLString"]}];
    } else if ([type isEqual:@"WebBookmarkTypeList"]) {
      NSArray* kids = SafariNodes(n[@"Children"]);
      if (kids.count) [out addObject:@{@"title" : n[@"Title"] ?: @"Folder", @"children" : kids}];
    }
  }
  return out;
}

}  // namespace

std::string SafariBookmarksJson() {
  NSString* path = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Safari/Bookmarks.plist"];
  NSDictionary* root = [NSDictionary dictionaryWithContentsOfURL:[NSURL fileURLWithPath:path] error:nil];
  if (!root) return "";
  NSMutableArray* bookmarks = [NSMutableArray array];
  NSArray* reading = @[];
  NSMutableArray* loose = [NSMutableArray array];  // Top-level leaves, kept in order after the bar.
  for (NSDictionary* top in root[@"Children"]) {
    if (![top isKindOfClass:[NSDictionary class]]) continue;
    if ([top[@"WebBookmarkType"] isEqual:@"WebBookmarkTypeLeaf"]) { [loose addObject:top]; continue; }
    NSString* title = top[@"Title"];
    NSArray* kids = SafariNodes(top[@"Children"]);
    if ([title isEqual:@"BookmarksBar"]) [bookmarks addObjectsFromArray:kids];
    else if ([title isEqual:@"BookmarksMenu"]) { if (kids.count) [bookmarks addObject:@{@"title" : @"Bookmarks Menu", @"children" : kids}]; }
    else if ([title isEqual:@"com.apple.ReadingList"]) reading = kids;
    else if (kids.count && title) [bookmarks addObject:@{@"title" : title, @"children" : kids}];
  }
  [bookmarks addObjectsFromArray:SafariNodes(loose)];
  NSData* json = [NSJSONSerialization dataWithJSONObject:@{@"bookmarks" : bookmarks, @"readingList" : reading}
                                                 options:0 error:nil];
  return json ? std::string(static_cast<const char*>(json.bytes), json.length) : "";
}

std::string UnpackedExtensionId(const std::string& path) {
  uint8_t digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(path.data(), static_cast<CC_LONG>(path.size()), digest);
  std::string id;
  for (int i = 0; i < 16; ++i) {
    id += static_cast<char>('a' + (digest[i] >> 4));
    id += static_cast<char>('a' + (digest[i] & 15));
  }
  return id;
}

namespace {
bool PortFree(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return false;
  sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  bool ok = bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0;
  close(fd);
  return ok;
}

std::string InstanceDir(const std::string& name) {
  return std::string(getenv("HOME")) + "/Library/Application Support/Roar-" + name;
}

// Whether a running Roar holds |dir|'s instance lock.
bool InstanceRunning(const std::string& dir) {
  int fd = open((dir + "/instance.lock").c_str(), O_RDONLY);
  if (fd < 0) return false;
  bool held = flock(fd, LOCK_EX | LOCK_NB) != 0;
  close(fd);
  return held;
}
}  // namespace

std::string InstanceName() {
  const char* env = getenv("ROAR_INSTANCE");
  return env ? env : "";
}

int CdpPort() {
  static int port = [] {
    const char* env = getenv("ROAR_CDP_PORT");
    if (int p = env ? atoi(env) : 0; p > 0) return p;
    if (InstanceName().empty()) return 9222;
    // 9222 belongs to other Chromes and 9444 to headless Roar.
    for (int p = 9333; p < 9500; ++p)
      if (p != 9444 && PortFree(p)) return p;
    return 0;
  }();
  return port;
}

bool CdpEnabled() {
  static bool on = [] {
    if (getenv("ROAR_CDP_PORT") || Headless()) return true;
    // Read before CefInitialize, so straight from state.json rather than State.
    NSData* data = [NSData dataWithContentsOfFile:NS(roar::State::Get().Dir() + "/state.json")];
    NSDictionary* root = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    id s = [root isKindOfClass:NSDictionary.class] ? root[@"settings"] : nil;
    id on = [s isKindOfClass:NSDictionary.class] ? s[@"cdpOpen"] : nil;
    return on ? (bool)[on boolValue] : true;
  }();
  return on;
}

namespace {
// Calls |fn| with each TCP socket of |pid|.
template <typename Fn>
void ForEachTcp(pid_t pid, Fn fn) {
  int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nullptr, 0);
  if (bytes <= 0) return;
  std::vector<proc_fdinfo> fds(bytes / sizeof(proc_fdinfo) + 16);
  bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds.data(), static_cast<int>(fds.size() * sizeof(proc_fdinfo)));
  for (int i = 0; i < bytes / static_cast<int>(sizeof(proc_fdinfo)); ++i) {
    if (fds[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
    socket_fdinfo si;
    if (proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDSOCKETINFO, &si, sizeof si) != sizeof si) continue;
    if (si.psi.soi_kind == SOCKINFO_TCP) fn(si.psi.soi_proto.pri_tcp);
  }
}
}  // namespace

// Counts the processes on the other end of this Roar's CDP connections: one
// client (an MCP server) often holds several sockets.
int CdpClientCount() {
  int port = CdpPort();
  std::set<int> peers;  // Client-side ports of established CDP connections.
  ForEachTcp(getpid(), [&](const tcp_sockinfo& tcp) {
    if (tcp.tcpsi_state == TSI_S_ESTABLISHED && ntohs(tcp.tcpsi_ini.insi_lport) == port)
      peers.insert(ntohs(tcp.tcpsi_ini.insi_fport));
  });
  if (peers.empty()) return 0;
  std::vector<pid_t> pids(proc_listallpids(nullptr, 0) + 64);
  int n = proc_listallpids(pids.data(), static_cast<int>(pids.size() * sizeof(pid_t)));
  std::set<pid_t> clients;
  for (int i = 0; i < n && !peers.empty(); ++i) {
    if (pids[i] == getpid() || pids[i] <= 0) continue;
    ForEachTcp(pids[i], [&](const tcp_sockinfo& tcp) {
      if (ntohs(tcp.tcpsi_ini.insi_fport) == port && peers.erase(ntohs(tcp.tcpsi_ini.insi_lport)))
        clients.insert(pids[i]);
    });
  }
  // Sockets whose owner could not be read (another user's process) count one each.
  return static_cast<int>(clients.size() + peers.size());
}

void Notify(const std::string& title, const std::string& body, const std::string& id) {
  UNUserNotificationCenter* center = UNUserNotificationCenter.currentNotificationCenter;
  NSString* t = NS(title);
  NSString* b = NS(body);
  NSString* ident = id.empty() ? NSUUID.UUID.UUIDString : NS("roar." + id);
  [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound
                        completionHandler:^(BOOL granted, NSError*) {
                          if (!granted) return;
                          UNMutableNotificationContent* c = [[UNMutableNotificationContent alloc] init];
                          c.title = t;
                          c.body = b;
                          c.sound = UNNotificationSound.defaultSound;
                          [center addNotificationRequest:[UNNotificationRequest requestWithIdentifier:ident
                                                                                              content:c
                                                                                              trigger:nil]
                                   withCompletionHandler:nil];
                        }];
}

void Unnotify(const std::string& id) {
  if (id.empty()) return;
  NSArray<NSString*>* ids = @[ NS("roar." + id) ];
  UNUserNotificationCenter* center = UNUserNotificationCenter.currentNotificationCenter;
  [center removePendingNotificationRequestsWithIdentifiers:ids];
  [center removeDeliveredNotificationsWithIdentifiers:ids];
}

void SetDockBadge(int count) {
  NSApp.dockTile.badgeLabel = count > 0 ? [NSString stringWithFormat:@"%d", count] : nil;
}

bool AppActive() { return NSApp.isActive; }

bool IsDefaultBrowser() {
  NSURL* app = [NSWorkspace.sharedWorkspace URLForApplicationToOpenURL:[NSURL URLWithString:@"https://example.com"]];
  // By bundle id, so a build outside /Applications still counts.
  return app && [[NSBundle bundleWithURL:app].bundleIdentifier isEqualToString:NSBundle.mainBundle.bundleIdentifier];
}

void MakeDefaultBrowser(std::function<void()> done) {
  NSURL* me = NSBundle.mainBundle.bundleURL;
  NSWorkspace* ws = NSWorkspace.sharedWorkspace;
  [ws setDefaultApplicationAtURL:me toOpenURLsWithScheme:@"http" completionHandler:^(NSError*) {
    [ws setDefaultApplicationAtURL:me toOpenURLsWithScheme:@"https" completionHandler:^(NSError*) {
      dispatch_async(dispatch_get_main_queue(), ^{ if (done) done(); });
    }];
  }];
}

void RelaunchAfterExit(const std::string& wipe_dir) {
  // Instances and scratch runs come back as themselves.
  // Values go in as arguments, never into the script text.
  NSMutableArray* args = [NSMutableArray arrayWithArray:@[
    @"/bin/sh", @"-c",
    @"while kill -0 \"$1\" 2>/dev/null; do sleep 0.5; done; [ -n \"$2\" ] && rm -rf \"$2\"; shift 2; exec open -n \"$@\"",
    @"sh", [NSString stringWithFormat:@"%d", getpid()], NS(wipe_dir)
  ]];
  for (const char* key : {"ROAR_DATA_DIR", "ROAR_INSTANCE", "ROAR_CDP_PORT", "ROAR_UI_CDP"})
    if (const char* v = getenv(key)) [args addObjectsFromArray:@[ @"--env", [NSString stringWithFormat:@"%s=%s", key, v] ]];
  [args addObject:NSBundle.mainBundle.bundlePath];
  if (Headless()) [args addObjectsFromArray:@[ @"--args", @"--headless=new" ]];
  NSTask* run = [[NSTask alloc] init];
  run.executableURL = [NSURL fileURLWithPath:@"/usr/bin/nohup"];
  run.arguments = args;
  run.standardOutput = [NSFileHandle fileHandleWithNullDevice];
  run.standardError = [NSFileHandle fileHandleWithNullDevice];
  [run launchAndReturnError:nil];
}

bool ClaimInstance(const std::string& dir) {
  [NSFileManager.defaultManager createDirectoryAtPath:NS(dir) withIntermediateDirectories:YES attributes:nil error:nil];
  int fd = open((dir + "/instance.lock").c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0644);
  if (fd < 0 || flock(fd, LOCK_EX | LOCK_NB) != 0) return false;  // fd stays open, holding the lock
  [[NSString stringWithFormat:@"%d\n", CdpPort()] writeToFile:NS(dir + "/cdp-port")
                                                     atomically:YES
                                                       encoding:NSUTF8StringEncoding
                                                          error:nil];
  return true;
}

void LaunchInstance() {
  std::string name;
  for (int n = 2;; ++n)
    if (!InstanceRunning(InstanceDir(name = std::to_string(n)))) break;
  NSTask* task = [[NSTask alloc] init];
  task.launchPath = @"/usr/bin/open";
  task.arguments = @[ @"-n", NSBundle.mainBundle.bundlePath, @"--args", NS("--instance=" + name) ];
  [task launch];
}

bool Headless() {
  for (NSString* arg in NSProcessInfo.processInfo.arguments)
    if ([arg isEqualToString:@"--headless"] || [arg hasPrefix:@"--headless="]) return true;
  return false;
}

void InstallStatusItem() {
  static NSStatusItem* item = nil;
  if (item) return;
  item = [NSStatusBar.systemStatusBar statusItemWithLength:NSSquareStatusItemLength];
  NSImage* icon = [NSImage imageNamed:NSImageNameApplicationIcon];
  icon = [icon copy];
  icon.size = NSMakeSize(18, 18);
  item.button.image = icon;
  item.button.toolTip = @"Roar (headless)";
  NSMenu* menu = [[NSMenu alloc] init];
  auto add = [&](NSString* title, SEL action) {
    NSMenuItem* entry = [menu addItemWithTitle:title action:action keyEquivalent:@""];
    entry.target = g_menu_target;
  };
  add(@"Show Roar", @selector(showRoar:));
  add(@"Hide Roar", @selector(hideRoar:));
  [menu addItem:[NSMenuItem separatorItem]];
  add(@"Quit Roar", @selector(quitRoar:));
  item.menu = menu;
}

void HideApp() { [NSApp hide:nil]; }

void InstallMenu() {
  g_menu_target = [[RoarMenuTarget alloc] init];
  {
    // Scratch/test instances and headless Roar never check, unless ROAR_SPARKLE_TEST=1.
    const char* test = getenv("ROAR_SPARKLE_TEST");
    bool on = (test && !strcmp(test, "1")) || !(getenv("ROAR_DATA_DIR") || getenv("ROAR_CDP_PORT") || Headless());
    if (on)
      g_updater = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:YES
                                                                updaterDelegate:g_menu_target
                                                             userDriverDelegate:nil];
    // Sparkle's windows (update found, download progress, install) float above Roar's
    // tab windows, so a click in a page never buries a pending update.
    if (on)
      [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidBecomeKeyNotification object:nil queue:nil
                                                  usingBlock:^(NSNotification* n) {
        NSWindow* w = n.object;
        NSString* cls = NSStringFromClass([w.windowController class] ?: [w class]);
        if ([cls hasPrefix:@"SU"] || [cls hasPrefix:@"SPU"]) {
          w.level = NSFloatingWindowLevel;
          w.hidesOnDeactivate = NO;
        }
      }];
  }
  NSMutableArray<NSString*>* commands = [NSMutableArray array];
  NSMenu* bar = [[NSMenu alloc] init];

  auto addMenu = [&](NSString* title) {
    NSMenuItem* holder = [bar addItemWithTitle:title action:nil keyEquivalent:@""];
    NSMenu* menu = [[NSMenu alloc] initWithTitle:title];
    holder.submenu = menu;
    return menu;
  };
  // Shortcuts are handled by the browser views (Controller::OnKey), so these
  // items carry no key equivalents of their own; the hint shows the keys.
  auto addCommand = [&](NSMenu* menu, NSString* title, NSString* command, NSString* keys) {
    NSString* label = keys.length ? [NSString stringWithFormat:@"%@\t%@", title, keys] : title;
    NSMenuItem* item = [menu addItemWithTitle:label action:@selector(run:) keyEquivalent:@""];
    item.target = g_menu_target;
    item.tag = commands.count;
    [commands addObject:command];
  };

  NSMenu* app = addMenu(@"Roar");
  [app addItemWithTitle:@"About Roar" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
  [app addItem:[NSMenuItem separatorItem]];
  addCommand(app, @"Check for Updates…", @"checkUpdates", @"");
  if (sizeof(ROAR_SOURCE_DIR) > 1) addCommand(app, @"Update Chromium…", @"updateChromium", @"");  // Not in release builds.
  addCommand(app, @"New Instance", @"newInstance", @"");
  {
    std::string name = InstanceName();
    NSString* label = [NSString stringWithFormat:@"%@ · %@", name.empty() ? @"Main instance" : NS("Instance " + name),
                                                 [NSString stringWithFormat:@"CDP port %d", CdpPort()]];
    [app addItemWithTitle:label action:nil keyEquivalent:@""].enabled = NO;
  }
  // A real key equivalent, so ⌘, works even when no page has keyboard focus (pages that do get it
  // first through OnKey; OpenSettings is idempotent either way).
  addCommand(app, @"Settings…", @"settings", @"");
  app.itemArray.lastObject.keyEquivalent = @",";
  [app addItemWithTitle:@"Send Diagnostics…" action:@selector(sendDiagnostics:) keyEquivalent:@""].target = g_menu_target;
  [app addItemWithTitle:@"Uninstall Roar…" action:@selector(uninstallRoar:) keyEquivalent:@""].target = g_menu_target;
  [app addItem:[NSMenuItem separatorItem]];
  [app addItemWithTitle:@"Hide Roar" action:@selector(hide:) keyEquivalent:@"h"];
  NSMenuItem* quit = [app addItemWithTitle:@"Quit Roar" action:@selector(quit:) keyEquivalent:@"q"];
  quit.target = g_menu_target;

  NSMenu* file = addMenu(@"File");
  addCommand(file, @"New Tab", @"newTab", @"⌘T");
  addCommand(file, @"New Window", @"newInstance", @"⌘N");
  addCommand(file, @"New Ghost Tab", @"newGhostTab", @"⇧⌘N");
  addCommand(file, @"Reopen Archived Tab", @"reopen", @"⇧⌘T");
  addCommand(file, @"Close Tab", @"closeTab", @"⌘W");
  addCommand(file, @"Print…", @"print", @"⌘P");
  [file addItem:[NSMenuItem separatorItem]];
  addCommand(file, @"Copy Page as Markdown", @"copyMarkdown", @"⇧⌘C");
  addCommand(file, @"Save Page as Markdown", @"saveMarkdown", @"");
  [file addItem:[NSMenuItem separatorItem]];
  NSMenuItem* importHolder = [file addItemWithTitle:@"Import From" action:nil keyEquivalent:@""];
  NSMenu* importMenu = [[NSMenu alloc] initWithTitle:@"Import From"];
  for (NSArray* b in @[ @[ @"Arc", @"arc" ], @[ @"Chrome", @"chrome" ], @[ @"Edge", @"edge" ], @[ @"Firefox", @"firefox" ],
                        @[ @"Safari", @"safari" ], @[ @"Dia", @"dia" ] ])
    addCommand(importMenu, b[0], [@"import:" stringByAppendingString:b[1]], @"");
  importHolder.submenu = importMenu;

  NSMenu* edit = addMenu(@"Edit");
  [edit addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
  [edit addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"Z"];
  [edit addItem:[NSMenuItem separatorItem]];
  [edit addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
  [edit addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
  [edit addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
  [edit addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
  [edit addItem:[NSMenuItem separatorItem]];
  addCommand(edit, @"Find in Page…", @"find", @"⌘F");

  NSMenu* view = addMenu(@"View");
  addCommand(view, @"Toggle Sidebar", @"sidebar", @"⌥⌘B");
  addCommand(view, @"Reload", @"reload", @"⌘R");
  addCommand(view, @"Back", @"back", @"⌘[");
  addCommand(view, @"Forward", @"forward", @"⌘]");
  [view addItem:[NSMenuItem separatorItem]];
  addCommand(view, @"Zoom In", @"zoomIn", @"⌘+");
  addCommand(view, @"Zoom Out", @"zoomOut", @"⌘−");
  addCommand(view, @"Actual Size", @"zoomReset", @"⌘0");
  addCommand(view, @"Reader Mode", @"reader", @"⌥⌘R");
  [view addItem:[NSMenuItem separatorItem]];
  addCommand(view, @"Picture in Picture", @"pip", @"⇧⌘P");
  addCommand(view, @"Float Tab", @"float", @"⇧⌘F");
  [view addItem:[NSMenuItem separatorItem]];
  addCommand(view, @"Developer Tools", @"devtools", @"⌥⌘I");

  NSMenu* tabs = addMenu(@"Tabs");
  addCommand(tabs, @"Clean Up Tabs", @"clean", @"⇧⌘K");
  addCommand(tabs, @"Close All Tabs in This Space", @"closeSpaceTabs", @"");
  addCommand(tabs, @"Pin or Unpin Tab", @"pin", @"⌘D");
  addCommand(tabs, @"Mute or Unmute Tab", @"mute", @"");
  addCommand(tabs, @"Show Downloads", @"downloads", @"⇧⌘J");
  addCommand(tabs, @"Agent Files Browser", @"agentmd", @"");
  addCommand(tabs, @"Refresh Pull Requests", @"github", @"");
  addCommand(tabs, @"Refresh Mail", @"gmail", @"");

  NSMenu* history = addMenu(@"History");
  history.delegate = g_menu_target;

  NSMenu* bookmarks = addMenu(@"Bookmarks");
  bookmarks.delegate = g_menu_target;

  NSMenu* extensions = addMenu(@"Extensions");
  extensions.delegate = g_menu_target;

  NSMenu* window = addMenu(@"Window");
  [window addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
  [window addItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@""];
  NSApp.windowsMenu = window;

  g_menu_target.commands = commands;
  NSApp.mainMenu = bar;
}

void SetSidebarButton(void* window, bool visible) {
  NSWindow* w = Win(window);
  if (!w) return;
  static NSButton* button = nil;
  if (!button) {
    NSImage* icon = [NSImage imageWithSystemSymbolName:@"sidebar.left" accessibilityDescription:@"Show sidebar"];
    button = [NSButton buttonWithImage:icon target:g_menu_target action:@selector(toggleSidebar:)];
    button.bordered = NO;
    button.toolTip = @"Show sidebar (⌥⌘B)";
    button.contentTintColor = NSColor.secondaryLabelColor;
  }
  NSView* frameView = w.contentView.superview;
  NSButton* zoom = [w standardWindowButton:NSWindowZoomButton];
  if (button.superview != frameView) {
    [button removeFromSuperview];
    [frameView addSubview:button positioned:NSWindowAbove relativeTo:nil];
  }
  NSRect z = zoom ? [frameView convertRect:zoom.bounds fromView:zoom] : NSMakeRect(52, NSHeight(frameView.bounds) - 22, 14, 14);
  button.frame = NSMakeRect(NSMaxX(z) + 12, NSMidY(z) - 11, 22, 22);
  button.autoresizingMask = NSViewMaxXMargin | NSViewMinYMargin;
  button.hidden = !visible;
}

void AttachChild(void* parent, void* child) {
  NSWindow* p = Win(parent);
  NSWindow* c = Win(child);
  if (!p || !c) return;
  // Re-adding moves it to the top of the parent's children.
  if (c.parentWindow == p) [p removeChildWindow:c];
  [p addChildWindow:c ordered:NSWindowAbove];
  // orderFront: would lift the whole window group over the app the person is using.
  if (NSApp.isActive) [c orderFront:nil];
  else [c orderWindow:NSWindowAbove relativeTo:p.windowNumber];
}

void DetachChild(void* parent, void* child) {
  NSWindow* p = Win(parent);
  NSWindow* c = Win(child);
  if (!c) return;
  if (p && c.parentWindow == p) [p removeChildWindow:c];
  [c orderOut:nil];
}

namespace {
NSString* const kBackdropId = @"roar.backdrop";
}

void AddBackdrop(void* parent, void* child, const std::string& jpeg) {
  NSWindow* p = Win(parent);
  NSWindow* c = Win(child);
  NSImage* image = [[NSImage alloc] initWithData:[NSData dataWithBytes:jpeg.data() length:jpeg.size()]];
  if (!p || !c || !image || NSApp.active) return;
  NSView* content = p.contentView;
  NSRect frame = [content convertRect:[p convertRectFromScreen:c.frame] fromView:nil];
  NSImageView* view = [NSImageView imageViewWithImage:image];
  view.identifier = kBackdropId;
  view.imageScaling = NSImageScaleAxesIndependently;
  view.frame = frame;
  view.wantsLayer = YES;
  view.layer.cornerRadius = c.contentView.layer.cornerRadius;
  view.layer.masksToBounds = YES;
  [content addSubview:view positioned:NSWindowAbove relativeTo:nil];
}

void ClearBackdrop(void* parent) {
  NSWindow* p = Win(parent);
  for (NSView* v in [p.contentView.subviews copy])
    if ([v.identifier isEqualToString:kBackdropId]) [v removeFromSuperview];
}

void StyleWindow(void* window, double corner_radius, bool shadow) {
  NSWindow* w = Win(window);
  if (!w) return;
  w.opaque = NO;
  w.backgroundColor = NSColor.clearColor;
  w.hasShadow = shadow;
  // Tab and popup windows are parts of the shell window: keep them out of the
  // Dock's window list, Exposé, the Window menu and ⌘` cycling.
  w.collectionBehavior |= NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorTransient |
                          NSWindowCollectionBehaviorIgnoresCycle;
  w.excludedFromWindowsMenu = YES;
  // Window switchers and Dock previews (Vorssaint, AltTab) list a process's
  // AXStandardWindows; a tab window is not one.
  w.accessibilitySubrole = NSAccessibilityUnknownSubrole;
  // A resizable edge would sit over the sidebar's resize handle and drag the
  // tab window out from under the layout instead.
  w.styleMask &= ~NSWindowStyleMaskResizable;
  // Click-through between panes: Chromium's web view asks its window -acceptsFirstMouse (1 on,
  // 0 default); without it a click on the split pane that isn't key only focused that window,
  // so its play button (and anything else) needed a second click.
  static char kClickThrough;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    class_addMethod(w.class, @selector(acceptsFirstMouse), imp_implementationWithBlock(^int(NSWindow* self_) {
      return objc_getAssociatedObject(self_, &kClickThrough) && NSApp.isActive ? 1 : 0;
    }), "i@:");
  });
  objc_setAssociatedObject(w, &kClickThrough, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  NSView* content = w.contentView;
  content.wantsLayer = YES;
  content.layer.cornerRadius = corner_radius;
  content.layer.cornerCurve = kCACornerCurveContinuous;
  content.layer.masksToBounds = YES;
}

void SetIgnoresMouse(void* window, bool ignores) {
  if (NSWindow* w = Win(window)) w.ignoresMouseEvents = ignores;
}

bool IsLeftMouseDown() { return NSEvent.pressedMouseButtons & 1; }

void TrackHorizontalDrag(void* window, std::function<void(int x)> on_move) {
  NSWindow* w = Win(window);
  // A click that is already over would leave the monitor waiting for the next one.
  if (!w || !(NSEvent.pressedMouseButtons & 1)) return;
  // A local monitor sees the drag even over the tab windows, which a page's
  // pointer capture cannot reach.
  __block id monitor = nil;
  monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp
                                                  handler:^NSEvent*(NSEvent* event) {
    NSPoint p = [w convertPointFromScreen:NSEvent.mouseLocation];
    on_move(static_cast<int>(p.x));
    if ((event.type == NSEventTypeLeftMouseUp || !(NSEvent.pressedMouseButtons & 1)) && monitor) {
      [NSEvent removeMonitor:monitor];
      monitor = nil;
    }
    return event;
  }];
}

}  // namespace roar::platform

@interface RoarPaneNav : NSPanel
@property(nonatomic, copy) void (^press)(BOOL forward);
@end
@implementation RoarPaneNav
- (BOOL)canBecomeKeyWindow { return NO; }
- (void)back:(id)s { if (self.press) self.press(NO); }
- (void)forward:(id)s { if (self.press) self.press(YES); }
@end

@interface RoarDivider : NSView
@property(nonatomic) BOOL stacked;
@property(nonatomic, copy) void (^onDrag)(NSPoint screen);
@property(nonatomic, copy) void (^onReset)(void);
@property(nonatomic, copy) void (^onKey)(int step);
@end

@implementation RoarDivider {
  id _monitor;
}
- (void)resetCursorRects {
  [self addCursorRect:self.bounds cursor:self.stacked ? NSCursor.resizeUpDownCursor : NSCursor.resizeLeftRightCursor];
}
- (void)drawRect:(NSRect)r {
  // A short grip in the middle of the gap; brighter while it has keyboard focus.
  NSRect b = self.bounds;
  NSRect g = self.stacked ? NSMakeRect(NSMidX(b) - 18, NSMidY(b) - 1.5, 36, 3) : NSMakeRect(NSMidX(b) - 1.5, NSMidY(b) - 18, 3, 36);
  BOOL focused = self.window.isKeyWindow && self.window.firstResponder == self;
  [[NSColor colorWithWhite:0.5 alpha:focused ? 0.9 : 0.45] setFill];
  [[NSBezierPath bezierPathWithRoundedRect:g xRadius:1.5 yRadius:1.5] fill];
}
- (BOOL)acceptsFirstMouse:(NSEvent*)e { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)becomeFirstResponder { self.needsDisplay = YES; return YES; }
- (BOOL)resignFirstResponder { self.needsDisplay = YES; return YES; }
- (void)keyDown:(NSEvent*)e {
  // Arrows nudge 2% (⇧ 10%); Return or Esc hands focus back to the pages.
  unichar c = e.charactersIgnoringModifiers.length ? [e.charactersIgnoringModifiers characterAtIndex:0] : 0;
  int big = (e.modifierFlags & NSEventModifierFlagShift) ? 5 : 1;
  int dir = 0;
  if (c == NSLeftArrowFunctionKey || c == NSUpArrowFunctionKey) dir = -1;
  else if (c == NSRightArrowFunctionKey || c == NSDownArrowFunctionKey) dir = 1;
  if (dir && self.onKey) return self.onKey(dir * big);
  if (c == 27 || c == '\r') { [self.window.parentWindow makeKeyWindow]; return; }
  [super keyDown:e];
}
- (void)mouseDown:(NSEvent*)e {
  [self.window makeKeyWindow];
  [self.window makeFirstResponder:self];
  if (e.clickCount == 2) { if (self.onReset) self.onReset(); return; }
  // A local monitor keeps tracking while the pointer is over the tab windows.
  RoarDivider* me = self;  // The one divider lives for the whole run.
  _monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp
                                                   handler:^NSEvent*(NSEvent* ev) {
    RoarDivider* d = me;
    if (d && d.onDrag) d.onDrag(NSEvent.mouseLocation);
    if (d && ev.type == NSEventTypeLeftMouseUp) { [NSEvent removeMonitor:d->_monitor]; d->_monitor = nil; }
    return ev;
  }];
}
@end

// Key only after a click on it, so arrows reach the divider instead of a page.
@interface RoarDividerPanel : NSPanel
@end
@implementation RoarDividerPanel
- (BOOL)canBecomeKeyWindow { return YES; }
@end

namespace roar::platform {

void SetSplitDivider(void* window, int x, int y, int w, int h, bool stacked,
                     std::function<void(int sx, int sy)> on_drag, std::function<void()> reset,
                     std::function<void(int step)> on_key) {
  NSWindow* win = Win(window);
  if (!win) return;
  // Its own child panel: the shell's content view (Chromium's BridgedContentView) answers
  // -hitTest: itself for the gap, so a subview there never saw a click.
  static RoarDividerPanel* panel = nil;
  if (w <= 0 || h <= 0) {
    if (panel.parentWindow) [panel.parentWindow removeChildWindow:panel];
    [panel orderOut:nil];
    return;
  }
  if (!panel) {
    panel = [[RoarDividerPanel alloc] initWithContentRect:NSZeroRect
                                                styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                                  backing:NSBackingStoreBuffered defer:NO];
    panel.releasedWhenClosed = NO;
    panel.opaque = NO;
    panel.backgroundColor = NSColor.clearColor;
    panel.hasShadow = NO;
    panel.collectionBehavior = NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorIgnoresCycle;
    panel.excludedFromWindowsMenu = YES;
    panel.contentView = [[RoarDivider alloc] initWithFrame:NSZeroRect];
    // Shows as a plain splitter to VoiceOver, adjustable with the arrows.
    panel.contentView.accessibilityRole = NSAccessibilitySplitterRole;
    panel.contentView.accessibilityLabel = @"Split divider";
  }
  CGFloat top = NSScreen.screens.firstObject.frame.size.height;
  [panel setFrame:NSMakeRect(x, top - y - h, w, h) display:NO];
  RoarDivider* divider = (RoarDivider*)panel.contentView;
  divider.stacked = stacked;
  divider.onDrag = ^(NSPoint p) { on_drag(static_cast<int>(p.x), static_cast<int>(top - p.y)); };
  divider.onReset = ^{ reset(); };
  divider.onKey = ^(int step) { on_key(step); };
  AttachChild(window, (__bridge void*)panel);  // Above the tab windows, which SyncWindows just re-added.
  [panel invalidateCursorRectsForView:divider];
  divider.needsDisplay = YES;
}

void SetPaneNav(void* window, bool show, std::function<void(bool forward)> press) {
  NSWindow* w = Win(window);
  if (!w) return;
  // Hung on the window itself: a weak-keyed NSMapTable kept a closed tab window's
  // key, and the next lookup messaged that zombie at launch (CrZombie crash).
  static char kNavKey;
  RoarPaneNav* nav = objc_getAssociatedObject(w, &kNavKey);
  if (!show) {
    if (nav) { [w removeChildWindow:nav]; [nav orderOut:nil]; }
    return;
  }
  if (!nav) {
    nav = [[RoarPaneNav alloc] initWithContentRect:NSMakeRect(0, 0, 56, 28)
                                          styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                            backing:NSBackingStoreBuffered defer:NO];
    nav.releasedWhenClosed = NO;
    nav.opaque = NO;
    nav.backgroundColor = [NSColor colorWithSRGBRed:0x2a / 255.0 green:0x1d / 255.0 blue:0x12 / 255.0 alpha:0xd8 / 255.0];
    nav.hasShadow = NO;
    nav.contentView.wantsLayer = YES;
    nav.contentView.layer.cornerRadius = 6;
    nav.collectionBehavior = NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorIgnoresCycle;
    nav.excludedFromWindowsMenu = YES;
    for (int i = 0; i < 2; i++) {
      NSButton* b = [NSButton buttonWithTitle:i ? @"›" : @"‹" target:nav action:i ? @selector(forward:) : @selector(back:)];
      b.bordered = NO;
      b.toolTip = i ? @"Forward" : @"Back";
      b.attributedTitle = [[NSAttributedString alloc] initWithString:b.title attributes:@{
        NSFontAttributeName : [NSFont boldSystemFontOfSize:15],
        NSForegroundColorAttributeName : [NSColor colorWithSRGBRed:0xfb / 255.0 green:0xee / 255.0 blue:0xdd / 255.0 alpha:1]}];
      b.frame = NSMakeRect(4 + i * 24, 2, 24, 24);
      [nav.contentView addSubview:b];
    }
    objc_setAssociatedObject(w, &kNavKey, nav, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  nav.press = ^(BOOL forward) { press(forward); };
  NSRect f = w.frame;
  [nav setFrameOrigin:NSMakePoint(NSMinX(f) + 6, NSMaxY(f) - 6 - nav.frame.size.height)];
  if (nav.parentWindow != w) [w addChildWindow:nav ordered:NSWindowAbove];
  [nav orderFront:nil];
}

// The tag hangs from the frame's top edge like a sewn-on label: flush top, rounded bottom.
static CGPathRef DrivenTagPath(CGRect r, CGFloat rad) {
  CGMutablePathRef p = CGPathCreateMutable();
  CGPathMoveToPoint(p, nullptr, CGRectGetMinX(r) - rad, CGRectGetMaxY(r));
  CGPathAddArcToPoint(p, nullptr, CGRectGetMinX(r), CGRectGetMaxY(r), CGRectGetMinX(r), CGRectGetMaxY(r) - rad, rad);
  CGPathAddArcToPoint(p, nullptr, CGRectGetMinX(r), CGRectGetMinY(r), CGRectGetMidX(r), CGRectGetMinY(r), rad);
  CGPathAddArcToPoint(p, nullptr, CGRectGetMaxX(r), CGRectGetMinY(r), CGRectGetMaxX(r), CGRectGetMaxY(r), rad);
  CGPathAddArcToPoint(p, nullptr, CGRectGetMaxX(r), CGRectGetMaxY(r), CGRectGetMaxX(r) + rad, CGRectGetMaxY(r), rad);
  CGPathCloseSubpath(p);
  return p;
}

static void LayoutDrivenFrame(NSPanel* panel, NSWindow* tab) {
  [panel setFrame:tab.frame display:NO];
  CALayer* root = panel.contentView.layer;
  NSRect b = panel.contentView.bounds;
  CAShapeLayer* ring = (CAShapeLayer*)root.sublayers[0];
  CAShapeLayer* tag = (CAShapeLayer*)root.sublayers[1];
  CATextLayer* text = (CATextLayer*)root.sublayers[2];
  CGPathRef rp = CGPathCreateWithRoundedRect(NSInsetRect(b, 1.5, 1.5), 9, 9, nullptr);
  ring.path = rp;
  CGPathRelease(rp);
  CGRect tr = CGRectMake(NSMidX(b) - 31, NSMaxY(b) - 19, 62, 19);
  CGPathRef tp = DrivenTagPath(tr, 6);
  tag.path = tp;
  CGPathRelease(tp);
  text.frame = CGRectMake(tr.origin.x, tr.origin.y + 3, tr.size.width, 14);
}

void SetDrivenFrame(void* tab_window, bool show) {
  NSWindow* tab = Win(tab_window);
  if (!tab) return;
  static NSMutableDictionary<NSValue*, NSPanel*>* frames = [[NSMutableDictionary alloc] init];  // No ARC here: keep it.
  NSValue* key = [NSValue valueWithNonretainedObject:tab];
  NSPanel* panel = frames[key];
  if (!show) {
    if (panel && panel.alphaValue > 0) [NSAnimationContext runAnimationGroup:^(NSAnimationContext* c) {
      c.duration = 0.35;
      panel.animator.alphaValue = 0;
    } completionHandler:^{
      if (panel.alphaValue == 0) { [panel.parentWindow removeChildWindow:panel]; [panel orderOut:nil]; }
    }];
    return;
  }
  NSColor* mint = [NSColor colorWithSRGBRed:0x7a / 255.0 green:0xa8 / 255.0 blue:0x98 / 255.0 alpha:1];
  if (!panel) {
    panel = [[NSPanel alloc] initWithContentRect:tab.frame
                                       styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                         backing:NSBackingStoreBuffered defer:NO];
    panel.releasedWhenClosed = NO;
    panel.opaque = NO;
    panel.backgroundColor = NSColor.clearColor;
    panel.sharingType = NSWindowSharingNone;  // Hidden from capture, so recordings never show it.
    panel.ignoresMouseEvents = YES;
    panel.hasShadow = NO;
    panel.collectionBehavior = NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorIgnoresCycle;
    panel.excludedFromWindowsMenu = YES;
    panel.alphaValue = 0;
    panel.contentView.wantsLayer = YES;
    CALayer* root = panel.contentView.layer;
    CAShapeLayer* ring = [CAShapeLayer layer];
    ring.fillColor = nil;
    ring.strokeColor = mint.CGColor;
    ring.lineWidth = 3;
    ring.shadowColor = mint.CGColor;  // A soft glow inward and out, so the edge reads on light and dark pages.
    ring.shadowOpacity = 0.7;
    ring.shadowRadius = 6;
    ring.shadowOffset = CGSizeZero;
    CAShapeLayer* tag = [CAShapeLayer layer];
    tag.fillColor = mint.CGColor;
    CATextLayer* text = [CATextLayer layer];
    text.string = @"Agent";
    NSFontDescriptor* d = [[NSFont systemFontOfSize:11 weight:NSFontWeightBold].fontDescriptor fontDescriptorWithDesign:NSFontDescriptorSystemDesignRounded];
    text.font = (__bridge CFTypeRef)[NSFont fontWithDescriptor:d size:11];
    text.fontSize = 11;
    text.foregroundColor = [NSColor colorWithSRGBRed:0x1e / 255.0 green:0x14 / 255.0 blue:0x0c / 255.0 alpha:1].CGColor;
    text.alignmentMode = kCAAlignmentCenter;
    text.contentsScale = tab.backingScaleFactor;
    [root addSublayer:ring];
    [root addSublayer:tag];
    [root addSublayer:text];
    frames[key] = panel;
    // The frame follows the tab window when the layout resizes it; a closed tab drops its frame.
    [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidResizeNotification object:tab queue:nil
                                                usingBlock:^(NSNotification*) { LayoutDrivenFrame(panel, tab); }];
    [NSNotificationCenter.defaultCenter addObserverForName:NSWindowWillCloseNotification object:tab queue:nil
                                                usingBlock:^(NSNotification*) { [panel orderOut:nil]; [frames removeObjectForKey:key]; }];
  }
  LayoutDrivenFrame(panel, tab);
  if (panel.parentWindow != tab) {
    [panel.parentWindow removeChildWindow:panel];
    [tab addChildWindow:panel ordered:NSWindowAbove];
  }
  if (panel.alphaValue < 1 && !panel.isVisible) {
    // One moment on attach: the ring draws itself around the tab.
    CABasicAnimation* draw = [CABasicAnimation animationWithKeyPath:@"strokeEnd"];
    draw.fromValue = @0;
    draw.toValue = @1;
    draw.duration = 0.6;
    draw.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
    [panel.contentView.layer.sublayers[0] addAnimation:draw forKey:@"draw"];
  }
  [panel orderFront:nil];
  panel.animator.alphaValue = 1;
}

void KeepAbove(void* window) {
  NSWindow* w = Win(window);
  if (!w) return;
  w.level = NSFloatingWindowLevel;
  w.hidesOnDeactivate = YES;  // Floats over Roar only, not over other apps.
}

void SetFloating(void* window, bool floating, const std::string& title) {
  NSWindow* w = Win(window);
  if (!w) return;
  if (floating) {
    // Chrome's frameless windows draw content under a hidden title bar; undo that
    // so the mini window has a real bar to drag and a close button to dock it.
    w.styleMask = (w.styleMask | NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                   NSWindowStyleMaskResizable) & ~NSWindowStyleMaskFullSizeContentView;
    w.titlebarAppearsTransparent = NO;
    w.titleVisibility = NSWindowTitleVisible;
    [w standardWindowButton:NSWindowCloseButton].hidden = NO;
    w.title = NS(title);
    w.level = NSFloatingWindowLevel;
    w.hasShadow = YES;
    w.collectionBehavior = (w.collectionBehavior | NSWindowCollectionBehaviorCanJoinAllSpaces) &
                           ~(NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorIgnoresCycle);
    w.excludedFromWindowsMenu = NO;
    w.accessibilitySubrole = NSAccessibilityStandardWindowSubrole;
    w.contentView.layer.cornerRadius = 0;
  } else {
    w.styleMask = (w.styleMask & ~(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                   NSWindowStyleMaskResizable)) |
                  NSWindowStyleMaskFullSizeContentView;
    w.titlebarAppearsTransparent = YES;
    w.titleVisibility = NSWindowTitleHidden;
    [w standardWindowButton:NSWindowCloseButton].hidden = YES;
    w.level = NSNormalWindowLevel;
    w.hasShadow = NO;
    w.collectionBehavior = (w.collectionBehavior & ~NSWindowCollectionBehaviorCanJoinAllSpaces) |
                           NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorIgnoresCycle;
    w.excludedFromWindowsMenu = YES;
    w.accessibilitySubrole = NSAccessibilityUnknownSubrole;
    w.contentView.layer.cornerRadius = 10;
  }
}

void CopyText(const std::string& text) {
  NSPasteboard* pb = NSPasteboard.generalPasteboard;
  [pb clearContents];
  [pb setString:NS(text) forType:NSPasteboardTypeString];
}

bool MoveToTrash(const std::string& path) {
  return [NSFileManager.defaultManager trashItemAtURL:[NSURL fileURLWithPath:NS(path)] resultingItemURL:nil error:nil];
}

bool UpdaterRunning() { return g_updater != nil; }
std::string BundleBuild() {
  NSString* v = NSBundle.mainBundle.infoDictionary[@"CFBundleVersion"];
  return v ? v.UTF8String : "";
}
bool AutoUpdateChecks() { return g_updater && g_updater.updater.automaticallyChecksForUpdates; }
bool AutoUpdateDownloads() { return g_updater && g_updater.updater.automaticallyDownloadsUpdates; }
void SetAutoUpdate(bool checks, bool downloads) {
  if (!g_updater) return;
  g_updater.updater.automaticallyChecksForUpdates = checks;
  g_updater.updater.automaticallyDownloadsUpdates = checks && downloads;
}

void SendDiagnostics() { [g_menu_target sendDiagnostics:nil]; }

void CheckForUpdates() {
  // Test mode checks without UI so a scratch instance never takes the front.
  if (g_updater && getenv("ROAR_SPARKLE_TEST")) [g_updater.updater checkForUpdateInformation];
  else if (g_updater) [g_updater checkForUpdates:nil];
  else NSBeep();
}

void UpdateChromium(void* window) {
  NSString* root = @ROAR_SOURCE_DIR;
  NSWindow* win = Win(window) ?: NSApp.keyWindow;
  auto show = ^(NSString* title, NSString* text, NSArray<NSString*>* buttons, void (^done)(NSInteger)) {
    NSAlert* alert = [[NSAlert alloc] init];
    alert.messageText = title;
    alert.informativeText = text;
    for (NSString* b in buttons) [alert addButtonWithTitle:b];
    [alert beginSheetModalForWindow:win
                  completionHandler:^(NSModalResponse r) {
                    if (done) done(r - NSAlertFirstButtonReturn);
                  }];
  };
  NSString* update = [root stringByAppendingPathComponent:@"scripts/update-cef.sh"];
  if (![NSFileManager.defaultManager fileExistsAtPath:update]) {
    show(@"Can't check for updates", [NSString stringWithFormat:@"No Roar checkout at %@.", root], @[ @"OK" ], nil);
    return;
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSTask* task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/bin/bash"];
    task.arguments = @[ update, @"--check" ];
    NSPipe* pipe = [NSPipe pipe];
    task.standardOutput = pipe;
    task.standardError = pipe;
    NSString* out = @"";
    if ([task launchAndReturnError:nil]) {
      NSData* data = [pipe.fileHandleForReading readDataToEndOfFile];
      [task waitUntilExit];
      out = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
    }
    out = [out stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    dispatch_async(dispatch_get_main_queue(), ^{
      if (task.terminationStatus != 0 || ![out containsString:@"Update available"]) {
        show(task.terminationStatus ? @"Update check failed" : @"Roar is up to date", out, @[ @"OK" ], nil);
        return;
      }
      bool codecs = [NSFileManager.defaultManager
          fileExistsAtPath:[root stringByAppendingPathComponent:@"third_party/cef/args.gn"]];  // A source (codec) build keeps its args.gn.
      NSString* text = [NSString
          stringWithFormat:@"%@\n\nRoar rebuilds in the background%@ and relaunches itself when done. "
                           @"The log is at ~/Library/Logs/Roar-update.log.",
                           out, codecs ? @" (the Chromium rebuild takes about 20 minutes)" : @""];
      show(@"Chromium update available", text, @[ @"Update", @"Later" ], ^(NSInteger choice) {
        if (choice != 0) return;
        NSString* log = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Logs/Roar-update.log"];
        [NSFileManager.defaultManager createFileAtPath:log contents:nil attributes:nil];
        NSFileHandle* out = [NSFileHandle fileHandleForWritingAtPath:log] ?: [NSFileHandle fileHandleWithNullDevice];
        NSTask* run = [[NSTask alloc] init];
        run.executableURL = [NSURL fileURLWithPath:@"/usr/bin/nohup"];
        run.currentDirectoryURL = [NSURL fileURLWithPath:root];
        NSString* script = @"{ scripts/update-cef.sh && scripts/deploy.sh; } || osascript -e 'display notification "
                           @"\"See ~/Library/Logs/Roar-update.log\" with title \"Roar update failed\"'";
        run.arguments = @[ @"/bin/bash", @"-lc", script ];
        run.standardOutput = out;
        run.standardError = out;
        [run launchAndReturnError:nil];
      });
    });
  });
}

void ChooseLookback(void* window, const std::string& what, std::function<void(double since)> done) {
  NSAlert* alert = [[NSAlert alloc] init];
  alert.messageText = [NSString stringWithFormat:@"Clear %@ in this space", NS(what)];
  alert.informativeText = @"How far back?";
  NSTextField* amount = [NSTextField textFieldWithString:@"1"];
  amount.frame = NSMakeRect(0, 0, 60, 24);
  NSNumberFormatter* digits = [[NSNumberFormatter alloc] init];
  digits.minimum = @1;
  digits.allowsFloats = NO;
  amount.formatter = digits;
  NSPopUpButton* unit = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(68, 0, 120, 24) pullsDown:NO];
  [unit addItemsWithTitles:@[ @"Hours", @"Days", @"Weeks", @"Months" ]];
  [unit selectItemAtIndex:1];
  NSView* box = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 188, 24)];
  [box addSubview:amount];
  [box addSubview:unit];
  alert.accessoryView = box;
  for (NSString* t in @[ @"Clear", @"All Time", @"Cancel" ]) [alert addButtonWithTitle:t];
  alert.buttons.lastObject.keyEquivalent = @"\e";
  alert.window.initialFirstResponder = amount;
  [alert beginSheetModalForWindow:Win(window) ?: NSApp.keyWindow
                completionHandler:^(NSModalResponse response) {
                  if (response == NSAlertSecondButtonReturn) return done(0);
                  if (response != NSAlertFirstButtonReturn) return;
                  long n = MAX(1L, (long)amount.integerValue);
                  static const double kUnit[] = {3600, 86400, 7 * 86400, 30 * 86400};
                  done([NSDate date].timeIntervalSince1970 - n * kUnit[unit.indexOfSelectedItem]);
                }];
}

void ConfirmDownload(void* window, const std::string& name, const std::string& host,
                     std::function<void(bool allow)> done) {
  NSAlert* alert = [[NSAlert alloc] init];
  alert.messageText = [NSString stringWithFormat:@"Download \u201c%@\u201d?", NS(name)];
  alert.informativeText = [NSString stringWithFormat:@"%@ wants to save a file that can run programs on your Mac.",
                                                        NS(host.empty() ? "This page" : host)];
  [alert addButtonWithTitle:@"Cancel"];
  [alert addButtonWithTitle:@"Download"];
  alert.buttons.firstObject.keyEquivalent = @"\r";
  [alert beginSheetModalForWindow:Win(window) ?: NSApp.keyWindow
                completionHandler:^(NSModalResponse response) { done(response == NSAlertSecondButtonReturn); }];
}

void QuarantineDownload(const std::string& path, const std::string& url) {
  NSURL* file = [NSURL fileURLWithPath:NS(path)];
  NSDictionary* props = nil;
  [file getResourceValue:&props forKey:NSURLQuarantinePropertiesKey error:nil];
  if (props) return;  // Chromium's own quarantine, with its origin data.
  NSMutableDictionary* q = [@{
    (__bridge NSString*)kLSQuarantineAgentNameKey : @"Roar",
    (__bridge NSString*)kLSQuarantineTypeKey : (__bridge NSString*)kLSQuarantineTypeWebDownload,
  } mutableCopy];
  if (NSURL* origin = url.empty() ? nil : [NSURL URLWithString:NS(url)]) q[(__bridge NSString*)kLSQuarantineDataURLKey] = origin;
  [file setResourceValue:q forKey:NSURLQuarantinePropertiesKey error:nil];
}

void PopupMenu(const std::vector<std::string>& titles, std::function<void(int index)> done) {
  NSMenu* menu = [[NSMenu alloc] init];
  menu.autoenablesItems = NO;
  RoarMenuPick* target = [[RoarMenuPick alloc] init];
  target.picked = -1;
  for (size_t i = 0; i < titles.size(); ++i) {
    const std::string& t = titles[i];
    if (t.empty()) { [menu addItem:NSMenuItem.separatorItem]; continue; }
    bool label = t[0] == '-';
    NSMenuItem* item = [menu addItemWithTitle:NS(label ? t.substr(1) : t) action:@selector(pick:) keyEquivalent:@""];
    item.target = target;
    item.tag = static_cast<NSInteger>(i);
    item.enabled = !label;
  }
  [menu popUpMenuPositioningItem:nil atLocation:NSEvent.mouseLocation inView:nil];
  if (target.picked >= 0) done(static_cast<int>(target.picked));
}

std::string UniqueDownloadPath(const std::string& name) {
  NSFileManager* fm = NSFileManager.defaultManager;
  NSURL* downloads = [fm URLsForDirectory:NSDownloadsDirectory inDomains:NSUserDomainMask].firstObject;
  NSString* file = NS(name);
  NSString* stem = file.stringByDeletingPathExtension;
  NSString* ext = file.pathExtension;
  NSURL* url = [downloads URLByAppendingPathComponent:file];
  auto taken = [&](NSURL* u) {
    return [fm fileExistsAtPath:u.path] || [fm fileExistsAtPath:[u.path stringByAppendingString:@".crdownload"]];
  };
  for (int i = 1; taken(url); ++i) {
    NSString* next = ext.length ? [NSString stringWithFormat:@"%@ (%d).%@", stem, i, ext]
                                : [NSString stringWithFormat:@"%@ (%d)", stem, i];
    url = [downloads URLByAppendingPathComponent:next];
  }
  return url.path.UTF8String;
}

void RevealInFinder(const std::string& path) {
  NSURL* url = [NSURL fileURLWithPath:NS(path)];
  if ([NSFileManager.defaultManager fileExistsAtPath:url.path])
    [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:@[ url ]];
}

void OpenFullDiskAccessSettings() {
  // macOS 13+ renamed the pane; the old ID no longer opens it on current releases.
  NSString* pane = NSProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 13
                       ? @"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"
                       : @"x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
  [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:pane]];
}

bool OpenInApp(void* window, const std::string& url) {
  NSURL* u = [NSURL URLWithString:NS(url)];
  NSURL* app = u ? [NSWorkspace.sharedWorkspace URLForApplicationToOpenURL:u] : nil;
  if (!app) return false;
  NSString* name = [NSFileManager.defaultManager displayNameAtPath:app.path].stringByDeletingPathExtension;
  NSAlert* alert = [[NSAlert alloc] init];
  alert.messageText = [NSString stringWithFormat:@"Open \u201c%@\u201d?", name];
  alert.informativeText = @"This page wants to open an app on your Mac.";
  [alert addButtonWithTitle:@"Cancel"];
  [alert addButtonWithTitle:@"Open"];
  alert.buttons.firstObject.keyEquivalent = @"\r";
  [alert beginSheetModalForWindow:Win(window) ?: NSApp.keyWindow
                completionHandler:^(NSModalResponse response) {
                  if (response == NSAlertSecondButtonReturn) [NSWorkspace.sharedWorkspace openURL:u];
                }];
  return true;
}

std::string SaveMarkdown(const std::string& title, const std::string& markdown) {
  NSString* name = NS(title.empty() ? "page" : title);
  NSCharacterSet* bad = [NSCharacterSet characterSetWithCharactersInString:@"/\\:*?\"<>|\n\r\t"];
  name = [[name componentsSeparatedByCharactersInSet:bad] componentsJoinedByString:@" "];
  name = [name stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
  if (name.length > 80) name = [name substringToIndex:80];
  NSURL* downloads = [NSFileManager.defaultManager URLsForDirectory:NSDownloadsDirectory
                                                          inDomains:NSUserDomainMask].firstObject;
  NSURL* url = [downloads URLByAppendingPathComponent:[name stringByAppendingPathExtension:@"md"]];
  for (int i = 2; [NSFileManager.defaultManager fileExistsAtPath:url.path]; ++i)
    url = [downloads URLByAppendingPathComponent:[NSString stringWithFormat:@"%@ %d.md", name, i]];
  NSError* error = nil;
  if (![NS(markdown) writeToURL:url atomically:YES encoding:NSUTF8StringEncoding error:&error]) return "";
  return url.path.UTF8String;
}

void SearchGitHub(const std::string& query,
                  std::function<void(std::string json, std::string error)> done) {
  if (!GhPath()) {
    done("", "Install the GitHub CLI (gh) to see pull requests here.");
    return;
  }
  NSString* q = NS(query);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSString *out = nil, *err = nil;
    int status = RunGh(@[ @"api", @"-X", @"GET", @"search/issues", @"-f",
                          [@"q=" stringByAppendingString:q], @"-f", @"per_page=25" ],
                       &out, &err);
    std::string json = status == 0 ? out.UTF8String : "";
    std::string error;
    if (status != 0) {
      error = [err containsString:@"auth login"] || [err containsString:@"not logged"]
                  ? "Run `gh auth login` to connect GitHub."
                  : std::string("GitHub search failed: ") +
                        [err stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].UTF8String;
    }
    OnUi(base::BindOnce([](std::function<void(std::string, std::string)> cb, std::string j,
                           std::string e) { cb(j, e); },
                        done, json, error));
  });
}

void GitHubAuthStatus(std::function<void(std::string status)> done) {
  if (!GhPath()) {
    done("missing");
    return;
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSString *out = nil, *err = nil;
    int status = RunGh(@[ @"auth", @"status", @"--hostname", @"github.com" ], &out, &err);
    std::string result = status == 0 ? "ok" : "signed-out";
    OnUi(base::BindOnce([](std::function<void(std::string)> cb, std::string r) { cb(r); }, done,
                        result));
  });
}

void GitHubContributions(std::function<void(std::string json)> done) {
  const char* mock = getenv("ROAR_GARDEN_MOCK");
  if (!mock && !GhPath()) {
    done("");
    return;
  }
  NSString* host = mock ? NS(mock) : @"https://github.com";
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    std::string login = "mock", json;
    NSString *out = nil, *err = nil;
    if (!mock) login = RunGh(@[ @"api", @"user", @"--jq", @".login" ], &out, &err) == 0 && out
                           ? [out stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].UTF8String
                           : "";
    if (roar::GardenLoginOk(login)) {
      NSURL* url = [NSURL URLWithString:[NSString stringWithFormat:@"%@/users/%s/contributions", host, login.c_str()]];
      NSData* data = url ? [NSData dataWithContentsOfURL:url] : nil;
      if (data.length && data.length < 4 * 1024 * 1024)
        json = roar::GardenJson(std::string((const char*)data.bytes, data.length), login);
    }
    OnUi(base::BindOnce([](std::function<void(std::string)> cb, std::string j) { cb(j); }, done, json));
  });
}

std::string HomeDir() {
  const char* h = getenv("HOME");
  return h && *h ? h : NSHomeDirectory().UTF8String;
}

void ChooseFolder(std::function<void(const std::string& path)> done) {
  NSOpenPanel* p = [NSOpenPanel openPanel];
  p.canChooseFiles = NO;
  p.canChooseDirectories = YES;
  p.allowsMultipleSelection = NO;
  p.prompt = @"Start Claude here";
  [NSApp activateIgnoringOtherApps:YES];
  [p beginWithCompletionHandler:^(NSModalResponse r) {
    done(r == NSModalResponseOK && p.URL ? std::string(p.URL.path.UTF8String) : "");
  }];
}

void RoarMcp(std::vector<std::string> args, std::function<void(const std::string& out)> done) {
  NSMutableArray<NSString*>* a = [NSMutableArray array];
  for (const auto& s : args) [a addObject:NS(s)];
  NSString* exe = NS(ResourcePath("roar-mcp"));
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSString *out = nil, *err = nil;
    RunTool(exe, a, &out, &err);
    std::string o = out ? std::string(out.UTF8String) : "";
    OnUi(base::BindOnce([](std::function<void(const std::string&)> cb, std::string o) { cb(o); }, done, o));
  });
}

namespace {
std::mutex g_streams_mu;
std::set<int> g_streams;  // Live SpawnStream pids: KillStream never signals a reused pid.
bool StreamLive(int pid) {
  std::lock_guard<std::mutex> l(g_streams_mu);
  return g_streams.count(pid) > 0;
}
}  // namespace

int SpawnStream(const std::string& exe, const std::vector<std::string>& args, const std::string& cwd,
                const std::string& path, const std::string& input, int timeout_s,
                std::function<void(const std::string& chunk)> on_out,
                std::function<void(int status, const std::string& err)> on_exit) {
  int in[2], out[2], err[2];
  if (pipe(in)) return on_exit(-1, strerror(errno)), 0;
  if (pipe(out)) return close(in[0]), close(in[1]), on_exit(-1, strerror(errno)), 0;
  if (pipe(err)) return close(in[0]), close(in[1]), close(out[0]), close(out[1]), on_exit(-1, strerror(errno)), 0;
  for (int fd : {in[1], out[0], err[0]}) fcntl(fd, F_SETFD, FD_CLOEXEC);
  fcntl(in[1], F_SETNOSIGPIPE, 1);  // A child that exits before reading its prompt must not kill Roar.
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, in[0], 0);
  posix_spawn_file_actions_adddup2(&fa, out[1], 1);
  posix_spawn_file_actions_adddup2(&fa, err[1], 2);
  posix_spawn_file_actions_addchdir_np(&fa, cwd.c_str());
  posix_spawnattr_t at;
  posix_spawnattr_init(&at);
  posix_spawnattr_setflags(&at, POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT);
  posix_spawnattr_setpgroup(&at, 0);
  std::vector<char*> argv = {const_cast<char*>(exe.c_str())};
  for (auto& a : args) argv.push_back(const_cast<char*>(a.c_str()));
  argv.push_back(nullptr);
  // The user's real environment, HOME included (a changed HOME brought Keychain prompts); only PATH widens.
  std::vector<std::string> env_s;
  for (char** e = *_NSGetEnviron(); *e; ++e)
    if (strncmp(*e, "PATH=", 5) != 0) env_s.push_back(*e);
  env_s.push_back("PATH=" + path);
  std::vector<char*> envp;
  for (auto& e : env_s) envp.push_back(const_cast<char*>(e.c_str()));
  envp.push_back(nullptr);
  pid_t pid = 0;
  int rc = posix_spawn(&pid, exe.c_str(), &fa, &at, argv.data(), envp.data());
  posix_spawn_file_actions_destroy(&fa);
  posix_spawnattr_destroy(&at);
  close(in[0]), close(out[1]), close(err[1]);
  if (rc != 0) {
    close(in[1]), close(out[0]), close(err[0]);
    on_exit(-1, strerror(rc));
    return 0;
  }
  {
    std::lock_guard<std::mutex> l(g_streams_mu);
    g_streams.insert(pid);
  }
  auto timed_out = std::make_shared<std::atomic<bool>>(false);
  auto errs = std::make_shared<std::string>();
  int win = in[1], rout = out[0], rerr = err[0];
  auto q = dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);
  // A block captures a reference parameter as a reference: copy, or the prompt is freed before it is written.
  const std::string text = input;
  dispatch_async(q, ^{
    for (size_t off = 0; off < text.size();) {
      ssize_t n = write(win, text.data() + off, text.size() - off);
      if (n <= 0) break;
      off += n;
    }
    close(win);
  });
  dispatch_group_t g = dispatch_group_create();
  dispatch_group_async(g, q, ^{
    char buf[4096];
    for (ssize_t n; (n = read(rerr, buf, sizeof buf)) > 0;) {
      errs->append(buf, n);
      if (errs->size() > 8000) errs->erase(0, errs->size() - 4000);
    }
    close(rerr);
  });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, int64_t(timeout_s) * NSEC_PER_SEC), q, ^{
    if (StreamLive(pid)) *timed_out = true, kill(-pid, SIGKILL);
  });
  dispatch_async(q, ^{
    char buf[8192];
    for (ssize_t n; (n = read(rout, buf, sizeof buf)) > 0;)
      OnUi(base::BindOnce([](std::function<void(const std::string&)> cb, std::string s) { cb(s); }, on_out, std::string(buf, n)));
    close(rout);
    dispatch_group_wait(g, DISPATCH_TIME_FOREVER);
    dispatch_release(g);  // No ARC in this file.
    int st = 0;
    while (waitpid(pid, &st, 0) < 0 && errno == EINTR) {}
    {
      std::lock_guard<std::mutex> l(g_streams_mu);
      g_streams.erase(pid);
    }
    int code = *timed_out ? -2 : WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st);
    OnUi(base::BindOnce([](std::function<void(int, const std::string&)> cb, int c, std::string e) { cb(c, e); }, on_exit, code, *errs));
  });
  return pid;
}

void KillStream(int pid) {
  if (pid <= 0 || !StreamLive(pid)) return;
  kill(-pid, SIGTERM);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    if (StreamLive(pid)) kill(-pid, SIGKILL);
  });
}

void ClaudeMcpAdd(const std::string& server, std::function<void(bool ok)> done) {
  NSString* home = NS(HomeDir());
  NSString* claude = nil;
  for (NSString* p in @[ [home stringByAppendingString:@"/.local/bin/claude"],
                         [home stringByAppendingString:@"/.claude/local/claude"], @"/opt/homebrew/bin/claude",
                         @"/usr/local/bin/claude" ])
    if ([[NSFileManager defaultManager] isExecutableFileAtPath:p]) { claude = p; break; }
  if (!claude) {
    done(false);
    return;
  }
  NSString* path = NS(server);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSString *out = nil, *err = nil;
    // `add` refuses an existing name, so drop a stale entry first.
    RunTool(claude, @[ @"mcp", @"remove", @"--scope", @"user", @"roar" ], &out, &err);
    int status = RunTool(claude, @[ @"mcp", @"add", @"--scope", @"user", @"roar", @"--", path ], &out, &err);
    OnUi(base::BindOnce([](std::function<void(bool)> cb, bool ok) { cb(ok); }, done, status == 0));
  });
}

namespace {
NSMutableDictionary* SecretQuery(const std::string& account) {
  return [[@{(id)kSecClass: (id)kSecClassGenericPassword, (id)kSecAttrService: @"Roar model chat",
            (id)kSecAttrAccount: [NSString stringWithUTF8String:account.c_str()]} mutableCopy] autorelease];  // No ARC here.
}
}  // namespace

std::string SecretGet(const std::string& account) {
  NSMutableDictionary* q = SecretQuery(account);
  q[(id)kSecReturnData] = @YES;
  CFTypeRef data = nullptr;
  if (SecItemCopyMatching((CFDictionaryRef)q, &data) != errSecSuccess || !data) return "";
  NSData* d = (NSData*)data;
  std::string out(static_cast<const char*>(d.bytes), d.length);
  CFRelease(data);
  return out;
}

bool SecretHas(const std::string& account) {
  NSMutableDictionary* q = SecretQuery(account);
  q[(id)kSecReturnAttributes] = @YES;  // Attributes only: no password prompt, no value in memory.
  CFTypeRef attrs = nullptr;
  bool ok = SecItemCopyMatching((CFDictionaryRef)q, &attrs) == errSecSuccess;
  if (attrs) CFRelease(attrs);
  return ok;
}

bool SecretSet(const std::string& account, const std::string& value) {
  NSMutableDictionary* q = SecretQuery(account);
  SecItemDelete((CFDictionaryRef)q);
  if (value.empty()) return true;
  q[(id)kSecValueData] = [NSData dataWithBytes:value.data() length:value.size()];
  q[(id)kSecAttrAccessible] = (id)kSecAttrAccessibleWhenUnlocked;
  return SecItemAdd((CFDictionaryRef)q, nullptr) == errSecSuccess;
}

}  // namespace roar::platform
