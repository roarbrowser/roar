// AppleScript support. The dictionary lives in resources/Roar.sdef.
#import <Cocoa/Cocoa.h>

#include "controller.h"
#include "state.h"

using roar::Controller;

@interface RoarScriptTab : NSObject
@property(nonatomic) int tabId;
@end

@implementation RoarScriptTab
+ (instancetype)withId:(int)tabId {
  RoarScriptTab* tab = [[RoarScriptTab alloc] init];
  tab.tabId = tabId;
  return tab;
}
- (const roar::Tab*)tab {
  for (const auto& t : Controller::Get()->tabs())
    if (t.id == self.tabId) return &t;
  return nullptr;
}
// Ghost tabs and tabs in spaces closed to agents stay hidden from scripts, as in ExecuteScriptFromApp.
- (const roar::Tab*)visibleTab {
  auto* t = [self tab];
  if (!t || t->ghost) return nullptr;
  roar::Space* sp = roar::State::Get().FindSpace(t->space);
  return sp && !sp->agents ? nullptr : t;
}
- (NSNumber*)uniqueID {
  return @(self.tabId);
}
- (NSString*)URL {
  auto* t = [self visibleTab];
  return t ? [NSString stringWithUTF8String:t->url.c_str()] : @"";
}
- (void)setURL:(NSString*)url {
  NSString* lower = [url stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].lowercaseString;
  for (NSString* scheme in @[ @"roar:", @"javascript:", @"file:" ])
    if ([lower hasPrefix:scheme]) return;
  auto* t = [self visibleTab];
  if (!t || t->url.rfind("roar:", 0) == 0) return;  // Same rules as ExecuteScriptFromApp.
  Controller::Get()->Navigate(self.tabId, url.UTF8String);
}
- (NSString*)title {
  auto* t = [self visibleTab];
  return t ? [NSString stringWithUTF8String:t->title.c_str()] : @"";
}
- (BOOL)pinned {
  auto* t = [self tab];
  return t && t->pinned;
}
- (void)setPinned:(BOOL)pinned {
  Controller::Get()->SetPinned(self.tabId, pinned);
}
- (BOOL)loading {
  auto* t = [self tab];
  return t && t->loading;
}
- (NSScriptObjectSpecifier*)objectSpecifier {
  NSScriptClassDescription* appDesc = (NSScriptClassDescription*)[NSApp classDescription];
  return [[NSUniqueIDSpecifier alloc] initWithContainerClassDescription:appDesc
                                                     containerSpecifier:nil
                                                                    key:@"roarTabs"
                                                               uniqueID:@(self.tabId)];
}
@end

@implementation NSApplication (RoarScripting)
- (NSArray*)roarTabs {
  NSMutableArray* result = [NSMutableArray array];
  for (const auto& t : Controller::Get()->tabs()) [result addObject:[RoarScriptTab withId:t.id]];
  return result;
}
- (RoarScriptTab*)activeRoarTab {
  int id = Controller::Get()->active_id();
  return id ? [RoarScriptTab withId:id] : nil;
}
- (id)valueInRoarTabsWithUniqueID:(NSNumber*)uniqueID {
  for (const auto& t : Controller::Get()->tabs())
    if (t.id == uniqueID.intValue) return [RoarScriptTab withId:t.id];
  return nil;
}
@end

// Resolves the optional "in tab" argument to a tab id, defaulting to the
// active tab.
static int TargetTab(NSScriptCommand* command, NSString* key) {
  id arg = command.evaluatedArguments[key];
  if ([arg isKindOfClass:[RoarScriptTab class]]) return ((RoarScriptTab*)arg).tabId;
  if ([arg isKindOfClass:[NSNumber class]]) return [arg intValue];
  id receiver = command.evaluatedReceivers;
  if ([receiver isKindOfClass:[RoarScriptTab class]]) return ((RoarScriptTab*)receiver).tabId;
  return Controller::Get()->active_id();
}

@interface RoarOpenURLCommand : NSScriptCommand
@end
@implementation RoarOpenURLCommand
- (id)performDefaultImplementation {
  NSString* url = self.directParameter;
  if (![url isKindOfClass:[NSString class]]) return nil;
  // Roar's own pages hold privileged UI; scripts may not open them.
  if ([[url stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].lowercaseString hasPrefix:@"roar:"]) return nil;
  int id = Controller::Get()->NewTab(url.UTF8String, true);
  return [RoarScriptTab withId:id];
}
@end

@interface RoarExecuteCommand : NSScriptCommand
@end
@implementation RoarExecuteCommand
- (id)performDefaultImplementation {
  NSString* code = self.directParameter;
  if (![code isKindOfClass:[NSString class]]) return @NO;
  return @(Controller::Get()->ExecuteScriptFromApp(TargetTab(self, @"tab"), code.UTF8String));
}
@end

@interface RoarTabCommand : NSScriptCommand
@end
@implementation RoarTabCommand
- (id)performDefaultImplementation {
  id target = self.directParameter;
  int id = [target isKindOfClass:[RoarScriptTab class]] ? ((RoarScriptTab*)target).tabId
           : [target isKindOfClass:[NSNumber class]]   ? [target intValue]
                                                       : TargetTab(self, @"tab");
  NSString* name = self.commandDescription.commandName;
  if ([name isEqualToString:@"close tab"]) Controller::Get()->CloseTab(id);
  else Controller::Get()->ActivateTab(id);
  return nil;
}
@end

@interface RoarRunCommand : NSScriptCommand
@end
@implementation RoarRunCommand
- (id)performDefaultImplementation {
  NSString* name = self.commandDescription.commandName;
  if ([name isEqualToString:@"clean up tabs"]) Controller::Get()->RunCommand("clean");
  else if ([name isEqualToString:@"copy page as markdown"]) Controller::Get()->RunCommand("copyMarkdown");
  return nil;
}
@end
