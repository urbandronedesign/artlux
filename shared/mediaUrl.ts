// THE MEDIA URL — one encoding, shared by all three processes.
//
// A sandboxed renderer cannot open a file path, so media used to be read WHOLE over IPC into a
// Uint8Array and wrapped in a Blob: a 1 GB HAP `.mov` measured 2.3 s of read, main RSS 125 MB → 3.7 GB
// and a 1.7 s event-loop stall, for a file the decoder wanted 4 MB of. `artlux-media://` replaces that
// with a privileged scheme main answers from a read stream, honouring HTTP Range — so Chromium's own
// demuxer reads the windows it needs and nothing holds the file in memory. See src/main/mediaProtocol.
//
// WHY BASE64URL AND NOT THE PATH. Chromium normalizes standard-scheme URLs: backslashes become
// forward slashes, `..` segments collapse, `%2e%2e` decodes, unicode is NFC-folded. A Windows path
// (`C:\show\assets\a.mov`) inside a URL path is a normalization minefield, and every one of those
// transformations is also a traversal primitive. Base64url contains nothing the URL parser will
// touch, so the path main decodes is byte-for-byte the path the renderer asked for — that removes a
// class of bug rather than defending against it. (The allowlist in main is still the authority; this
// just means it is checking what was actually meant.)

export const MEDIA_SCHEME = 'artlux-media';

// btoa/atob exist in the renderer; Buffer exists in main and preload. Both halves are here so the one
// module can be imported by all three without a bundler shim.
function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const b64urlEncode = (s: string): string =>
  toBase64(new TextEncoder().encode(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlDecode = (s: string): string => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return new TextDecoder().decode(fromBase64(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
};

/** An absolute file path → the URL a <video>/<img>/fetch can load. */
export const mediaUrl = (absPath: string): string => `${MEDIA_SCHEME}://f/${b64urlEncode(absPath)}`;

/** The inverse, for main's protocol handler. Returns null for anything that isn't one of ours. */
export function pathFromMediaUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== `${MEDIA_SCHEME}:`) return null;
    // `//f/<b64>` — the host is `f` and the path is `/<b64>`. Chromium lowercases the host of a
    // standard scheme, which is why the marker is a letter and not part of the payload.
    const encoded = u.pathname.replace(/^\//, '');
    if (!encoded) return null;
    const path = b64urlDecode(encoded);
    return path || null;
  } catch {
    return null;
  }
}

export const isMediaUrl = (url: string): boolean => !!url && url.startsWith(`${MEDIA_SCHEME}://`);

// Content types. Moved here from services/mediaCache so main (which must answer with one) and the
// renderer (which passes one to createImageBitmap/decodeAudioData) share a single table — it was
// already a pure function of the extension.
export function mimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'mp4': case 'mkv': return 'video/mp4';
    // .mov is served as video/quicktime, NOT video/mp4. A HAP .mov is claimed by the HAP codec and
    // never reaches a <video>; a non-HAP .mov falls back to one, and Chromium is stricter about a
    // mistyped container over a real network response than it was about a Blob.
    case 'mov': return 'video/quicktime';
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
