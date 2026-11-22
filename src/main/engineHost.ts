import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as logger from './logger';

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
      let m: { type?: string; adapter?: string; version?: string; backend?: string; pid?: number; n?: number };
      try { m = JSON.parse(line); } catch { console.log(`[engine] ${line}`); continue; }
      if (m.type === 'hello') {
        if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
        status.state = 'up';
        status.pid = proc.pid ?? null;
        status.adapter = m.adapter ?? null;
        lastPong = Date.now();
        logger.log('info', 'engine', 'up', { pid: proc.pid, adapter: m.adapter, backend: m.backend, version: m.version, starts: status.starts });
        console.log(`[engine] up (pid ${proc.pid}, ${m.adapter}, start ${status.starts})`);
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
            proc.kill();
            return;
          }
          try { proc.stdin?.write(`{"ping":${++pingN}}\n`); } catch { /* the exit handler takes it */ }
        }, PING_MS);
      } else if (m.type === 'pong') {
        lastPong = Date.now();
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
