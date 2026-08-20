import type { Surface, Fixture, FixtureProfile } from '../types';

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
  /**
   * Resolved DMX fixture profiles by id. OPTIONAL, and it must stay optional: StateView is built at
   * nine sites, two of them inside Stage's rAF tick, and widening it to a required field would
   * churn all of them for a rig that usually has no profiled fixtures at all. Absent simply means
   * "no profile channels in the catalogue" — the geometry params still enumerate normally.
   */
  profiles?: ReadonlyMap<string, FixtureProfile>;
}

export type ParamCategory = 'surface' | 'fixture' | 'global';

// Leaf keys (relative to a surface/fixture) that fade. Everything else snaps.
const SURFACE_FADEABLE = ['x', 'y', 'width', 'height', 'rotation', 'content.opacity', 'content.speed', 'content.intensity'];
const FIXTURE_FADEABLE = ['x', 'y', 'width', 'height', 'rotation', 'speed', 'intensity'];
// Geometry leaves change LED↔surface UV mapping, so the GPU mapper must rebuild while they animate.
const GEOMETRY_LEAVES = new Set(['x', 'y', 'width', 'height', 'rotation']);

// THE PATH GRAMMAR, IN ONE FUNCTION.
//
// Core paths are `<head>.<id>.<leaf…>`  (surfaces.s1.content.opacity)   → the leaf starts at index 2.
// Audio paths are ONE SEGMENT DEEPER:
//     audio.clip.<id>.<leaf…>     audio.track.<id>.<leaf…>              → the leaf starts at index 3
//     audio.master.<leaf…>                                              → the leaf starts at index 2
// (the master is a singleton — it has no id — which is why it is not uniformly index 3).
//
// Every leaf extractor in the app used a bare `.slice(2)`, so every one of them was wrong for audio
// (`audio.master.gain` read as the leaf `gain` on an owner called `master` only by accident; the clip form
// `audio.clip.c7.gain` read as the leaf `c7.gain`). This is the single head-aware replacement; use it,
// never slice(2), for anything that must work across heads.
export function pathLeaf(path: string): string {
  const p = path.split('.');
  if (p[0] !== 'audio') return p.slice(2).join('.');
  if (p[1] === 'master') return p.slice(2).join('.');   // audio.master.gain → 'gain'
  return p.slice(3).join('.');                           // audio.clip.c7.fx.e2.cutoff → 'fx.e2.cutoff'
}

export function isGeometryPath(path: string): boolean {
  const leaf = pathLeaf(path); // strips "surfaces.<id>." / "fixtures.<id>." / "audio.<kind>.<id>."
  return GEOMETRY_LEAVES.has(leaf) || GEOMETRY_LEAVES.has(path);
}

// Continuous audio leaves ONLY. Never a discrete `opts` mode (filter.mode = 'lowpass'), which the fade
// engine would hand `0.37` — AudioEffect.opts is typed as strings ON PURPOSE to make that unrepresentable.
// Never a chain's length, never spatial on/off: each changes the SHAPE of the engine's chain and forces a
// rebuild (a spatial flip changes its channel count 2⇔1), and a rebuild allocates.
//   audio.clip.<id>.gain          audio.track.<id>.gain          audio.master.gain
//   audio.clip.<id>.spatial.{angle|elevation|attenuation}   (and the legacy {x|y|z} — see below)
//   audio.clip.<id>.fx.<effectId>.<param>                        audio.master.fx.<effectId>.<param>
//
// ⚠ HARD CONSTRAINT ON EVERY CALLER: the `fx.<id>.<key>` arm CANNOT tell a continuous param from a discrete
// `opts` key — `fx.e2.cutoff` and `fx.e2.mode` are the same shape, and core must not import the plugin's
// effect defs to tell them apart (that is the whole point of the namespace boundary). So a PATH MUST NEVER
// BE HAND-TYPED OR FREE-TEXTED INTO A CUE/SCENE ENTRY. Every audio path an entry can carry must come from
// `provider.enumerate()`, which emits `def.params` and NOTHING else — never `opts`, never mute/solo, never
// the spatial flag. That is the only thing standing between this regex and the fade engine handing a
// filter's `mode` the value 0.37. isFadeablePath is a GATE, not a catalog; enumerate() is the catalog.
// ⚠ BOTH SPELLINGS OF A POSITION ARE ADMITTED, AND ONLY ONE IS OFFERED.
//
// `angle|elevation|attenuation` is the model (shared/spatial.ts). `x|y|z` is what documents written
// before it carry, and dropping it here would silently break every cue and lane already authored
// against a position — this regex is the GATE deciding whether an entry FADES or SNAPS, so a path
// falling out of it does not error, it just starts jumping. The plugin's enumerate() no longer offers
// the old spelling, so nothing NEW can be written against it; this keeps what exists working.
export const AUDIO_FADEABLE_RE = /^(gain|spatial\.(angle|elevation|attenuation|[xyz])|fx\.[^.]+\.[^.]+)$/;

// Whether a path addresses a fadeable numeric parameter (else a cue entry snaps on fire).
export function isFadeablePath(path: string): boolean {
  if (path === 'globalBrightness') return true;
  const head = path.split('.')[0];
  const leaf = pathLeaf(path);
  if (head === 'surfaces') return SURFACE_FADEABLE.includes(leaf);
  // A profiled fixture's channels (`dmx.<key>`) are continuous 0..1 and fade cleanly — that is what
  // makes a Pan crossfade rather than snap on a scene recall.
  //
  // A DISCRETE channel (a gobo or colour wheel) is deliberately still listed here, because the
  // caller cannot tell them apart from the path alone and the alternative — snapping every wheel —
  // is the worse default: interpolating across a wheel steps through the intermediate slots, which
  // is how a real wheel physically moves anyway. A slot-aware "snap" belongs in the UI that authors
  // the value, not in the fade engine.
  if (head === 'fixtures') {
    return FIXTURE_FADEABLE.includes(leaf)
      || /^segments\.\d+\.(speed|intensity)$/.test(leaf)
      || /^dmx\.[A-Za-z0-9_-]+$/.test(leaf);
  }
  if (head === 'audio') return AUDIO_FADEABLE_RE.test(leaf);
  return false;
}

// NOTE: there is deliberately no `audio` arm here or in setByPath. Audio does not live on the StateView —
// it lives behind the AutomationTargetProvider contract, and is read via provider.get() / provider.getLive()
// and written via provider.writeFade(). See transitions.ts's head router and DC11 in the Wave B plan.
// (Widening StateView would break its 9 construction sites, two of which are inside Stage's rAF tick.)
//
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

// Copy-on-write set into a nested object. Cues *patch existing* leaves — they never *create* structure:
// a numeric key into a non-array, or an out-of-range index, is a safe no-op (skip), not a fabricated
// `{"0":…}` object / sparse array. (Coercing a missing container to `[]` would be worse — a partial
// Segment then reaches the mapper with undefined ranges → NaN LED output. Skip matches the read side,
// where getByPath returns undefined and captureEntry bails.)
const isIndex = (k: string) => /^(0|[1-9]\d*)$/.test(k);

function setIn(obj: Record<string, unknown>, keys: string[], value: unknown): Record<string, unknown> {
  if (keys.length === 0) return obj;
  const [k, ...rest] = keys;
  if (Array.isArray(obj)) {
    const idx = Number(k);
    if (!isIndex(k) || idx >= obj.length) return obj;            // never extend/append/index-garbage via a cue
    const arr = (obj as unknown[]).slice();
    arr[idx] = rest.length === 0 ? value : setIn((arr[idx] ?? {}) as Record<string, unknown>, rest, value);
    return arr as unknown as Record<string, unknown>;
  }
  if (isIndex(k)) return obj;                                     // numeric key into a non-array ⇒ skip (was the corruption)
  if (rest.length === 0) return { ...obj, [k]: value };
  const child = obj[k];
  if (child == null || typeof child !== 'object') return obj;     // don't fabricate a missing nested container
  return { ...obj, [k]: setIn(child as Record<string, unknown>, rest, value) };
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

export function fixtureParams(f: Fixture, profile?: FixtureProfile): ParamDef[] {
  const id = f.id;
  const defs: ParamDef[] = [
    { path: `fixtures.${id}.x`, label: 'X' },
    { path: `fixtures.${id}.y`, label: 'Y' },
    { path: `fixtures.${id}.width`, label: 'Width' },
    { path: `fixtures.${id}.height`, label: 'Height' },
    { path: `fixtures.${id}.rotation`, label: 'Rotation' },
  ];
  // EVERY CHANNEL OF A PROFILED FIXTURE IS AUTOMATABLE, and this one function is why. Cues
  // (`{path, value}`), timeline lanes, scene binding and collectFadeableTargets all read the param
  // catalogue from here, so publishing Pan/Tilt/Gobo as paths makes them work everywhere at once
  // with no per-feature wiring.
  //
  // ⚠ These paths only WRITE if `f.dmx` already exists: setIn deliberately refuses to fabricate a
  // missing nested container (it is the guard that stopped a cue corrupting `segments`). So a
  // profiled fixture is always created with `dmx` seeded from the profile's defaults — see
  // seedProfileValues in App. A profiled fixture with no `dmx` object would silently ignore every
  // cue and lane aimed at it.
  if (profile) {
    for (const c of profile.channels) defs.push({ path: `fixtures.${id}.dmx.${c.key}`, label: c.label });
  }
  return defs;
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
