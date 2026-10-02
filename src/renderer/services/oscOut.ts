// OSC TRACKS — the `osc` automation namespace. A timeline lane whose curve is SENT, not applied.
//
// An OSC track is an ordinary AutomationLane carrying an `osc` block (types.ts → OscTrackConfig): the
// engine samples it on the same clock, through the same sampler, with the same change detection as every
// other lane (timeline.ts compileAutomation / sampleAutomation). The only thing this file adds is the
// far end: where an audio lane's write() lands in a mixer override, an OSC track's lands HERE, and here
// turns it into a typed OSC message fanned out to every destination on the track — Arduino boards with
// Ethernet shields being the case it was built for.
//
// THE FRAME-LOOP CONTRACT STILL HOLDS. write() is called from inside the rAF loop, so it only records the
// number (no IPC, no allocation). The send happens in flush(), once per frame at most, as ONE IPC hop for
// every track that moved — main encodes and sends (the sandboxed renderer cannot open a UDP socket).
//
// WHAT IS DELIBERATELY NOT HERE: delivery. UDP has no receipt, and an Arduino sketch does not answer.
// What main CAN report — whether the OS accepted each datagram, or refused it with EHOSTUNREACH because
// no network card is on that board's subnet — comes back through `window.artlux.oscSendStatus()` and is
// shown in the track's settings. "Sent" means "left this machine", never "the LED turned on".
import type { AutomationTargetDef, AutomationTargetProvider } from '@artlux/sdk/renderer';
import type { AutomationLane, OscTrackConfig } from '../types';
import type { OscOutPacket, OscTypedArg } from '../../../shared/protocol';
import * as renderClock from '../engine/renderClock';

export const OSC_NAMESPACE = 'osc';
export const oscTargetPath = (laneId: string) => `${OSC_NAMESPACE}.${laneId}`;

/** "→ 192.168.10.177:8000 +2" — the gutter's one-line answer to "where does this go?". */
export function oscDestinationSummary(cfg: OscTrackConfig): string {
  const on = cfg.destinations.filter((d) => d.enabled !== false);
  if (on.length === 0) return 'no destination — sends nothing';
  return `→ ${on[0].host}:${on[0].port}${on.length > 1 ? ` +${on.length - 1}` : ''}`;
}

/**
 * The target def an OSC lane is drawn and compiled against — DERIVED from the lane's own block, never
 * enumerated (there is no other record of a device on the end of a cable). Undefined for a non-OSC lane.
 * `step` is what makes an int/bool track change-detect on whole values: the engine pushes only when the
 * sampled value moves by half a step, so a 0→1 linear ramp on a bool track sends exactly one message.
 */
export function oscLaneDef(lane: AutomationLane): AutomationTargetDef | undefined {
  const c = lane.osc;
  if (!c) return undefined;
  const whole = c.argType !== 'float';
  return {
    path: lane.targetPath,
    label: c.name || c.address,
    group: `OSC ${c.address} · ${oscDestinationSummary(c)}`,
    min: c.min,
    max: c.max,
    def: c.min,
    step: whole ? 1 : (c.max - c.min) / 1000,
    unit: c.argType === 'bool' ? undefined : c.argType === 'int' ? 'i' : 'f',
  };
}

/** The value as it goes on the wire: an int track rounds, a bool track thresholds at 0.5. */
export function oscQuantize(cfg: OscTrackConfig, v: number): number {
  if (cfg.argType === 'bool') return v >= 0.5 ? 1 : 0;
  if (cfg.argType === 'int') return Math.round(v);
  return v;
}
function oscArg(cfg: OscTrackConfig, q: number): OscTypedArg {
  if (cfg.argType === 'bool') return q ? { t: 'T' } : { t: 'F' };
  if (cfg.argType === 'int') return { t: 'i', v: q };
  return { t: 'f', v: q };
}
const targetsOf = (cfg: OscTrackConfig) =>
  cfg.destinations.filter((d) => d.enabled !== false).map((d) => ({ host: d.host, port: d.port }));

// ── Per-track runtime ───────────────────────────────────────────────────────────────────────────
interface TrackRT {
  cfg: OscTrackConfig;
  cfgKey: string;                       // identity of the config, so an EDIT forces a resend
  targets: { host: string; port: number }[];
  value: number;                        // last value the engine wrote (NaN ⇒ never)
  sent: number;                         // last QUANTIZED value put on the wire (NaN ⇒ never)
  lastSendMs: number;
  count: number;                        // messages sent by this track since it was bound (for the gutter)
}
const tracks = new Map<string, TrackRT>();
let pump: ReturnType<typeof setInterval> | null = null;

// The frame loop only calls frameEnd() on a frame where some lane WROTE, so the two sends that happen
// without a write — the trailing send a rate limit deferred, and the keep-alive resend — need their own
// tick. 25 ms is finer than any sane maxRate needs and costs nothing when no track exists (it is only
// running while one is bound).
function ensurePump(): void {
  if (tracks.size > 0 && !pump) pump = setInterval(flush, 25);
  else if (tracks.size === 0 && pump) { clearInterval(pump); pump = null; }
}

/**
 * Called by compileAutomation for every OSC lane it keeps. Re-binding an UNCHANGED config keeps the
 * track's state, so an unrelated timeline edit (which recompiles everything) does not re-blast every
 * board. A CHANGED config (new address, new board, new type) forgets what was sent so the current value
 * goes out again on the next frame — the new destination must not wait for the curve to move.
 */
export function bind(path: string, cfg: OscTrackConfig): void {
  const cfgKey = JSON.stringify(cfg);
  const rt = tracks.get(path);
  if (rt && rt.cfgKey === cfgKey) return;
  tracks.set(path, {
    cfg, cfgKey, targets: targetsOf(cfg),
    value: rt?.value ?? NaN, sent: NaN, lastSendMs: 0, count: rt?.count ?? 0,
  });
  ensurePump();
}

/**
 * Put every pending value on the wire, within each track's rate limit, plus any keep-alive that is due.
 * ONE IPC hop for the lot. Skipped entirely during an offline bake: the bake drives the clock at
 * render speed, not wall speed, and blinking the venue's hardware at that rate is not something anyone
 * asked a pre-render to do. Pending values are kept, so the first live frame after the bake catches up.
 */
export function flush(): void {
  if (tracks.size === 0 || renderClock.isOffline()) return;
  const now = performance.now();
  let out: OscOutPacket[] | null = null;
  for (const rt of tracks.values()) {
    if (Number.isNaN(rt.value) || rt.targets.length === 0) continue;
    const q = oscQuantize(rt.cfg, rt.value);
    const since = now - rt.lastSendMs;
    const changed = q !== rt.sent;
    const due = changed && since >= 1000 / (rt.cfg.maxRate || 30);
    const keepAlive = !changed && (rt.cfg.resendSec ?? 0) > 0 && since >= (rt.cfg.resendSec as number) * 1000;
    if (!due && !keepAlive) continue;
    rt.sent = q;
    rt.lastSendMs = now;
    rt.count++;
    (out ??= []).push({ targets: rt.targets, address: rt.cfg.address, args: [oscArg(rt.cfg, q)] });
  }
  if (out) window.artlux?.sendOscBatch?.(out);
}

/** Forget what a track last sent, so its current value goes out again now (the gutter's "Send now"). */
export function resend(path: string): void {
  const rt = tracks.get(path);
  if (!rt) return;
  rt.sent = NaN;
  rt.lastSendMs = 0;
  flush();
}

/**
 * Send ONE value to a config's destinations immediately, bypassing the lane — the settings popover's
 * test buttons. Works on a disabled track too (that is when you want it: "is the board even listening?").
 */
export function sendTest(cfg: OscTrackConfig, v: number): void {
  const targets = targetsOf(cfg);
  if (targets.length === 0) return;
  window.artlux?.sendOscBatch?.([{ targets, address: cfg.address, args: [oscArg(cfg, oscQuantize(cfg, v))] }]);
}

/** What this track last put on the wire, and how many messages — read by the gutter, render-free. */
export function trackStats(path: string): { sent: number; count: number } | null {
  const rt = tracks.get(path);
  return rt ? { sent: rt.sent, count: rt.count } : null;
}

export const oscAutomationProvider: AutomationTargetProvider = {
  namespaces: [OSC_NAMESPACE],
  // Empty ON PURPOSE: an OSC track is not a parameter you pick from the target picker, it is a lane you
  // create with "+ OSC" (Timeline.tsx). Its def comes from oscLaneDef(lane), which compileAutomation and
  // the lane renderer both call directly.
  enumerate(): AutomationTargetDef[] { return []; },
  get(): number | undefined { return undefined; },
  write(path: string, value: number): void {
    const rt = tracks.get(path);
    if (rt) rt.value = value;
  },
  // Lane deleted, disabled or dropped by a scene swap: stop sending. Nothing is sent on release — the
  // board keeps whatever it was last told, exactly as a DMX fixture keeps its last frame. A "go dark on
  // release" would be a guess about what the far end wants; put a key at the end of the curve instead.
  release(path: string): void {
    tracks.delete(path);
    ensurePump();
  },
  frameEnd(): void { flush(); },
};
