// One robust download, shared by every script that fetches a binary at build time.
//
// It exists because of a build that failed on 2026-08-07, and the way it failed is the whole point:
//
//   [redist] NDI Runtime: downloading… done (9.6 MB) → build\ndi\NDI-Runtime.exe
//   [redist] VC++ 2015-2022 x64 redistributable: downloading…
//   > artlux@0.25.2 fetch:opencv                       ← the NEXT script, in the same step
//
// No "done". No error. No stack. `fetch-redist.cjs` **exited 0** having written nothing, the `&&` in
// the workflow step happily ran the next command, and the missing file only surfaced four minutes
// later in `verify:resources`. The three fetch scripts had each hand-rolled this:
//
//   res.pipe(file);
//   file.on('finish', () => file.close(() => { fs.renameSync(tmp, dst); resolve(); }));
//   file.on('error', reject);
//   req.on('error', reject);
//
// which settles the promise on exactly four events — and a response that ends WITHOUT ending covers
// none of them. `.pipe()` calls `file.end()` only when the source emits 'end', so when the peer drops
// the connection mid-body the write stream never finishes, never errors, and the request (long since
// fully sent) never errors either. All four doors stay shut, the promise is abandoned, and — because
// `await` does not keep Node alive, only open handles do — the event loop drains and the process exits
// **0**. An unsettled promise is not an error; it is garbage. Node has nothing to report.
//
// (The socket-inactivity timeout is what proves it, incidentally: a pending timer is itself a handle,
// so a merely STALLED download would have sat there for the full timeout and then rejected. That build
// died in under a second, which means the socket was destroyed rather than idle, taking the last handle
// with it. And note an emitted 'error' was never the danger — an 'error' with no listener THROWS, which
// is loud, exits 1, and fails the step. Silence was the failure mode.)
//
// So this module settles on the one condition that actually matters — the byte stream did not complete —
// and `stream.pipeline()` is used precisely because it detects premature close, which `.pipe()` cannot.
//
// Three further rules, each one a bug the old code could produce:
//   • Write to `.part`, rename only after the size check. A truncated file must never appear at the
//     destination path, because every caller's "already present, skip" check would then accept it
//     forever. (`fetch-mediapipe-assets.cjs` piped straight to the final path and skipped on
//     `size > 0` — one dropped connection would have poisoned a pose model permanently.)
//   • Retry. These URLs are vendor CDNs on a shared-IP CI runner; a transient reset should cost seconds,
//     not a ten-minute rebuild of every platform.
//   • `process.exitCode = 1`, never `process.exit(1)` — see `fail()` at the bottom.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: sleep } = require('node:timers/promises');

const DEFAULTS = {
  attempts: 3,
  timeoutMs: 120_000, // socket INACTIVITY, not total duration — a 185 MB file is fine on a slow link
  minBytes: 0,        // a vendor CDN's error page is a valid 200 with a tiny body; size is the only tell
  maxRedirects: 10,
  label: '',          // prefix for the retry notice, e.g. 'redist'
  onProgress: null,   // (seen, total) — total is 0 when the server sends no content-length
};

// Follows redirects across BOTH schemes: aka.ms and ndi.link each bounce through http and https hops,
// so picking the module once from the original URL (as a bare https.get does) throws partway down.
// Resolves with the 200 response, still unread — the caller pipes it.
function open(url, o, depth = 0) {
  if (depth > o.maxRedirects) return Promise.reject(new Error(`too many redirects for ${url}`));
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { headers: { 'user-agent': 'artlux-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain, or the socket stays open
        let next;
        try { next = new URL(res.headers.location, url).toString(); }
        catch { return reject(new Error(`unusable redirect target "${res.headers.location}" from ${url}`)); }
        return open(next, o, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      resolve(res);
    });
    req.on('error', reject);
    // Left armed for the body transfer too: incoming data keeps resetting it, so it only fires on a
    // genuine stall, and destroying the request then surfaces on `res` as the pipeline's rejection.
    req.setTimeout(o.timeoutMs, () => req.destroy(new Error(`timed out after ${o.timeoutMs / 1000}s of silence fetching ${url}`)));
  });
}

// Download `url` to `dst`, atomically. Returns the byte size. Throws only after every attempt failed.
async function download(url, dst, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const tmp = `${dst}.part`;
  const tag = o.label ? `[${o.label}] ` : '';

  for (let attempt = 1; ; attempt++) {
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.rmSync(tmp, { force: true }); // a previous attempt's carcass
      const res = await open(url, o);
      const total = Number(res.headers['content-length'] || 0);

      // Byte counting goes through a Transform rather than a `res.on('data')` listener: attaching one
      // flips the stream into flowing mode, which races whatever consumer pipeline() attaches next.
      let seen = 0;
      const meter = new Transform({
        transform(chunk, _enc, cb) { seen += chunk.length; if (o.onProgress) o.onProgress(seen, total); cb(null, chunk); },
      });

      // The fix, in one line: pipeline() rejects on premature close, which .pipe() cannot detect.
      // It also destroys every stream in the chain on failure, so no socket is left holding the loop.
      try {
        await pipeline(res, meter, fs.createWriteStream(tmp));
      } catch (e) {
        // Node's own text for a dropped body is the bare word "aborted", which tells a reader of a CI
        // log nothing at all. How far it got is the diagnosis: 0 bytes is a dead link or a proxy, most
        // of the way through is a flaky CDN worth retrying.
        throw new Error(`transfer failed after ${seen} of ${total || '?'} bytes (${e.code || e.message})`);
      }

      const size = fs.statSync(tmp).size;
      if (size < o.minBytes) throw new Error(`got ${size} bytes, expected at least ${o.minBytes} — the URL likely served an error page`);
      if (total && size !== total) throw new Error(`got ${size} bytes, expected ${total} — the transfer was truncated`);

      fs.renameSync(tmp, dst); // atomic: the destination path never holds a partial file
      return size;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      if (attempt >= o.attempts) throw e;
      const wait = attempt * 2;
      console.log(`${tag}attempt ${attempt}/${o.attempts} failed: ${e.message} — retrying in ${wait}s`);
      await sleep(wait * 1000);
    }
  }
}

// Report a fatal error and mark the process failed WITHOUT calling process.exit().
//
// On Windows — the only platform any of this runs on in CI — stdout/stderr to a PIPE are asynchronous
// (they are synchronous on Linux and macOS). `console.error(msg); process.exit(1)` therefore tears the
// process down with the message still queued, and the operator gets a bare exit code with no reason.
// Setting exitCode lets the loop drain normally, which flushes.
function fail(prefix, err) {
  console.error(`${prefix} ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}

module.exports = { download, fail };
