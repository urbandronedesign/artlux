import { app, BrowserWindow } from 'electron';
import { IPC } from '../../shared/protocol';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as logger from './logger';
import * as output from './transport/outputManager';
import { screen } from 'electron';
import { setProjectorsCovered } from './projector';
import type { OutputConfig } from '../../shared/protocol';

// THE NATIVE ENGINE AS ARTLUX'S CHILD (plans/native-engine.md §9c, E1a). Behind a flag until it carries
// output: `--native-engine` on the command line, or ARTLUX_NATIVE_ENGINE=1. Without it nothing here runs
// and the app is exactly what it was.
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

const FLAG = process.argv.includes('--native-engine') || process.env.ARTLUX_NATIVE_ENGINE === '1';
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

function setOwns(next: { rev: number; pid: number | null } | null, why: string): void {
  const was = !!owns;
  owns = next;
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
  if (!FLAG) return;
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
    if (lastDoc && lastDoc.includes(`"key":"${key}"`)) noteDoc(lastDoc, lastDocRev);
  } catch (e) { logger.log('warn', 'engine', 'baked-map-write-failed', { key }, e); }
}

// E2: PICTURES THE APP DRAWS AND THE ENGINE SHOWS (`raster` sources — TEXT first, plans/native-engine.md §2
// "phase 1: the app rasterises, the engine receives an image on change"). The renderer ships a surface's
// pixels when its generation changes; main writes them where the engine can read them and tells it. One file
// per surface and generation, the previous one removed once the next is announced. The last message per
// surface is kept: a restarted engine is given every raster BEFORE the document that names them.
const rasterMsgs = new Map<string, { msg: string; file: string }>();
export function noteRaster(surfaceId: string, gen: number, w: number, h: number, rgba: Uint8Array): void {
  if (!FLAG) return;
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
  let doc: { projectors?: { displayId?: number | null; bounds?: unknown; css?: [number, number]; why?: string; baked?: { key: string } & Record<string, unknown> }[] };
  try { doc = JSON.parse(json); } catch { return json; }
  if (!doc.projectors?.length) return json;
  const displays = screen.getAllDisplays();
  for (const p of doc.projectors) {
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

// E1f-3: whether the engine's windows show the projector outputs (the app's are then COVERED: told to stop
// drawing, kept open underneath — the engine's are topmost — so an engine that dies uncovers them at once).
let projOwns: { rev: number; pid: number | null } | null = null;
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
  if (was !== !!next) setProjectorsCovered(!!next);
}

function write(line: string): void { try { child?.stdin?.write(line + '\n'); } catch { /* the exit handler takes it */ } }

/** The output engine's settings (IPC.CONFIGURE) — the engine sends with the same ones. */
export function noteOutputConfig(cfg: OutputConfig): void {
  if (!FLAG) return;
  lastOutput = JSON.stringify({ type: 'output', broadcast: !!cfg.broadcast, fps: cfg.fps ?? 44, keepAlive: cfg.keepAlive ?? true, sync: cfg.sync ?? false });
  if (status.state === 'up') write(lastOutput);
}
/** The effective document, as the renderer serialised it (it carries its own `rev`). */
export function noteDoc(json: string, rev: number): void {
  if (!FLAG) return;
  lastDoc = withDisplayBounds(json); lastDocRev = rev;
  json = lastDoc;
  // TEST HOOK (scripts/test-native-takeover.cjs): the document as relayed, so a failure can be replayed
  // through the proven offscreen path. Off unless the variable names a file.
  if (process.env.ARTLUX_ENGINE_DOC_DUMP) { try { writeFileSync(process.env.ARTLUX_ENGINE_DOC_DUMP, json); } catch { /* a test aid */ } }
  if (status.state === 'up') write(`{"type":"doc","doc":${json}}`);
}
/** One frame. Sent only while the engine is up; a tick is never queued for a future engine. */
export function noteTick(json: string): void {
  if (!FLAG || status.state !== 'up') return;
  write(`{"type":"tick",${json.slice(1)}`);
}

// ── E4a: the engine's 3D view window ───────────────────────────────────────────────────────────────
// The scene and the open state are KEPT, like the document: a restarted engine gets both back and the
// window reappears where the operator had it (on its default size/place — the engine owns the window).
let lastScene3d: string | null = null;
let view3dOpen: string | null = null;   // the open message, while the view is open
/** The scene the engine's 3D view draws (renderer: Simulator3D/engineView.ts). */
export function noteScene3d(json: string): void {
  if (!FLAG) return;
  lastScene3d = json;
  if (status.state === 'up') write(`{"type":"scene3d",${json.slice(1)}`);
}
/** Open the engine's 3D view at the editor's camera, or close it. */
export function noteView3d(open: boolean, camera: unknown): void {
  if (!FLAG) return;
  const msg = JSON.stringify({ type: 'view3d', open, camera: camera ?? null });
  view3dOpen = open ? msg : null;
  if (status.state === 'up') write(msg);
}
function view3dClosedByOperator(): void {
  view3dOpen = null;
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.NATIVE_ENGINE_VIEW3D_CLOSED);
}

export function engineEnabled(): boolean { return FLAG; }
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
    proc = spawn(exe, ['--serve'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
      let m: { type?: string; adapter?: string; version?: string; backend?: string; pid?: number; n?: number; u?: number; d?: number; pps?: number; fps?: number; rev?: number; owns?: boolean; why?: string };
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
        // E4a: the 3D view's scene, and the window if it was open.
        if (lastScene3d) write(`{"type":"scene3d",${lastScene3d.slice(1)}`);
        if (view3dOpen) write(view3dOpen);
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
            if (owns) setOwns(null, 'the engine hung');
            if (projOwns) setProjOwns(null, 'the engine hung');
            proc.kill();
            return;
          }
          try { proc.stdin?.write(`{"ping":${++pingN}}\n`); } catch { /* the exit handler takes it */ }
        }, PING_MS);
      } else if (m.type === 'view3d') {
        // The operator closed the engine's 3D view from its title bar: tell the editor (its button state).
        view3dClosedByOperator();
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
      } else if (m.type === 'owns') {
        if (m.rev !== lastDocRev) continue;   // an answer about a document already replaced
        answeredRev = m.rev;
        setOwns(m.owns ? { rev: m.rev, pid: proc.pid ?? null } : null, m.why ?? '');
      }
    }
  });
  let errTail = '';
  proc.stderr?.on('data', (d: Buffer) => {
    for (const line of d.toString('utf8').split(/\r?\n/)) {
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
    if (owns && owns.pid === (proc.pid ?? null)) setOwns(null, 'the engine exited');
    if (projOwns && projOwns.pid === (proc.pid ?? null)) setProjOwns(null, 'the engine exited');
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

/** Start the engine if the flag asks for it. Safe to call once at startup in any mode. */
export function startEngine(): void {
  if (!FLAG) return;
  output.setWireOwner(engineOwnsWire);
  logger.log('info', 'engine', 'enabled', { path: enginePath() });
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
