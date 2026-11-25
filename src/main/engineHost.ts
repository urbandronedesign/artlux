import { app, BrowserWindow } from 'electron';
import { IPC, WINDOWED_DISPLAY } from '../../shared/protocol';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import * as logger from './logger';
import { getPrefs, setPrefs } from './persistence';
import * as output from './transport/outputManager';
import { screen } from 'electron';
import { setProjectorsCovered, windowedContent, placeWindowed, closeWindowedByOperator, onWindowedPlaced } from './projector';
import type { OutputConfig, EngineView3dPlace } from '../../shared/protocol';

// THE NATIVE ENGINE AS ARTLUX'S CHILD (plans/native-engine.md §9c, E1a). E6e: ON BY DEFAULT ON WINDOWS — the
// platform where it draws everything the app's output does (E6f closed the projector refusals there); OFF elsewhere
// (macOS: no MP4 decode, camera, Syphon or bake encode in the engine yet — E6g). See `decide()` for the switches.
// Off, nothing here runs and the app is exactly what it was. On, the app's own path is still the per-surface /
// per-output FALLBACK: anything the engine refuses, it refuses with a reason and the app keeps it.
//
// What main does for it — the engine's WATCHDOG RUNG:
//   - spawns `artlux-engine --serve` (engine/artlux-engine/src/serve.rs) and waits for its `hello`;
//   - pings it every second; an engine that stops answering is HUNG and is killed — a hang is worse than
//     a crash, because a hung output looks alive;
//   - restarts it after a crash or a kill, within a second (RESTART_DELAY_MS), the document untouched: it
//     lives in the Show Host, not in the engine;
//   - gives up after RESTART_LIMIT deaths in a minute rather than forking in a tight loop (the Show Host's
//     rule), and does NOT restart an engine that REFUSED to start (exit 2: no usable hardware adapter —
//     it would only refuse again);
//   - logs every transition to the machine log (category `engine`), which is how a venue tech finds out.
// The engine never outlives the app: its stdin is our pipe, and it exits when that closes.
//
// E1f — THE LIVE LINK. The renderer's frame engine keeps evaluating the show and sends the EFFECTIVE
// document (when it changes) and one tick per frame (src/renderer/engine/nativeLink.ts); main relays both,
// plus the output settings, to the engine. The engine answers each document with whether it OWNS the wire
// for it (runtime.rs: all or nothing). While it does, the app's own frames are recorded but NOT sent
// (outputManager.setWireOwner) — one sender, never two. The moment the engine dies, hangs or refuses a
// document, ownership is false again and the app's next frame goes out: the app's path IS the fallback.
// A restarted engine is handed the last output settings and document at once.

/**
 * E6e — IS THE NATIVE ENGINE ON FOR THIS RUN, and which switch said so. In order, the first that speaks wins:
 *   1. `--no-native-engine` or ARTLUX_NATIVE_ENGINE=0 — off (a test's app-side reference; a tech's way out);
 *   2. `--native-engine` or ARTLUX_NATIVE_ENGINE=1 — on (any platform: a developer, a test);
 *   3. not Windows — off (E6g);
 *   4. Preferences ▸ Engine ▸ Native output engine off (`Prefs.nativeEngineOff`, per MACHINE) — off;
 *   5. otherwise ON.
 * Decided ONCE, on first use (after app ready — the prefs are readable then), for the whole run: the switch takes
 * effect at the next launch, never mid-show.
 */
function decide(): { on: boolean; why: string } {
  if (process.argv.includes('--no-native-engine')) return { on: false, why: '--no-native-engine' };
  if (process.env.ARTLUX_NATIVE_ENGINE === '0') return { on: false, why: 'ARTLUX_NATIVE_ENGINE=0' };
  if (process.argv.includes('--native-engine')) return { on: true, why: '--native-engine' };
  if (process.env.ARTLUX_NATIVE_ENGINE === '1') return { on: true, why: 'ARTLUX_NATIVE_ENGINE=1' };
  if (process.platform !== 'win32') return { on: false, why: `not on ${process.platform} yet` };
  if (getPrefs().nativeEngineOff === true) return { on: false, why: 'turned off in Preferences' };
  return { on: true, why: 'the default on Windows' };
}
let decided: { on: boolean; why: string } | null = null;
const flag = (): boolean => (decided ??= decide()).on;
/** Why the engine is on or off for this run (the machine log, Preferences). */
export function nativeEngineWhy(): string { return (decided ??= decide()).why; }
// E3m: the SOUND from the engine too (its JUCE, artlux_audio.dll) — only with the engine, and only when asked.
const audioFlag = (): boolean => flag() && (process.argv.includes('--engine-audio') || process.env.ARTLUX_ENGINE_AUDIO === '1');
/** Does plugins/audio play through the native engine (E3m) rather than its own addon? */
export function engineAudioEnabled(): boolean { return audioFlag(); }
/** Is the native engine on for this run (see decide())? */
export function nativeEngineEnabled(): boolean { return flag(); }
const RESTART_DELAY_MS = 200;
const RESTART_LIMIT = 5;
const HELLO_TIMEOUT_MS = 10_000;   // opening the GPU device on a cold machine can take a few seconds
const PING_MS = 1000;
const PONG_TIMEOUT_MS = 3000;
const EXIT_REFUSED = 2;

export type EngineState = 'off' | 'starting' | 'up' | 'restarting' | 'refused' | 'gave-up' | 'missing';
export interface EngineStatus {
  state: EngineState;
  pid: number | null;
  adapter: string | null;
  /** Engine starts since the app started (1 = never restarted). */
  starts: number;
  lastExit: string | null;
}

const status: EngineStatus = { state: 'off', pid: null, adapter: null, starts: 0, lastExit: null };
let child: ChildProcess | null = null;
let stopping = false;
const deaths: number[] = [];
let pingTimer: NodeJS.Timeout | null = null;
let helloTimer: NodeJS.Timeout | null = null;
// The live link (E1f). `owns` is for ONE document revision and ONE engine process.
let lastDoc: string | null = null;      // the renderer's JSON, as sent
let lastDocRev = -1;
// The renderer's JSON BEFORE main added to it (display bounds, a windowed output's rect, a reason). A document
// re-sent because something main knows changed is rebuilt from THIS: rebuilt from `lastDoc` it kept the reason
// main had added the first time (a calibration map "still being handed over", a window "not open yet"), and the
// engine went on refusing an output whose reason was gone.
let lastDocRaw: string | null = null;
let lastOutput: string | null = null;
let owns: { rev: number; pid: number | null } | null = null;
let lastWhy = '';
// ⚠ LIVENESS IS "IT IS SENDING", NOT "IT IS ALIVE". The engine reports each frame it put on the wire; the
// app is muted only while those reports are fresh. A killed engine is seen by its exit (23 ms measured),
// but a render thread that stalls or fails while the stdin reader still answers pings never exits and
// never misses a pong — only the missing frames reveal it.
// (A first measurement blamed a 2.5 s handback on Windows' exit signal; it was MAIN blocked by the audio
// engine's synchronous start-up — see plans/native-engine.md E1f-1.)
const SENT_FRESH_MS = 250;
let lastSentAt = 0;
// WHAT THE ENGINE PUT ON THE WIRE, for the operator. While the engine owns the wire the app's own sender is
// muted, so its stats (the status bar's LIVE, the Prometheus pps gauge) read zero packets on a show that is
// running perfectly — the bar said READY, which an operator reads as "no output". Each `sent` carries the
// engine sender's own counters (the same output core as the app's, so the same meaning: packets/s, frames/s
// including keep-alive, universes) plus the running totals of frames drawn and ticks dropped by coalescing.
let sentFrames = 0, sentDropped = 0;
let sentWire = { pps: 0, fps: 0, universes: 0 };
let dropLog = { at: 0, dropped: 0, frames: 0 };
const DROP_LOG_MS = 60_000;
// A dropped tick is a frame the host asked for and the engine never drew (it was replaced by a newer one
// while the previous frame was still rendering). A few percent is jitter (measured ~5% at the default 30 Hz
// engineFps on the RTX box); beyond this share of a minute's ticks the engine is genuinely too slow.
const DROP_LOG_SHARE = 0.1;

// E6h — THE HOLD FILE (engine hold.rs): the engine keeps its last frame on the wire there; main reads it when that
// engine dies and holds it on the wire (outputManager.hold) until the wire has a live sender again. One per app
// process. The layout is hold.rs's: a 64-byte header (magic, seq, slot, len, fnv1a-32) and two 4 MB slots.
const HOLD_HEAD = 64, HOLD_CAP = 4 << 20;
let holdPath: string | null = null;
function holdFile(): string {
  if (!holdPath) {
    const dir = join(app.getPath('temp'), 'artlux-native-engine');
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    holdPath = join(dir, `hold-${process.pid}.bin`);
  }
  return holdPath;
}
function fnv1a32(b: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
/** The dead engine's last frame, or null if there is none or it does not verify (never a torn frame on a node). */
function readHold(): Uint8Array | null {
  if (!holdPath) return null;
  let fd = -1;
  try {
    fd = openSync(holdPath, 'r');
    const head = Buffer.alloc(HOLD_HEAD);
    if (readSync(fd, head, 0, HOLD_HEAD, 0) !== HOLD_HEAD || head.toString('latin1', 0, 8) !== 'ALHOLD01') return null;
    const slot = head.readUInt32LE(16), len = head.readUInt32LE(20), sum = head.readUInt32LE(24);
    if (slot > 1 || len <= 4 || len > HOLD_CAP) return null;
    const body = Buffer.alloc(len);
    if (readSync(fd, body, 0, len, HOLD_HEAD + slot * HOLD_CAP) !== len || fnv1a32(body) !== sum) return null;
    return new Uint8Array(body.buffer, body.byteOffset, len);
  } catch { return null; } finally { if (fd >= 0) try { closeSync(fd); } catch { /* gone */ } }
}
/** An engine that OWNED the wire is gone: hold its last frame there until the wire has a live sender again. */
function holdWire(why: string): void {
  const f = readHold();
  const held = !!f && output.hold(f);
  logger.log(held ? 'info' : 'warn', 'engine', held ? 'wire-held' : 'wire-not-held', { why, bytes: f?.length ?? 0 });
  console.log(held ? `[engine] holding its last frame on the wire (${why})` : `[engine] no last frame to hold (${why})`);
}

function setOwns(next: { rev: number; pid: number | null } | null, why: string): void {
  const was = !!owns;
  owns = next;
  // E6h: a (re)started engine owns the wire — main's held frame lets go (one sender, never two).
  if (next && !was) output.releaseHold();
  if (was !== !!next || why !== lastWhy) {
    logger.log('info', 'engine', next ? 'owns-wire' : 'app-has-wire', next ? { rev: next.rev } : { why });
    console.log(next ? `[engine] owns the wire (document ${next.rev})` : `[engine] the app keeps the wire: ${why}`);
  }
  lastWhy = why;
}
/** Does the engine drive the wire right now? (False whenever in doubt: the app's frames then go out.) */
export function engineOwnsWire(): boolean {
  // ⚠ A NEW DOCUMENT IS NOT A HANDBACK. Requiring the answer for the LATEST revision unmuted the app in the
  // gap between a document change and the engine's answer — and the engine was still sending, so both did
  // (measured: an NDI frame arriving auto-fits its surface, a new document, two senders for a moment). While
  // that answer is pending, an engine that owned the previous revision keeps the wire; "sent" freshness still
  // guards it, and a refusal hands it back at once.
  const current = !!owns && (owns.rev === lastDocRev || answeredRev !== lastDocRev);
  return current && !!child && owns!.pid === (child.pid ?? null) && status.state === 'up'
    && Date.now() - lastSentAt < SENT_FRESH_MS;
}
let answeredRev = -1;

/** The engine sender's throughput while the engine owns the wire (null otherwise: the app's sender is the
 *  truth then). Called once a second by the stats poll, which also gives the drop check its clock. */
export function engineWireStats(): { fps: number; universes: number; pps: number } | null {
  const now = Date.now();
  if (now - dropLog.at >= DROP_LOG_MS) {
    // The counters restart with every engine process — a lower count is a new engine, not negative frames.
    const d = sentDropped - dropLog.dropped, f = sentFrames - dropLog.frames;
    if (dropLog.at && d > 0 && f >= 0 && d / (d + f) > DROP_LOG_SHARE) {
      logger.log('warn', 'engine', 'ticks-dropped', { dropped: d, frames: f, seconds: Math.round((now - dropLog.at) / 1000) });
      console.warn(`[engine] dropped ${d} of ${d + f} tick(s) in the last minute — frames take longer than the tick interval`);
    }
    dropLog = { at: now, dropped: sentDropped, frames: sentFrames };
  }
  return engineOwnsWire() ? { ...sentWire } : null;
}

// Item 3: CALIBRATION MAPS as files. The renderer sends each map once (~10 MB); main writes it where the engine
// can read it and the document names it by key — so a document change never re-ships a map.
const bakedFiles = new Map<string, { w: number; h: number; uv: string; alpha?: { w: number; h: number; file: string } }>();
export function noteBakedMap(key: string, w: number, h: number, uv: Float32Array, alpha: { w: number; h: number; data: Uint8Array } | null): void {
  if (!flag()) return;
  const dir = join(app.getPath('temp'), 'artlux-native-engine');
  try {
    mkdirSync(dir, { recursive: true });
    const surface = key.replace(/-\d+$/, '');
    for (const [k, f] of bakedFiles) if (k.replace(/-\d+$/, '') === surface) { try { unlinkSync(f.uv); if (f.alpha) unlinkSync(f.alpha.file); } catch { /* gone */ } bakedFiles.delete(k); }
    const safe = key.replace(/[^\w.-]/g, '_');
    const uvFile = join(dir, `${safe}.uv`);
    writeFileSync(uvFile, Buffer.from(uv.buffer, uv.byteOffset, uv.byteLength));
    let a: { w: number; h: number; file: string } | undefined;
    if (alpha?.data) { const af = join(dir, `${safe}.alpha`); writeFileSync(af, Buffer.from(alpha.data.buffer, alpha.data.byteOffset, alpha.data.byteLength)); a = { w: alpha.w, h: alpha.h, file: af }; }
    bakedFiles.set(key, { w, h, uv: uvFile, ...(a ? { alpha: a } : {}) });
    // A document already sent with this key was waiting for the file: send it again, now complete.
    if (lastDocRaw && lastDocRaw.includes(`"key":"${key}"`)) noteDoc(lastDocRaw, lastDocRev);
  } catch (e) { logger.log('warn', 'engine', 'baked-map-write-failed', { key }, e); }
}

// E2: PICTURES THE APP DRAWS AND THE ENGINE SHOWS (`raster` sources — TEXT first, plans/native-engine.md §2
// "phase 1: the app rasterises, the engine receives an image on change"). The renderer ships a surface's
// pixels when its generation changes; main writes them where the engine can read them and tells it. One file
// per surface and generation, the previous one removed once the next is announced. The last message per
// surface is kept: a restarted engine is given every raster BEFORE the document that names them.
const rasterMsgs = new Map<string, { msg: string; file: string }>();
export function noteRaster(surfaceId: string, gen: number, w: number, h: number, rgba: Uint8Array): void {
  if (!flag()) return;
  const dir = join(app.getPath('temp'), 'artlux-native-engine');
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `raster-${surfaceId.replace(/[^\w.-]/g, '_')}-${gen}.rgba`);
    writeFileSync(file, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
    const msg = JSON.stringify({ type: 'raster', surface: surfaceId, gen, w, h, path: file });
    const prev = rasterMsgs.get(surfaceId);
    rasterMsgs.set(surfaceId, { msg, file });
    if (status.state === 'up') write(msg);
    // The engine reads a raster as the message arrives, so the previous file is free once this one is sent.
    if (prev && prev.file !== file) { try { unlinkSync(prev.file); } catch { /* gone */ } }
  } catch (e) { logger.log('warn', 'engine', 'raster-write-failed', { surfaceId }, e); }
}

// E1f-3: THE DISPLAYS ARE MAIN'S. The renderer names an output's display by Electron id; the engine places
// windows by PHYSICAL bounds (winit monitors), so each projector entry gets its display's bounds in screen
// pixels here — or a reason when that display is not connected (the engine then opens nothing anywhere).
function withDisplayBounds(json: string): string {
  let doc: { projectors?: { id?: string; displayId?: number | null; bounds?: unknown; window?: unknown; title?: string; css?: [number, number]; why?: string; baked?: { key: string } & Record<string, unknown> }[] };
  try { doc = JSON.parse(json); } catch { return json; }
  if (!doc.projectors?.length) return json;
  const displays = screen.getAllDisplays();
  for (const p of doc.projectors) {
    // E6f: a WINDOWED output — the engine opens its own window where the app's is (that one is hidden while the
    // engine shows the output, and shown there again if the engine goes): its CONTENT rect in physical pixels, and
    // its CSS size (innerWidth × innerHeight, what a shader on it is drawn at).
    if (p.displayId === WINDOWED_DISPLAY) {
      const w = windowedContent(p.id ?? '');
      if (!w) { if (!p.why) p.why = 'its window is not open yet'; continue; }
      p.window = w.physical; p.css = w.css; p.title = w.title;
      continue;
    }
    const d = displays.find((x) => x.id === p.displayId);
    if (!d) { if (!p.why) p.why = 'its display is not connected'; continue; }
    p.bounds = process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : { x: Math.round(d.bounds.x * d.scaleFactor), y: Math.round(d.bounds.y * d.scaleFactor), width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
    // E2: the display in CSS pixels — the app's projector window's innerWidth × innerHeight, which is the
    // pixel budget its shaders are drawn at (plugins/shader shaderDrawable.sizeFor, windowKind 'projector').
    p.css = [d.bounds.width, d.bounds.height];
    // Item 3: the calibration map's files. Not written yet → not drawable yet (the engine would warp it flat).
    if (p.baked) {
      const f = bakedFiles.get(p.baked.key);
      if (f) Object.assign(p.baked, f);
      else if (!p.why) p.why = 'its calibration map is still being handed over';
    }
  }
  return JSON.stringify(doc);
}

// E6f: a windowed output's app window opened or was laid out by main — the document carries its rect.
onWindowedPlaced(() => { if (flag() && lastDocRaw) noteDoc(lastDocRaw, lastDocRev); });

// E1f-3: whether the engine's windows show the projector outputs (the app's are then COVERED: told to stop
// drawing, kept open underneath — the engine's are topmost — so an engine that dies uncovers them at once).
let projOwns: { rev: number; pid: number | null } | null = null;
// E6f: told when the engine takes / gives back the projector outputs (the SDK's `nativeEngine.onProjectorsOwned`).
const projOwnsListeners = new Set<(owned: boolean) => void>();
export function onProjectorsOwned(cb: (owned: boolean) => void): () => void {
  projOwnsListeners.add(cb);
  try { cb(!!projOwns); } catch (e) { logger.log('warn', 'engine', 'projectors-owned-listener', {}, e); }
  return () => { projOwnsListeners.delete(cb); };
}
let lastProjWhy = '';
function setProjOwns(next: { rev: number; pid: number | null } | null, why: string): void {
  const was = !!projOwns;
  projOwns = next;
  // Logged on a change of owner OR of reason, like the wire: "the app keeps the outputs: output 'Wall':
  // calibrated" is the line a venue tech needs, and it is not a transition.
  if (was !== !!next || (!next && why !== lastProjWhy)) {
    logger.log('info', 'engine', next ? 'owns-projectors' : 'app-has-projectors', next ? { rev: next.rev } : { why });
    console.log(next ? `[engine] owns the projector outputs (document ${next.rev})` : `[engine] the app keeps the projector outputs: ${why}`);
  }
  lastProjWhy = next ? '' : why;
  if (was !== !!next) {
    setProjectorsCovered(!!next);
    for (const cb of projOwnsListeners) { try { cb(!!next); } catch (e) { logger.log('warn', 'engine', 'projectors-owned-listener', {}, e); } }
  }
}

function write(line: string): void { try { child?.stdin?.write(line + '\n'); } catch { /* the exit handler takes it */ } }

/** The output engine's settings (IPC.CONFIGURE) — the engine sends with the same ones. */
export function noteOutputConfig(cfg: OutputConfig): void {
  if (!flag()) return;
  lastOutput = JSON.stringify({ type: 'output', broadcast: !!cfg.broadcast, fps: cfg.fps ?? 44, keepAlive: cfg.keepAlive ?? true, sync: cfg.sync ?? false });
  if (status.state === 'up') write(lastOutput);
}
/** The effective document, as the renderer serialised it (it carries its own `rev`). */
export function noteDoc(json: string, rev: number): void {
  if (!flag()) return;
  lastDocRaw = json;
  lastDoc = withDisplayBounds(json); lastDocRev = rev;
  json = lastDoc;
  // TEST HOOK (scripts/test-native-takeover.cjs): the document as relayed, so a failure can be replayed
  // through the proven offscreen path. Off unless the variable names a file.
  if (process.env.ARTLUX_ENGINE_DOC_DUMP) { try { writeFileSync(process.env.ARTLUX_ENGINE_DOC_DUMP, json); } catch { /* a test aid */ } }
  if (status.state === 'up') write(`{"type":"doc","doc":${json}}`);
}
// ── E6a: A BAKE DRAWN BY THE ENGINE ────────────────────────────────────────────────────────────────────────
// plugins/bake's frames, one request each: the renderer has stepped its clock and settled its decoders, sends the
// frame's tick, and waits for the engine to have drawn and encoded it before it steps again. NOT a tick: a tick
// is coalesced (only the newest is drawn) and a bake frame must never be. A death fails every waiting request,
// and the bake is refused with the reason (the file is incomplete; the runner deletes it).
let bakeReq = 0;
const bakePending = new Map<number, (r: { ok: boolean; value?: unknown; error?: string }) => void>();
export function engineBake(op: string, body: string): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  if (!flag() || status.state !== 'up' || !child) return Promise.resolve({ ok: false, error: 'the native engine is not running' });
  if (!/^bake(Begin|Frame|End|Cancel)$/.test(op) || !body.startsWith('{')) return Promise.resolve({ ok: false, error: `not a bake message: ${op}` });
  const req = ++bakeReq;
  const p = new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => bakePending.set(req, resolve));
  write(`{"type":${JSON.stringify(op)},"req":${req}${body === '{}' ? '' : ',' + body.slice(1, -1)}}`);
  return p;
}
function failBakes(why: string): void {
  for (const r of bakePending.values()) r({ ok: false, error: why });
  bakePending.clear();
}

/** One frame. Sent only while the engine is up; a tick is never queued for a future engine. */
export function noteTick(json: string): void {
  if (!flag() || status.state !== 'up') return;
  write(`{"type":"tick",${json.slice(1)}`);
}

// ── E4a: the engine's 3D view window ───────────────────────────────────────────────────────────────
// The scene and the open state are KEPT, like the document: a restarted engine gets both back and the
// window reappears where the operator had it (on its default size/place — the engine owns the window).
let lastScene3d: string | null = null;
let view3dOpen: { camera: unknown } | null = null;   // while the view is open: the camera it was opened at
/** The scene the engine's 3D view draws (renderer: Simulator3D/engineView.ts). */
export function noteScene3d(json: string): void {
  if (!flag()) return;
  lastScene3d = json;
  if (status.state === 'up') write(`{"type":"scene3d",${json.slice(1)}`);
}
/** Open the engine's 3D view at the editor's camera, or close it. */
export function noteView3d(open: boolean, camera: unknown): void {
  if (!flag()) return;
  view3dOpen = open ? { camera: camera ?? null } : null;
  if (status.state === 'up') write(view3dMessage(open, camera ?? null));
}
/** The open / close message. An open carries the window's last PLACE (machine prefs, E4b): the engine's own
 *  physical pixels, stored as it reported them and never read here — the engine checks it against the screens
 *  that exist when it opens. Built at send time, so a restarted engine reopens where the window was LAST. */
function view3dMessage(open: boolean, camera: unknown): string {
  return JSON.stringify({ type: 'view3d', open, camera, place: open ? getPrefs().engineView3dPlace ?? null : null });
}
function view3dClosedByOperator(): void {
  view3dOpen = null;
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.NATIVE_ENGINE_VIEW3D_CLOSED);
}

export function engineEnabled(): boolean { return flag(); }
export function engineStatus(): EngineStatus { return { ...status }; }

/** The engine binary: beside the app's resources when packaged, the cargo build output in dev. */
export function enginePath(): string {
  const exe = process.platform === 'win32' ? 'artlux-engine.exe' : 'artlux-engine';
  return app.isPackaged
    ? join(process.resourcesPath || '', 'engine', exe)
    : join(app.getAppPath(), 'engine', 'target', 'release', exe);
}

function clearTimers(): void {
  if (pingTimer) clearInterval(pingTimer);
  if (helloTimer) clearTimeout(helloTimer);
  pingTimer = helloTimer = null;
}

function spawnEngine(): void {
  if (stopping) return;
  const exe = enginePath();
  if (!existsSync(exe)) {
    status.state = 'missing';
    logger.log('error', 'engine', 'missing', { path: exe });
    console.error(`[engine] not found at ${exe} — the native engine stays off (build it: npm run build:engine)`);
    return;
  }
  status.state = status.starts === 0 ? 'starting' : 'restarting';
  status.starts++;
  let proc: ChildProcess;
  try {
    proc = spawn(exe, ['--serve'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ARTLUX_ENGINE_HOLD: holdFile() } });
  } catch (e) {
    logger.log('error', 'engine', 'spawn-failed', { path: exe }, e);
    onDeath(null, `spawn failed: ${(e as Error).message}`);
    return;
  }
  child = proc;
  let lastPong = Date.now();
  let pingN = 0;
  let buf = '';
  proc.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m: { type?: string; adapter?: string; version?: string; backend?: string; pid?: number; n?: number; u?: number; d?: number; pps?: number; fps?: number; rev?: number; owns?: boolean; why?: string; id?: string | null; add?: boolean; place?: EngineView3dPlace; phase?: string; delta?: number[]; rot?: number[]; scale?: number[]; model?: string | null; x?: number; y?: number; w?: number; h?: number };
      try { m = JSON.parse(line); } catch { console.log(`[engine] ${line}`); continue; }
      if (m.type === 'hello') {
        if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
        status.state = 'up';
        status.pid = proc.pid ?? null;
        status.adapter = m.adapter ?? null;
        lastPong = Date.now();
        logger.log('info', 'engine', 'up', { pid: proc.pid, adapter: m.adapter, backend: m.backend, version: m.version, starts: status.starts });
        console.log(`[engine] up (pid ${proc.pid}, ${m.adapter}, start ${status.starts})`);
        // A (re)started engine knows nothing: the settings, then the document, before any tick.
        if (lastOutput) write(lastOutput);
        for (const r of rasterMsgs.values()) write(r.msg);   // E2: the pictures before the document naming them
        if (lastDoc) write(`{"type":"doc","doc":${lastDoc}}`);
        flushAudio();   // E3m: the audio calls made while it started
        // E4a: the 3D view's scene, and the window if it was open.
        if (lastScene3d) write(`{"type":"scene3d",${lastScene3d.slice(1)}`);
        if (view3dOpen) write(view3dMessage(true, view3dOpen.camera));
        let lastTick = Date.now();
        pingTimer = setInterval(() => {
          // A LATE TICK MEANS MAIN WAS STALLED, NOT THE ENGINE. Main's event loop is busy for seconds at
          // boot (seen in the packaged E1a probe: ticks ~3 s late), and the engine's pongs sit unread in
          // the pipe meanwhile — judging "silence" then would kill a healthy engine. So a tick that comes
          // more than two periods late restarts the clock instead of judging.
          const now = Date.now();
          const late = now - lastTick > 2 * PING_MS;
          lastTick = now;
          if (late) lastPong = now;
          if (now - lastPong > PONG_TIMEOUT_MS) {
            logger.log('warn', 'engine', 'hung', { pid: proc.pid, silentMs: Date.now() - lastPong });
            console.warn(`[engine] hung (no answer for ${Date.now() - lastPong} ms) — killing pid ${proc.pid}`);
            clearTimers();
            if (owns) { holdWire('the engine hung'); setOwns(null, 'the engine hung'); }
            if (projOwns) setProjOwns(null, 'the engine hung');
            proc.kill();
            return;
          }
          try { proc.stdin?.write(`{"ping":${++pingN}}\n`); } catch { /* the exit handler takes it */ }
        }, PING_MS);
      } else if (m.type === 'view3d') {
        // The operator closed the engine's 3D view from its title bar: tell the editor (its button state).
        view3dClosedByOperator();
      } else if (m.type === 'view3dGizmo') {
        // E4b: a drag on the engine window's move gizmo — relayed; the EDITOR turns the offset into the move.
        if ((m.phase === 'start' || m.phase === 'move' || m.phase === 'end') && Array.isArray(m.delta) && m.delta.length === 3) {
          const gesture = { delta: m.delta, rot: Array.isArray(m.rot) && m.rot.length === 4 ? m.rot : [0, 0, 0, 1], scale: Array.isArray(m.scale) && m.scale.length === 3 ? m.scale : [1, 1, 1] };
          for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.NATIVE_ENGINE_VIEW3D_GIZMO, m.phase, gesture);
        }
      } else if (m.type === 'outputPlace') {
        // E6f: the operator moved / resized the engine's window of a WINDOWED output: the app's hidden one follows
        // (the fallback reappears there), and the document is rebuilt — a shader on it is drawn at its new size.
        if (typeof m.id === 'string' && [m.x, m.y, m.w, m.h].every((n) => typeof n === 'number')) {
          placeWindowed(m.id, { x: m.x!, y: m.y!, width: m.w!, height: m.h! });
          if (lastDocRaw) noteDoc(lastDocRaw, lastDocRev);
        }
      } else if (m.type === 'outputClosed') {
        // E6f: ...or closed it from its title bar: the same as closing the app's window — the output is turned off.
        if (typeof m.id === 'string') closeWindowedByOperator(m.id);
      } else if (m.type === 'view3dPlace') {
        // E4b: the operator moved / resized the window (reported once it settles). Per MACHINE — screens are.
        if (m.place && typeof m.place === 'object') setPrefs({ engineView3dPlace: m.place });
      } else if (m.type === 'view3dPick') {
        // E4b: a click in the engine's 3D view. The EDITOR owns the selection, so it is only relayed: every
        // window gets it, and the one whose 3D view opened the engine's window applies it.
        const id = typeof m.id === 'string' ? m.id : null;
        const model = typeof m.model === 'string' ? m.model : null;
        for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.NATIVE_ENGINE_VIEW3D_PICK, id, !!m.add, model);
      } else if (m.type === 'pong') {
        lastPong = Date.now();
      } else if (m.type === 'sent') {
        lastSentAt = Date.now();
        if (typeof m.n === 'number') sentFrames = m.n;
        if (typeof m.d === 'number') sentDropped = m.d;
        if (typeof m.pps === 'number') sentWire = { pps: m.pps, fps: m.fps ?? 0, universes: m.u ?? 0 };
      } else if (m.type === 'projOwns') {
        if (m.rev !== lastDocRev) continue;
        setProjOwns(m.owns ? { rev: m.rev, pid: proc.pid ?? null } : null, m.why ?? '');
      } else if (m.type === 'audio') {
        // E3m: the answer to a relayed audio call.
        const a = m as { req?: number; ok?: boolean; value?: unknown; error?: string };
        const p = a.req !== undefined ? audioPending.get(a.req) : undefined;
        if (p) { audioPending.delete(a.req!); if (a.ok) p.resolve(a.value); else p.reject(new Error(a.error ?? 'audio call failed')); }
      } else if (m.type === 'bake') {
        // E6a: the answer to a bake message.
        const b = m as { req?: number; ok?: boolean; value?: unknown; error?: string };
        const r = b.req !== undefined ? bakePending.get(b.req) : undefined;
        if (r) { bakePending.delete(b.req!); r({ ok: !!b.ok, value: b.value, error: b.error }); }
      } else if (m.type === 'owns') {
        if (m.rev !== lastDocRev) continue;   // an answer about a document already replaced
        answeredRev = m.rev;
        setOwns(m.owns ? { rev: m.rev, pid: proc.pid ?? null } : null, m.why ?? '');
      }
    }
  });
  let errTail = '';
  // A pipe chunk ends anywhere, mid-line included: keep the unfinished tail for the next chunk (as stdout does), or a
  // line is logged as two halves and no reader (a log search, a test) ever sees it whole.
  let errBuf = '';
  proc.stderr?.on('data', (d: Buffer) => {
    errBuf += d.toString('utf8');
    const lines = errBuf.split(/\r?\n/);
    errBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      errTail = (errTail + '\n' + line).slice(-600);
      console.error(`[engine] ${line}`);
    }
  });
  proc.stdin?.on('error', () => { /* a dead engine's pipe: the exit handler takes it */ });
  helloTimer = setTimeout(() => {
    logger.log('warn', 'engine', 'no-hello', { pid: proc.pid, waitedMs: HELLO_TIMEOUT_MS });
    console.warn(`[engine] no hello within ${HELLO_TIMEOUT_MS} ms — killing pid ${proc.pid}`);
    proc.kill();
  }, HELLO_TIMEOUT_MS);
  proc.on('exit', (code, signal) => {
    if (child === proc) child = null;
    clearTimers();
    // THE WIRE GOES BACK TO THE APP FIRST — before anything else is decided about this death.
    if (owns && owns.pid === (proc.pid ?? null)) { holdWire('the engine exited'); setOwns(null, 'the engine exited'); }
    if (projOwns && projOwns.pid === (proc.pid ?? null)) setProjOwns(null, 'the engine exited');
    failAudio('the engine exited');   // E3m: an answer that will never come
    failBakes('the engine exited during the bake');   // E6a: the same
    const what = signal ? `signal ${signal}` : `code ${code}`;
    if (stopping) { status.state = 'off'; status.pid = null; return; }
    if (code === EXIT_REFUSED) {
      status.state = 'refused';
      status.pid = null;
      status.lastExit = what;
      logger.log('error', 'engine', 'refused', { detail: errTail.trim() });
      console.error(`[engine] refused to start — not restarting: ${errTail.trim()}`);
      return;
    }
    onDeath(proc.pid ?? null, what);
  });
}

function onDeath(pid: number | null, what: string): void {
  status.pid = null;
  status.lastExit = what;
  const now = Date.now();
  while (deaths.length && now - deaths[0] > 60_000) deaths.shift();
  deaths.push(now);
  if (deaths.length > RESTART_LIMIT) {
    status.state = 'gave-up';
    logger.log('error', 'engine', 'gave-up', { deathsInAMinute: deaths.length, last: what });
    console.error(`[engine] died ${deaths.length}× in a minute — not restarting`);
    return;
  }
  status.state = 'restarting';
  logger.log('warn', 'engine', 'exited', { pid, exit: what, restartInMs: RESTART_DELAY_MS });
  console.warn(`[engine] exited (${what}) — restarting in ${RESTART_DELAY_MS} ms`);
  setTimeout(() => { if (!stopping && !child) spawnEngine(); }, RESTART_DELAY_MS);
}

// ── E3m: SOUND FROM THE ENGINE ─────────────────────────────────────────────────────────────────────────────
// plugins/audio's calls, relayed to the engine's audio thread (engine audio.rs `serve` → artlux_audio.dll, the same
// JUCE core the addon is) instead of audio_engine.node — so the sound comes out of the process that also draws and
// puts DMX on the wire. A call made before the engine says hello is QUEUED (the driver configures the device at boot,
// while the engine is still starting); an answering call is a promise settled by the engine's `audio` line, and
// rejected if the engine dies first.
let audioReq = 0;
const audioPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const audioQueue: { op: string; args: unknown[]; req?: number; line: string }[] = [];
/** Relay one audio call to the engine. `answer`: a promise of its answer; otherwise fire-and-forget, in order. */
export function audioCall(op: string, args: unknown[], answer: boolean): Promise<unknown> | void {
  const req = answer ? ++audioReq : undefined;
  const line = JSON.stringify({ type: 'audio', op, args, ...(req ? { req } : {}) });
  const p = req ? new Promise<unknown>((resolve, reject) => audioPending.set(req, { resolve, reject })) : undefined;
  trackAudio(op, args);
  if (status.state === 'up') write(line);
  else if (audioQueue.length < 10_000) audioQueue.push({ op, args, req, line });
  return p;
}

// ── E3n: A RESTARTED ENGINE GETS ITS SOUND BACK ───────────────────────────────────────────────────────────────
// The audio driver (plugins/audio) keeps its own view — which clips it loaded, which are sounding, at what offset —
// and never re-sends what it believes done. A restarted engine knows nothing, so the show would go SILENT until the
// driver's next reload. So main keeps the audio STATE the calls describe — the device, the master, each loaded clip
// with its gain / position / chain and, if sounding, where it was started and when — and hands it to a restarted
// engine before anything else, exactly as it re-sends the document. A sounding clip resumes where it would be NOW
// (its seek + the time since); the driver's own drift lock (a 50 ms source-offset test) still holds it from there.
interface ClipAudio { path: string; gain?: number; spatial?: unknown[]; effects?: unknown; playing?: { seek: number; gain: number; at: number }; lock?: unknown }
const aud = { configure: null as unknown[] | null, clips: new Map<string, ClipAudio>(), gain: undefined as number | undefined, effects: undefined as unknown, tone: undefined as unknown[] | undefined };
function trackAudio(op: string, args: unknown[]): void {
  const id = String(args[0] ?? '');
  const c = aud.clips.get(id);
  switch (op) {
    case 'configure': aud.configure = args; break;
    case 'loadClip': aud.clips.set(id, { path: String(args[1] ?? '') }); break;   // a reload is a new clip: no chain, not sounding
    case 'unloadClip': aud.clips.delete(id); break;
    case 'playClip': if (c) { c.playing = { seek: Number(args[1]) || 0, gain: Number(args[2] ?? 1), at: Date.now() }; c.gain = Number(args[2] ?? 1); } break;
    case 'stopClip': if (c) { c.playing = undefined; c.lock = undefined; } break;
    case 'lockClip': if (c) c.lock = args[1] ?? undefined; break;   // E3p: what the engine holds it to
    case 'setClipGain': if (c) c.gain = Number(args[1]); break;
    case 'setClipSpatial': if (c) c.spatial = args.slice(1); break;
    case 'clearClipSpatial': if (c) c.spatial = undefined; break;
    case 'setClipEffects': if (c) c.effects = args[1]; break;
    case 'setMasterGain': aud.gain = Number(args[0]); break;
    case 'setMasterEffects': aud.effects = args[0]; break;
    case 'setTestTone': aud.tone = args; break;
    case 'stopAll': for (const x of aud.clips.values()) { x.playing = undefined; x.lock = undefined; } break;
    case 'close': aud.configure = null; aud.clips.clear(); aud.gain = undefined; aud.effects = undefined; aud.tone = undefined; break;
    default: break;   // reads (meters, spectrum, devices) and the offline render change nothing to replay
  }
}
/** On every hello after the first: the calls that are still waiting for an answer (the latest intents), then the
 *  state — minus what those calls already do. Queued fire-and-forget calls are DROPPED: the state holds their effect,
 *  and replaying an old playClip after the state's would move a resumed clip back to where it was minutes ago. */
function replayAudio(): void {
  const reqs = audioQueue.filter((q) => q.req !== undefined);
  audioQueue.length = 0;
  for (const q of reqs) write(q.line);
  const send = (op: string, args: unknown[]) => write(JSON.stringify({ type: 'audio', op, args }));
  const queuedLoads = new Set(reqs.filter((q) => q.op === 'loadClip').map((q) => String(q.args[0])));
  if (aud.configure && !reqs.some((q) => q.op === 'configure')) send('configure', aud.configure);
  if (aud.gain !== undefined) send('setMasterGain', [aud.gain]);
  if (aud.effects !== undefined) send('setMasterEffects', [aud.effects]);
  if (aud.tone) send('setTestTone', aud.tone);
  let sounding = 0, held = 0;
  const now = Date.now();
  for (const [id, c] of aud.clips) {
    if (!queuedLoads.has(id)) send('loadClip', [id, c.path]);
    if (c.effects !== undefined) send('setClipEffects', [id, c.effects]);
    if (c.spatial) send('setClipSpatial', [id, ...c.spatial]);
    if (c.playing) { send('playClip', [id, c.playing.seek + (now - c.playing.at) / 1000, c.playing.gain]); sounding++; }
    // E3p: …and held to the new engine's clock again — which puts it back exactly, where the resume is a wall estimate.
    // E3q: with the engine deciding there is no play to resume — the lock alone starts it, where its clock says.
    if (c.lock) { send('lockClip', [id, c.lock]); held++; }
    if (c.gain !== undefined) send('setClipGain', [id, c.gain]);
  }
  if (aud.configure || aud.clips.size) {
    logger.log('info', 'engine', 'audio-replayed', { clips: aud.clips.size, sounding, held });
    console.log(`[engine] audio replayed to the restarted engine: the device, ${aud.clips.size} clip(s), ${sounding} sounding, ${held} held by the engine`);
  }
}
function flushAudio(): void {
  if (status.starts > 1) { replayAudio(); return; }
  for (const q of audioQueue.splice(0)) write(q.line);
}
function failAudio(why: string): void {
  for (const [, p] of audioPending) p.reject(new Error(why));
  audioPending.clear();
}

/** Start the engine if the flag asks for it. Safe to call once at startup in any mode. */
export function startEngine(): void {
  if (!flag()) { logger.log('info', 'engine', 'off', { why: nativeEngineWhy() }); return; }
  output.setWireOwner(engineOwnsWire);
  logger.log('info', 'engine', 'enabled', { path: enginePath(), why: nativeEngineWhy() });
  spawnEngine();
}

/** Quit: stop it for good — a clean `quit`, then a kill if it does not go. */
export function stopEngine(): void {
  stopping = true;
  clearTimers();
  const proc = child;
  child = null;
  if (!proc) return;
  try { proc.stdin?.write('{"quit":true}\n'); proc.stdin?.end(); } catch { /* gone */ }
  setTimeout(() => { try { if (proc.exitCode === null) proc.kill(); } catch { /* gone */ } }, 500).unref();
}
