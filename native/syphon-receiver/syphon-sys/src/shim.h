/*
 * artlux syphon shim — a flat C ABI over the Objective-C Syphon framework.
 *
 * WHY THERE IS OBJECTIVE-C HERE INSTEAD OF `objc2` msg_send! IN RUST.
 * This plugin is being written on a Windows machine with no Mac (plans/syphon-plugin.md §4.8), so
 * every line of it is compiled for the first time by CI. Raw `msg_send!` is unchecked at the point
 * of writing: a wrong selector, a wrong nullability or a wrong ownership family compiles happily in
 * Rust and misbehaves at runtime, which is the one failure mode a compile-only CI gate cannot catch.
 * Written as Objective-C, clang checks every selector against Syphon's own headers, and the Rust
 * side collapses to the `extern "C"` declarations below — which are trivially auditable by eye.
 *
 * The shim is deliberately DUMB. No policy, no rate limiting, no caching: it owns the Syphon objects
 * and nothing else. Everything that could be a decision lives in Rust or, better, in TypeScript.
 *
 * ⚠ MAIN THREAD ONLY. SyphonServerDirectory and SyphonClientBase are CFMessagePort/distributed-
 * notification driven and need run-loop turns on the thread that created them. Electron's main
 * process runs a Cocoa run loop, so "call everything from the JS main thread" is both correct and
 * free. Nothing here is thread-safe and nothing here needs to be.
 */
#ifndef ARTLUX_SYPHON_SHIM_H
#define ARTLUX_SYPHON_SHIM_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 1 if the Syphon classes are present. 0 means the framework did not load, which in practice means
 * the addon itself would not have loaded either — kept as a belt-and-braces check. */
int artlux_syphon_available(void);

/* Create the shared server directory. Call this EARLY (plugin activation), not lazily on the first
 * listing: the directory learns about servers from announcements, so one created the moment an
 * operator opens the picker has heard nothing yet and reports an empty list — which reads as "my
 * sender is broken" and sends them to look in the wrong place. */
void artlux_syphon_directory_start(void);

int artlux_syphon_server_count(void);
/* UTF-8 into `buf`, NUL-terminated. Returns bytes written excluding the NUL, or -1. Either string
 * may legitimately be empty: a Syphon server's NAME is frequently blank and the app name is what
 * identifies it. That is why identity here is a PAIR — see plans/syphon-plugin.md §4.2. */
int artlux_syphon_server_name(int idx, char *buf, int cap);
int artlux_syphon_server_app_name(int idx, char *buf, int cap);

/* Remember (name, appName) as the wanted server and connect. Empty strings mean "don't care", so
 * ("","") is Spout's "active sender": the first server on the system. Returns 1 on connect. */
int artlux_syphon_connect(const char *name, const char *app_name);

/* Reconnect if the client has died. THIS IS NOT OPTIONAL POLISH.
 * SyphonClientBase.isValid goes NO when its server quits and NEVER recovers — unlike Spout, where
 * the sender-side lookup re-resolves for us. Without this call on every poll, "Active server" is a
 * lie the first time the sender app restarts, which in a venue is every time. Returns 1 if
 * connected afterwards. Cheap when already valid (one BOOL read). */
int artlux_syphon_ensure_connected(void);

void artlux_syphon_disconnect(void);
int artlux_syphon_is_valid(void);

/* Backed by the server's published frame ID, so unlike Spout's is_frame_new() this is TRUTHFUL.
 * That is why the poll can be gated on it instead of rate-limited against it. */
int artlux_syphon_has_new_frame(void);

/* The current frame's IOSurface, +1 RETAINED — the caller owns it and must pass it to
 * artlux_syphon_release_surface(). Returns 0 when there is nothing to hand over.
 *
 * ⚠ THE +1 IS THE MACOS LEAK HAZARD. Electron's importSharedTexture RETAINS the surface rather than
 * taking ownership of it (verified in electron_api_shared_texture.cc), so our reference is still
 * ours after the import and dropping it is our job. A missed release leaks a full-resolution
 * surface per frame — the exact twin of a missed VideoFrame.close() on the renderer side. */
uintptr_t artlux_syphon_new_surface(uint32_t *w, uint32_t *h, uint32_t *pixel_format);
void artlux_syphon_release_surface(uintptr_t surface);

/* ── selftest support ────────────────────────────────────────────────────────────────────────
 * A Syphon SERVER, in-process, with no Metal, no OpenGL and no GPU — SyphonSubclassing.h exposes
 * exactly the surface-and-publish pair needed to write one against plain IOSurface memory. That is
 * what makes the loopback test runnable on a headless CI runner, which is what buys back most of
 * the blindness of building this without a Mac. Not used by the plugin. */
int artlux_syphon_test_server_start(const char *name);
int artlux_syphon_test_server_publish(uint32_t w, uint32_t h, uint32_t bgra);
void artlux_syphon_test_server_stop(void);
/* Connect to the test server via its OWN serverDescription, bypassing the directory entirely. The
 * directory needs distributed notifications and a run loop; this path needs neither, so it isolates
 * "does the IOSurface path work" from "does discovery work in this environment". */
int artlux_syphon_test_connect_direct(void);
/* Has the server noticed a client attach? The client/server handshake runs over CFMessagePort and
 * completes on RUN-LOOP TURNS, not synchronously in -init — so this is the diagnostic that separates
 * "the connection never happened" from "we did not wait for it". */
int artlux_syphon_test_server_has_clients(void);
/* Let the run loop turn, so distributed notifications can actually be delivered. */
void artlux_syphon_runloop_spin(double seconds);
int artlux_syphon_surface_retain_count(uintptr_t surface);
/* One pixel, as it sits in memory (BGRA byte order). Used to prove the frame is REAL rather than
 * merely a non-null pointer, and that a second publish actually changes it. */
uint32_t artlux_syphon_surface_pixel(uintptr_t surface, uint32_t x, uint32_t y);

#ifdef __cplusplus
}
#endif
#endif /* ARTLUX_SYPHON_SHIM_H */
