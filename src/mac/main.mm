#import <Cocoa/Cocoa.h>

#include "include/cef_app.h"
#include "include/cef_application_mac.h"
#include "include/wrapper/cef_library_loader.h"

#include "action_watch.h"
#include "browser_app.h"
#include "controller.h"
#include "mac/platform.h"
#include "state.h"

// CEF requires an NSApplication that implements CefAppProtocol.
@interface RoarApplication : NSApplication <CefAppProtocol> {
 @private
  BOOL handlingSendEvent_;
}
@end

@implementation RoarApplication
- (BOOL)isHandlingSendEvent {
  return handlingSendEvent_;
}
- (void)setHandlingSendEvent:(BOOL)handlingSendEvent {
  handlingSendEvent_ = handlingSendEvent;
}
- (void)sendEvent:(NSEvent*)event {
  CefScopedSendingEvent sendingEventScoper;
  [super sendEvent:event];
}
- (void)terminate:(id)sender {
  roar::Controller::Get()->Quit();
}
@end

@interface RoarAppDelegate : NSObject <NSApplicationDelegate>
@end

@implementation RoarAppDelegate
- (void)applicationWillFinishLaunching:(NSNotification*)notification {
  // Links opened from other apps arrive as GetURL Apple events.
  [[NSAppleEventManager sharedAppleEventManager]
      setEventHandler:self
          andSelector:@selector(handleGetURL:withReplyEvent:)
        forEventClass:kInternetEventClass
           andEventID:kAEGetURL];
}
- (void)handleGetURL:(NSAppleEventDescriptor*)event withReplyEvent:(NSAppleEventDescriptor*)reply {
  NSString* url = [[event paramDescriptorForKeyword:keyDirectObject] stringValue];
  if (url) roar::Controller::Get()->NewTab(url.UTF8String, true);
}
- (void)applicationDidResignActive:(NSNotification*)notification {
  roar::Controller::Get()->PaintPreview();
}
- (void)applicationDidBecomeActive:(NSNotification*)notification {
  roar::Controller::Get()->ClearPreview();
}
- (BOOL)applicationShouldHandleReopen:(NSApplication*)app hasVisibleWindows:(BOOL)visible {
  roar::Controller::Get()->Focus();
  return NO;
}
- (void)newWindow:(id)sender {
  roar::platform::LaunchInstance();
}
- (NSMenu*)applicationDockMenu:(NSApplication*)sender {
  NSMenu* menu = [[NSMenu alloc] init];
  [menu addItemWithTitle:@"New Window" action:@selector(newWindow:) keyEquivalent:@""].target = self;
  return menu;
}
- (BOOL)application:(NSApplication*)sender delegateHandlesKey:(NSString*)key {
  return [key isEqualToString:@"roarTabs"] || [key isEqualToString:@"activeRoarTab"];
}
@end

int main(int argc, char* argv[]) {
  CefScopedLibraryLoader library_loader;
  if (!library_loader.LoadInMain()) return 1;

  CefMainArgs main_args(argc, argv);
  for (int i = 1; i < argc; ++i)
    if (!strncmp(argv[i], "--instance=", 11) && argv[i][11]) setenv("ROAR_INSTANCE", argv[i] + 11, 1);
  roar::action_watch::PrepareMain();
  @autoreleasepool {
    [RoarApplication sharedApplication];
    RoarAppDelegate* delegate = [[RoarAppDelegate alloc] init];
    NSApp.delegate = delegate;
    CHECK([NSApp isKindOfClass:[RoarApplication class]]);
    // Headless: a menu bar icon instead of a Dock icon (platform::InstallStatusItem).
    if (roar::platform::Headless()) [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    CefSettings settings;
    settings.no_sandbox = false;
#if !defined(CEF_USE_SANDBOX)
    settings.no_sandbox = true;
#endif
    // A second Roar on the same data dir would fight over its profiles, so a
    // plain second launch becomes the next free instance.
    std::string data_dir = roar::State::Get().Dir();
    for (int n = 2; !roar::platform::ClaimInstance(data_dir); ++n) {
      if (getenv("ROAR_DATA_DIR") || n > 50) return 0;
      setenv("ROAR_INSTANCE", std::to_string(n).c_str(), 1);
      data_dir = roar::State::Get().Dir();
    }
    settings.remote_debugging_port = roar::platform::CdpPort();
    // Roar restores its own tabs; Chromium's session restore would reopen them
    // a second time as plain Chrome windows.
    // Chrome style keeps its profile in <root>/Default.
    [NSFileManager.defaultManager
        removeItemAtPath:[NSString stringWithUTF8String:(data_dir + "/Default/Sessions").c_str()]
                   error:nil];
    // Each Space's profile lives in <root>/Space-<id>.
    NSString* root = [NSString stringWithUTF8String:data_dir.c_str()];
    // Chrome style starts the global context in Local State's last-used
    // profile, which a ghost or Space context can claim. Space 0 must stay
    // Default, or its tabs open in an empty profile with no logins or extensions.
    NSString* local_state = [root stringByAppendingPathComponent:@"Local State"];
    if (NSData* data = [NSData dataWithContentsOfFile:local_state]) {
      NSMutableDictionary* json = [NSJSONSerialization JSONObjectWithData:data
                                                                  options:NSJSONReadingMutableContainers
                                                                    error:nil];
      NSMutableDictionary* profile = [json isKindOfClass:NSMutableDictionary.class] ? json[@"profile"] : nil;
      if ([profile isKindOfClass:NSMutableDictionary.class] && ![profile[@"last_used"] isEqual:@"Default"]) {
        profile[@"last_used"] = @"Default";
        profile[@"last_active_profiles"] = @[ @"Default" ];
        [[NSJSONSerialization dataWithJSONObject:json options:0 error:nil] writeToFile:local_state
                                                                             atomically:YES];
      }
    }
    for (NSString* name in [NSFileManager.defaultManager contentsOfDirectoryAtPath:root error:nil])
      if ([name hasPrefix:@"Ghost-"])  // Ghost tab profiles from a previous run.
        [NSFileManager.defaultManager removeItemAtPath:[root stringByAppendingPathComponent:name] error:nil];
      else if ([name hasPrefix:@"Space-"])
        [NSFileManager.defaultManager
            removeItemAtPath:[[root stringByAppendingPathComponent:name]
                                 stringByAppendingPathComponent:@"Sessions"]
                       error:nil];
    CefString(&settings.root_cache_path) = data_dir;
    settings.persist_session_cookies = true;

    CefRefPtr<roar::BrowserApp> app(new roar::BrowserApp());
    if (!CefInitialize(main_args, settings, app.get(), nullptr)) return CefGetExitCode();
    CefRunMessageLoop();
    CefShutdown();
  }
  return 0;
}
