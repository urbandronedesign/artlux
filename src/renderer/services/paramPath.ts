import type { Surface, Fixture } from '../types';

// Parameter-addressing layer for Scenes & Cues. A "path" is a dot-string addressing one
// controllable parameter on the live state view, e.g.:
//   globalBrightness
//   surfaces.<id>.x | surfaces.<id>.content.opacity | surfaces.<id>.content.intensity
//   fixtures.<id>.rotation | fixtures.<id>.intensity | fixtures.<id>.segments.0.speed
//
// getByPath/setByPath operate on a thin StateView (copy-on-write, immutable) so the transition
// engine can layer interpolated values over the committed state without mutating it. The registry
// classifies leaves as fadeable numerics (interpolated over a fade) vs discrete (snapped).

// The slice of app state cues/scenes address. Phase-1 fades touch only the main-render slice
// (surfaces, fixtures, globalBrightness); scene3D/projectorOutputs are reserved for later.
export interface StateView {
  surfaces: Surface[];
  fixtures: Fixture[];
  globalBrightness: number;
}

export type ParamCategory = 'surface' | 'fixture' | 'global';

// Leaf keys (relative to a surface/fixture) that fade. Everything else snaps.
const SURFACE_FADEABLE = ['x', 'y', 'width', 'height', 'rotation', 'content.opacity', 'content.speed', 'content.intensity'];
const FIXTURE_FADEABLE = ['x', 'y', 'width', 'height', 'rotation', 'speed', 'intensity'];
// Geometry leaves change LED↔surface UV mapping, so the GPU mapper must rebuild while they animate.
const GEOMETRY_LEAVES = new Set(['x', 'y', 'width', 'height', 'rotation']);

export function isGeometryPath(path: string): boolean {
  const leaf = path.split('.').slice(2).join('.'); // strip "surfaces.<id>." / "fixtures.<id>."
  return GEOMETRY_LEAVES.has(leaf) || GEOMETRY_LEAVES.has(path);
}

// Whether a path addresses a fadeable numeric parameter (else a cue entry snaps on fire).
export function isFadeablePath(path: string): boolean {
  if (path === 'globalBrightness') return true;
  const head = path.split('.')[0];
  const leaf = path.split('.').slice(2).join('.');
  if (head === 'surfaces') return SURFACE_FADEABLE.includes(leaf);
  if (head === 'fixtures') return FIXTURE_FADEABLE.includes(leaf) || /^segments\.\d+\.(speed|intensity)$/.test(leaf);
  return false;
}

// Read a value at a dot-path from the state view (numeric leaves only matter for fades).
export function getByPath(view: StateView, path: string): number | string | boolean | null | undefined {
  const parts = path.split('.');
  if (parts[0] === 'globalBrightness') return view.globalBrightness;
  if (parts[0] === 'surfaces' || parts[0] === 'fixtures') {
    const list = parts[0] === 'surfaces' ? view.surfaces : view.fixtures;
    const obj = list.find(o => o.id === parts[1]);
    if (!obj) return undefined;
    return descend(obj as unknown as Record<string, unknown>, parts.slice(2));
  }
  return undefined;
}

function descend(obj: Record<string, unknown>, keys: string[]): number | string | boolean | null | undefined {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur as number | string | boolean | null | undefined;
}

// Immutably set a value at a dot-path, copying only the objects/arrays along the way.
export function setByPath(view: StateView, path: string, value: number | string | boolean | null): StateView {
  const parts = path.split('.');
  if (parts[0] === 'globalBrightness') return { ...view, globalBrightness: value as number };
  if (parts[0] === 'surfaces' || parts[0] === 'fixtures') {
    const isSurf = parts[0] === 'surfaces';
    const list = isSurf ? view.surfaces : view.fixtures;
    const idx = list.findIndex(o => o.id === parts[1]);
    if (idx < 0) return view;
    const nextObj = setIn(list[idx] as unknown as Record<string, unknown>, parts.slice(2), value);
    const nextList = list.slice();
    nextList[idx] = nextObj as unknown as (Surface & Fixture);
    return isSurf ? { ...view, surfaces: nextList as Surface[] } : { ...view, fixtures: nextList as Fixture[] };
  }
  return view;
}

// Copy-on-write set into a nested object, handling numeric array indices (e.g. segments.0.speed).
function setIn(obj: Record<string, unknown>, keys: string[], value: unknown): Record<string, unknown> {
  if (keys.length === 0) return obj;
  const [k, ...rest] = keys;
  const asIdx = Number(k);
  if (Array.isArray(obj)) {
    const arr = (obj as unknown[]).slice();
    arr[asIdx] = rest.length === 0 ? value : setIn((arr[asIdx] ?? {}) as Record<string, unknown>, rest, value);
    return arr as unknown as Record<string, unknown>;
  }
  const copy = { ...obj };
  copy[k] = rest.length === 0 ? value : setIn((copy[k] ?? {}) as Record<string, unknown>, rest, value);
  return copy;
}

// --- Cuable parameter catalog (for authoring cues by capturing current values) ---
export interface ParamDef { path: string; label: string }

export function globalParams(): ParamDef[] {
  return [{ path: 'globalBrightness', label: 'LED Brightness' }];
}

export function surfaceParams(s: Surface): ParamDef[] {
  const id = s.id;
  const defs: ParamDef[] = [
    { path: `surfaces.${id}.x`, label: 'X' },
    { path: `surfaces.${id}.y`, label: 'Y' },
    { path: `surfaces.${id}.width`, label: 'Width' },
    { path: `surfaces.${id}.height`, label: 'Height' },
    { path: `surfaces.${id}.rotation`, label: 'Rotation' },
    { path: `surfaces.${id}.content.opacity`, label: 'Opacity' },
  ];
  if (s.content.type === 'EFFECT') {
    defs.push(
      { path: `surfaces.${id}.content.speed`, label: 'FX Speed' },
      { path: `surfaces.${id}.content.intensity`, label: 'FX Intensity' },
      { path: `surfaces.${id}.content.effectId`, label: 'Effect' },
      { path: `surfaces.${id}.content.paletteId`, label: 'Palette' },
    );
  }
  return defs;
}

export function fixtureParams(f: Fixture): ParamDef[] {
  const id = f.id;
  return [
    { path: `fixtures.${id}.x`, label: 'X' },
    { path: `fixtures.${id}.y`, label: 'Y' },
    { path: `fixtures.${id}.width`, label: 'Width' },
    { path: `fixtures.${id}.height`, label: 'Height' },
    { path: `fixtures.${id}.rotation`, label: 'Rotation' },
  ];
}

export interface FadeTarget { path: string; from: number; to: number }

// Diff two state views into the fadeable numeric targets that differ (matched by object id).
// Discrete params and structural differences are NOT returned — callers snap those by committing
// the full target state. Used by scene recall (and later, cue apply).
export function collectFadeableTargets(from: StateView, to: StateView): FadeTarget[] {
  const out: FadeTarget[] = [];
  const push = (path: string) => {
    const a = getByPath(from, path), b = getByPath(to, path);
    if (typeof a === 'number' && typeof b === 'number' && isFinite(a) && isFinite(b) && a !== b) {
      out.push({ path, from: a, to: b });
    }
  };
  if (from.globalBrightness !== to.globalBrightness) push('globalBrightness');
  for (const s of to.surfaces) {
    if (!from.surfaces.some(x => x.id === s.id)) continue;
    for (const leaf of SURFACE_FADEABLE) push(`surfaces.${s.id}.${leaf}`);
  }
  for (const f of to.fixtures) {
    const fromF = from.fixtures.find(x => x.id === f.id);
    if (!fromF) continue;
    for (const leaf of FIXTURE_FADEABLE) push(`fixtures.${f.id}.${leaf}`);
    const segs = Math.min(f.segments?.length ?? 0, fromF.segments?.length ?? 0);
    for (let i = 0; i < segs; i++) { push(`fixtures.${f.id}.segments.${i}.speed`); push(`fixtures.${f.id}.segments.${i}.intensity`); }
  }
  return out;
}
