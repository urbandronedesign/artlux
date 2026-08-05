// Shared file-path → blob-URL cache for the sandboxed renderer. Asset paths stored in a
// project are absolute file paths; the renderer can't read them directly, so it asks main
// for the bytes (IPC) and wraps them in a Blob URL.
//
// ⚠ THIS IS NO LONGER THE PATH FOR VIDEO OR IMAGES. Anything a <video>, <img> or a demuxer loads now
// goes through `artlux-media://` (shared/mediaUrl + src/main/mediaProtocol), which STREAMS with Range
// support instead of reading whole files into renderer memory — a 1 GB HAP `.mov` used to cost 2.3 s
// of read and take main's RSS from 125 MB to 3.7 GB for a few megabytes of actual want. What remains
// here is the handful of consumers that genuinely need the BYTES in hand: audio peak analysis
// (decodeAudioData), the audio conform hand-off, and GLB venue models (drei wants a URL).
//
// Note there is still no eviction and no revokeObjectURL — see the plan's phase 4. That was survivable
// only because the big consumers have left; do not bring one back.

import { mediaUrl, mimeForPath } from '../../../shared/mediaUrl';

const cache = new Map<string, string>(); // file path -> blob: url
// In-flight reads, keyed by path. This holds the PROMISE, not just the path: a concurrent caller
// must await the same read, not be told "busy". It used to be a Set<string>, and the second caller
// got `undefined` back — resolveMediaUrl then fell through to the raw absolute file path, which a
// sandboxed renderer cannot load. So two surfaces created against the same clip in one action left
// the second one permanently black. Exactly the case that shows up with one clip on several surfaces.
const loading = new Map<string, Promise<string | undefined>>();

// Already-usable urls (in-session blob/http/data, and our own streaming scheme) need no file read.
export const isLiveUrl = (url: string): boolean => /^(blob:|https?:|data:|artlux-media:)/i.test(url);

// The mime table moved to shared/mediaUrl so main — which must answer the media protocol with a
// Content-Type — and the renderer share one copy. Re-exported here because a dozen call sites import
// it from this module and the table is not what changed.
export { mimeForPath };

// Synchronous lookup of an already-resolved blob url (undefined if not loaded yet).
export const getBlobUrl = (path: string): string | undefined => cache.get(path);

// Read a file's bytes via IPC and cache its blob url (idempotent; concurrent calls share one read).
export function ensureBlobUrl(path: string, mime: string): Promise<string | undefined> {
  if (!path) return Promise.resolve(undefined);
  const hit = cache.get(path);
  if (hit) return Promise.resolve(hit);
  const inFlight = loading.get(path);
  if (inFlight) return inFlight; // join the existing read instead of failing this caller

  const read = (async () => {
    try {
      const bytes = await window.artlux?.readFile?.(path);
      if (bytes) {
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        cache.set(path, url);
        return url;
      }
    } catch { /* ignore */ } finally {
      loading.delete(path);
    }
    return undefined;
  })();

  loading.set(path, read);
  return read;
}

// Resolve any media url to one a <video>/<img> can load.
//
// SYNCHRONOUS NOW, and that is the point: a file path becomes an `artlux-media://` url by string
// construction, so there is no window in which a source "has not landed yet". That state used to be
// real and load-bearing — timeline.warmPoolVideos carried a long comment about a pool promoting on an
// element whose blob had not arrived, i.e. the show opening on black. It is now unrepresentable.
export function resolveMediaUrl(url: string): string {
  if (!url || isLiveUrl(url)) return url;
  return mediaUrl(url);
}
