// Embedded control server for the tablet remote. HTTP serves the PWA; Server-Sent Events stream live
// snapshot/status/metrics/playlist down to every connected device; commands + config come up as plain
// JSON POSTs. SSE (not WebSocket) is deliberate: zero extra dependency (pure node:http), native
// EventSource auto-reconnect (a tablet self-heals across a broadcast relaunch), and it fits a
// one-producer/many-consumer stream. Same-origin (the PWA is served by this server) so no CORS dance,
// though we send permissive headers anyway. Graceful-degrading: a bind failure logs + disables, never
// throws (parity with oscManager / metrics.ts).

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import * as auth from './auth';
import { getPlaylist, setPlaylist } from './playlist';
import { scanProjects } from './projectScanner';
import * as scheduler from './scheduler';
import { CLIENT_HTML } from './clientHtml';
import type {
  ShowCommand, ShowSnapshot, ShowStatus, MetricsSnapshot, PlaylistStatus, DeviceInfo,
  ServerEvent, Playlist, LanInfo,
} from './types';

export interface ServerHandlers {
  onCommand(cmd: ShowCommand): void;        // tablet → show engine (forwarded to the renderer by plugin.main)
  onPlaylistChanged(): void;                // tablet edited the playlist (re-broadcast status)
  onSchedule(entries: unknown[]): void;     // tablet edited the in-project schedule (→ renderer host.show)
  onNeedSnapshot(): void;                   // a device connected — ask the renderer for a fresh show snapshot
}

interface Client { res: ServerResponse; id: number; token: string }

let server: Server | null = null;
let port = 0;
let handlers: ServerHandlers | null = null;
let locked = false;
let clientSeq = 0;
const clients = new Set<Client>();

// Latest-known payloads, replayed to a freshly-connected client so it renders immediately.
let lastSnapshot: ShowSnapshot | null = null;
let lastStatus: ShowStatus | null = null;
let lastMetrics: MetricsSnapshot | null = null;
let lastDevices: DeviceInfo[] = [];

function send(res: ServerResponse, code: number, body: unknown, type = 'application/json'): void {
  const text = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function bearer(req: IncomingMessage, body: any): string | undefined {
  const h = req.headers['authorization'];
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7);
  return typeof body?.token === 'string' ? body.token : undefined;
}

function emit(ev: ServerEvent): void {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) { try { c.res.write(line); } catch { /* dropped; close handler cleans up */ } }
}

// ─── SSE ──────────────────────────────────────────────────────────────────────────────────────
function openStream(req: IncomingMessage, res: ServerResponse, token: string | undefined): void {
  if (!auth.verifyToken(token)) { send(res, 401, { error: 'unpaired' }); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n'); // hint EventSource to reconnect quickly
  const client: Client = { res, id: ++clientSeq, token: token || '' }; // token verified above; retained so a kick can cut this stream
  clients.add(client);

  // Replay current state so the tablet paints immediately on (re)connect.
  const push = (ev: ServerEvent) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* */ } };
  push({ t: 'hello', locked, mode: scheduler.isBroadcast() ? 'broadcast' : 'editor' });
  if (lastSnapshot) push({ t: 'snapshot', snapshot: lastSnapshot });
  if (lastStatus) push({ t: 'status', status: lastStatus });
  push({ t: 'playlist', playlist: getPlaylist(), status: scheduler.status() });
  push({ t: 'devices', devices: currentDevices() });

  // …then ask the renderer for a CURRENT one. The replay above is only as good as the last push we
  // received, and the show snapshot is the one payload that is not periodic (see plugin.renderer.ts):
  // if the cache is empty or stale, this connection is precisely the moment that becomes visible, and
  // waiting for the operator to edit a scene is not a recovery. Arrives a few ms later and replaces it.
  handlers?.onNeedSnapshot();

  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 20000);
  req.on('close', () => { clearInterval(beat); clients.delete(client); });
}

function currentDevices(): DeviceInfo[] {
  const paired = auth.listDevices();
  return paired.map((d) => ({ id: d.token.slice(0, 8), name: d.name, pairedAt: d.pairedAt, connected: true }));
}

// ─── Router ─────────────────────────────────────────────────────────────────────────────────
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') { send(res, 204, ''); return; }

  // Static PWA.
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    send(res, 200, CLIENT_HTML, 'text/html; charset=utf-8'); return;
  }
  if (req.method === 'GET' && path === '/health') { send(res, 200, { ok: true }); return; }

  // SSE stream (token in query — EventSource can't set headers).
  if (req.method === 'GET' && path === '/events') { openStream(req, res, url.searchParams.get('token') || undefined); return; }

  // Pairing: PIN → token. No auth (that's the point).
  if (req.method === 'POST' && path === '/pair') {
    const body = await readBody(req);
    const token = auth.pair(String(body?.pin ?? ''), String(body?.name ?? 'Tablet'));
    if (!token) { send(res, 401, { error: 'bad-pin' }); return; }
    pushDevices();
    send(res, 200, { token, name: auth.deviceName(token) });
    return;
  }

  // Everything below needs a paired token.
  const body = req.method === 'POST' ? await readBody(req) : {};
  const token = bearer(req, body);
  if (!auth.verifyToken(token)) { send(res, 401, { error: 'unpaired' }); return; }

  if (req.method === 'POST' && path === '/command') {
    if (locked) { send(res, 423, { error: 'locked' }); return; }
    const cmd = body?.command as ShowCommand | undefined;
    if (cmd && typeof cmd.kind === 'string') handlers?.onCommand(cmd);
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && path === '/playlist') {
    send(res, 200, { playlist: getPlaylist(), status: scheduler.status() });
    return;
  }
  if (req.method === 'POST' && path === '/playlist') {
    if (locked) { send(res, 423, { error: 'locked' }); return; }
    setPlaylist(body?.playlist as Playlist);
    handlers?.onPlaylistChanged();
    emit({ t: 'playlist', playlist: getPlaylist(), status: scheduler.status() });
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && path === '/scan') {
    send(res, 200, { projects: scanProjects(String(body?.folder ?? '')) });
    return;
  }
  if (req.method === 'POST' && path === '/schedule') {
    if (locked) { send(res, 423, { error: 'locked' }); return; }
    handlers?.onSchedule(Array.isArray(body?.schedule) ? body.schedule : []);
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && path === '/playlist/start') {
    if (locked) { send(res, 423, { error: 'locked' }); return; }
    scheduler.startBroadcast();
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && path === '/playlist/load') {
    if (locked) { send(res, 423, { error: 'locked' }); return; }
    const p = String(body?.path ?? '');
    if (p) scheduler.relaunchBroadcast(p);
    send(res, 200, { ok: true });
    return;
  }

  send(res, 404, { error: 'not-found' });
}

// ─── Public API (driven by plugin.main) ───────────────────────────────────────────────────────
export function configure(cfg: { enabled: boolean; port: number }, h: ServerHandlers): void {
  handlers = h;
  if (!cfg.enabled) { close(); return; }
  if (server && port === cfg.port) return; // already up on this port
  close();
  port = cfg.port;
  const s = createServer((req, res) => { route(req, res).catch((e) => { console.error('[show-control] route error', e); try { send(res, 500, { error: 'server' }); } catch { /* */ } }); });
  s.on('error', (err) => { console.error(`[show-control] server unavailable (port ${port} in use?)`, err); server = null; });
  s.listen(port, '0.0.0.0', () => { console.log(`[show-control] tablet server at http://0.0.0.0:${port}  (pin ${auth.getPin()})`); });
  server = s;
}

export function close(): void {
  for (const c of clients) { try { c.res.end(); } catch { /* */ } }
  clients.clear();
  server?.close();
  server = null;
}

export function hasClients(): boolean { return clients.size > 0; }

// Close any SSE stream whose token no longer verifies — called right after auth.revoke so a kicked
// device's live view is cut immediately, not "eventually, when it reconnects". The req 'close' handler
// also deletes from clients (and clears the heartbeat), so the delete here is idempotent; Set deletion
// mid-iteration only skips the removed entry.
export function disconnectRevoked(): void {
  for (const c of clients) {
    if (!auth.verifyToken(c.token)) {
      try { c.res.end(); } catch { /* */ }
      clients.delete(c);
    }
  }
}

export function pushSnapshot(s: ShowSnapshot): void { lastSnapshot = s; emit({ t: 'snapshot', snapshot: s }); }
export function pushStatus(s: ShowStatus): void { lastStatus = s; emit({ t: 'status', status: s }); }
export function pushMetrics(m: MetricsSnapshot): void { lastMetrics = m; emit({ t: 'metrics', metrics: m }); }
export function pushPlaylistStatus(status: PlaylistStatus): void { emit({ t: 'playlist', playlist: getPlaylist(), status }); }
export function pushDevices(): void { lastDevices = currentDevices(); emit({ t: 'devices', devices: lastDevices }); }

export function setLocked(v: boolean): void { locked = v; emit({ t: 'locked', locked: v }); }
export function isLocked(): boolean { return locked; }

export function lanInfo(): LanInfo {
  const urls: string[] = [];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${port}`);
    }
  }
  return { urls, port, pin: auth.getPin(), enabled: !!server };
}

export function lastMetricsSnapshot(): MetricsSnapshot | null { return lastMetrics; }
