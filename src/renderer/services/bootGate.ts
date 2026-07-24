// THE COLD-START GATE — "wait for the content, THEN play."
//
// Opening a project is asynchronous in every direction at once: blob reads over IPC, codec probes,
// <video> metadata + first-frame seeks, image decodes, audio conforms. Everything that kicks those is
// fire-and-forget (timeline.warmPool, contentSource.acquire), so before this module existed the show
// started on the very next frame: applyProjectData → the engine's FSM tick → the initial state's
// `play` entry action → the transport running over decoders that held NOTHING. A <video> under
// readyState 2 is undrawable and buildProgram clears to black, so the opening seconds went out BLACK,
// on the projectors and on the Art-Net alike, and an 'afterDelay' on the opening state burned its
// dwell while the audience looked at nothing.
//
// So: on every project open the FSM is HELD (timeline.setArmed(false)) and this module polls the
// things that have to be resident before frame 0. When they are — or when the venue's patience runs
// out — it arms, and the show starts against decoders that are actually holding pictures.
//
// WHAT IT WAITS FOR (and just as importantly, what it does NOT):
//   · the opening scene's timeline pool — the first frame of each layer          (timeline.poolReady)
//   · the loaded surfaces' own VIDEO/IMAGE media                              (surfaceMedia.pendingMedia)
//   · anything a plugin registers as a probe — today the audio plugin's conforms + engine loads
//   · LIVE sources (camera / NDI / Spout / DMX-in / tracking) are NEVER waited on. They may legitimately
//     never arrive, and a gate that blocked on one would hold a venue dark because a sending machine
//     was off. Same for a missing file: see the timeout.
//
// IT FAILS OPEN, ALWAYS. The deadline is a hard promise: a venue must never stay dark because one
// asset is unreadable. On expiry we arm anyway and name what never came, at error level, so the log
// says why the show opened on black instead of leaving someone to guess.
//
// It holds ONLY the state machine. Stage keeps compositing and publishing `dmx:frame` throughout (it
// must — unmounting it stops Art-Net), the surfaces show whatever they have, and the warm pool has
// already parked each layer on its first frame. A human pressing Play during the hold arms it
// immediately: an explicit operator action outranks a preload.

import { timeline as engine } from './timeline';
import * as surfaceMedia from './surfaceMedia';
import type { Surface, Timeline } from '../types';

// A readiness contributor. `pending` names what is still missing (shown in the status chip and in the
// timeout log); an empty/absent list with ready:false still holds, it just can't say why.
export type ReadyProbe = () => { ready: boolean; pending?: string[] };

export interface BootProgress {
  booting: boolean;    // the gate is holding the show right now
  ready: number;       // items resolved (of `total`)
  total: number;       // the workload measured on the first poll — 0 when nothing had to load
  pending: string[];   // what is still missing (capped for display)
  elapsedSec: number;
  timedOut: boolean;   // armed by the deadline rather than by everything being ready
  // WHY the gate released, on the notification that releases it (null while holding, and before the
  // first project is opened). It is the difference between a show STARTING — which should begin at the
  // top — and an operator who reached past the wait and pressed Play, whose playhead is theirs.
  armedBy: 'ready' | 'timeout' | 'manual' | null;
}

const DEFAULT_TIMEOUT_SEC = 15;
const POLL_MS = 100;
const MAX_LISTED = 12; // a project with 400 unreadable clips must not build a 400-line log line

let timeoutSec = DEFAULT_TIMEOUT_SEC;
let spec: { poolKey: string; timeline: Timeline; surfaces: Surface[] } | null = null;
let startMs = 0;
let poll = 0;
let total = 0;          // workload measured on the first poll; 0 until measured
let measured = false;
let pending: string[] = [];
let timedOut = false;
let armedBy: BootProgress['armedBy'] = null;

const probes = new Map<string, ReadyProbe>();
const subs = new Set<(p: BootProgress) => void>();

const progress = (): BootProgress => ({
  booting: !!spec,
  ready: Math.max(0, total - pending.length),
  total,
  pending,
  elapsedSec: spec ? (performance.now() - startMs) / 1000 : 0,
  timedOut,
  armedBy,
});

const notify = (): void => { const p = progress(); subs.forEach(cb => cb(p)); };

// How long the venue waits before the show starts anyway. Pushed by App from AppSettings, and read
// LAZILY on every poll rather than captured at hold(): in broadcast the machine's real prefs arrive
// asynchronously and can land AFTER the project they configure.
export function setTimeoutSec(sec: number): void {
  timeoutSec = Number.isFinite(sec) && sec > 0 ? sec : DEFAULT_TIMEOUT_SEC;
}

// Register a readiness contributor (plugins reach this through `host.boot`). Called at activation, so
// it survives every project open; returns an unregister for symmetry with the other registries.
export function registerProbe(id: string, probe: ReadyProbe): () => void {
  probes.set(id, probe);
  return () => { probes.delete(id); };
}

function collect(): string[] {
  if (!spec) return [];
  const out: string[] = [];
  // The opening scene's timeline: re-drives its pre-roll as it measures (see poolReadiness).
  out.push(...engine.poolReady(spec.poolKey, spec.timeline).pending);
  out.push(...surfaceMedia.pendingMedia(spec.surfaces));
  for (const [id, probe] of probes) {
    let r: { ready: boolean; pending?: string[] };
    // A throwing probe must not wedge the gate — a plugin's readiness bug is not a reason to hold a
    // show. Treat it as ready and say so once per poll (the log is the venue's only witness).
    try { r = probe(); } catch (e) { console.warn(`[boot] probe "${id}" threw — ignoring it`, e); continue; }
    if (!r.ready) out.push(...(r.pending?.length ? r.pending : [id]));
  }
  return out;
}

function tick(): void {
  if (!spec) return;
  pending = collect();
  // The workload is whatever was outstanding on the FIRST poll — measured a beat after the open, by
  // which time Stage has run one tick and acquired the surfaces' content sources. Before that
  // everything reads "not ready" for a reason that has nothing to do with decoding.
  if (!measured) { measured = true; total = pending.length; }
  const elapsed = (performance.now() - startMs) / 1000;
  if (pending.length === 0) { finish(false, elapsed); return; }
  if (elapsed >= timeoutSec) { finish(true, elapsed); return; }
  notify();
}

function finish(byTimeout: boolean, elapsedSec: number): void {
  const outstanding = pending.slice(0, MAX_LISTED);
  const more = pending.length - outstanding.length;
  timedOut = byTimeout;
  armedBy = byTimeout ? 'timeout' : 'ready';
  if (byTimeout) {
    // ERROR, not warn: the show is about to open on a hole. This line is what the venue log will be
    // read for the morning after.
    console.error(
      `[boot] armed by TIMEOUT after ${elapsedSec.toFixed(1)}s — ${pending.length} item(s) never became ready: ` +
      `${outstanding.join(', ')}${more > 0 ? `, +${more} more` : ''}`,
    );
  } else if (total > 0) {
    console.log(`[boot] content ready in ${elapsedSec.toFixed(1)}s (${total} item(s)) — arming the show`);
  }
  release();
}

// Drop the hold and let the machine run. Idempotent.
function release(): void {
  if (poll) { clearInterval(poll); poll = 0; }
  spec = null;
  pending = [];
  engine.setArmed(true);
  notify();
}

// HOLD THE SHOW: called from applyProjectData with the look the project opens on — the scene the FSM's
// initial state is bound to (its pool key + timeline) and the project's surfaces. Every cold start
// funnels through there (editor open, --project=, the watchdog's relaunch, the playlist's next show),
// so this one call site covers all of them. Re-holding while already holding restarts the wait against
// the new project, which is exactly right for a playlist switch.
export function hold(next: { poolKey: string; timeline: Timeline; surfaces: Surface[] }): void {
  spec = next;
  startMs = performance.now();
  measured = false;
  total = 0;
  timedOut = false;
  armedBy = null;
  pending = [];
  engine.setArmed(false);
  if (poll) clearInterval(poll);
  poll = window.setInterval(tick, POLL_MS);
  notify();
  // First measurement on the NEXT poll, not now: contentSource.acquire runs from Stage's tick, so
  // "nothing is ready" is guaranteed and meaningless on this frame.
}

// Arm immediately, whatever is still loading — an explicit operator action (pressing Play, a manual
// GO) outranks a preload. No-op when nothing is held.
export function armNow(reason: string): void {
  if (!spec) return;
  console.log(`[boot] armed early: ${reason}`);
  armedBy = 'manual';
  release();
}

export function subscribe(cb: (p: BootProgress) => void): () => void {
  subs.add(cb);
  cb(progress());
  return () => { subs.delete(cb); };
}

export const get = (): BootProgress => progress();
export const isBooting = (): boolean => !!spec;
