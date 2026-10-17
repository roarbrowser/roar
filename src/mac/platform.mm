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
#include <sys/file.h>
#include <sys/socket.h>
#include <unistd.h>

#include "mac/platform.h"

#include "include/base/cef_callback.h"
#include "include/cef_task.h"
#include "include/wrapper/cef_closure_task.h"

#include "controller.h"
#include "state.h"

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
}
- (void)updaterDidNotFindUpdate:(SPUUpdater*)updater {
  if (getenv("ROAR_SPARKLE_TEST")) fprintf(stderr, "sparkle: no update\n");
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
    return on ? [on boolValue] : YES;
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

void RelaunchAfterExit() {
  // Instances and scratch runs come back as themselves.
  // Values go in as arguments, never into the script text.
  NSMutableArray* args = [NSMutableArray arrayWithArray:@[
    @"/bin/sh", @"-c", @"while kill -0 \"$1\" 2>/dev/null; do sleep 0.5; done; shift; exec open -n \"$@\"", @"sh",
    [NSString stringWithFormat:@"%d", getpid()]
  ]];
  for (const char* key : {"ROAR_DATA_DIR", "ROAR_INSTANCE", "ROAR_CDP_PORT"})
    if (const char* v = getenv(key)) [args addObjectsFromArray:@[ @"--env", [NSString stringWithFormat:@"%s=%s", key, v] ]];
  [args addObject:NSBundle.mainBundle.bundlePath];
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
  addCommand(app, @"Settings…", @"settings", @"⌘,");
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
  [c orderFront:nil];
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

@interface RoarDivider : NSView
@property(nonatomic) BOOL stacked;
@property(nonatomic, copy) void (^onDrag)(NSPoint screen);
@property(nonatomic, copy) void (^onReset)(void);
@end

@implementation RoarDivider {
  id _monitor;
}
- (void)resetCursorRects {
  [self addCursorRect:self.bounds cursor:self.stacked ? NSCursor.resizeUpDownCursor : NSCursor.resizeLeftRightCursor];
}
- (void)drawRect:(NSRect)r {
  // A short grip in the middle of the gap.
  NSRect b = self.bounds;
  NSRect g = self.stacked ? NSMakeRect(NSMidX(b) - 18, NSMidY(b) - 1.5, 36, 3) : NSMakeRect(NSMidX(b) - 1.5, NSMidY(b) - 18, 3, 36);
  [[NSColor colorWithWhite:0.5 alpha:0.45] setFill];
  [[NSBezierPath bezierPathWithRoundedRect:g xRadius:1.5 yRadius:1.5] fill];
}
- (BOOL)acceptsFirstMouse:(NSEvent*)e { return YES; }
- (void)mouseDown:(NSEvent*)e {
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

namespace roar::platform {

void SetSplitDivider(void* window, int x, int y, int w, int h, bool stacked,
                     std::function<void(int sx, int sy)> on_drag, std::function<void()> reset) {
  NSWindow* win = Win(window);
  if (!win) return;
  static RoarDivider* divider = nil;
  if (w <= 0 || h <= 0) { [divider removeFromSuperview]; return; }
  if (!divider) divider = [[RoarDivider alloc] initWithFrame:NSZeroRect];
  CGFloat top = NSScreen.screens.firstObject.frame.size.height;
  NSRect screen = NSMakeRect(x, top - y - h, w, h);
  NSRect inWin = [win convertRectFromScreen:screen];
  NSView* content = win.contentView;
  divider.frame = [content convertRect:inWin fromView:nil];
  divider.stacked = stacked;
  divider.onDrag = ^(NSPoint p) { on_drag(static_cast<int>(p.x), static_cast<int>(top - p.y)); };
  divider.onReset = ^{ reset(); };
  if (divider.superview != content) [content addSubview:divider positioned:NSWindowAbove relativeTo:nil];
  [win invalidateCursorRectsForView:divider];
  divider.needsDisplay = YES;
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

bool UpdaterRunning() { return g_updater != nil; }
bool AutoUpdateChecks() { return g_updater && g_updater.updater.automaticallyChecksForUpdates; }
bool AutoUpdateDownloads() { return g_updater && g_updater.updater.automaticallyDownloadsUpdates; }
void SetAutoUpdate(bool checks, bool downloads) {
  if (!g_updater) return;
  g_updater.updater.automaticallyChecksForUpdates = checks;
  g_updater.updater.automaticallyDownloadsUpdates = checks && downloads;
}

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
          fileExistsAtPath:[root stringByAppendingPathComponent:@"third_party/cef.prebuilt"]];
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

}  // namespace roar::platform
