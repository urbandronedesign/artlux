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

// ownerId of a path: audio.clip.<id>.… → <id>; audio.track.<id>.… → <id>; audio.master.… → 'master'.
const ownerOf = (path: string): string | null => {
  const p = path.split('.');
  if (p[0] !== NS) return null;
  if (p[1] === 'clip' || p[1] === 'track') return p[2] ?? null;
  if (p[1] === 'master') return MASTER_BUS_ID;
  return null;
};

const link = (owner: string, path: string) => {
  let s = byOwner.get(owner);
  if (!s) { s = new Set(); byOwner.set(owner, s); }
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

export const autoGain = (clipId: string): number | undefined => ovr.get(`${NS}.clip.${clipId}.gain`);
export const autoTrackGain = (trackId: string): number | undefined => ovr.get(`${NS}.track.${trackId}.gain`);
export const autoMasterGain = (): number | undefined => ovr.get(`${NS}.master.gain`);
export const hasOverride = (ownerId: string): boolean => (byOwner.get(ownerId)?.size ?? 0) > 0;

/** A clip with its automated leaves laid over the authored ones. Only called for clips that have some. */
export function applyClipOverrides<T extends OvClip>(clip: T): T {
  const paths = byOwner.get(clip.id);
  if (!paths || paths.size === 0) return clip;
  let spatial = clip.spatial;
  let effects = clip.effects;
  for (const path of paths) {
    const v = ovr.get(path);
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
export function applyBusOverrides<T extends OvBus>(bus: T): T {
  const paths = byOwner.get(MASTER_BUS_ID);
  if (!paths || paths.size === 0) return bus;
  let effects = bus.effects;
  for (const path of paths) {
    const v = ovr.get(path);
    if (v === undefined) continue;
    const p = path.split('.'); // audio.master.fx.<effectId>.<param>
    if (p[2] === 'fx' && effects) {
      effects = effects.map(fx => (fx.id === p[3] ? { ...fx, params: { ...(fx.params ?? {}), [p[4]]: v } } : fx));
    }
  }
  return { ...bus, effects } as T;
}

// ── The provider ────────────────────────────────────────────────────────────────────────────────
const GAIN = { min: 0, max: 1.5, step: 0.01, def: 1 };
const POS = { min: -6, max: 6, step: 0.05, def: 0, unit: 'm' };

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
    link(owner, path);
    dirty.add(owner);
  },

  release(path: string): void {
    const owner = ownerOf(path);
    if (!owner) return;
    ovr.delete(path);
    byOwner.get(owner)?.delete(path);
    dirty.add(owner); // re-push, so the AUTHORED value goes back to the engine on the next frame
  },
};
