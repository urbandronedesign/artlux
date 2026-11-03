/*
 * artlux syphon shim — implementation. See shim.h for why this is Objective-C and not Rust msg_send.
 * Compiled with ARC (-fobjc-arc) by build.rs. Main thread only.
 */
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>

/* Deliberately NOT <Syphon/Syphon.h>. The umbrella header pulls in SyphonMetalServer/Client, which
 * pulls in Metal — and the whole point of using SyphonClientBase directly is that we need neither
 * Metal nor OpenGL to reach the IOSurface (plans/syphon-plugin.md §4.3). Importing the umbrella
 * would drag a Metal link dependency in for nothing. */
#import <Syphon/SyphonServerDirectory.h>
#import <Syphon/SyphonClientBase.h>
#import <Syphon/SyphonServerBase.h>
#import <Syphon/SyphonSubclassing.h>

#include "shim.h"

/* 'BGRA' as an OSType. Syphon servers create their surface with kCVPixelFormatType_32BGRA and have
 * done explicitly since the commit build-syphon.sh pins, so this is a fact rather than a hope — but
 * it is asserted anyway, because the alternative to asserting it is handing Chromium bytes it will
 * read as the wrong colours with nothing anywhere saying why. */
#define ARTLUX_BGRA 0x42475241u

/* Can this surface go to Chromium as BGRA?
 *
 * ⚠ THE NOTE ABOVE IS TRUE OF THE SYPHON *WE* BUILD, NOT OF THE SERVER'S. Every Syphon app ships its
 * own copy of the framework, and the surface is created by THAT copy. Older Syphon (the OpenGL
 * servers — TouchDesigner, and many others) never set kIOSurfacePixelFormat at all: the surface reads
 * as format 0 with 4 bytes per element, and its bytes are BGRA all the same, because BGRA8 is the only
 * thing Syphon has ever published. Requiring the 'BGRA' tag refused EVERY frame from TouchDesigner on
 * the first real-Mac test (2026-11-03, M1 Pro, macOS 13.1) — an empty surface with the server found and
 * connected. The loopback selftest could not see it: its server is our own, current framework.
 * So: the tag, or no tag and 4 bytes a pixel. Anything else is still refused. */
static int artlux_surface_is_bgra(IOSurfaceRef s)
{
    OSType fmt = IOSurfaceGetPixelFormat(s);
    if (fmt == ARTLUX_BGRA) return 1;
    return (fmt == 0 && IOSurfaceGetBytesPerElement(s) == 4) ? 1 : 0;
}

static SyphonServerDirectory *gDirectory = nil;
static SyphonClientBase *gClient = nil;
static NSString *gWantName = nil;   /* "" means don't care */
static NSString *gWantApp = nil;

/* ── the one runtime decision we could not settle without a Mac ──────────────────────────────
 * plans/syphon-plugin.md §4.3: SyphonClientBase is written as a base for subclasses, and there is a
 * small chance direct instantiation misbehaves. It is confined to THIS FUNCTION so that swapping in
 * a subclass (or SyphonMetalClient + .iosurface) on the day is a local edit and not a redesign.
 *
 * Direct instantiation should be fine: -initWithServerDescription:options:newFrameHandler: is a
 * public designated initializer, and -invalidateFrame — the documented subclass hook — is a no-op in
 * the base, which is precisely what we want since we cache no texture of our own.
 *
 * The handler is nil on purpose: we POLL, gated on -hasNewFrame. A block would fire on a Syphon
 * thread and buy us a napi ThreadsafeFunction and its lifetime hazards, to save polls that cost one
 * lock and one integer compare. See §4.5. */
static SyphonClientBase *artlux_make_client(NSDictionary *description)
{
    if (description == nil) return nil;
    SyphonClientBase *c = [[SyphonClientBase alloc] initWithServerDescription:description
                                                                      options:nil
                                                              newFrameHandler:nil];
    return (c != nil && c.isValid) ? c : nil;
}

static int copy_out(NSString *s, char *buf, int cap)
{
    if (buf == NULL || cap <= 0) return -1;
    const char *utf8 = [(s ?: @"") UTF8String];
    if (utf8 == NULL) utf8 = "";
    size_t len = strlen(utf8);
    if ((int)len >= cap) len = (size_t)cap - 1;
    memcpy(buf, utf8, len);
    buf[len] = '\0';
    return (int)len;
}

static NSArray *current_servers(void)
{
    artlux_syphon_directory_start();
    return gDirectory.servers ?: @[];
}

int artlux_syphon_available(void)
{
    return (NSClassFromString(@"SyphonClientBase") != nil
            && NSClassFromString(@"SyphonServerDirectory") != nil) ? 1 : 0;
}

void artlux_syphon_directory_start(void)
{
    if (gDirectory == nil) gDirectory = [SyphonServerDirectory sharedDirectory];
}

int artlux_syphon_server_count(void)
{
    return (int)current_servers().count;
}

static NSDictionary *server_at(int idx)
{
    NSArray *all = current_servers();
    if (idx < 0 || idx >= (int)all.count) return nil;
    return all[(NSUInteger)idx];
}

int artlux_syphon_server_name(int idx, char *buf, int cap)
{
    NSDictionary *d = server_at(idx);
    if (d == nil) return -1;
    return copy_out(d[SyphonServerDescriptionNameKey], buf, cap);
}

int artlux_syphon_server_app_name(int idx, char *buf, int cap)
{
    NSDictionary *d = server_at(idx);
    if (d == nil) return -1;
    return copy_out(d[SyphonServerDescriptionAppNameKey], buf, cap);
}

/* Resolve the wanted (name, appName) to a description. Empty string -> nil -> "don't care", which
 * is what -serversMatchingName:appName: wants, and what makes ("","") mean "the active server". */
static NSDictionary *resolve_wanted(void)
{
    artlux_syphon_directory_start();
    NSString *name = (gWantName.length > 0) ? gWantName : nil;
    NSString *app  = (gWantApp.length  > 0) ? gWantApp  : nil;
    NSArray *matches = [gDirectory serversMatchingName:name appName:app];
    if (matches.count > 0) return matches[0];
    /* An explicit pick that is not on the system right now. Do NOT silently fall back to some other
     * server: an operator who chose "Resolume" and got a stray TouchDesigner output would have no
     * way to tell, and the surface looking WRONG is worse than the surface being empty. Falling back
     * is only correct when they asked for "the active server" in the first place. */
    return nil;
}

int artlux_syphon_connect(const char *name, const char *app_name)
{
    gWantName = name ? [NSString stringWithUTF8String:name] : @"";
    gWantApp  = app_name ? [NSString stringWithUTF8String:app_name] : @"";
    gClient = nil;
    return artlux_syphon_ensure_connected();
}

int artlux_syphon_ensure_connected(void)
{
    if (gClient != nil && gClient.isValid) return 1;
    gClient = artlux_make_client(resolve_wanted());
    return (gClient != nil) ? 1 : 0;
}

void artlux_syphon_disconnect(void)
{
    [gClient stop];
    gClient = nil;
    gWantName = nil;
    gWantApp = nil;
}

int artlux_syphon_is_valid(void)
{
    return (gClient != nil && gClient.isValid) ? 1 : 0;
}

int artlux_syphon_has_new_frame(void)
{
    return (gClient != nil && gClient.hasNewFrame) ? 1 : 0;
}

uintptr_t artlux_syphon_new_surface(uint32_t *w, uint32_t *h, uint32_t *pixel_format)
{
    if (gClient == nil) return 0;
    IOSurfaceRef s = [gClient newSurface];   /* +1 — ours to release. See shim.h. */
    if (s == NULL) return 0;

    if (!artlux_surface_is_bgra(s)) {
        /* Defensive, not a supported path: a future Syphon that publishes something else must not
         * be silently reinterpreted as BGRA. Refusing produces an empty surface and a log; guessing
         * produces wrong colours and no explanation. ONE line per format, not one per frame: the
         * poll asks ~60×/s, and the first Mac test's log was 3,463 copies of this line. */
        static OSType lastRefused = 0xFFFFFFFFu;
        OSType fmt = IOSurfaceGetPixelFormat(s);
        if (fmt != lastRefused) {
            lastRefused = fmt;
            NSLog(@"[syphon] refusing surface with unexpected pixel format 0x%08X, %zu bytes/pixel (want BGRA)",
                  (unsigned)fmt, IOSurfaceGetBytesPerElement(s));
        }
        CFRelease(s);
        return 0;
    }
    if (w) *w = (uint32_t)IOSurfaceGetWidth(s);
    if (h) *h = (uint32_t)IOSurfaceGetHeight(s);
    /* Normalised: a legacy surface says 0, and every caller should see the BGRA it really is. */
    if (pixel_format) *pixel_format = ARTLUX_BGRA;
    return (uintptr_t)s;
}

void artlux_syphon_release_surface(uintptr_t surface)
{
    if (surface) CFRelease((IOSurfaceRef)surface);
}

/* ── selftest support ─────────────────────────────────────────────────────────────────────── */

/* A minimal Syphon server over plain IOSurface memory. SyphonSubclassing.h hands us exactly the two
 * hooks needed — get a surface, publish — so this needs no GPU at all and runs on a headless runner. */
@interface ArtluxTestServer : SyphonServerBase
@end
@implementation ArtluxTestServer
@end

static ArtluxTestServer *gTestServer = nil;

int artlux_syphon_test_server_start(const char *name)
{
    NSString *n = name ? [NSString stringWithUTF8String:name] : @"artlux-selftest";
    gTestServer = [[ArtluxTestServer alloc] initWithName:n options:nil];
    return (gTestServer != nil) ? 1 : 0;
}

int artlux_syphon_test_server_publish(uint32_t w, uint32_t h, uint32_t bgra)
{
    if (gTestServer == nil) return 0;
    IOSurfaceRef s = [gTestServer newSurfaceForWidth:w height:h options:nil];  /* +1 */
    if (s == NULL) return 0;
    IOSurfaceLock(s, 0, NULL);
    uint8_t *base = (uint8_t *)IOSurfaceGetBaseAddress(s);
    size_t bpr = IOSurfaceGetBytesPerRow(s);
    for (uint32_t y = 0; y < h; y++) {
        uint32_t *row = (uint32_t *)(base + (size_t)y * bpr);
        for (uint32_t x = 0; x < w; x++) row[x] = bgra;
    }
    IOSurfaceUnlock(s, 0, NULL);
    CFRelease(s);
    [gTestServer publish];
    return 1;
}

void artlux_syphon_test_server_stop(void)
{
    [gTestServer stop];
    gTestServer = nil;
}

int artlux_syphon_test_connect_direct(void)
{
    if (gTestServer == nil) return 0;
    gClient = artlux_make_client(gTestServer.serverDescription);
    return (gClient != nil) ? 1 : 0;
}

int artlux_syphon_test_server_has_clients(void)
{
    return (gTestServer != nil && gTestServer.hasClients) ? 1 : 0;
}

void artlux_syphon_runloop_spin(double seconds)
{
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]];
}

int artlux_syphon_test_accepts(uint32_t pixel_format, uint32_t bytes_per_element)
{
    NSMutableDictionary *props = [@{
        (id)kIOSurfaceWidth: @16, (id)kIOSurfaceHeight: @16,
        (id)kIOSurfaceBytesPerElement: @(bytes_per_element),
    } mutableCopy];
    /* 0 = leave the key out entirely, which is what a legacy Syphon server does — not the same as
     * setting it to 0, and the case the format check has to accept. */
    if (pixel_format) props[(id)kIOSurfacePixelFormat] = @(pixel_format);
    IOSurfaceRef s = IOSurfaceCreate((__bridge CFDictionaryRef)props);
    if (s == NULL) return -1;
    int ok = artlux_surface_is_bgra(s);
    CFRelease(s);
    return ok;
}

int artlux_syphon_surface_retain_count(uintptr_t surface)
{
    return surface ? (int)CFGetRetainCount((CFTypeRef)surface) : -1;
}

uint32_t artlux_syphon_surface_pixel(uintptr_t surface, uint32_t x, uint32_t y)
{
    if (!surface) return 0;
    IOSurfaceRef s = (IOSurfaceRef)surface;
    IOSurfaceLock(s, kIOSurfaceLockReadOnly, NULL);
    uint8_t *base = (uint8_t *)IOSurfaceGetBaseAddress(s);
    size_t bpr = IOSurfaceGetBytesPerRow(s);
    uint32_t px = *(uint32_t *)(base + (size_t)y * bpr + (size_t)x * 4);
    IOSurfaceUnlock(s, kIOSurfaceLockReadOnly, NULL);
    return px;
}
