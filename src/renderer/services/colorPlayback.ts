import type {
  ColorKey, ColorLane, ColorValue, Fixture, FixtureGroup, NamedColor, Timeline,
} from '../types';
import { timeline as engine } from './timeline';
import { sampleColorLane as sampleColorLaneIn } from './colorSample';
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

/** E3e: what this player evaluates — for the native engine, which evaluates the same (engine light.rs). */
export function nativeState(): { data: Timeline | null; fixtures: Fixture[]; groups: FixtureGroup[]; palette: readonly NamedColor[]; started: boolean } {
  return { data, fixtures, groups, palette, started };
}

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

/** One lane at `t`, against the project's palette (services/colorSample — the sampler the UI draws with too). */
export function sampleColorLane(lane: ColorLane, t: number, cursor?: { i: number }, pal: readonly NamedColor[] = palette): ColorValue | undefined {
  return sampleColorLaneIn(lane, t, cursor, pal);
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
