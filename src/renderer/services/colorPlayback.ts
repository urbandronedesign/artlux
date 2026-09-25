import type { ColorKey, ColorLane, ColorValue, Timeline } from '../types';
import { timeline as engine } from './timeline';
import { bezierEase, BEZ_DEFAULT } from './automation';
import { mixColor, temperatureColor } from './colorEngine';
import * as overlay from './colorOverlay';

// Replays COLOUR LANES during timeline playback: evaluate each fixture's colour at the playhead and
// publish it, as a colour, to colorOverlay.
//
// The twin of services/lightingPlayback, and written the same way on purpose — including the part
// that matters most: it subscribes to the playhead EVERY FRAME, even while paused, so SCRUBBING
// moves the rig. A colour is authored by dragging the playhead and looking at it.
//
// WHAT IT DELIBERATELY DOES NOT DO: solve. It publishes the authored colour and stops. The solve
// needs the target fixture's profile and mode, which only the packer has, and doing it here would
// mean either threading profiles into playback or guessing — see colorOverlay's header.

let data: Timeline | null = null;
let started = false;
let hadOutput = false;

// The sampler's cursor, per lane, exactly as lightingPlayback keeps one per (clip, fixture, role):
// steady playback then costs ~0 steps instead of a binary search per lane per frame.
const cursors = new Map<string, number>();
let laneKeys = '';

export function setData(t: Timeline | null): void { data = t; }

/**
 * Interpolate one lane at `t`.
 *
 * Exported because the UI needs the identical answer — a gradient strip that sampled the curve any
 * other way would draw a fade the rig does not play, and "the picture disagrees with the wire" is
 * the bug class this app has already paid for twice.
 */
export function sampleColorLane(lane: ColorLane, t: number): ColorValue | undefined {
  const keys = lane.keys;
  if (!keys.length || lane.enabled === false) return undefined;

  // HOLD BEFORE THE FIRST KEY AND AFTER THE LAST — the same rule sampleLane follows for automation.
  // It is what lets one key at t=0 mean "this fixture is this colour, for the whole show".
  if (t <= keys[0].t) return keys[0].value;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].value;

  let i = cursors.get(lane.id) ?? 0;
  if (i >= keys.length - 1 || keys[i].t > t) i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  cursors.set(lane.id, i);

  const a = keys[i], b = keys[i + 1];
  const span = b.t - a.t;
  if (span <= 0) return b.value;                 // coincident keys are a step, not a divide by zero
  if (a.curve === 'hold') return a.value;

  const u = (t - a.t) / span;
  // TIME EASING FIRST, COLOUR PATH SECOND. They are different axes: the curve decides how fast the
  // fade moves, the space decides which colours it moves through. Easing the parameter and then
  // interpolating in the chosen space composes them correctly and in one place.
  const e = a.curve === 'bezier'
    ? bezierEase(u, a.cx1 ?? BEZ_DEFAULT.cx1, a.cy1 ?? BEZ_DEFAULT.cy1, a.cx2 ?? BEZ_DEFAULT.cx2, a.cy2 ?? BEZ_DEFAULT.cy2)
    : u;

  return blend(a, b, e);
}

/**
 * Blend two colour keys.
 *
 * TWO TEMPERATURES STAY ON THE LINE. Converting them to RGB and back would let a warm→cold fade
 * bow off the warm-cold line through colours a tuneable-white fixture cannot make, and then land
 * near — but not on — the value that was authored at the far end. Only a mixed pair goes through
 * RGB, because that is the only case where there is no line to stay on.
 */
function blend(a: ColorKey, b: ColorKey, e: number): ColorValue {
  if (a.value.kind === 'cct' && b.value.kind === 'cct') {
    return { kind: 'cct', t: a.value.t + (b.value.t - a.value.t) * e };
  }
  const from = a.value.kind === 'rgb' ? a.value.rgb : temperatureColor(a.value.t);
  const to = b.value.kind === 'rgb' ? b.value.rgb : temperatureColor(b.value.t);
  const mixed = mixColor(from, to, e, a.space ?? 'oklab');
  return { kind: 'rgb', rgb: [mixed[0], mixed[1], mixed[2]] };
}

function tick(playhead: number): void {
  const lanes = (data?.colorLanes ?? []).filter((l) => l.enabled !== false && l.keys.length);

  // Nothing authored: publish one empty frame so the rig RELEASES back to its own values, then stop
  // writing. Without that trailing frame the last colour would stay latched forever — the stranded
  // value trap both other overlays document.
  if (!lanes.length) {
    if (hadOutput) { overlay.begin(); overlay.commit(); hadOutput = false; }
    if (cursors.size) cursors.clear();
    return;
  }

  // The lane set changing means the curves behind those cursors changed.
  const keys = lanes.map((l) => l.id).join(',');
  if (keys !== laneKeys) { cursors.clear(); laneKeys = keys; }

  overlay.begin();
  for (const lane of lanes) {
    const value = sampleColorLane(lane, playhead);
    if (value) overlay.set(lane.fixtureId, value);
  }
  overlay.commit();
  hadOutput = true;
}

/** Subscribe to the engine playhead. Main window only — call once. */
export function start(): void {
  if (started) return;
  started = true;
  engine.subscribe(tick);
}

export function stop(): void {
  overlay.clear();
  hadOutput = false;
  cursors.clear();
  laneKeys = '';
}
