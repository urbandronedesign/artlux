// Shared file-path → blob-URL cache for the sandboxed renderer. Asset paths stored in a
// project are absolute file paths; the renderer can't read them directly, so it asks main
// for the bytes (IPC) and wraps them in a Blob URL. Both the timeline engine and surface
// media use this so a given path is read once and reused.

const cache = new Map<string, string>(); // file path -> blob: url
// In-flight reads, keyed by path. This holds the PROMISE, not just the path: a concurrent caller
// must await the same read, not be told "busy". It used to be a Set<string>, and the second caller
// got `undefined` back — resolveMediaUrl then fell through to the raw absolute file path, which a
// sandboxed renderer cannot load. So two surfaces created against the same clip in one action left
// the second one permanently black. Exactly the case that shows up with one clip on several surfaces.
const loading = new Map<string, Promise<string | undefined>>();

// Already-usable urls (in-session blob/http/data) need no file read.
export const isLiveUrl = (url: string): boolean => /^(blob:|https?:|data:)/i.test(url);

export function mimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'mp4': case 'mov': case 'mkv': return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    case 'svg': return 'image/svg+xml';
    case 'wav': return 'audio/wav';
    case 'aiff': case 'aif': return 'audio/aiff';
    case 'flac': return 'audio/flac';
    case 'ogg': return 'audio/ogg';
    case 'mp3': return 'audio/mpeg';
    case 'aac': case 'm4a': return 'audio/aac';
    default: return 'application/octet-stream';
  }
}

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

// Resolve any media url to one an <video>/<img> can load: live urls pass through; file
// paths are read into a blob url (falls back to the raw path if the read fails).
export async function resolveMediaUrl(url: string, mime: string): Promise<string> {
  if (!url || isLiveUrl(url)) return url;
  return (await ensureBlobUrl(url, mime)) ?? url;
}
