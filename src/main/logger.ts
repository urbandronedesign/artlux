// THE MACHINE LOG — one file per session, start to finish.
//
// A venue install runs unattended for days or weeks. When one misbehaves there has been no way to
// answer the four questions that actually get asked — what IS this machine, how long did the show take
// to load, which video cost that time, and what failed — even though the app already MEASURES most of
// it (openTrace, bootReport, bootGate, perfMonitor). All of that goes to console.log, which is visible
// to a developer with DevTools open and to nobody else, ever. This module is the durable home.
//
// ONE FILE = ONE RUN OF THE APP. A log opens with `session.start` and closes with `session.end`, and
// everything that happened in between is in it and nothing else is. That is the property the whole
// design is arranged around, because a log you have to reassemble from interleaved runs is one nobody
// reads. It also makes "did the last run end cleanly?" answerable by looking at the last line — and a
// file whose last line is NOT session.end is a run that died, which is exactly the case worth finding.
// `session.incomplete` says so on the next boot rather than leaving it to be noticed.
//
// ⚠ THE COST OF THAT CHOICE, AND WHY IT IS PAID DELIBERATELY. An earlier version shared one file
// across boots, because an unattended machine RELAUNCHES constantly (the watchdog self-heals, the
// playlist scheduler starts a clean process per show) and a file per boot made a count-based retention
// setting mean "ten boots", which on a bad night is an hour. One file per session brings that problem
// back, so retention can no longer be a file count alone: it is newest-N **and** an age limit **and** a
// total-size budget (see prune). Three limits, because any one of them alone has a case it gets wrong.
//
// Canonical design: plans/machine-logging.md. The three rules that shape everything below:
//
// 1. MAIN IS THE SINGLE WRITER. Renderers and projector windows ship batches over IPC.LOG_EVENT. N
//    processes appending to one file interleaves and corrupts it, and ArtLux routinely runs main +
//    editor + N projector windows.
//
// 2. NOTHING IS LOGGED AT FRAME RATE, and this module cannot enforce that — callers must. What it DOES
//    enforce is that the cost of logging is bounded by the CLOCK rather than by the event rate: one
//    flush per second no matter how much arrives, and a bounded queue that drops rather than grows.
//
// 3. NEVER SYNC, except in the quit path. `appendFileSync` on main's main thread blocks it — Art-Net
//    survives (the native pacer has its own thread) but IPC, the watchdog health timer and anything the
//    renderer awaits all stall behind it. And a venue project folder can be a USB stick or an SMB
//    share, where an append is ~1–20 ms nominal and can hang for SECONDS on a flaky link.
//
// TWO SINKS, AND THEY ARE NOT EQUALS.
//   · Sink A — `userData/logs/` — is the SINK OF RECORD. Local disk, always writable, per-machine by
//     definition, pruned. It never degrades, and the machine configuration is knowable before any
//     project exists, which is exactly when you need it (a venue PC that will not start has no project
//     folder to write to).
//   · Sink B — `<project>/logs/<machine>-<stamp>.log` — is BEST EFFORT, so a show folder carries its own
//     history. It attaches only when a project opens, which is LATER than the session start — so the
//     records from before that point are replayed into it (see `preamble`). Without that replay sink B
//     would open mid-story and would not be a complete session at all. If it stalls it is dropped and
//     sink A records that it was: a dead share costs one stalled write, not a growing buffer.
//
// ⚠ DEVIATION FROM THE PLAN, DELIBERATE: the plan specified one kept-open createWriteStream per sink;
// this uses `appendFile` (open → append → close) per flush instead. At one flush per second the extra
// syscalls are free, and it buys three things a long-lived handle does not: no stream back-pressure to
// manage, no handle to reopen, and — the reason that matters — no STALE HANDLE when a network share
// drops and comes back. appendFile simply starts working again.
//
// EVERYTHING HERE SWALLOWS. This module only ever runs when something else is already interesting; it
// must never be the thing that takes the app down.

import { app } from 'electron';
import { appendFile, appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import type { LogLevel, LogRecord, LoggingPrefs } from '../../shared/protocol';
import { installConsoleTap } from '../../shared/consoleTap';

// ── Configuration ─────────────────────────────────────────────────────────────────────────────

export const LOGGING_DEFAULTS: Required<Omit<LoggingPrefs, 'categories'>> & { categories: Record<string, LogLevel> } = {
  enabled: true,
  level: 'info',
  categories: {},
  projectSink: true,
  // A CEILING on one session, not a rotation point — rotating would split a session across files and
  // break the one property this module promises. Generous because a session is now the unit: a normal
  // venue night at `info` is a few hundred KB, and only a multi-day run at `debug` approaches this.
  maxFileMB: 32,
  maxFiles: 50,      // sessions kept locally…
  maxAgeDays: 30,    // …none older than this…
  maxTotalMB: 256,   // …and never more than this on disk in total.
  sessionKeep: 50,   // session files kept in a project's logs/
};

// Lower is more severe. A record passes when its rank is <= the configured level's rank.
const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

const QUEUE_CAP = 4096;   // records held before we start dropping the OLDEST
const FLUSH_MS = 1000;    // the paced flush
const FLUSH_AT = 256;     // …or this many records, whichever comes first
const STALL_MS = 5000;    // a write outstanding this long marks its sink degraded
// A BACKSTOP against an accidental payload, not a budget. It exists to catch the §2.3 trap — a tap
// that stringifies a whole rig — which is hundreds of KB, so 8 KB catches it with room to spare.
//
// ⚠ It was 1 KB, and that was wrong: `config.snapshot` is 2 KB of deliberate, bounded machine specs and
// the cap ate it, leaving `{_elided:true}` where the answer should have been. A record whose size is
// fixed by its own structure is not the thing this guard is for — hence BOUNDED_EVENTS below.
const PAYLOAD_CAP = 8192;
// Records whose payload is bounded BY CONSTRUCTION: a fixed set of machine fields, a fixed-length
// phase list, a capped item array. They can be large and are never unboundedly so.
const BOUNDED_EVENTS = /^(config\.|session\.|open\.trace$|open\.armed$|media\.ready$|boot\.)/;
const BOUNDED_CAP = 65536;
const PREAMBLE_CAP = 1 << 20; // 1 MB of pre-project records held for replay into sink B

// Events that must reach disk NOW rather than at the next tick. Batching loses the last ≤1 s in a
// crash, and that is precisely the second you care about.
const IMMEDIATE = /^(session\.|config\.|fault\.|watchdog\.|sink\.)/;

// ── State ─────────────────────────────────────────────────────────────────────────────────────

interface Sink {
  id: 'A' | 'B';
  dir: string;
  file: string;
  bytes: number;      // what we believe is on disk, so the ceiling needs no stat per flush
  degraded: boolean;  // stopped feeding it — it stalled, filled, or could not be opened
  inFlight: boolean;
  startedAt: number;
  pending: string;    // text accumulated while a write is in flight
}

let cfg = { ...LOGGING_DEFAULTS };
let sinkA: Sink | null = null;
let sinkB: Sink | null = null;
let queue: LogRecord[] = [];
let dropped = 0;      // records lost to back-pressure since the last time we said so
let seq = 0;          // per-process; a gap in this is how a reader knows records were lost
let runId = '';
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;
let ended = false;    // session.end has been written — later records would belong to no session

// THE SESSION SO FAR, held for replay into sink B when a project opens (see setProjectFolder).
// Bounded: if a session produces more than PREAMBLE_CAP before any project opens, the early part is
// dropped and sink B is told, rather than the buffer growing without limit on a machine that never
// opens one.
let preamble = '';
let preambleOverflow = false;
let preambleClosed = false;

const now = (): number => Math.round(performance.now());
const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
const sessionStamp = (d = new Date()): string =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** This machine's name, used in sink B's filename so one project folder can hold several machines. */
const machine = (): string => {
  try { return hostname().replace(/[^A-Za-z0-9._-]/g, '_') || 'machine'; } catch { return 'machine'; }
};

// ── Serialization ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON for one record, capped and never throwing.
 *
 * The cap is a BACKSTOP, not the mechanism. The real defence against a huge payload is that callers
 * summarize before they get here — `setFixtures(next)` takes the whole rig, and stringifying that
 * inside a user gesture is tens of milliseconds on the renderer main thread. If a payload arrives
 * oversized anyway we keep the record (the fact that it happened is the useful part) and replace `d`
 * with a marker rather than dropping the line or writing a megabyte.
 */
function serialize(r: LogRecord): string {
  try {
    let line = JSON.stringify(r);
    const cap = BOUNDED_EVENTS.test(r.ev) ? BOUNDED_CAP : PAYLOAD_CAP;
    if (r.d && line.length > cap + 512) {
      line = JSON.stringify({ ...r, d: { _elided: true, bytes: JSON.stringify(r.d).length } });
    }
    return line;
  } catch {
    // Circular or otherwise unserializable payload. Keep the event, lose the detail.
    try {
      return JSON.stringify({ ...r, d: { _unserializable: true } });
    } catch { return ''; }
  }
}

// ── Sinks ─────────────────────────────────────────────────────────────────────────────────────

function openSink(id: 'A' | 'B', dir: string, file: string): Sink | null {
  try {
    mkdirSync(dir, { recursive: true });
    return { id, dir, file, bytes: 0, degraded: false, inFlight: false, startedAt: 0, pending: '' };
  } catch {
    return null; // unwritable — the other sink (or nothing) carries on
  }
}

/** `artlux-<date>-<time>.log` — one per run of the app, never reused. */
const sessionFileName = (): string => `artlux-${sessionStamp()}.log`;

/**
 * Keep the local logs bounded by THREE limits, because each alone gets a case wrong.
 *
 * A count alone ("keep 50") is unbounded in bytes — a debug session can be enormous. A size budget
 * alone can evict this morning's crash because last night ran long. An age limit alone lets a relaunch
 * storm write thousands of files in a day. Newest-N, then age, then total bytes: whichever bites first.
 *
 * The CURRENT session's file is never a candidate — pruning the file being written is how a log loses
 * the run it was recording.
 */
function prune(dir: string, keepFile: string): void {
  try {
    const cutoff = Date.now() - cfg.maxAgeDays * 86_400_000;
    const files = readdirSync(dir)
      .filter((f) => /^artlux-.*\.log$/.test(f) && f !== keepFile)
      .map((f) => {
        const p = join(dir, f);
        let m = 0; let size = 0;
        try { const st = statSync(p); m = st.mtimeMs; size = st.size; } catch { /* vanished */ }
        return { p, m, size };
      })
      .sort((a, b) => b.m - a.m); // newest first

    let total = files.reduce((n, f) => n + f.size, 0);
    const budget = cfg.maxTotalMB * 1024 * 1024;
    files.forEach((f, i) => {
      const tooMany = i >= cfg.maxFiles - 1; // -1: the live session occupies one slot
      const tooOld = f.m < cutoff;
      const tooBig = total > budget;
      if (!tooMany && !tooOld && !tooBig) return;
      try { unlinkSync(f.p); total -= f.size; } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
}

/** Prune a project's logs/ to the newest N session files. */
function pruneSessions(dir: string, keepFile: string): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => /\.log$/.test(f) && f !== keepFile)
      .map((f) => ({ p: join(dir, f), m: (() => { try { return statSync(join(dir, f)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.m - a.m);
    files.slice(Math.max(0, cfg.sessionKeep - 1)).forEach((e) => { try { unlinkSync(e.p); } catch { /* ignore */ } });
  } catch { /* ignore */ }
}

/**
 * Hand text to one sink. Never blocks, never awaits, never throws.
 *
 * If a write is already in flight the text accumulates in `pending` and goes out with the next one —
 * so a slow sink coalesces rather than queueing unbounded writes at it. A write outstanding longer than
 * STALL_MS marks the sink degraded: we cannot cancel it, but we stop feeding it, which is what keeps a
 * dropped SMB share from turning into a growing memory buffer.
 */
function write(s: Sink | null, text: string): void {
  if (!s || s.degraded || !text) return;
  if (s.inFlight) {
    if (now() - s.startedAt > STALL_MS) { degrade(s, 'write stalled'); return; }
    s.pending += text;
    return;
  }
  const payload = s.pending + text;
  s.pending = '';
  // The session ceiling. NOT a rotation: splitting here would break "one file, one session", so the
  // file is closed with a marker and the session stops being recorded rather than continuing into a
  // second file that would claim to be a session of its own.
  if (s.bytes + payload.length > cfg.maxFileMB * 1024 * 1024) {
    const note = JSON.stringify({
      t: new Date().toISOString(), up: now(), lv: 'warn', cat: 'app', ev: 'log.truncated',
      proc: 'main', seq: seq++, d: { limitMB: cfg.maxFileMB, sink: s.id },
    }) + '\n';
    // Async like every other write on this path. A sync call here would be a stall on exactly the
    // sink most likely to be slow (see the module header) — and the marker is not worth blocking for.
    s.degraded = true; // set FIRST: the callback must not be able to re-enter this branch
    try { appendFile(join(s.dir, s.file), note, 'utf-8', () => { /* best effort */ }); } catch { /* ignore */ }
    return;
  }
  s.inFlight = true;
  s.startedAt = now();
  const target = join(s.dir, s.file);
  try {
    appendFile(target, payload, 'utf-8', (err) => {
      s.inFlight = false;
      if (err) { degrade(s, err.message); return; }
      s.bytes += payload.length;
      if (s.pending) { const p = s.pending; s.pending = ''; write(s, p); }
    });
  } catch (e) {
    s.inFlight = false;
    degrade(s, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Stop feeding a sink, and say so ON THE OTHER ONE. A silently-degraded sink is worse than no sink:
 * you would read the local log, see nothing about the project folder, and conclude nothing happened.
 */
function degrade(s: Sink, reason: string): void {
  if (s.degraded) return;
  s.degraded = true;
  s.pending = '';
  const other = s.id === 'B' ? sinkA : null; // sink A degrading has nowhere left to tell
  const rec = build('warn', 'app', 'sink.degraded', { sink: s.id, path: join(s.dir, s.file), reason });
  console.warn(`[logger] sink ${s.id} degraded: ${reason}`);
  if (other) write(other, serialize(rec) + '\n');
}

// ── Record construction ───────────────────────────────────────────────────────────────────────

function build(lv: LogLevel, cat: string, ev: string, d?: Record<string, unknown>, err?: unknown): LogRecord {
  const r: LogRecord = {
    t: new Date().toISOString(),
    up: now(),
    lv,
    cat,
    ev,
    proc: 'main',
    seq: seq++,
    ...(runId ? { run: runId } : {}),
    ...(d ? { d } : {}),
  };
  if (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    r.err = { message: e.message, ...(e.stack ? { stack: e.stack } : {}) };
  }
  return r;
}

/** Is this record wanted at the configured verbosity? Category overrides beat the global floor. */
function passes(lv: LogLevel, cat: string): boolean {
  if (!cfg.enabled) return false;
  const override = cfg.categories[cat] ?? cfg.categories[cat.split(':')[0]!];
  return RANK[lv] <= RANK[override ?? cfg.level];
}

/**
 * Did the previous session end cleanly?
 *
 * A file whose last record is not `session.end` describes a run that was killed, crashed, or was
 * relaunched by a path that skipped the quit handler — and that is exactly the run someone will want
 * to look at. Reported once, on the next boot, naming the file, so the question never has to be asked
 * by hand. Only the tail is read: these files can be megabytes and this runs during startup.
 */
function reportPreviousSession(dir: string, keepFile: string): void {
  try {
    const prev = readdirSync(dir)
      .filter((f) => /^artlux-.*\.log$/.test(f) && f !== keepFile)
      .map((f) => ({ f, p: join(dir, f), m: (() => { try { return statSync(join(dir, f)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.m - a.m)[0];
    if (!prev) return;
    const buf = readFileSync(prev.p, 'utf-8');
    const tail = buf.slice(-4096).trim().split('\n').filter(Boolean);
    const last = tail.length ? tail[tail.length - 1]! : '';
    if (last.includes('"ev":"session.end"')) return;
    log('warn', 'app', 'session.incomplete', {
      file: prev.f,
      hint: 'the previous run wrote no session.end — it crashed, was killed, or relaunched',
    });
  } catch { /* ignore */ }
}

// ── Public API ────────────────────────────────────────────────────────────────────────────────

/**
 * Start the writer and open the session.
 *
 * `session` is written HERE, as the file's first record, rather than by the caller — the guarantee
 * that a log opens with session.start is this module's to keep, and a caller that logged it a moment
 * later would put anything emitted in between (the previous-session check, a plugin's first warning)
 * ahead of it. Which is exactly what happened the first time this was wired.
 */
export function start(prefs?: LoggingPrefs, session?: Record<string, unknown>): void {
  cfg = { ...LOGGING_DEFAULTS, ...(prefs || {}), categories: { ...(prefs?.categories || {}) } };
  if (started) return;
  started = true;
  if (!cfg.enabled) return;
  let file = '';
  try {
    const dir = join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    file = sessionFileName();
    sinkA = openSink('A', dir, file);
    prune(dir, file);
  } catch { /* no local sink — the app still runs */ }
  timer = setInterval(() => flush(), FLUSH_MS);
  timer.unref?.();
  // Adopt the ~253 console lines the app already writes. See shared/consoleTap.ts — the gate runs
  // before any argument is formatted, and a hot-path line is rate-limited rather than blocked, so no
  // existing call site had to be touched or audited for safety.
  installConsoleTap(
    (lv, cat, _msg, extra) => log(lv, cat, 'log.console', extra),
    (lv, cat) => passes(lv, cat),
  );
  // FIRST record, always. Then — and only then — the verdict on the previous run.
  log('info', 'app', 'session.start', session ?? {});
  if (sinkA && file) reportPreviousSession(sinkA.dir, file);
}

/**
 * Point sink B at a project folder (or clear it with null).
 *
 * THE REPLAY IS THE POINT. A project opens well after the app starts, so a sink attached here would
 * otherwise begin mid-story — no session.start, no machine configuration, none of the plugin load
 * results — and would not be a complete session at all. Everything written so far is replayed into the
 * new file first, so both sinks tell the same whole story.
 */
export function setProjectFolder(root: string | null): void {
  if (!started || ended || !cfg.enabled) return;
  if (sinkB) { flush(); sinkB = null; }
  if (!root || !cfg.projectSink) return;
  const dir = join(root, 'logs');
  const file = `${machine()}-${sessionStamp()}.log`;
  sinkB = openSink('B', dir, file);
  if (!sinkB) return;
  pruneSessions(dir, file);
  if (preambleOverflow) {
    write(sinkB, JSON.stringify(build('warn', 'app', 'log.replayTruncated', {
      hint: 'this session was long before the project opened; its earliest records are only in the machine log',
    })) + '\n');
  }
  if (preamble) write(sinkB, preamble);
  preambleClosed = true;
  preamble = '';
}

/** The correlation id every subsequent record carries, minted per project open. */
export function setRun(id: string): void { runId = id; }
export function getRun(): string { return runId; }

/** Emit one record from the main process. */
export function log(lv: LogLevel, cat: string, ev: string, d?: Record<string, unknown>, err?: unknown): void {
  if (!started || ended || !passes(lv, cat)) return;
  enqueue(build(lv, cat, ev, d, err));
}

/**
 * Accept a batch shipped from another process.
 *
 * Their `seq`, `proc` and clocks are THEIRS and are preserved — renumbering here would destroy the one
 * property that makes a gap meaningful. Level gating already happened at the source (it is cheaper
 * there, and it keeps the record off the IPC bus entirely), so these are written as they arrive.
 */
export function ingest(records: LogRecord[]): void {
  if (!started || ended || !cfg.enabled || !Array.isArray(records)) return;
  for (const r of records) if (r && typeof r.ev === 'string') enqueue(r);
}

/**
 * Queue one record, dropping the OLDEST if we are over capacity.
 *
 * Dropping the oldest rather than the newest is deliberate: when a burst overruns the writer, the
 * records that explain what is happening NOW are worth more than the ones that describe how it began.
 * The count is surfaced as `log.dropped` so the loss is never silent — that plus the per-process `seq`
 * is what keeps the log honest about its own gaps.
 */
function enqueue(r: LogRecord): void {
  if (queue.length >= QUEUE_CAP) { queue.shift(); dropped++; }
  queue.push(r);
  if (queue.length >= FLUSH_AT || IMMEDIATE.test(r.ev) || r.lv === 'error') flush();
}

/**
 * Write everything queued.
 *
 * `sync` is for the quit path ONLY, where blocking is acceptable and losing the last second is not.
 * Everywhere else this is fire-and-forget; see the module header for why sync is otherwise banned.
 */
export function flush(sync = false): void {
  if (!queue.length && !dropped) return;
  if (dropped) {
    // Say so IN the stream, at the point the loss happened, rather than in a counter nobody reads.
    queue.push(build('warn', 'app', 'log.dropped', { count: dropped }));
    dropped = 0;
  }
  const batch = queue;
  queue = [];
  let text = '';
  for (const r of batch) { const line = serialize(r); if (line) text += line + '\n'; }
  if (!text) return;
  // Hold the session so far, for replay into a project sink that has not attached yet.
  if (!preambleClosed) {
    if (preamble.length + text.length > PREAMBLE_CAP) preambleOverflow = true;
    else preamble += text;
  }
  if (sync) {
    for (const s of [sinkA, sinkB]) {
      if (!s || s.degraded) continue;
      try { appendFileSync(join(s.dir, s.file), s.pending + text, 'utf-8'); s.pending = ''; } catch { /* ignore */ }
    }
    return;
  }
  write(sinkA, text);
  write(sinkB, text);
}

/**
 * Close the session: write `session.end` and flush synchronously.
 *
 * ⚠ MUST be called on EVERY path out of the process, not only `before-quit`. The relaunch paths
 * (`app.relaunch(); app.exit(0)` in main/index.ts and main/watchdog.ts) skip before-quit entirely, and
 * an unattended machine takes those paths far more often than it is ever quit by hand — so leaving
 * them uninstrumented would mean the sessions that matter most are exactly the ones with no end
 * marker. Idempotent: a relaunch that also triggers before-quit is safe.
 */
export function shutdown(reason: string, extra?: Record<string, unknown>): void {
  if (!started || ended) return;
  log('info', 'app', 'session.end', { reason, uptimeSec: Math.round(now() / 1000), ...(extra || {}) });
  ended = true; // after this, late records would belong to no session and are refused
  if (timer) { clearInterval(timer); timer = null; }
  flush(true);
}

/** Where the local log is, for anyone asked to go and read it. */
export function logDir(): string | null {
  try { return join(app.getPath('userData'), 'logs'); } catch { return null; }
}
