// The CORE automation provider: the visual params scenes/cues already address (surfaces, fixtures,
// globalBrightness). It reuses paramPath's dot-path grammar verbatim, so a lane and a cue entry name a
// param exactly the same way — one addressing language across the app.
//
// It writes to automationOverlay (render-free), never to React state. See automationOverlay.ts.
import type { AutomationTargetDef, AutomationTargetProvider } from '@artlux/sdk/renderer';
import type { StateView } from './paramPath';
import { getByPath, globalParams, surfaceParams, fixtureParams } from './paramPath';
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
const RANGE: Record<string, { min: number; max: number; step: number; unit?: string }> = {
  intensity: { min: 0, max: 1, step: 0.01 },
  speed: { min: 0, max: 4, step: 0.01, unit: '×' },
  'content.opacity': { min: 0, max: 1, step: 0.01 },
  'content.intensity': { min: 0, max: 1, step: 0.01 },
  'content.speed': { min: 0, max: 4, step: 0.01, unit: '×' },
};

export const coreAutomationProvider: AutomationTargetProvider = {
  // paramPath's grammar spans three heads, and this provider owns all of them.
  namespaces: ['surfaces', 'fixtures', 'globalBrightness'],

  enumerate(): AutomationTargetDef[] {
    const view = viewRef();
    const out: AutomationTargetDef[] = [];
    const push = (path: string, label: string, group: string) => {
      // A lane needs a min/max to draw an axis against — a leaf with no range is not automatable in P4.
      const leaf = path.includes('.') ? path.split('.').slice(2).join('.') : 'intensity';
      const r = RANGE[leaf] ?? RANGE[leaf.replace(/^segments\.\d+\./, '')];
      if (!r) return;
      const cur = getByPath(view, path);
      out.push({ path, label, group, min: r.min, max: r.max, step: r.step, unit: r.unit, def: typeof cur === 'number' ? cur : r.min });
    };
    for (const p of globalParams()) push(p.path, p.label, 'Global');
    for (const s of view.surfaces) for (const p of surfaceParams(s)) push(p.path, p.label, `Surface ▸ ${s.name ?? s.id}`);
    for (const f of view.fixtures) for (const p of fixtureParams(f)) push(p.path, p.label, `Fixture ▸ ${f.name ?? f.id}`);
    return out;
  },

  get(path: string): number | undefined {
    const v = getByPath(viewRef(), path);
    return typeof v === 'number' ? v : undefined;
  },

  write(path: string, value: number): void { overlay.set(path, value); },
  release(path: string): void { overlay.release(path); },
};
