#import <Cocoa/Cocoa.h>

#include "include/cef_app.h"
#include "include/cef_application_mac.h"
#include "include/wrapper/cef_library_loader.h"

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
- (BOOL)applicationShouldHandleReopen:(NSApplication*)app hasVisibleWindows:(BOOL)visible {
  roar::Controller::Get()->Focus();
  return NO;
}
- (BOOL)application:(NSApplication*)sender delegateHandlesKey:(NSString*)key {
  return [key isEqualToString:@"roarTabs"] || [key isEqualToString:@"activeRoarTab"];
}
@end

int main(int argc, char* argv[]) {
  CefScopedLibraryLoader library_loader;
  if (!library_loader.LoadInMain()) return 1;

  CefMainArgs main_args(argc, argv);
  @autoreleasepool {
    [RoarApplication sharedApplication];
    RoarAppDelegate* delegate = [[RoarAppDelegate alloc] init];
    NSApp.delegate = delegate;
    CHECK([NSApp isKindOfClass:[RoarApplication class]]);

    CefSettings settings;
    settings.no_sandbox = false;
#if !defined(CEF_USE_SANDBOX)
    settings.no_sandbox = true;
#endif
    settings.remote_debugging_port = roar::platform::CdpPort();
    std::string data_dir = roar::State::Get().Dir();
    // Roar restores its own tabs; Chromium's session restore would reopen them
    // a second time as plain Chrome windows.
    // Chrome style keeps its profile in <root>/Default.
    [NSFileManager.defaultManager
        removeItemAtPath:[NSString stringWithUTF8String:(data_dir + "/Default/Sessions").c_str()]
                   error:nil];
    // Each Space's profile lives in <root>/Space-<id>.
    NSString* root = [NSString stringWithUTF8String:data_dir.c_str()];
    for (NSString* name in [NSFileManager.defaultManager contentsOfDirectoryAtPath:root error:nil])
      if ([name hasPrefix:@"Space-"])
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
