// The audio plugin's automation namespace — everything on the bed a curve may drive.
//
// THE AUTHORED VALUE IS NEVER TOUCHED. A lane writes here, to a live override layer; the number the user
// last set with a slider stays exactly where they put it, in the project. Disabling a lane doesn't
// "restore" anything — it just stops shadowing, and the authored value is simply visible again. That is
// also why the sampler must never write the persisted AudioMix: doing so would re-render React 60×/s and
// bake the moving value into the saved file, so the fader would appear to move on its own after reload.
//
// AND write() NEVER CALLS audioClient. The driver's reconcile() re-reads each clip from the bed every
// frame and pushes its gain/params to the engine; if we pushed the automated value directly, reconcile
// would overwrite it with the AUTHORED value on the very same frame, forever — an audible 60 Hz flutter,
// not a silent bug. So the override is read THROUGH the driver's own read path (see `eff`/`effGain` in
// plugin.renderer.ts), and the driver stays the only thing that talks to the engine.
//
// Only CONTINUOUS leaves are offered. Never an effect's type, never the chain's length, never spatial
// on/off: each of those changes the shape of the engine's chain, forcing a rebuild (and a spatial flip
// changes its channel count 2⇔1). A rebuild allocates; at 60 Hz that would hammer the audio thread. Every
// target here lands on the engine's cheap in-place `updateParams` path, by construction.
import type { AutomationTargetDef, AutomationTargetProvider } from '@artlux/sdk/renderer';
import { getAudioHost } from './audioHost';
import type { SpatialPos } from '../../../shared/spatial';
import { MASTER_BUS_ID, defOf } from './effectDefs';

type Spatial = SpatialPos;
interface Effect { id: string; type: string; params?: Record<string, number>; opts?: Record<string, string> }
interface Clip { id: string; trackId: string; name: string; gain?: number; spatial?: Spatial; effects?: Effect[] }
interface Track { id: string; name: string; gain?: number }
interface Bus { id: string; name: string; gain?: number; effects?: Effect[] }
interface Mix { tracks: Track[]; clips: Clip[]; buses: Bus[] }

// The minimum an override can be laid over — kept structural so the driver's own BedClip/BedBus (which
// carry extra fields we don't care about here) satisfy it without a cross-import.
interface OvEffect { id: string; params?: Record<string, number> }
interface OvClip { id: string; spatial?: Spatial; effects?: OvEffect[] }
interface OvBus { id: string; effects?: OvEffect[] }

const NS = 'audio';
export const AUDIO_NS = NS;

// A DOCUMENT IS NOT A TYPE. `effects` is one of the two fields NO sanitizer coerces (sanitizeAudioClip
// spreads ...c and touches only start/duration/inPoint/sourceDuration/gain/mute/fades), and a PLUGIN can
// write a clip through patchTimelineClip, which does `{...c, ...patch}` and never sees a sanitizer at all.
// So this module must assume nothing about the shape of what it is handed.
//
// enumerate() is called from compileAutomation on EVERY project load and EVERY GO, with no try/catch. A
// bare `for..of` over a non-iterable there is a CRASH ON LOAD — the app is dead before the operator sees a
// pixel. And not throwing is not the same as being fine: a STRING is iterable, so `for (const fx of
// 'reverb')` walks its CHARACTERS and silently emits six targets whose id is undefined.
//
// The array->object corruption this guards (`"effects": {"0": {...}}`) is not hypothetical — this repo has
// already shipped it once; see the `segments` repair in applyProjectData.
function effectsOf(x: { effects?: unknown }): Effect[] {
  if (!Array.isArray(x.effects)) return [];
  return x.effects.filter((fx): fx is Effect =>
    !!fx && typeof fx === 'object'
    && typeof (fx as Effect).id === 'string'
    && typeof (fx as Effect).type === 'string');
}

// Same rule for the OVERRIDE path, where an fx chain is only ever mapped, never read for its type.
// `Array.isArray`, NOT truthiness: `{}` is truthy and `{}.map` is not a function — which is how a CUE
// firing an fx param could crash the frame loop with no automation lane anywhere in the document.
function ovEffectsOf(x: { effects?: unknown }): OvEffect[] | undefined {
  return Array.isArray(x.effects) ? (x.effects.filter(fx => !!fx && typeof fx === 'object') as OvEffect[]) : undefined;
}

const readMix = (): Mix => (getAudioHost()?.audio.getMix() as Mix) ?? { tracks: [], clips: [], buses: [] };
// THE OTHER TWO CONTAINERS. `enumerate()` read the bed and only the bed until now — which is why a scene's
// own audio, and a video clip's soundtrack, had no lane and no curve over them. Both are `{tracks, clips}`
// in the same shape, and both belong to whichever timeline is BOUND right now.
const EMPTY_CONTAINER: { tracks: Track[]; clips: Clip[] } = { tracks: [], clips: [] };
const readTimelineAudio = () => (getAudioHost()?.audio.getTimelineAudio() as { tracks: Track[]; clips: Clip[] }) ?? EMPTY_CONTAINER;
const readVideoAudio = () => (getAudioHost()?.audio.getVideoAudio() as { tracks: Track[]; clips: Clip[] }) ?? EMPTY_CONTAINER;

// ── The live override layer ─────────────────────────────────────────────────────────────────────
const ovr = new Map<string, number>();          // targetPath → live value
const byOwner = new Map<string, Set<string>>(); // ownerId (clipId | trackId | 'master') → its paths
const dirty = new Set<string>();                // owners whose engine state needs a re-push this frame

// ── THE SCENE / CUE FADE LAYER ───────────────────────────────────────────────────────────────────
// A SECOND override layer, kept strictly separate from `ovr` above. Written by core's transitions.ts (a
// scene recall or a cue, through AutomationTargetProvider.writeFade), and read UNDER it.
//
// WHY A SECOND MAP AND NOT `ovr`:
//   · A LANE MUST WIN. With one map, a lane and a fade on the same path would be two writers racing
//     last-writer-wins, every frame. With two, the driver's read order settles it once and for all — and
//     core cannot ask "does a lane own this path?" across the plugin boundary anyway (automationOverlay's
//     owns() is a CORE-ONLY map; the provider contract has no owns() and is not getting one).
//   · `release(path)` (below) unconditionally deletes the path — so a lane being disabled would have
//     DELETED A LIVE SCENE FADE. Two maps make that structurally impossible.
//
// A fade's value PERSISTS after the fade completes. It is not "the fade animating"; it IS the recalled
// scene's audio state, held outside the persisted AudioMix exactly as `ovr` is — so nothing is ever baked
// into the saved file and nothing has to be "restored". A later recall/cue overwrites it; a MANUAL move of
// the control takes the path back (releaseFade); opening a project drops the lot (releaseAllFades).
const fade = new Map<string, number>();               // targetPath → the scene/cue value
const fadeByOwner = new Map<string, Set<string>>();   // ownerId → its faded paths

// ownerId of a path: audio.clip.<id>.… → <id>; audio.track.<id>.… → <id>; audio.master.… → 'master'.
const ownerOf = (path: string): string | null => {
  const p = path.split('.');
  if (p[0] !== NS) return null;
  if (p[1] === 'clip' || p[1] === 'track') return p[2] ?? null;
  if (p[1] === 'master') return MASTER_BUS_ID;
  return null;
};

const link = (index: Map<string, Set<string>>, owner: string, path: string) => {
  let s = index.get(owner);
  if (!s) { s = new Set(); index.set(owner, s); }
  s.add(path);
};

/** Owners touched since the last call. The driver drains this each frame and re-pushes them. */
export function takeDirty(): ReadonlySet<string> {
  if (dirty.size === 0) return EMPTY;
  const out = new Set(dirty);
  dirty.clear();
  return out;
}
const EMPTY: ReadonlySet<string> = new Set<string>();

// THE READ ORDER, IN ONE PLACE: lane override ?? scene/cue fade ?? (the caller's authored value).
// Every driver read of an automatable leaf goes through these — that is what makes "a lane always wins"
// true, structurally, with no query and no coordination between the two writers.
const layered = (path: string): number | undefined => ovr.get(path) ?? fade.get(path);

export const autoOrFadeGain = (clipId: string): number | undefined => layered(`${NS}.clip.${clipId}.gain`);
export const autoOrFadeTrackGain = (trackId: string): number | undefined => layered(`${NS}.track.${trackId}.gain`);
// (There was an autoOrFadeAtten here. `spatial.attenuation` was removed in 0.27 — a source has a
// direction, and a level belongs on the clip's own gain, which already has a lane one line above.)
export const autoOrFadeMasterGain = (): number | undefined => layered(`${NS}.master.gain`);
export const hasAnyOverride = (ownerId: string): boolean =>
  (byOwner.get(ownerId)?.size ?? 0) > 0 || (fadeByOwner.get(ownerId)?.size ?? 0) > 0;

// ── THE SAME READ, FOR THE SURFACE THAT HAS TO *DRAW* IT ────────────────────────────────────────────
// THE MIXER RENDERED THE AUTHORED VALUE AND NOTHING ELSE. The driver plays `lane ?? fade ?? authored`
// (plugin.renderer.ts) and the panel's faders drew `mix.buses[master].gain` — the DOCUMENT — so a house
// fade slid the room from 1.0 to 0.32 while the master fader sat frozen at 1.00. The panel was not merely
// uninformative: it ASSERTED A LEVEL THE ENGINE WAS NOT PLAYING, which is the self-reporting-healthy
// failure this codebase kills on sight (AudioBedPanel's own words, about a different field).
//
// Fader.tsx:87 already said it out loud — "the fader can sit at 1.00 over a 0.2 room" — and fixed only the
// WRITE half (a gesture is always a takeover). This is the READ half.
//
// TWO READERS, ONE RULE, AND THEY MAY NEVER DRIFT:
//   · layered()        — the DRIVER's hot path. Per clip, per frame. Allocates nothing, and must not.
//   · drivenSnapshot() — the MIXER's 100 ms poll. Allocates one small Map; at 10 Hz nobody cares.
// scratch/faderreadback-sim.mjs asserts, exhaustively over both maps, that they agree on every path.
export type DrivenBy = 'lane' | 'fade';
/** What the ENGINE is applying to a path, and WHICH LAYER is applying it. */
export interface Driven { by: DrivenBy; value: number }

// A SHARED FROZEN EMPTY, never a fresh `new Map()`: this lands in the panel's React state on every poll,
// and the un-automated case is the overwhelmingly common one. Same reference ⇒ setState bails out ⇒ no
// re-render. A fresh map per tick would re-render the whole mixer 10×/s for a show with no automation.
const NOTHING_DRIVEN: ReadonlyMap<string, Driven> = new Map();

/**
 * Every path the engine is currently DRIVING, with the layer that owns it. The mixer polls this and draws
 * the value it finds instead of the authored one, so the thumb IS the level in the room.
 *
 * ⚠ THE LAYER NAME IS NOT DECORATION — IT DECIDES WHETHER THE CONTROL IS DEAD.
 *   · 'fade' — a scene/cue fade. A manual move is a REAL takeover and it WORKS: the mixer's onCommit calls
 *     releaseFade(), which drops both halves (the layer entry AND the leg). The fader stays LIVE.
 *   · 'lane' — an automation lane. A manual move is SILENTLY SHADOWED: only the automation engine may drop
 *     a lane (Fader.tsx:89), so the write lands in the document, changes nothing audible, and is overwritten
 *     on the next frame. The fader must go READ-ONLY, or it tells its second lie of the day.
 *
 * ⚠ THIS WARNING USED TO SAY "THESE ARE BED PATHS", AND IT NO LONGER DOES. enumerate() now catalogs all
 * three containers, so `audio.clip.<id>` names a clip wherever it lives and a caller rendering a TIMELINE
 * or VIDEO row SHOULD look its id up here — drawing the authored value under a live lane is the
 * self-reporting-healthy failure this map exists to end. What made the old gate necessary was a fear of
 * id aliasing; what makes it unnecessary is that every id in every container is a `crypto.randomUUID()`
 * (and a video clip's carries a `va:` prefix besides), so there is nothing to alias INTO.
 *
 * The `fade` layer is a different question and is still bed-only — nothing writes a scene/cue fade over
 * the other two containers — which is why releaseSel's gate on the WRITE side stays exactly as it was.
 */
export function drivenSnapshot(): ReadonlyMap<string, Driven> {
  if (ovr.size === 0 && fade.size === 0) return NOTHING_DRIVEN;
  const out = new Map<string, Driven>();
  for (const [path, value] of fade) out.set(path, { by: 'fade', value });   // fade first…
  for (const [path, value] of ovr) out.set(path, { by: 'lane', value });    // …lane laid OVER it.
  return out;   // ORDER IS THE PRIORITY — the same rule layered() and applyClipLayers() both encode.
}

// One layer's worth of clip leaves, laid over `clip`. Called TWICE per clip (fade, then lane) — the SECOND
// call wins on any path both layers hold, which IS the priority rule.
function applyClipPaths<T extends OvClip>(clip: T, paths: Set<string> | undefined, values: Map<string, number>): T {
  if (!paths || paths.size === 0) return clip;
  let spatial = clip.spatial;
  let effects = ovEffectsOf(clip); // NOT clip.effects — `{}` is truthy and `{}.map` is not a function
  for (const path of paths) {
    const v = values.get(path);
    if (v === undefined) continue;
    const p = path.split('.'); // audio.clip.<id>.<what>...
    if (p[3] === 'spatial' && spatial) {
      spatial = { ...spatial, [p[4]]: v } as Spatial;
    } else if (p[3] === 'fx' && effects) {
      effects = effects.map(fx => (fx.id === p[4] ? { ...fx, params: { ...(fx.params ?? {}), [p[5]]: v } } : fx));
    }
    // `gain` is applied by the driver's effGain(), not here — the transport owns it separately.
  }
  return { ...clip, spatial, effects } as T;
}

/** Same, for the master bus. */
function applyBusPaths<T extends OvBus>(bus: T, paths: Set<string> | undefined, values: Map<string, number>): T {
  if (!paths || paths.size === 0) return bus;
  let effects = ovEffectsOf(bus); // NOT bus.effects — see applyClipPaths
  for (const path of paths) {
    const v = values.get(path);
    if (v === undefined) continue;
    const p = path.split('.'); // audio.master.fx.<effectId>.<param>
    if (p[2] === 'fx' && effects) {
      effects = effects.map(fx => (fx.id === p[3] ? { ...fx, params: { ...(fx.params ?? {}), [p[4]]: v } } : fx));
    }
  }
  return { ...bus, effects } as T;
}

/**
 * THE TAKEOVER — drop the scene/cue fade on `path`, handing it back to the AUTHORED value.
 *
 * Exported as a plain function as well as a provider member because THE MIXER CALLS IT DIRECTLY, on every
 * authored write it makes (AudioBedPanel). Without that, the `fade` map is WRITE-ONLY and the layer is a
 * one-way trap: the driver reads `laneOvr ?? fade ?? authored`, a fade's value persists by design, so the
 * instant ANY scene or cue touches `audio.master.gain` the house-volume fader stops doing anything at all —
 * for the rest of the session, and across every project opened in it. An automation lane does not have that
 * bug precisely because it HAS a release. This is the fade layer's.
 *
 * A TAKEOVER HAS TWO HALVES, AND DELETING FROM `fade` IS ONLY ONE OF THEM. While a fade is IN FLIGHT the
 * host re-writes every faded path through writeFade() on EVERY FRAME — so a release that stops here is
 * undone within 16 ms, and then made PERMANENT when the leg lands on its endpoint and persists there. The
 * operator pulls the master up two seconds into a 5 s fade to 0.2 (exactly when they would), the fader
 * moves, the document says 1.0 — and the house still slides to 0.2 and STAYS. So the LEG has to go too,
 * and only the host owns the animation: host.show.dropFadeLeg is that half. Every door into a takeover
 * (the mixer's own faders, and core's timeline gutter fader via the provider member below) routes through
 * THIS function, so this is the one place both halves have to meet.
 */
export function releaseFade(path: string): void {
  const owner = ownerOf(path);
  if (!owner) return;
  getAudioHost()?.show.dropFadeLeg(path);   // …the leg, before the layer: order is cosmetic (one task), intent is not
  fade.delete(path);
  fadeByOwner.get(owner)?.delete(path);
  dirty.add(owner);   // re-push, so the AUTHORED value reaches the engine on the next frame
}

/** A clip with its scene/cue fade laid on, then its automated leaves laid OVER that. Lane wins. */
export function applyClipLayers<T extends OvClip>(clip: T): T {
  let out = clip;
  out = applyClipPaths(out, fadeByOwner.get(clip.id), fade);   // fade first…
  out = applyClipPaths(out, byOwner.get(clip.id), ovr);        // …lane over it. ORDER IS THE PRIORITY.
  return out;
}

/** Same, for the master bus. */
export function applyBusLayers<T extends OvBus>(bus: T): T {
  let out = bus;
  out = applyBusPaths(out, fadeByOwner.get(MASTER_BUS_ID), fade);
  out = applyBusPaths(out, byOwner.get(MASTER_BUS_ID), ovr);
  return out;
}

// ── The provider ────────────────────────────────────────────────────────────────────────────────
const GAIN = { min: 0, max: 1.5, step: 0.01, def: 1 };
// ⚠ THE ANGLE'S RANGE IS FOUR TURNS EACH WAY, NOT 0–360, AND THAT IS THE FEATURE.
//
// A lane INTERPOLATES between keyframes. Bounded to one turn, a full orbit is unexpressible (0 → 360 is
// a lane that does not move) and 350 → 10 sweeps BACKWARDS through 180 — the sound crosses the room the
// long way at the exact moment it should pass the front. Unbounded, a spin is one straight ramp and the
// short way round is simply the shorter number. The widget still READS 0–360 (normAngle); only the
// stored and automated value is free to run past it.
//
// ±1440 rather than truly unbounded because a lane editor has to draw an axis. Four turns in either
// direction is past anything anyone has asked a sound to do, and a curve that needs more can be built
// from two lanes' worth of keyframes on one lane.
// `wrap` is what makes a scene/cue fade take the SHORT way round; see AutomationTargetDef.wrap. It is
// deliberately NOT set on elevation, which is a bounded −90…90 and has no far side to go round.
const ANGLE = { min: -1440, max: 1440, step: 1, def: 0, unit: '°', wrap: true };
const ELEV = { min: -90, max: 90, step: 1, def: 0, unit: '°' };

/**
 * THE ENGINE DOOR FOR A GAIN — the LAST bound before a level reaches the amplifier.
 *
 * Every AUTHORING door is already bounded: the mixer's faders are min 0 / max 1.5, the cue inspector
 * clamps on commit, compileAutomation clamps every keyframe, and the fade engine clamps a cue's endpoint
 * against this same catalog. The one value with NO bound was the PERSISTED one: `AudioClip.gain` /
 * `AudioTrack.gain` are coerced by sanitizeAudioClip for FINITENESS only, never for RANGE. A hand-edited
 * or tool-generated .artlux — this sanitizer's own declared threat model — carrying `"gain": 20` loaded
 * clean, drew normally on the lane, and played at 20× into the mix the moment the show clock crossed it.
 * A level event, in a venue, with nobody in the room.
 *
 * ⚠ IT IS CLAMPED **HERE**, AT THE DOOR, AND NEVER IN THE NORMALIZER. normalizeAudioMix's output is what
 * setAudioMix stores and buildProjectData re-saves, so a clamp there would be PERSISTED on the next save —
 * an authored value silently rewritten by a load, which is the exact invariant-6 shape this project has
 * shipped once already. The document keeps whatever it says; the AMPLIFIER gets a number that is in range.
 * (A NaN is not the same case and does become the default: it has no recoverable authored intent.)
 *
 * Each FACTOR is bounded against its own declared range, not the product — a clip at 1.5 on a track at 1.5
 * is authored, reachable from the faders, and must stay audible as authored.
 */
export const boundGain = (g: number | undefined | null, def = GAIN.def): number => {
  const n = typeof g === 'number' && Number.isFinite(g) ? g : def;
  return n < GAIN.min ? GAIN.min : n > GAIN.max ? GAIN.max : n;
};

export const audioAutomationProvider: AutomationTargetProvider = {
  namespaces: [NS],

  enumerate(): AutomationTargetDef[] {
    const mix = readMix();
    const out: AutomationTargetDef[] = [];

    // ── ONE EMITTER, THREE CONTAINERS ────────────────────────────────────────────────────────────────
    //
    // THE PATHS DO NOT CARRY THE CONTAINER, AND THEY MUST NOT START. `audio.clip.<id>` names a clip in
    // whichever container holds that id, and that is safe for one reason worth stating rather than
    // rediscovering: every clip and track id in all three is a `crypto.randomUUID()` (AudioBedPanel's
    // `uid`, Timeline.tsx's mints) and a video clip's derived id additionally carries a `va:` prefix. A
    // bed↔timeline collision is not merely improbable, it is not producible.
    //
    // That is what makes this a five-line change instead of a re-modelling. Every consumer already
    // resolves by id and is already container-blind, all the way down: `ownerOf`, `write`, `release`, the
    // driver's `autoOrFadeGain(clip.id)` / `hasAnyOverride(clip.id)` / `applyClipLayers`, and core's
    // `pathLeaf` (which splits `audio.<kind>.<id>.<leaf>` generically). Not one of them needed to learn
    // what a container is — the driver's own comment already said so, that these lookups "enumerate the
    // BED's and the bound timeline's clips alike". Only the CATALOG was bed-only.
    //
    // ⚠ THE TWO NEW CONTAINERS BELONG TO THE **BOUND** DOCUMENT, so this catalog changes on every recall.
    // compileAutomation() already runs there (timeline.ts, after the recall seek) and on every setData, so
    // a scene's lanes wake with the scene and sleep when it leaves. The BED's entries are unaffected by a
    // recall, which is the same difference the two clocks make everywhere else in this subsystem.
    const named = (c: Clip) => c.name || 'clip';
    const emitClip = (c: Clip, group: string): void => {
      out.push({ path: `${NS}.clip.${c.id}.gain`, label: 'Gain', group, ...GAIN, def: c.gain ?? 1 });
      // Position is only offered for a clip that is ALREADY spatial — turning spatialisation on changes
      // the engine chain's channel count (2⇔1) and forces a rebuild, which automation must never do.
      //
      // ⚠ THE OLD `spatial.x` / `.y` / `.z` PATHS ARE DELIBERATELY NOT LISTED, AND ARE STILL HONOURED.
      // A lane already written against one keeps playing (applyClipPaths writes any leaf, and the driver
      // folds a legacy axis back into a bearing through resolveLegacyAxes), so no existing show loses its
      // movement. But they are not offered for NEW work, because they describe a geometry the engine does
      // not have: `Position X` in metres never did anything except change a direction, and two lanes were
      // needed to say what one Angle lane says. `enumerate()` is the catalog; the fadeable regex in core
      // is only the gate, and it still admits both spellings.
      if (c.spatial) {
        out.push({ path: `${NS}.clip.${c.id}.spatial.angle`, label: 'Angle', group, ...ANGLE, def: c.spatial.angle ?? 0 });
        out.push({ path: `${NS}.clip.${c.id}.spatial.elevation`, label: 'Height', group, ...ELEV, def: c.spatial.elevation ?? 0 });
      }
      for (const fx of effectsOf(c)) {
        const def = defOf(fx.type);
        if (!def) continue;
        for (const p of def.params) {
          out.push({
            path: `${NS}.clip.${c.id}.fx.${fx.id}.${p.key}`,
            label: p.label, group: `${group} ▸ ${def.label}`,
            min: p.min, max: p.max, step: p.step, unit: p.unit, log: p.curve === 'log',
            def: fx.params?.[p.key] ?? p.def,
          });
        }
      }
    };

    for (const t of mix.tracks) {
      out.push({ path: `${NS}.track.${t.id}.gain`, label: 'Gain', group: `Track ▸ ${t.name || t.id}`, ...GAIN, def: t.gain ?? 1 });
    }
    for (const c of mix.clips) emitClip(c, `Bed ▸ ${named(c)}`);
    // THE BOUND TIMELINE'S OWN AUDIO — the scene's clips, on the scene's playhead. The group names match
    // the mixer's container badge word for word ('this timeline' / 'video clip'), because the picker and the
    // inspector are two views of one decision and an operator should not have to translate between them.
    const tl = readTimelineAudio();
    for (const t of tl.tracks) {
      out.push({ path: `${NS}.track.${t.id}.gain`, label: 'Gain', group: `This timeline · track ▸ ${t.name || t.id}`, ...GAIN, def: t.gain ?? 1 });
    }
    for (const c of tl.clips) emitClip(c, `This timeline ▸ ${named(c)}`);

    // AND THE DERIVED ONE — a video clip's own soundtrack. Authored on the VIDEO clip (`VideoClipAudio`),
    // recomputed into `va:`-prefixed clips every read; a lane over one is read by the driver through the
    // same override layer as any other clip, so nothing has to write back into a container that has no
    // document. A clip contributes here only while it is audible at all, which is exactly the set that can
    // be selected in the mixer — the picker and the inspector agree on what exists.
    //
    // NO TRACK ENTRIES. The derived `vl:` tracks mirror the timeline's video LAYERS, whose audio gain is
    // authored on the layer and already reachable from the lane gutter; offering a second, derived path to
    // the same number would be two writers on one control.
    const vid = readVideoAudio();
    for (const c of vid.clips) emitClip(c, `Video clip ▸ ${named(c)}`);

    const master = mix.buses.find(b => b.id === MASTER_BUS_ID);
    out.push({ path: `${NS}.master.gain`, label: 'Gain', group: 'Master', ...GAIN, def: master?.gain ?? 1 });
    for (const fx of master ? effectsOf(master) : []) {
      const def = defOf(fx.type);
      if (!def) continue;
      for (const p of def.params) {
        out.push({
          path: `${NS}.master.fx.${fx.id}.${p.key}`,
          label: p.label, group: `Master ▸ ${def.label}`,
          min: p.min, max: p.max, step: p.step, unit: p.unit, log: p.curve === 'log',
          def: fx.params?.[p.key] ?? p.def,
        });
      }
    }
    return out;
  },

  // The AUTHORED value — what the slider last wrote. Used to seed a new lane's first keyframe, so
  // creating a lane never changes the sound.
  get(path: string): number | undefined {
    return this.enumerate().find(d => d.path === path)?.def;
  },

  write(path: string, value: number): void {
    const owner = ownerOf(path);
    if (!owner) return;
    ovr.set(path, value);
    link(byOwner, owner, path);
    dirty.add(owner);
  },

  release(path: string): void {
    const owner = ownerOf(path);
    if (!owner) return;
    ovr.delete(path);
    byOwner.get(owner)?.delete(path);
    dirty.add(owner); // re-push, so the AUTHORED value goes back to the engine on the next frame
    // NOTE: `fade` is UNTOUCHED, and deliberately so. A lane being disabled hands the path back to the
    // SCENE FADE (one layer down), not to the authored value — which is exactly right: the recalled scene's
    // value is still in effect, it was merely shadowed. The fade is dropped by releaseFade() (a manual
    // takeover) or releaseAllFades() (a project open) — NEVER by a lane.
  },

  // A SCENE/CUE FADE. Same contract as write(): it NEVER calls audioClient. The driver re-reads each clip
  // from its container every frame through eff()/effGain(), so a value pushed straight to the engine would
  // be overwritten with the AUTHORED one on the same frame, forever — an audible 60 Hz flutter, not a
  // silent bug. PULL-THROUGH, never push-per-frame. See the header of this file.
  writeFade(path: string, value: number): void {
    const owner = ownerOf(path);
    if (!owner) return;
    fade.set(path, value);
    link(fadeByOwner, owner, path);
    dirty.add(owner);   // the driver's takeDirty() re-pushes this owner on the next frame
  },

  // THE TAKEOVER. Without this the `fade` map is WRITE-ONLY and the layer is a one-way trap: the mixer's
  // master fader dies the moment any scene or cue touches audio.master.gain, because effGain/syncMaster
  // read `laneOvr ?? fade ?? authored` and the authored value they'd read is the one the fader just wrote.
  // A manual write to the authored value means the operator has taken the param back. Drop the fade.
  releaseFade,

  // A fade layer is SHOW state, not DOCUMENT state. App calls this on project open/reset (through the
  // registry), or a stale master fade from the last project would clamp the next one's output — silently,
  // with the fader sitting at 1.0 and reading as healthy.
  releaseAllFades(): void {
    for (const owner of fadeByOwner.keys()) dirty.add(owner);
    fade.clear();
    fadeByOwner.clear();
  },

  // The EFFECTIVE value — what is actually reaching the engine right now. A FADE'S `from` MUST BE THIS, not
  // get()'s AUTHORED value: otherwise the second recall of a path jumps to the authored value on frame 1 and
  // glides down from there — a full-scale pop on every audio recall after the first. (Lane SEEDING still
  // reads get(): creating a lane must not change the sound.)
  getLive(path: string): number | undefined {
    return layered(path) ?? audioAutomationProvider.get(path);
  },
};
