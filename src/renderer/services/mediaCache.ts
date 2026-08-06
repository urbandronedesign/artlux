// Media URL resolution for the sandboxed renderer.
//
// ── WHAT THIS USED TO BE, AND WHY IT ISN'T ────────────────────────────────────────────────────────
// This module was a path → blob-URL cache: asset paths in a project are absolute file paths, a
// sandboxed renderer cannot open one, so it asked main for the BYTES over IPC and wrapped them in a
// Blob. That worked and it did not scale. Measured on a 1 GB HAP `.mov`: 2.3 s of read, main RSS
// 125 MB → 3.7 GB, its event loop stalled 1.7 s — for a file the decoder wanted a few megabytes of.
// And the cache never evicted (there was no `revokeObjectURL` anywhere in the media path), which is
// the reason `src/main/watchdog.ts` recovers by RELAUNCHING the app rather than reloading it.
//
// Media now streams over `artlux-media://` (shared/mediaUrl + src/main/mediaProtocol): main answers
// HTTP Range requests from a read stream, so a `<video>`, an `<img>`, a demuxer or `fetch` pulls the
// byte windows it needs and nothing accumulates. Every consumer of the old blob path has moved, so
// the cache, its in-flight dedupe map and the eviction policy it never had are all deleted rather
// than fixed — measured across a 60-scene show, bytes over IPC went 887 MB → 0.
//
// ⚠ DO NOT REINTRODUCE A BLOB PATH FOR PICTURES OR SOUND. It looks harmless in dev (small files, warm
// page cache) and it is a venue-scale memory leak: guarded by `npm run verify:invariants`. The three
// consumers that legitimately still want BYTES in hand call `window.artlux.readFile` directly and own
// what they allocate — the audio conform hand-off (plugins/audio/conformClient), LiDAR take files
// (plugins/lidar-tracking/trackingTake) and GLB venue models. Peak analysis fetches over the scheme
// and lets the ArrayBuffer be collected after `decodeAudioData`.

import { mediaUrl, mimeForPath } from '../../../shared/mediaUrl';

// Already-usable urls (in-session blob/http/data, and our own streaming scheme) pass through
// untouched — a plugin content source may legitimately hand us one it created itself.
export const isLiveUrl = (url: string): boolean => /^(blob:|https?:|data:|artlux-media:)/i.test(url);

// The mime table lives in shared/ so main — which must answer the media protocol with a Content-Type
// — and the renderer cannot disagree about what a `.mov` is. Re-exported here because call sites
// import it from this module and the table is not what changed.
export { mimeForPath };

/**
 * Any media url a `<video>`, `<img>`, `fetch` or demuxer can load.
 *
 * SYNCHRONOUS, and that is load-bearing rather than incidental: a file path becomes a streaming url
 * by string construction, so there is no window in which a source "has not landed yet". That state
 * used to be real — `timeline.warmPoolVideos` carried a long comment about a standby pool promoting
 * on an element whose blob had not arrived, i.e. the show opening on black — and it is now
 * unrepresentable rather than merely handled.
 */
export function resolveMediaUrl(url: string): string {
  if (!url || isLiveUrl(url)) return url;
  return mediaUrl(url);
}
