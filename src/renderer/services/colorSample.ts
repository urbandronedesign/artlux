// A COLOUR LANE'S VALUE AT A TIME — the one sampler the engine (services/colorPlayback) and the timeline's
// colour rows both use, so a gradient strip can never draw a fade the rig does not play. Pure (moved out of
// colorPlayback for the detached timeline: a panel window may draw colour rows, and must not import the
// player, which subscribes to the transport). The palette is the CALLER's: the player passes the project's,
// the colour row the one it was handed.
import type { ColorKey, ColorLane, ColorValue, NamedColor } from '../types';
import { segmentEase } from './automation';
import { mixColor, resolveColorValue, temperatureColor } from './colorEngine';

/**
 * Interpolate one lane at `t`.
 *
 * Exported because the UI needs the identical answer — a gradient strip that sampled the curve any
 * other way would draw a fade the rig does not play, and "the picture disagrees with the wire" is
 * the bug class this app has already paid for twice.
 */
export function sampleColorLane(
  lane: ColorLane, t: number, cursor: { i: number } | undefined, pal: readonly NamedColor[],
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
  // Clamped: an overshooting ease (back, elastic) has no meaning past either colour — there is no
  // "more than the destination colour" to extrapolate to, only out-of-gamut values.
  const e = Math.min(1, Math.max(0, segmentEase(a, u)));

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
