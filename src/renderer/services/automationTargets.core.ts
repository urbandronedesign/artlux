// The CORE automation provider: the visual params scenes/cues already address (surfaces, fixtures,
// globalBrightness). It reuses paramPath's dot-path grammar verbatim, so a lane and a cue entry name a
// param exactly the same way — one addressing language across the app.
//
// It writes to automationOverlay (render-free), never to React state. See automationOverlay.ts.
import type { AutomationTargetDef, AutomationTargetProvider } from '@artlux/sdk/renderer';
import type { StateView } from './paramPath';
import { getByPath, globalParams, surfaceParams, fixtureParams } from './paramPath';
import { profileOf } from './fixtureKind';
import * as overlay from './automationOverlay';

// The provider reads the live committed state through a getter the host keeps fresh, rather than holding
// a stale snapshot — the bed of surfaces/fixtures changes as the user edits.
let viewRef: () => StateView = () => ({ surfaces: [], fixtures: [], globalBrightness: 1 });
export function setCoreStateView(get: () => StateView): void { viewRef = get; }

// The ranges a lane draws its axis against (and, via `step`, quantizes and change-detects with). Cues
// need no range, which is why this table is new rather than reused from paramPath.
//
// GEOMETRY (x / y / width / height / rotation) IS DELIBERATELY ABSENT, for two reasons, both hard:
//   · A geometry leaf changes the LED↔surface UV mapping, so every frame it moves the GPU mapper must
//     rebuild — and on the WebGPU path that rebuild reallocates the readback cache, which would blank
//     the DMX output while the curve ran. Animating geometry needs the mapper to support an incremental
//     update; that is its own piece of work, not a range table.
//   · These values are NORMALIZED 0..1 (Surface/Fixture x,y,width,height are fractions of the stage,
//     not pixels), so a lane over them also needs the projector bridge to carry the animated value —
//     the projector windows self-render from the last COMMITTED config and never see a render-free
//     override.
// What is left below is exactly what is correct end-to-end today: the non-geometry leaves, which reach
// the output through mapper.updateParams + the composite, with no mapping rebuild.
// `display` is declared here too, though no entry uses one: these leaves are ALREADY authored in the
// unit they are stored in (a 0..1 opacity, a 0..4 speed), so a display map would be an identity. It
// keeps the two branches of the `??` below one type rather than a union the push site has to widen.
const RANGE: Record<string, { min: number; max: number; step: number; unit?: string; display?: { unit: string; min: number; max: number } }> = {
  intensity: { min: 0, max: 1, step: 0.01 },
  speed: { min: 0, max: 4, step: 0.01, unit: '×' },
  'content.opacity': { min: 0, max: 1, step: 0.01 },
  'content.intensity': { min: 0, max: 1, step: 0.01 },
  'content.speed': { min: 0, max: 4, step: 0.01, unit: '×' },
};

// A PROFILED FIXTURE'S CHANNEL RANGE CANNOT COME FROM THE TABLE ABOVE, because that table is keyed
// on the leaf NAME and every profile channel shares the same leaf shape (`dmx.<key>`) while meaning
// something different per fixture: Pan is 0..540°, Zoom 8..45°, a gobo wheel a list of slots.
//
// So resolve it from the profile instead.
//
// ⚠ THE STORED AXIS IS 0..1, NOT DEGREES, and that is deliberate. `min`/`max` on an
// AutomationTargetDef are not merely a drawing hint — compileAutomation CLAMPS every keyframe to
// them and then hands the result straight to provider.write(), which lands in `Fixture.dmx`
// (normalised 0..1, see the type). Publishing a Pan lane as 0..540 would therefore let the operator
// draw a curve to 540, clamp nothing, and write 540 into a field the packer treats as a fraction —
// pinning the head at its maximum for the whole curve.
//
// So storage stays 0..1 and the DISPLAY map carries the degrees: `display` is read only by the lane
// UI (axis readout, keyframe values, typed entry) and never by the clamp or by write(). That closes
// the split this comment used to describe as unfixable — a Pan lane read `0.50` while a pose key for
// the same channel read `270°`, two units for one thing — without moving a single stored number.
//
// What the profile DOES contribute is the step: one DMX byte for a discrete wheel (fractional slots
// are meaningless), and the channel's true resolution otherwise — which is also the epsilon the
// sampler change-detects on, so a 16-bit Pan is not quantised to 8-bit steps.
function profileChannelRange(
  view: StateView,
  path: string,
): { min: number; max: number; step: number; unit?: string; display?: { unit: string; min: number; max: number } } | null {
  const parts = path.split('.');                       // fixtures.<id>.dmx.<key>
  if (parts[0] !== 'fixtures' || parts[2] !== 'dmx' || !parts[3]) return null;
  const fixture = view.fixtures.find((f) => f.id === parts[1]);
  const profile = fixture ? profileOf(fixture, view.profiles) : undefined;
  const channel = profile?.channels.find((c) => c.key === parts[3]);
  if (!channel) return null;
  const step = channel.ranges?.length ? 1 / 255 : 1 / (256 ** channel.resolution - 1);
  // The channel's own declared physical range becomes the axis the operator reads — the same numbers
  // a pose key stores, so a Pan lane and a Pan key finally agree. Only when the profile actually
  // declares one: a channel with no physical range (a gobo wheel, a macro) has no honest unit to
  // show, and inventing one would be the "unit label that lies" this used to warn about.
  const display = Number.isFinite(channel.min) && Number.isFinite(channel.max) && channel.unit
    ? { unit: channel.unit, min: channel.min as number, max: channel.max as number }
    : undefined;
  return { min: 0, max: 1, step, display };
}

export const coreAutomationProvider: AutomationTargetProvider = {
  // paramPath's grammar spans three heads, and this provider owns all of them.
  namespaces: ['surfaces', 'fixtures', 'globalBrightness'],

  enumerate(): AutomationTargetDef[] {
    const view = viewRef();
    const out: AutomationTargetDef[] = [];
    const push = (path: string, label: string, group: string) => {
      // A lane needs a min/max to draw an axis against — a leaf with no range is not automatable in P4.
      const leaf = path.includes('.') ? path.split('.').slice(2).join('.') : 'intensity';
      const r = profileChannelRange(view, path) ?? RANGE[leaf] ?? RANGE[leaf.replace(/^segments\.\d+\./, '')];
      if (!r) return;
      const cur = getByPath(view, path);
      out.push({ path, label, group, min: r.min, max: r.max, step: r.step, unit: r.unit, display: r.display, def: typeof cur === 'number' ? cur : r.min });
    };
    for (const p of globalParams()) push(p.path, p.label, 'Global');
    for (const s of view.surfaces) for (const p of surfaceParams(s)) push(p.path, p.label, `Surface ▸ ${s.name ?? s.id}`);
    for (const f of view.fixtures) {
      const profile = profileOf(f, view.profiles);
      for (const p of fixtureParams(f, profile)) push(p.path, p.label, `Fixture ▸ ${f.name ?? f.id}`);
    }
    return out;
  },

  get(path: string): number | undefined {
    const v = getByPath(viewRef(), path);
    return typeof v === 'number' ? v : undefined;
  },

  write(path: string, value: number): void { overlay.set(path, value); },
  release(path: string): void { overlay.release(path); },
};
