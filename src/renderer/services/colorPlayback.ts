import type {
  ColorKey, ColorLane, ColorValue, Fixture, FixtureGroup, NamedColor, Timeline,
} from '../types';
import { timeline as engine } from './timeline';
import { bezierEase, BEZ_DEFAULT } from './automation';
import { mixColor, resolveColorValue, temperatureColor } from './colorEngine';
import { phaseOffset } from './lightingTake';
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
let fixtures: Fixture[] = [];
let groups: FixtureGroup[] = [];
// The project's named colours. Resolved HERE, so everything downstream — the overlay, the packer,
// the solver's memo — only ever sees an actual colour and knows nothing about the palette.
let palette: readonly NamedColor[] = [];
let started = false;
let hadOutput = false;

// The sampler's cursor, per lane, exactly as lightingPlayback keeps one per (clip, fixture, role):
// steady playback then costs ~0 steps instead of a binary search per lane per frame.
const cursors = new Map<string, { i: number }>();
let laneKeys = '';

function cursorFor(laneId: string, slot: number): { i: number } {
  const key = `${laneId}|${slot}`;
  let c = cursors.get(key);
  if (!c) { c = { i: 0 }; cursors.set(key, c); }
  return c;
}

export function setData(t: Timeline | null): void { data = t; }

/**
 * The rig a GROUP lane resolves against. Kept fresh rather than captured, because a lane names a
 * group and the group's membership — and its ORDER, which is the spread axis — is edited live.
 */
export function setRig(f: Fixture[], g: FixtureGroup[]): void { fixtures = f; groups = g; }

/** The project's named colours, kept fresh so retuning one moves every key that references it. */
export function setPalette(p: readonly NamedColor[]): void { palette = p; }

/**
 * The fixtures a lane drives, in the group's OWN order.
 *
 * Mapped through the group's id list rather than filtering `fixtures`, for the reason
 * lightingPlayback documents: filtering would silently re-sort the spread into fixture-list order,
 * and order is the show.
 */
function targetsOf(lane: ColorLane): Fixture[] {
  if (lane.fixtureId) {
    const f = fixtures.find((x) => x.id === lane.fixtureId);
    return f ? [f] : [];
  }
  const g = groups.find((x) => x.id === lane.groupId);
  if (!g) return [];
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  return g.fixtureIds.map((id) => byId.get(id)).filter((f): f is Fixture => !!f);
}

/**
 * Interpolate one lane at `t`.
 *
 * Exported because the UI needs the identical answer — a gradient strip that sampled the curve any
 * other way would draw a fade the rig does not play, and "the picture disagrees with the wire" is
 * the bug class this app has already paid for twice.
 */
export function sampleColorLane(
  lane: ColorLane, t: number, cursor?: { i: number }, pal: readonly NamedColor[] = palette,
): ColorValue | undefined {
  const keys = lane.keys;
  if (!keys.length || lane.enabled === false) return undefined;

  // HOLD BEFORE THE FIRST KEY AND AFTER THE LAST — the same rule sampleLane follows for automation.
  // It is what lets one key at t=0 mean "this fixture is this colour, for the whole show".
  if (t <= keys[0].t) return resolveColorValue(keys[0].value, pal);
  if (t >= keys[keys.length - 1].t) return resolveColorValue(keys[keys.length - 1].value, pal);

  // THE CALLER BRINGS ITS OWN CURSOR. The engine keeps one per lane and walks it forward a frame at
  // a time; the UI sweeps the whole visible width every repaint to paint the gradient. Sharing one
  // would have the strip's sweep drag the engine's cursor backwards on every draw — still correct
  // (the search below re-seeks) but silently O(n) again, which is the regression nothing reports.
  let i = cursor ? cursor.i : 0;
  if (i < 0 || i >= keys.length - 1 || keys[i].t > t) i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  if (cursor) cursor.i = i;

  const a = keys[i], b = keys[i + 1];
  // Resolved BEFORE anything is blended. An unresolved reference drives nothing — so a segment with
  // a missing colour at either end goes quiet rather than fading to or from an invented one.
  const av = resolveColorValue(a.value, pal);
  const bv = resolveColorValue(b.value, pal);
  if (!av || !bv) return undefined;
  const span = b.t - a.t;
  if (span <= 0) return bv;                      // coincident keys are a step, not a divide by zero
  if (a.curve === 'hold') return av;

  const u = (t - a.t) / span;
  // TIME EASING FIRST, COLOUR PATH SECOND. They are different axes: the curve decides how fast the
  // fade moves, the space decides which colours it moves through. Easing the parameter and then
  // interpolating in the chosen space composes them correctly and in one place.
  const e = a.curve === 'bezier'
    ? bezierEase(u, a.cx1 ?? BEZ_DEFAULT.cx1, a.cy1 ?? BEZ_DEFAULT.cy1, a.cx2 ?? BEZ_DEFAULT.cx2, a.cy2 ?? BEZ_DEFAULT.cy2)
    : u;

  return blend(av, bv, a.space ?? 'oklab', e);
}

/**
 * Blend two colour keys.
 *
 * TWO TEMPERATURES STAY ON THE LINE. Converting them to RGB and back would let a warm→cold fade
 * bow off the warm-cold line through colours a tuneable-white fixture cannot make, and then land
 * near — but not on — the value that was authored at the far end. Only a mixed pair goes through
 * RGB, because that is the only case where there is no line to stay on.
 */
function blend(av: ColorValue, bv: ColorValue, space: NonNullable<ColorKey['space']>, e: number): ColorValue {
  if (av.kind === 'cct' && bv.kind === 'cct') {
    return { kind: 'cct', t: av.t + (bv.t - av.t) * e };
  }
  const from = av.kind === 'rgb' ? av.rgb : temperatureColor(av.t);
  const to = bv.kind === 'rgb' ? bv.rgb : temperatureColor(bv.t);
  const mixed = mixColor(from, to, e, space);
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
    // A single-fixture lane goes through this same path — one target, no phase, no stagger. One code
    // path for both means a group lane cannot drift from the thing it generalises.
    const targets = targetsOf(lane);
    for (let i = 0; i < targets.length; i++) {
      // ⚠ A CURSOR PER (LANE, SLOT). With a phase, slot i is sampled at a DIFFERENT time from slot
      // i+1, so a cursor shared across the group would ping-pong between positions every frame —
      // still correct (the sampler re-seeks) but silently O(n), the regression nothing reports.
      // lightingPlayback's cursor pool is keyed per (clip, fixture, role) for exactly this reason.
      const at = playhead - phaseOffset(lane, i, targets.length);
      const value = sampleColorLane(lane, at, cursorFor(lane.id, i));
      if (value) overlay.set(targets[i].id, value);
    }
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
