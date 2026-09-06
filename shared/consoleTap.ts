// THE CONSOLE TAP — 253 log lines that already exist, given a durable home for free.
//
// Every subsystem in ArtLux already narrates itself: `[output] native Rust engine loaded`,
// `[watchdog] relaunch → render-stall`, `[open-trace] apply=412ms(+31) gate-armed=1840ms(+22)`. All of
// it goes to console, which means it is visible to a developer with DevTools open and to nobody else,
// ever. Rather than edit 253 call sites — and rather than ask every future one to remember — this
// wraps console once and lets the existing narration flow into the machine log.
//
// It is deliberately a WRAP, not a replacement: the original console call still happens first, so a
// terminal, DevTools and the CDP harnesses all behave exactly as before.
//
// THREE THINGS MAKE THIS SAFE, and each is load-bearing:
//
// 1. RATE LIMITING, because a console call CAN sit in a hot path. `fixtureSignal.ts` logs a throwing
//    subscriber inside its publish loop, and publish runs at frame rate — a subscriber that throws
//    every frame would otherwise write 60 records a second, forever. faultReporter already learned
//    this lesson for the same reason. A per-message budget is a structural answer; an allowlist of
//    "safe" call sites would be wrong the first time someone adds a line.
//
// 2. BOUNDED FORMATTING. `console.log('[x] state', bigObject)` must never deep-stringify its
//    arguments — that is the same trap that makes a naive action tap serialize the entire rig inside a
//    user gesture. Objects are summarized, never walked.
//
// 3. A RE-ENTRANCY GUARD. The logger itself calls console.warn when a sink degrades. Without the flag
//    that is an infinite loop that ends the process.
//
// Note on the frame-path invariant: `frameEngine.ts` and the live channels must never IMPORT the
// logger, and they do not — they call console, and this tap picks it up. That is not a loophole. The
// invariant exists to stop anyone DELIBERATELY logging per frame; the rate limiter is what makes the
// incidental case harmless.

export type TapLevel = 'error' | 'warn' | 'info' | 'debug';
export type TapEmit = (lv: TapLevel, cat: string, msg: string, extra?: Record<string, unknown>) => void;

// ── Tag → category ────────────────────────────────────────────────────────────────────────────
// The codebase already prefixes nearly every line with a `[subsystem]` tag. Reusing it means the log's
// categories match the vocabulary the source already speaks, rather than inventing a second one.

const PLUGIN_TAGS = new Set([
  'calib', 'calibration', 'show-control', 'audio', 'shader', 'spout', 'ndi', 'hap', 'hapGL',
  'mp4', 'mediapipe', 'augmenta', 'lidar', 'lidar-tracking',
]);

const ALIASES: Record<string, string> = {
  artnet: 'output', sacn: 'output', output: 'output', dmx: 'output',
  persistence: 'project', projectFolder: 'project', assets: 'project',
  'open-trace': 'open', boot: 'boot', plugins: 'boot', splash: 'boot', preload: 'boot',
  main: 'app', broadcast: 'app', artlux: 'app', headless: 'app',
  WebGPUMapper: 'engine', engine: 'engine', ProjectorGL: 'engine', scene3d: 'engine',
  enginePort: 'engine', hapGL: 'engine',
  watchdog: 'watchdog', metrics: 'metrics', osc: 'tracking', timeline: 'timeline',
  projector: 'projector', scene: 'scene', editor: 'editor', media: 'media',
  contentSource: 'media', 'fixture-profiles': 'fixture', 'fixture-library': 'fixture',
};

/** Pull a leading `[tag]` off the message and turn it into a category. */
function categorize(msg: string): { cat: string; rest: string } {
  const m = /^\[([A-Za-z0-9_.-]+)\]\s*/.exec(msg);
  if (!m) return { cat: 'app', rest: msg };
  const tag = m[1]!;
  const rest = msg.slice(m[0].length);
  if (PLUGIN_TAGS.has(tag)) return { cat: `plugin:${tag === 'calib' ? 'calibration' : tag}`, rest };
  const alias = ALIASES[tag];
  // An unmapped tag becomes its own category rather than a bucket: a new subsystem should show up in
  // the log under its own name the day it is written, not the day someone remembers to add it here.
  return { cat: alias ?? tag.toLowerCase(), rest };
}

// ── Argument formatting ───────────────────────────────────────────────────────────────────────

const MSG_CAP = 600;   // characters of assembled message kept
const OBJ_CAP = 160;   // characters of any one summarized object

/**
 * One argument → a short string. Never walks a structure deeply, never throws.
 *
 * An Error keeps its message here and its stack is lifted out separately by the caller, because a
 * stack belongs in `err`, not glued into the middle of a sentence.
 */
function fmt(a: unknown): string {
  if (a === null) return 'null';
  if (a === undefined) return 'undefined';
  const t = typeof a;
  if (t === 'string') return a as string;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(a);
  if (a instanceof Error) return a.message;
  if (t === 'function') return '[fn]';
  try {
    const s = JSON.stringify(a);
    if (!s) return String(a);
    return s.length > OBJ_CAP ? s.slice(0, OBJ_CAP) + '…' : s;
  } catch {
    return Array.isArray(a) ? `[array ${(a as unknown[]).length}]` : '[object]';
  }
}

// ── Secret redaction ──────────────────────────────────────────────────────────────────────────
// THE ONE THING THAT MUST NEVER REACH THE LOG.
//
// The design promise is that secrets are never written at source. Adopting 253 existing console lines
// quietly breaks that promise, because those lines were written for a developer watching a terminal,
// not for a file someone might email. The show-control plugin prints `tablet server at http://… (pin
// 7829)` at startup — found by reading this feature's own output, which is exactly how it would have
// been found by an operator, later, in a log they had already sent to somebody.
//
// So the guard lives HERE rather than at each call site: a tap that adopts every line, present and
// future, has to assume the next line it adopts will contain something it should not keep. Redacting
// at the source line as well is right, but it can only ever fix the lines someone remembered.
const SECRETS: Array<[RegExp, string]> = [
  [/\b(pin)\b(\s*[:=]?\s*)(\d{3,})/gi, '$1$2••••'],
  [/\b(password|passcode|secret|token|apikey|api[-_ ]?key)\b(\s*[:=]?\s*)(\S+)/gi, '$1$2••••'],
];

function redact(s: string): string {
  let out = s;
  for (const [re, to] of SECRETS) out = out.replace(re, to);
  return out;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────────────────────

const WINDOW_MS = 10_000; // budget window per distinct message
const BUDGET = 5;         // records allowed per key per window

interface Bucket { count: number; suppressed: number; until: number }
const buckets = new Map<string, Bucket>();

/**
 * Should this line be recorded, and how many of its siblings were dropped since we last said?
 *
 * Keyed on level + category + the first 60 characters, so a message whose tail varies (an id, a path,
 * a duration) still shares one budget. Otherwise a per-frame line with a changing number in it would
 * defeat the limiter completely — which is exactly the shape the hot-path cases take.
 */
function admit(key: string, now: number): { ok: boolean; suppressed: number } {
  let b = buckets.get(key);
  if (!b || now >= b.until) {
    const suppressed = b ? b.suppressed : 0;
    b = { count: 0, suppressed: 0, until: now + WINDOW_MS };
    buckets.set(key, b);
    // Keep the map from growing without bound on a long unattended run.
    if (buckets.size > 500) for (const [k, v] of buckets) { if (now >= v.until) buckets.delete(k); }
    b.count = 1;
    return { ok: true, suppressed };
  }
  if (b.count < BUDGET) { b.count++; return { ok: true, suppressed: 0 }; }
  b.suppressed++;
  return { ok: false, suppressed: 0 };
}

// ── Installation ──────────────────────────────────────────────────────────────────────────────

const LEVELS: Array<[keyof Console, TapLevel]> = [
  ['error', 'error'], ['warn', 'warn'], ['info', 'info'], ['log', 'info'], ['debug', 'debug'],
];

let installed = false;
let inside = false; // re-entrancy guard — the logger itself calls console.warn when a sink degrades

/**
 * Wrap console so every existing line also reaches the machine log. Returns an uninstaller.
 *
 * `should` is an optional cheap pre-filter (the level/category gate). It runs before any argument is
 * formatted, so a line the configuration does not want costs a regex and a map lookup — not a walk of
 * whatever was passed alongside it.
 *
 * Safe to call once per process; a second call is a no-op.
 */
export function installConsoleTap(emit: TapEmit, should?: (lv: TapLevel, cat: string) => boolean): () => void {
  if (installed) return () => { /* already tapped */ };
  installed = true;
  const c = console as unknown as Record<string, (...a: unknown[]) => void>;
  const originals: Record<string, (...a: unknown[]) => void> = {};

  for (const [method, lv] of LEVELS) {
    const key = method as string;
    const original = c[key];
    if (typeof original !== 'function') continue;
    originals[key] = original;
    c[key] = (...args: unknown[]): void => {
      original.apply(console, args);            // the terminal / DevTools behave exactly as before
      if (inside) return;                        // …and the logger's own warnings do not recurse
      inside = true;
      try {
        // ORDER MATTERS: categorize and rate-gate off the CHEAP head of the line, and only format the
        // remaining arguments once the record is known to be wanted. Formatting first would make a
        // suppressed hot-path line cost exactly as much as an admitted one, which defeats the point of
        // suppressing it.
        const head = typeof args[0] === 'string' ? (args[0] as string) : fmt(args[0]);
        const { cat, rest } = categorize(head);
        if (should && !should(lv, cat)) return;

        const gate = admit(`${lv}|${cat}|${rest.slice(0, 60)}`, Date.now());
        if (!gate.ok) return;

        let msg = rest;
        for (let i = 1; i < args.length && msg.length < MSG_CAP; i++) msg += ' ' + fmt(args[i]);
        if (msg.length > MSG_CAP) msg = msg.slice(0, MSG_CAP) + '…';
        msg = redact(msg);
        const err = args.find((a) => a instanceof Error) as Error | undefined;
        const extra: Record<string, unknown> = { msg };
        // Report the previous window's losses on the next line through, so a flood is visible in the
        // log rather than silently thinned.
        if (gate.suppressed) extra.suppressed = gate.suppressed;
        if (err?.stack) extra.stack = err.stack.slice(0, 1200);
        emit(lv, cat, msg, extra);
      } catch {
        /* the tap must never be the reason a console call throws */
      } finally {
        inside = false;
      }
    };
  }

  return () => {
    for (const [k, fn] of Object.entries(originals)) c[k] = fn;
    installed = false;
  };
}
