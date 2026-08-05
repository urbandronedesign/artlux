// `artlux-media://` — media served as a STREAM instead of read whole into renderer memory.
//
// Before this, every clip crossed IPC as one Uint8Array and became a Blob: measured, a 1 GB HAP `.mov`
// took 2.3 s to read, pushed main's RSS from 125 MB to 3.7 GB and stalled its event loop for 1.7 s —
// and the decoder wanted a few megabytes of it. Worse, `mediaCache` never evicted (no
// revokeObjectURL anywhere in the media path), which is why the watchdog recovers by RELAUNCHING
// rather than reloading. A privileged scheme that answers HTTP Range from a read stream removes the
// whole shape: Chromium's demuxer asks for the byte windows it needs, main streams them, nothing
// accumulates.
//
// It also deletes a subtler hazard. With a blob URL, "the file has not been read yet" was a STATE the
// timeline had to carry — warmPoolVideos' most delicate comment describes a pool promoting on an
// element whose blob had not landed, i.e. the show starting on black. A src that is valid the instant
// it is constructed makes that state unrepresentable.
//
// ── THE THREE THINGS THAT MUST BE RIGHT ────────────────────────────────────────────────────────────
// 1. RANGE. `<video>.currentTime = t` is a Range request. Get this wrong and seeking silently
//    refetches from zero or never fires `seeked` — and warmPoolVideos + poolReadiness (the cold-start
//    gate) are built entirely on that seek.
// 2. CORS. Both <video> factories set `crossOrigin = 'anonymous'` — inert under `blob:` (same origin),
//    but under a custom scheme it makes every load a CORS request, and a response without
//    Access-Control-Allow-Origin fails outright: every video in the show, black. The attribute cannot
//    be dropped either — it is what keeps the frames UNTAINTED for canvas/WebGPU sampling, i.e. the
//    entire LED pipeline. So every response carries ACAO, including the 403.
// 3. ABORT. A scrubbing <video> issues and cancels ranges constantly. Without honouring
//    `req.signal`, each cancelled request leaks a file descriptor and the app dies of EMFILE within
//    minutes of normal timeline work.

import { protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { MEDIA_SCHEME, mimeForPath, pathFromMediaUrl } from '../../shared/mediaUrl';
import * as mediaAccess from './mediaAccess';

// MUST run at module scope, BEFORE app.whenReady() — Chromium fixes its scheme registry during
// startup, and registering late throws (or worse, silently yields a scheme with none of these
// privileges). `standard` gives it an origin so fetch/CORS behave; `stream` + `supportFetchAPI` make
// a ReadableStream body legal; `secure` keeps <video>/createImageBitmap from treating it as opaque.
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: false },
  }]);
}

// `bytes=a-b` | `bytes=a-` | `bytes=-n` (suffix). Returns null for absent/unsatisfiable/multi-range —
// callers then serve the whole file, which is always a legal answer to a range request.
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  let start: number, end: number;
  if (rawStart === '') {
    // Suffix form: the LAST n bytes. This is the one an mp4 demuxer uses to find a `moov` atom that
    // sits at the end of a non-faststart file, so it is not a theoretical branch.
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

// Every response, success or refusal, carries these. ACAO because of the crossOrigin note above;
// Accept-Ranges because a client that cannot see it will not attempt to seek.
const baseHeaders = (extra: Record<string, string>): Record<string, string> => ({
  'Access-Control-Allow-Origin': '*',
  'Accept-Ranges': 'bytes',
  ...extra,
});

const deny = (path: string, why: string, status: number): Response => {
  if (mediaAccess.noteDenied(path)) console.warn(`[media] ${why}: ${path}`);
  return new Response(null, { status, headers: baseHeaders({}) });
};

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    const path = pathFromMediaUrl(req.url);
    if (!path) return new Response(null, { status: 400, headers: baseHeaders({}) });
    if (!mediaAccess.isAllowed(path)) return deny(path, 'refused (not in the open project)', 403);

    let size: number;
    try {
      const st = await stat(path);
      if (!st.isFile()) return deny(path, 'not a file', 404);
      size = st.size;
    } catch {
      return deny(path, 'missing', 404);
    }

    const type = mimeForPath(path);
    const range = parseRange(req.headers.get('range'), size);
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;

    const stream = createReadStream(path, { start, end });
    // ⚠ THE FD LEAK GUARD. A scrubbing <video> cancels ranges constantly; without this each one leaks
    // a descriptor and the process dies of EMFILE during ordinary timeline work.
    const onAbort = () => stream.destroy();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    stream.once('close', () => req.signal?.removeEventListener('abort', onAbort));
    // A read error after the headers are out cannot be turned into a status — end the body instead of
    // leaving the renderer waiting on a stream that will never finish.
    stream.on('error', () => stream.destroy());

    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: range ? 206 : 200,
      headers: baseHeaders({
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
        // Media is immutable for a session and re-requested constantly (every seek). Letting Chromium
        // cache it is most of the benefit of streaming in the first place.
        'Cache-Control': 'private, max-age=3600',
      }),
    });
  });
}
