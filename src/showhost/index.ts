// THE SHOW HOST — an Electron utilityProcess that holds the authoritative project document.
//
// plans/native-engine.md §9a, W3. Every window is a REPLICA of what lives here; from W5 a detached panel
// window reads and writes the document through this process instead of through the editor, which is
// what lets any panel live in its own window without a second copy of the show drifting from the first.
//
// WHAT IT IS TODAY (W3a): the authority for the two W1 stores, kept in lockstep with the editor. The
// editor hands over its whole state on connect (so a host restart, or a renderer reload, converges on
// what the operator is looking at), and every slice write after that arrives in order. Since W3b the
// UNDO STACKS live here too (below); persistence and the close guard follow in W3c.
//
// WHAT IT MUST NEVER BECOME: a second engine. No decode, no GPU, no output, no timers that write the
// document. It orders writes and remembers them. The frame engine stays in the editor renderer, reading
// the replica (plan §9a rule 2), so nothing here is on the show-critical path: if this process dies, the
// editor keeps editing and the show keeps playing, and main starts a fresh one.
//
// Plain Node + Electron's parentPort. It imports the dependency-free store core and the wire types only.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDocStore, type DocStore } from '../../shared/docStore';
import { shareEqual } from '../../shared/shareEqual';
import { sliceDigest, type ClientToHost, type HostConnect, type HostToClient, type Slices, type StoreName } from '../../shared/showHostProtocol';

// Electron's MessagePortMain, as far as this file uses it (the utility process has no `electron` module
// import for it; the ports arrive on parentPort's message event).
interface PortLike {
  on(ev: 'message', fn: (e: { data: unknown }) => void): void;
  on(ev: 'close', fn: () => void): void;
  postMessage(msg: unknown): void;
  start(): void;
  close(): void;
}
interface Client { id: number; port: PortLike; lastSeq: number; role: 'editor' | 'panel' | null }

const stores: Record<StoreName, DocStore<Slices>> = {
  doc: createDocStore<Slices>({}),
  session: createDocStore<Slices>({}),
};
const clients = new Map<number, Client>();

// ── UNDO / REDO (W3b) ───────────────────────────────────────────────────────────────────────────────
// The same model App's useHistory had in-process (hooks/useHistory.ts): snapshots of the undoable doc
// slices, held BY REFERENCE, capped in depth, FIFO when full. References are cheap here for the same
// reason they were there: nothing in this process mutates a value, and every write is folded into the
// previous value with shareEqual, so consecutive snapshots share every part that did not change.
//
// The present document for an op is the host's copy with the client's `present` overrides on top (see
// the protocol): the client flushed its writes first, so the copy is current except for writes it made
// earlier in the same handler and has not rendered yet, which is exactly what the overrides carry.
const MAX_DEPTH = 100;
let undoable: string[] = [];
let past: Slices[] = [];
let future: Slices[] = [];

function presentDoc(overrides: Slices, keys: string[] = undoable): Slices {
  const doc = stores.doc.get();
  const out: Slices = {};
  for (const k of keys) out[k] = k in overrides ? shareEqual(doc[k], overrides[k]) : doc[k];
  return out;
}

// ── UNSAVED CHANGES (W3c) ───────────────────────────────────────────────────────────────────────────
// The question "does the document differ from the file?" used to be answered in the editor by
// JSON-stringifying the whole project once a second ON THE UI THREAD (~78 kB). Here it is answered by
// digests of the project-file slices against the digests at the last baseline, computed only for a
// slice whose value actually changed (digests are cached per object, and a slice keeps its object
// unless written: shareEqual), and only after a write, never on a clock. Content, not revisions: an edit
// and its undo leave the document clean, exactly as the signature compare did.
let projectFile: string[] = [];
let saved: Record<string, string> | null = null;
let forcedDirty = false;
let lastDirty = false;
let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
const digestCache = new WeakMap<object, string>();
function digestOf(v: unknown): string {
  if (v && typeof v === 'object') {
    let d = digestCache.get(v);
    if (d == null) { d = sliceDigest(v); digestCache.set(v, d); }
    return d;
  }
  return sliceDigest(v);
}
function computeDirty(): boolean {
  if (forcedDirty) return true;
  if (!saved) return false;
  const doc = stores.doc.get();
  for (const k of projectFile) if (digestOf(doc[k]) !== saved[k]) return true;
  return false;
}
// ── AUTOSAVE (W3c) ──────────────────────────────────────────────────────────────────────────────────
// The host holds the document, so the host keeps it safe: it outlives the editor renderer, and it
// writes off the UI thread. A RECOVERY FILE, never the project: the operator's .artlux changes only
// when they save. One file per project (a hash of its path; 'untitled' for an unsaved one) in
// <userData>/autosave, written atomically (temp + rename):
//   • every AUTOSAVE_MS while the document has unsaved changes and has changed since the last write;
//   • AT ONCE when a new editor page says hello while this one holds unsaved work — the renderer died
//     (crash, GPU reset) and main reloaded it; the work it had not saved is still here, and this is the
//     last moment before the new page's handover replaces it;
// and DELETED by a real save of that project, or when the operator discards it. Never in a show mode.
// The editor offers it back when that project is opened again and the autosave is newer than the file.
// 30 s. `--autosave-ms=` (from ARTLUX_AUTOSAVE_MS, harness only) shortens it; never below 1 s.
const AUTOSAVE_MS = Math.max(1000, Number((process.argv.find((a) => a.startsWith('--autosave-ms=')) ?? '').slice('--autosave-ms='.length)) || 30_000);
const AUTOSAVE_DIR = (process.argv.find((a) => a.startsWith('--autosave-dir=')) ?? '').slice('--autosave-dir='.length) || null;
let autosaveOn = false;
let autosaveSuspended = true;      // until the first baseline names the project
let projectPath: string | null = null;
let autosavedRev = -1;
function autosaveFile(p: string | null): string | null {
  if (!AUTOSAVE_DIR) return null;
  const id = crypto.createHash('sha1').update(p ?? 'untitled').digest('hex').slice(0, 16);
  return path.join(AUTOSAVE_DIR, `${id}.json`);
}
function writeAutosave(reason: string): void {
  const file = autosaveFile(projectPath);
  if (!file || !autosaveOn || autosaveSuspended || !computeDirty() || !projectFile.length) return;
  const rev = stores.doc.revision();
  if (rev === autosavedRev) return;
  try {
    const doc = stores.doc.get();
    const slices: Slices = {};
    for (const k of projectFile) slices[k] = doc[k];
    const body = JSON.stringify({ kind: 'artlux-autosave', format: 1, projectPath, savedAt: new Date().toISOString(), slices });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, body);
    fs.renameSync(`${file}.tmp`, file);
    autosavedRev = rev;
    console.log(`[showHost] autosaved (${reason}): ${projectPath ?? 'untitled'} — ${Math.round(body.length / 1024)} kB`);
  } catch (e) {
    console.error('[showHost] autosave failed:', (e as Error).message);
  }
}
function deleteAutosave(p: string | null, why: string): void {
  const file = autosaveFile(p);
  if (!file) return;
  try { if (fs.existsSync(file)) { fs.unlinkSync(file); console.log(`[showHost] autosave retired (${why}): ${p ?? 'untitled'}`); } }
  catch (e) { console.warn('[showHost] could not delete autosave:', (e as Error).message); }
}
function readAutosave(p: string | null): { savedAt: string; slices: Slices } | null {
  const file = autosaveFile(p);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { kind?: string; format?: number; savedAt?: string; slices?: Slices };
    if (j.kind !== 'artlux-autosave' || j.format !== 1 || !j.savedAt || !j.slices) return null;
    // Stale: the file on disk was written after the autosave (saved elsewhere, or by another build).
    if (p && fs.existsSync(p) && fs.statSync(p).mtimeMs >= Date.parse(j.savedAt)) { deleteAutosave(p, 'older than the file'); return null; }
    return { savedAt: j.savedAt, slices: j.slices };
  } catch (e) {
    console.warn('[showHost] unreadable autosave ignored:', (e as Error).message);
    return null;
  }
}
setInterval(() => writeAutosave('timer'), AUTOSAVE_MS);

function publishDirty(always = false): void {
  const d = computeDirty();
  if (d === lastDirty && !always) return;
  lastDirty = d;
  for (const c of clients.values()) send(c, { t: 'dirty', dirty: d });
}
/** After a write, a moment later (a burst of writes is one evaluation). */
function scheduleDirty(): void {
  if (dirtyTimer) return;
  dirtyTimer = setTimeout(() => { dirtyTimer = null; publishDirty(); }, 150);
}

/** Restore a snapshot: write each slice that differs, and patch EVERY client (the asker included). */
function restore(snap: Slices): void {
  for (const k of undoable) {
    if (!(k in snap) || Object.is(stores.doc.getSlice(k), snap[k])) continue;
    stores.doc.set(k, snap[k]);
    for (const c of clients.values()) send(c, { t: 'patch', store: 'doc', key: k, value: snap[k], acked: c.lastSeq });
  }
  scheduleDirty();
}

function historyState(): void {
  for (const c of clients.values()) send(c, { t: 'historyState', canUndo: past.length > 0, canRedo: future.length > 0, depth: past.length });
}

function send(c: Client, msg: HostToClient): void {
  try { c.port.postMessage(msg); } catch (e) { console.warn(`[showHost] client ${c.id} send failed:`, (e as Error).message); }
}

/** Relay one accepted write to every OTHER client (the writer already shows it). */
function relay(from: Client, store: StoreName, key: string, value: unknown): void {
  for (const c of clients.values()) {
    if (c === from) continue;
    send(c, { t: 'patch', store, key, value, acked: c.lastSeq });
  }
}

function onMessage(c: Client, raw: unknown): void {
  const m = raw as ClientToHost;
  switch (m?.t) {
    case 'hello':
      c.role = m.role;
      // The editor names the undoable slices. A changed list means a different editor build: stacks
      // recorded over the old list would restore the wrong set of slices, so they are dropped.
      if (Array.isArray(m.undoable)) undoable = m.undoable.slice();
      if (Array.isArray(m.projectFile)) projectFile = m.projectFile.slice();
      // A new editor page also starts with no baseline: it opens a project and settles it.
      // …but first, keep what the page it replaces had not saved (a crashed renderer's last work).
      if (m.role === 'editor') {
        writeAutosave('editor page replaced');
        saved = null; forcedDirty = false; lastDirty = false;
        autosaveOn = m.autosave === true;
        autosaveSuspended = true;
      }
      // A NEW EDITOR PAGE STARTS A NEW HISTORY, as it did when the stacks lived in the page: a reload
      // (crash recovery, a dev reload) must not let Ctrl+Z restore a snapshot recorded against the
      // previous page's document. (A panel window joining, from W5, keeps the history.)
      if (m.role === 'editor') { past = []; future = []; historyState(); }
      return;
    case 'set': {
      if (m.store !== 'doc' && m.store !== 'session') return;
      c.lastSeq = m.seq;
      // Folded into the previous value: the parts that did not change keep their identity, so undo
      // snapshots share structure, and a write that changed nothing is a no-op (and is not relayed).
      const prev = stores[m.store].getSlice(m.key);
      const next = shareEqual(prev, m.value);
      if (Object.is(prev, next)) return;
      stores[m.store].set(m.key, next);
      relay(c, m.store, m.key, next);
      if (m.store === 'doc') scheduleDirty();
      return;
    }
    case 'baseline': {
      c.lastSeq = m.seq;
      const present = presentDoc(m.present ?? {}, projectFile);
      saved = {};
      for (const k of projectFile) saved[k] = digestOf(present[k]);
      forcedDirty = !!m.dirty;
      if (m.projectPath !== undefined) projectPath = m.projectPath;
      autosaveSuspended = false;
      if (m.save) { deleteAutosave(projectPath, 'saved'); autosavedRev = stores.doc.revision(); }
      publishDirty(true);
      return;
    }
    case 'loading':
      autosaveSuspended = true;
      return;
    case 'autosaveQuery':
      send(c, { t: 'autosaveFound', req: m.req, found: readAutosave(m.path) });
      return;
    case 'autosaveDiscard':
      deleteAutosave(m.path, 'discarded');
      return;
    case 'history': {
      c.lastSeq = m.seq;
      const present = presentDoc(m.present ?? {});
      if (m.op === 'record') {
        past.push(present);
        if (past.length > MAX_DEPTH) past = past.slice(past.length - MAX_DEPTH);
        future = [];
      } else if (m.op === 'undo') {
        const prev = past.pop();
        if (prev) { future.unshift(present); restore(prev); }
      } else if (m.op === 'redo') {
        const next = future.shift();
        if (next) {
          past.push(present);
          if (past.length > MAX_DEPTH) past = past.slice(past.length - MAX_DEPTH);
          restore(next);
        }
      } else if (m.op === 'reset') {
        past = []; future = [];
      }
      historyState();
      return;
    }
    case 'digest': {
      const digests: Record<string, string> = {};
      for (const name of ['doc', 'session'] as StoreName[]) {
        const all = stores[name].get();
        for (const k of Object.keys(all)) digests[`${name}.${k}`] = sliceDigest(all[k]);
      }
      const unsaved = saved ? projectFile.filter((k) => digestOf(stores.doc.getSlice(k)) !== saved![k]) : [];
      send(c, { t: 'digest', req: m.req, digests, unsaved });
      return;
    }
    default:
      console.warn('[showHost] unknown message', (raw as { t?: unknown })?.t);
  }
}

process.parentPort.on('message', (e) => {
  const msg = e.data as HostConnect;
  const port = e.ports[0] as unknown as PortLike | undefined;
  if (msg?.t !== 'connect' || !port) return;
  // A reconnect under the same id (a renderer reload) replaces the old client outright.
  clients.get(msg.clientId)?.port.close();
  const c: Client = { id: msg.clientId, port, lastSeq: 0, role: null };
  clients.set(c.id, c);
  port.on('message', (ev) => { try { onMessage(c, ev.data); } catch (err) { console.error('[showHost] message failed:', err); } });
  port.on('close', () => { if (clients.get(c.id) === c) clients.delete(c.id); });
  port.start();
  send(c, { t: 'welcome', clientId: c.id, pid: process.pid });
  console.log(`[showHost] client ${c.id} connected`);
});

console.log(`[showHost] up (pid ${process.pid})`);
