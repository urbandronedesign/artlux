// HOW LONG EACH PIECE OF MEDIA TOOK TO BECOME USABLE — the one measurement the app never had.
//
// A cold open is dominated by media, and until now nothing recorded WHICH file spent the time. The
// boot gate could say "eight items never became ready" and `openTrace` could say the whole span was
// 15 s, but the question actually asked at a venue — *which video is making my show start slowly* —
// had no answer anywhere. The HAP probe alone was measured at ~3.2 s across one project, unattributed
// to any file.
//
// TWO SPANS, MEASURED WHERE THEY ACTUALLY HAPPEN, and they fail for different reasons:
//   · probeMs — codec identification. For HAP this is a NATIVE FILE OPEN, so it scales with the file
//     and with how fast the disk is; it is the span that punishes a project living on a slow share.
//   · openMs  — decoder construction, once the codec is known.
//
// …and a third, from a different place entirely:
//   · readyMs — how long a gate item took to become usable, which is what the venue actually waits
//     on. That is the boot gate's ledger, not a codec call, so it is reported separately rather than
//     joined: the gate's items are LABELS ("synthetic-00.mp4 (mp4-webcodecs)", "Surface Wall") and a
//     label is not a path. Guessing a join between them would produce a number that is wrong in
//     exactly the cases that matter — two clips of the same file, or a surface named after a file.
//
// ⚠ WHAT THIS DELIBERATELY DOES NOT INSTRUMENT: `surfaceFrame()`. It is called EVERY FRAME, per
// surface, and the honest way to catch a true "first frame" would be a check inside it. Even a Set
// lookup there is work on the hot path for a number the `readyMs` span already answers well enough.
// The rule this repo keeps is sample rates, log edges — and the edge here is available elsewhere.
//
// Nor does it stat the file for its size. That would be an IPC round trip per asset during the exact
// window this module exists to measure, which is a fine way to make the thing you are measuring
// slower. If bytes are ever wanted, they belong on main's existing READ_FILE accounting.

import { log } from './log';

interface Span {
  path: string;
  codec: string;
  probeMs?: number;      // the WORST observed, which is the one that describes the wait
  probeCalls?: number;
  probeFailed?: boolean;
  reported?: boolean;
}

// path → what we know so far. Cleared per open: a playlist machine opens many projects a night and
// last show's timings must not be attributed to this one.
const spans = new Map<string, Span>();

const base = (p: string): string => p.split(/[\\/]/).pop() || p;

/** A new project open. Called from openTrace.begin(), which is the same event by another name. */
export function reset(): void { spans.clear(); }

/**
 * Codec identification finished (or failed) — and for most media this IS the load.
 *
 * ⚠ It emits a record on success, which the first version of this module did not: it suppressed
 * probe-only paths on the theory that a probe with no `openSurface` after it was a thumbnail query.
 * That was wrong, and running it showed why. Only SURFACES go through `openSurface`; a timeline clip
 * loads through the fire-and-forget `preWarm`/`preWarmLayer` pair, so on a timeline-driven show the
 * probe was the only span anyone would ever measure — and it was the one being thrown away. HAP's
 * probe is a native file open measured at ~3.2 s across one project, which is precisely the number
 * this whole module exists to attribute to a filename.
 *
 * A codec answering "not mine" is still not attributed: several codecs may probe one file and only
 * the winner's time describes the load.
 */
export function noteProbe(path: string, codec: string, ms: number, ok: boolean): void {
  const s = spans.get(path) ?? { path, codec };
  s.codec = codec;
  if (ok) {
    // ONE RECORD PER FILE PER OPEN, not one per call.
    //
    // Running this against a real show found the same file probed FOUR times, all four issued in the
    // same millisecond with times of 62/44/28/3 ms — four concurrent callers awaiting one underlying
    // open, each timing from its own call. Four identical lines per file is noise in a venue log with
    // twenty videos, but the fact of it is information, so it is kept as a count rather than thrown
    // away. The WORST time is the one reported: that is what the show actually waited.
    s.probeCalls = (s.probeCalls ?? 0) + 1;
    s.probeMs = Math.max(s.probeMs ?? 0, ms);
    if (!s.reported) {
      s.reported = true;
      // Deferred a tick so concurrent callers are all counted before the record is written.
      setTimeout(() => {
        const cur = spans.get(path);
        if (!cur) return;
        log.info('media', 'media.probe', {
          file: base(path), path, codec,
          probeMs: Math.round(cur.probeMs ?? 0),
          ...(cur.probeCalls && cur.probeCalls > 1 ? { calls: cur.probeCalls } : {}),
        });
      }, 0);
    }
  } else {
    s.probeFailed = true;
  }
  spans.set(path, s);
}

/**
 * Decoder construction finished — the point at which this file's load is describable, so this is
 * where the record is emitted.
 *
 * Surfaces only — a timeline clip never reaches here (see noteProbe). The probe span is carried in
 * so a surface's record is the whole story in one line rather than two that must be joined.
 */
export function noteOpen(path: string, codec: string, ms: number, ok: boolean): void {
  const s = spans.get(path);
  const probeMs = s?.probeMs;
  const d: Record<string, unknown> = {
    file: base(path),
    path,
    codec,
    openMs: Math.round(ms),
    ...(probeMs !== undefined ? { probeMs: Math.round(probeMs) } : {}),
    ...(probeMs !== undefined ? { totalMs: Math.round(probeMs + ms) } : {}),
  };
  if (ok) log.info('media', 'media.load', d);
  // `false` from openSurface is not an error — it means "not this codec, fall back to a plain
  // <video>" — but it IS a cost the open paid, so it is recorded at debug rather than dropped.
  else log.debug('media', 'media.load', { ...d, ok: false, reason: 'codec declined' });
}

/** A codec threw. Rare, and always worth a line: a file that cannot decode is a hole in the show. */
export function noteError(path: string, codec: string, phase: 'probe' | 'open', err: unknown): void {
  log.error('media', 'media.error', { file: base(path), path, codec, phase }, err);
}

/**
 * Per-item readiness from the boot gate's ledger, reported in one record at the end of the wait.
 *
 * One record rather than one per item: a heavy project has dozens, they are only interesting
 * together (the question is always "what was slowest"), and they are already sorted here so the
 * answer is the first entry rather than a sort the reader has to do.
 */
export function reportReady(items: Array<{ label: string; ms: number; done: boolean }>): void {
  if (!items.length) return;
  const sorted = items.slice().sort((a, b) => b.ms - a.ms);
  log.info('media', 'media.ready', {
    count: sorted.length,
    slowestMs: Math.round(sorted[0]!.ms),
    items: sorted.slice(0, 30).map((i) => ({ label: i.label, ms: Math.round(i.ms), done: i.done })),
  });
}
