// Shared file-path → blob-URL cache for the sandboxed renderer. Asset paths stored in a
// project are absolute file paths; the renderer can't read them directly, so it asks main
// for the bytes (IPC) and wraps them in a Blob URL. Both the timeline engine and surface
// media use this so a given path is read once and reused.

const cache = new Map<string, string>(); // file path -> blob: url
const loading = new Set<string>();

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
    default: return 'application/octet-stream';
  }
}

// Synchronous lookup of an already-resolved blob url (undefined if not loaded yet).
export const getBlobUrl = (path: string): string | undefined => cache.get(path);

// Read a file's bytes via IPC and cache its blob url (idempotent; concurrent calls dedupe).
export async function ensureBlobUrl(path: string, mime: string): Promise<string | undefined> {
  if (!path) return undefined;
  const hit = cache.get(path);
  if (hit) return hit;
  if (loading.has(path)) return undefined;
  loading.add(path);
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
}

// Resolve any media url to one an <video>/<img> can load: live urls pass through; file
// paths are read into a blob url (falls back to the raw path if the read fails).
export async function resolveMediaUrl(url: string, mime: string): Promise<string> {
  if (!url || isLiveUrl(url)) return url;
  return (await ensureBlobUrl(url, mime)) ?? url;
}
