#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <Security/Security.h>

#include "mac/platform.h"

#include "include/base/cef_callback.h"
#include "include/cef_task.h"
#include "include/wrapper/cef_closure_task.h"

#include "controller.h"

@interface RoarMenuTarget : NSObject
@property(nonatomic, strong) NSArray<NSString*>* commands;
- (void)run:(NSMenuItem*)sender;
@end

@implementation RoarMenuTarget
- (void)run:(NSMenuItem*)sender {
  NSString* command = self.commands[sender.tag];
  roar::Controller::Get()->RunCommand(command.UTF8String);
}
- (void)quit:(id)sender {
  roar::Controller::Get()->Quit();
}
@end

namespace roar::platform {

namespace {

RoarMenuTarget* g_menu_target = nil;

NSString* NS(const std::string& s) { return [NSString stringWithUTF8String:s.c_str()]; }

NSString* GhPath() {
  for (NSString* p in @[ @"/opt/homebrew/bin/gh", @"/usr/local/bin/gh", @"/usr/bin/gh" ])
    if ([[NSFileManager defaultManager] isExecutableFileAtPath:p]) return p;
  return nil;
}

// Runs gh with |args| and returns stdout, stderr text and the exit status.
int RunGh(NSArray<NSString*>* args, NSString** out, NSString** err) {
  NSTask* task = [[NSTask alloc] init];
  task.executableURL = [NSURL fileURLWithPath:GhPath()];
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

int CdpPort() {
  const char* env = getenv("ROAR_CDP_PORT");
  int port = env ? atoi(env) : 0;
  return port > 0 ? port : 9222;
}

void InstallMenu() {
  g_menu_target = [[RoarMenuTarget alloc] init];
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
  addCommand(app, @"Settings…", @"settings", @"⌘,");
  [app addItem:[NSMenuItem separatorItem]];
  [app addItemWithTitle:@"Hide Roar" action:@selector(hide:) keyEquivalent:@"h"];
  NSMenuItem* quit = [app addItemWithTitle:@"Quit Roar" action:@selector(quit:) keyEquivalent:@"q"];
  quit.target = g_menu_target;

  NSMenu* file = addMenu(@"File");
  addCommand(file, @"New Tab", @"newTab", @"⌘T");
  addCommand(file, @"Reopen Archived Tab", @"reopen", @"⇧⌘T");
  addCommand(file, @"Close Tab", @"closeTab", @"⌘W");
  [file addItem:[NSMenuItem separatorItem]];
  addCommand(file, @"Copy Page as Markdown", @"copyMarkdown", @"⇧⌘C");
  addCommand(file, @"Save Page as Markdown", @"saveMarkdown", @"");

  NSMenu* edit = addMenu(@"Edit");
  [edit addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
  [edit addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"Z"];
  [edit addItem:[NSMenuItem separatorItem]];
  [edit addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
  [edit addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
  [edit addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
  [edit addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];

  NSMenu* view = addMenu(@"View");
  addCommand(view, @"Toggle Sidebar", @"sidebar", @"⌘S");
  addCommand(view, @"Reload", @"reload", @"⌘R");
  addCommand(view, @"Back", @"back", @"⌘[");
  addCommand(view, @"Forward", @"forward", @"⌘]");
  [view addItem:[NSMenuItem separatorItem]];
  addCommand(view, @"Picture in Picture", @"pip", @"⇧⌘P");
  addCommand(view, @"Float Tab", @"float", @"⇧⌘F");
  [view addItem:[NSMenuItem separatorItem]];
  addCommand(view, @"Developer Tools", @"devtools", @"⌥⌘I");
  addCommand(view, @"Extensions", @"extensions", @"");

  NSMenu* tabs = addMenu(@"Tabs");
  addCommand(tabs, @"Clean Up Tabs", @"clean", @"⇧⌘K");
  addCommand(tabs, @"Pin or Unpin Tab", @"pin", @"⌘D");
  addCommand(tabs, @"Refresh Pull Requests", @"github", @"");

  NSMenu* window = addMenu(@"Window");
  [window addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
  [window addItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@""];
  NSApp.windowsMenu = window;

  g_menu_target.commands = commands;
  NSApp.mainMenu = bar;
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

void StyleWindow(void* window, double corner_radius, bool shadow) {
  NSWindow* w = Win(window);
  if (!w) return;
  w.opaque = NO;
  w.backgroundColor = NSColor.clearColor;
  w.hasShadow = shadow;
  w.collectionBehavior |= NSWindowCollectionBehaviorFullScreenAuxiliary;
  NSView* content = w.contentView;
  content.wantsLayer = YES;
  content.layer.cornerRadius = corner_radius;
  content.layer.cornerCurve = kCACornerCurveContinuous;
  content.layer.masksToBounds = YES;
}

void SetIgnoresMouse(void* window, bool ignores) {
  if (NSWindow* w = Win(window)) w.ignoresMouseEvents = ignores;
}

void SetFloating(void* window, bool floating, const std::string& title) {
  NSWindow* w = Win(window);
  if (!w) return;
  if (floating) {
    w.styleMask |= NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable;
    w.title = NS(title);
    w.level = NSFloatingWindowLevel;
    w.hasShadow = YES;
    w.collectionBehavior |= NSWindowCollectionBehaviorCanJoinAllSpaces;
    w.contentView.layer.cornerRadius = 0;
  } else {
    w.styleMask &= ~(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable);
    w.level = NSNormalWindowLevel;
    w.hasShadow = NO;
    w.collectionBehavior &= ~NSWindowCollectionBehaviorCanJoinAllSpaces;
    w.contentView.layer.cornerRadius = 10;
  }
}

void CopyText(const std::string& text) {
  NSPasteboard* pb = NSPasteboard.generalPasteboard;
  [pb clearContents];
  [pb setString:NS(text) forType:NSPasteboardTypeString];
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

}  // namespace roar::platform
