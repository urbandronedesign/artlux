import { MessageChannelMain, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron';
import path from 'node:path';
import { IPC } from '../../shared/protocol';

// MAIN'S HALF OF THE SHOW HOST (src/showhost/index.ts): start it, keep it alive, introduce windows to it.
//
// Main never touches the document itself. It forks the host, and for each window it opens a
// MessageChannel: one end to the host, one end to the window (relayed by the preload, exactly as the
// engine port and projector ports are — a MessagePort cannot cross the contextBridge). After that the
// two talk directly and main is out of the path.
//
// ⚠ A DEAD HOST MUST NEVER BE A DEAD SHOW. The host is not on the output path (the frame engine reads
// the editor's replica), and the editor keeps working with no host at all — so a crash is logged, a
// fresh host is forked, and every window is reconnected; the editor then hands the new host its full
// state again (see state/hostLink.ts). A host that keeps dying is given up on after RESTART_LIMIT in a
// minute rather than forked in a tight loop, and the app carries on standalone.

const RESTART_LIMIT = 5;
const RESTART_DELAY_MS = 500;

let child: UtilityProcess | null = null;
let stopping = false;
let nextClientId = 1;
const restarts: number[] = [];
// The window → client id map, so a reload reconnects under the SAME id (the host replaces the old port).
const windows = new Map<BrowserWindow, number>();

function spawn(): UtilityProcess | null {
  if (stopping) return null;
  const now = Date.now();
  while (restarts.length && now - restarts[0] > 60_000) restarts.shift();
  if (restarts.length >= RESTART_LIMIT) {
    console.error(`[showHost] died ${RESTART_LIMIT}× in a minute — not restarting; the editor carries on standalone`);
    return null;
  }
  restarts.push(now);
  const entry = path.join(__dirname, 'showHost.js');
  let proc: UtilityProcess;
  try {
    // 'pipe', forwarded line by line through main's console: 'inherit' does not reach main's stdout on
    // Windows (measured: a forked host logged nothing), and main's console is what the machine log
    // (docs/LOGGING.md) records.
    proc = utilityProcess.fork(entry, [], { serviceName: 'ArtLux Show Host', stdio: 'pipe' });
  } catch (e) {
    console.error(`[showHost] could not fork ${entry}:`, (e as Error).message);
    return null;
  }
  proc.once('spawn', () => console.log(`[showHost] forked (pid ${proc.pid})`));
  const forward = (write: (line: string) => void) => (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) write(line);
  };
  proc.stdout?.on('data', forward((l) => console.log(l)));
  proc.stderr?.on('data', forward((l) => console.error(l)));
  proc.on('exit', (code) => {
    if (child === proc) child = null;
    if (stopping) return;
    console.warn(`[showHost] exited (code ${code}) — restarting`);
    setTimeout(() => {
      if (stopping || child) return;
      child = spawn();
      if (child) for (const [win] of windows) connect(win);
    }, RESTART_DELAY_MS);
  });
  return proc;
}

function connect(win: BrowserWindow): void {
  if (win.isDestroyed()) { windows.delete(win); return; }
  if (!child) child = spawn();
  if (!child) return;
  let id = windows.get(win);
  if (id == null) { id = nextClientId++; windows.set(win, id); }
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ t: 'connect', clientId: id }, [port1]);
  win.webContents.postMessage(IPC.SHOW_HOST_PORT, null, [port2]);
}

/**
 * Give this window a port to the Show Host. Call on every `did-finish-load`: a reload throws the old
 * page's port away, and the new page needs its own (the host replaces the old one under the same id).
 */
export function connectShowHost(win: BrowserWindow): void {
  // THE KILL SWITCH. `ARTLUX_NO_SHOW_HOST=1` runs the editor standalone, exactly as when main gives up
  // restarting a host: the replica is the whole document and undo uses the in-process stacks. Two uses:
  // a venue that needs the host out of the picture while a fault is diagnosed, and the harnesses, which
  // run test-undo this way to prove the fallback still undoes.
  if (process.env.ARTLUX_NO_SHOW_HOST === '1') {
    if (!disabledLogged) { disabledLogged = true; console.log('[showHost] disabled by ARTLUX_NO_SHOW_HOST=1 — the editor runs standalone'); }
    return;
  }
  if (!windows.has(win)) win.once('closed', () => windows.delete(win));
  connect(win);
}
let disabledLogged = false;

/** Quit: stop the host for good (no restart). */
export function stopShowHost(): void {
  stopping = true;
  try { child?.kill(); } catch { /* already gone */ }
  child = null;
}

/** The host's pid, for logs and the harness. Null when it is not running. */
export function showHostPid(): number | null { return child?.pid ?? null; }
