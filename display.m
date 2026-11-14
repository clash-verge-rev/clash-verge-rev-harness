#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <dispatch/dispatch.h>
#include <signal.h>
#include <fcntl.h>
#include <unistd.h>
#include <math.h>

// Private API declarations checked against Chromium's virtual_display_util_mac.mm.
@interface CGVirtualDisplayDescriptor : NSObject
@property(nonatomic) unsigned int vendorID, productID, serialNum, serialNumber;
@property(nonatomic) unsigned int maxPixelsWide, maxPixelsHigh;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) CGPoint redPrimary, greenPrimary, bluePrimary, whitePoint;
@property(strong, nonatomic) NSString *name;
@property(strong, nonatomic) id queue;
@end
@interface CGVirtualDisplayMode : NSObject
- (id)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)rate;
@end
@interface CGVirtualDisplaySettings : NSObject
@property(strong, nonatomic) NSArray *modes;
@property(nonatomic) unsigned int hiDPI;
@end
@interface CGVirtualDisplay : NSObject
@property(readonly, nonatomic) unsigned int displayID;
- (id)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@end

static volatile sig_atomic_t stopping;
static CGVirtualDisplay *owned;
static void stopSignal(int signalNumber) { stopping = signalNumber; }
static NSArray *rect(CGRect r) { return @[@(r.origin.x), @(r.origin.y), @(r.size.width), @(r.size.height)]; }
static void emit(NSDictionary *value) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  fwrite(json.bytes, 1, json.length, stdout); fputc('\n', stdout); fflush(stdout);
}
static void tick(void) { [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]]; }
static NSArray *inventory(void) {
  uint32_t count = 0;
  if (CGGetOnlineDisplayList(0, NULL, &count) != kCGErrorSuccess || !count) return nil;
  CGDirectDisplayID *ids = calloc(count, sizeof(CGDirectDisplayID));
  if (!ids) return nil;
  if (CGGetOnlineDisplayList(count, ids, &count) != kCGErrorSuccess) { free(ids); return nil; }
  NSMutableArray *result = [NSMutableArray array];
  for (uint32_t i = 0; i < count; i++) {
    CGDirectDisplayID display = ids[i];
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(display);
    NSMutableDictionary *item = [@{@"id": @(display), @"main": (display == CGMainDisplayID() ? @YES : @NO), @"bounds": rect(CGDisplayBounds(display)), @"mirrored": (CGDisplayIsInMirrorSet(display) ? @YES : @NO), @"online": (CGDisplayIsOnline(display) ? @YES : @NO)} mutableCopy];
    if (mode) {
      item[@"logical"] = @[@(CGDisplayModeGetWidth(mode)), @(CGDisplayModeGetHeight(mode))];
      item[@"pixels"] = @[@(CGDisplayModeGetPixelWidth(mode)), @(CGDisplayModeGetPixelHeight(mode))];
      item[@"refreshHz"] = @(CGDisplayModeGetRefreshRate(mode));
      CGDisplayModeRelease(mode);
    }
    for (NSScreen *screen in NSScreen.screens) {
      if ([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue] == display) {
        item[@"frame"] = rect(NSRectToCGRect(screen.frame));
        item[@"visibleFrame"] = rect(NSRectToCGRect(screen.visibleFrame));
        item[@"scale"] = @(screen.backingScaleFactor);
      }
    }
    if (!item[@"logical"] || !item[@"pixels"] || !item[@"refreshHz"] || !item[@"frame"] || !item[@"visibleFrame"] || !item[@"scale"]) { free(ids); return nil; }
    [result addObject:item];
  }
  free(ids);
  [result sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) { return [a[@"id"] compare:b[@"id"]]; }];
  return result;
}
static BOOL physicalUnchanged(NSArray *before, NSArray *after, unsigned int newID) {
  NSMutableArray *physical = [NSMutableArray array];
  for (NSDictionary *item in after) if ([item[@"id"] unsignedIntValue] != newID) [physical addObject:item];
  return [before isEqual:physical];
}
int main(int argc, char **argv) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSArray *before = inventory();
    if (!before) { emit(@{@"error": @"display inventory unavailable"}); return 1; }
    if (argc > 1 && strcmp(argv[1], "--inventory") == 0) { emit(@{@"screens": before}); return 0; }
    // Parent verifies PID/start/executable before allowing display creation.
    if (getchar() != 'C') return 1;
    for (NSString *name in @[@"CGVirtualDisplayDescriptor", @"CGVirtualDisplayMode", @"CGVirtualDisplaySettings", @"CGVirtualDisplay"]) if (!NSClassFromString(name)) { emit(@{@"error": @"private display API unavailable"}); return 1; }
    signal(SIGINT, stopSignal); signal(SIGTERM, stopSignal);
    CGVirtualDisplayDescriptor *descriptor = [[NSClassFromString(@"CGVirtualDisplayDescriptor") alloc] init];
    for (NSString *selector in @[@"setSerialNumber:", @"setSerialNum:", @"setVendorID:", @"setMaxPixelsWide:", @"setMaxPixelsHigh:"]) if (![descriptor respondsToSelector:NSSelectorFromString(selector)]) { emit(@{@"error": @"private descriptor API unavailable"}); return 1; }
    unsigned int identity = arc4random();
    if (!identity) identity = (unsigned int)getpid();
    descriptor.vendorID = identity; descriptor.productID = 1;
    descriptor.serialNum = descriptor.serialNumber = identity;
    descriptor.maxPixelsWide = 2560; descriptor.maxPixelsHigh = 1800;
    descriptor.sizeInMillimeters = CGSizeMake(295, 208);
    descriptor.name = @"Verge task-owned virtual display";
    descriptor.queue = dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);
    descriptor.redPrimary = CGPointMake(0.64, 0.33); descriptor.greenPrimary = CGPointMake(0.30, 0.60);
    descriptor.bluePrimary = CGPointMake(0.15, 0.06); descriptor.whitePoint = CGPointMake(0.3127, 0.3290);
    owned = [[NSClassFromString(@"CGVirtualDisplay") alloc] initWithDescriptor:descriptor];
    if (!owned) { emit(@{@"error": @"virtual display creation failed"}); return 1; }
    unsigned int displayID = owned.displayID;
    if (!displayID) { emit(@{@"error": @"virtual display ID unavailable"}); return 1; }
    for (NSDictionary *screen in before) if ([screen[@"id"] unsignedIntValue] == displayID) { emit(@{@"error": @"display ID was already present"}); return 1; }
    CGVirtualDisplaySettings *settings = [[NSClassFromString(@"CGVirtualDisplaySettings") alloc] init];
    settings.hiDPI = 1;
    settings.modes = @[[[NSClassFromString(@"CGVirtualDisplayMode") alloc] initWithWidth:1280 height:900 refreshRate:60.0]];
    if (![owned applySettings:settings]) { owned = nil; emit(@{@"error": @"virtual mode rejected"}); return 1; }
    double maxX = 0;
    for (NSDictionary *item in before) { NSArray *b = item[@"bounds"]; maxX = fmax(maxX, [b[0] doubleValue] + [b[2] doubleValue]); }
    CGDisplayConfigRef config;
    CGError error = CGBeginDisplayConfiguration(&config);
    if (error == kCGErrorSuccess) {
      error = CGConfigureDisplayOrigin(config, displayID, (int)ceil(maxX + 64), 0);
      if (error == kCGErrorSuccess) error = CGCompleteDisplayConfiguration(config, kCGConfigureForAppOnly);
      else CGCancelDisplayConfiguration(config);
    }
    if (error != kCGErrorSuccess) { owned = nil; emit(@{@"error": @"owned origin configuration failed", @"code": @(error)}); return 1; }
    NSDictionary *screenState = nil; NSArray *during = nil;
    for (int i = 0; i < 100 && !screenState; i++) {
      tick(); during = inventory();
      for (NSDictionary *item in during) if ([item[@"id"] unsignedIntValue] == displayID && item[@"scale"]) screenState = item;
    }
    BOOL nonoverlap = YES;
    CGRect virtualBounds = CGDisplayBounds(displayID);
    for (NSDictionary *item in before) { NSArray *b = item[@"bounds"]; CGRect physicalBounds = CGRectMake([b[0] doubleValue], [b[1] doubleValue], [b[2] doubleValue], [b[3] doubleValue]); if (CGRectIntersectsRect(virtualBounds, physicalBounds)) nonoverlap = NO; }
    BOOL valid = nonoverlap && screenState && physicalUnchanged(before, during, displayID) && ![screenState[@"main"] boolValue] && ![screenState[@"mirrored"] boolValue] && [screenState[@"scale"] doubleValue] == 2 && fabs([screenState[@"refreshHz"] doubleValue] - 60) < 0.01 && [screenState[@"logical"] isEqual:@[@1280, @900]] && [screenState[@"pixels"] isEqual:@[@2560, @1800]];
    emit(@{@"event": @"created", @"pid": @(getpid()), @"displayID": @(displayID), @"nonoverlap": (nonoverlap ? @YES : @NO), @"valid": (valid ? @YES : @NO), @"before": before, @"during": during ?: @[]});

    fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK);
    while (valid && !stopping) {
      tick();
      char input[128]; ssize_t n = read(STDIN_FILENO, input, sizeof(input));
      if (n >= 0) break;
    }
    owned = nil;
    return valid ? 0 : 1;
  }
}
