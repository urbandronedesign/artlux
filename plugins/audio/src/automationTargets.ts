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
import { MASTER_BUS_ID, defOf } from './effectDefs';

interface Spatial { x: number; y: number; z: number }
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

const readMix = (): Mix => (getAudioHost()?.audio.getMix() as Mix) ?? { tracks: [], clips: [], buses: [] };

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
export const autoOrFadeMasterGain = (): number | undefined => layered(`${NS}.master.gain`);
export const hasAnyOverride = (ownerId: string): boolean =>
  (byOwner.get(ownerId)?.size ?? 0) > 0 || (fadeByOwner.get(ownerId)?.size ?? 0) > 0;

// One layer's worth of clip leaves, laid over `clip`. Called TWICE per clip (fade, then lane) — the SECOND
// call wins on any path both layers hold, which IS the priority rule.
function applyClipPaths<T extends OvClip>(clip: T, paths: Set<string> | undefined, values: Map<string, number>): T {
  if (!paths || paths.size === 0) return clip;
  let spatial = clip.spatial;
  let effects = clip.effects;
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
  let effects = bus.effects;
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
const POS = { min: -6, max: 6, step: 0.05, def: 0, unit: 'm' };

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
    const named = (c: Clip) => c.name || 'clip';

    for (const t of mix.tracks) {
      out.push({ path: `${NS}.track.${t.id}.gain`, label: 'Gain', group: `Track ▸ ${t.name || t.id}`, ...GAIN, def: t.gain ?? 1 });
    }
    for (const c of mix.clips) {
      const g = `Bed ▸ ${named(c)}`;
      out.push({ path: `${NS}.clip.${c.id}.gain`, label: 'Gain', group: g, ...GAIN, def: c.gain ?? 1 });
      // Position is only offered for a clip that is ALREADY spatial — turning spatialisation on changes
      // the engine chain's channel count (2⇔1) and forces a rebuild, which automation must never do.
      if (c.spatial) {
        for (const ax of ['x', 'y', 'z'] as const) {
          out.push({ path: `${NS}.clip.${c.id}.spatial.${ax}`, label: `Position ${ax.toUpperCase()}`, group: g, ...POS, def: c.spatial[ax] ?? 0 });
        }
      }
      for (const fx of c.effects ?? []) {
        const def = defOf(fx.type);
        if (!def) continue;
        for (const p of def.params) {
          out.push({
            path: `${NS}.clip.${c.id}.fx.${fx.id}.${p.key}`,
            label: p.label, group: `${g} ▸ ${def.label}`,
            min: p.min, max: p.max, step: p.step, unit: p.unit, log: p.curve === 'log',
            def: fx.params?.[p.key] ?? p.def,
          });
        }
      }
    }
    const master = mix.buses.find(b => b.id === MASTER_BUS_ID);
    out.push({ path: `${NS}.master.gain`, label: 'Gain', group: 'Master', ...GAIN, def: master?.gain ?? 1 });
    for (const fx of master?.effects ?? []) {
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
