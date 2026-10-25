import type { CalibAssign, MpcdiRegion } from '../../../shared/protocol';
import { getHost, sendToProjector } from './calibHost';

// IMPORTED CALIBRATION MAPS — the other half of the baked-file design.
//
// A calibration file describes an INSTALL: which point of the venue each projector pixel lands on,
// solved once with a camera (or by hand) and then good until something moves. Importing one is how a
// show machine gets a calibrated rig without ever running a wizard, and how a venue's alignment
// survives being re-used by a different show.
//
// ── WHY THIS IS NOT PROJECT DATA ────────────────────────────────────────────────────────────────
//
// A map belongs to the ROOM, not to the show. One file should serve every project you run in that
// venue, and re-calibrating must not mean re-saving twelve `.artlux` files. So the document stores at
// most a reference; the pixels live here, in memory, loaded from a path.
//
// It is also large. A 1264×681 map is 860,784 samples — 9.9 MB of Float32 per projector — which is
// nothing to hold once and ruinous to embed in every save and every undo snapshot.
//
// ── WHAT A REGION HOLDS, AND WHAT IT DOES NOT ───────────────────────────────────────────────────
//
// `geo.xyz` holds three floats per projector pixel and `geo.kind` says what they mean:
//
//   'uv'    — (u, v, spare): the content coordinate to sample. MPCDI's 2D profile, and what ArtLux
//             writes. Playable by anything that can sample a texture.
//   'world' — (x, y, z) in venue space. MPCDI's 3D profile. Parsed because another tool may send one,
//             but only replayable by a consumer that ALSO holds the venue geometry and its content
//             projection.
//
// NaN marks a pixel with nothing behind it — no geometry, or geometry outside the content footprint.
//
// The store used to insist on 'world', on the theory that a UV bakes in the content mapping and is
// therefore show data rather than install data. True, and it is still the cost of the 2D profile —
// re-unwrapping the mesh means re-baking. But the recovery it assumed only works in PROJECTED uv
// mode: a mesh on its own authored UVs has an arbitrary unwrap that no matrix reproduces from a
// position, and that is what real venue GLBs use.

export interface ImportedRig {
  /** Where it came from, so the UI can say so and a reload can find it again. */
  path: string;
  regions: MpcdiRegion[];
  importedAt: string;
}

// ── PER-OUTPUT CHOICE ───────────────────────────────────────────────────────────────────────────
//
// The RIG file (Prefs.calibrationFile) is matched to outputs AUTOMATICALLY: each region carries the
// surface id it was exported for. That is right for the file this project made, and useless for one
// from another project or another media server, whose ids match nothing here. So an output can also be
// told which region to play — from the rig file or from an EXTRA file loaded only for that — or to play
// none. Both persist per machine beside calibrationFile, because they describe the room too.
let rig: ImportedRig | null = null;
let extras: ImportedRig[] = [];
let assign: Record<string, CalibAssign> = {};
// One immutable snapshot per change, for useSyncExternalStore.
export interface BakedState { rig: ImportedRig | null; extras: ImportedRig[]; assign: Record<string, CalibAssign> }
let state: BakedState = { rig, extras, assign };
const subs = new Set<() => void>();

export function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }
const emit = (): void => { state = { rig, extras, assign }; subs.forEach((f) => f()); };

export function get(): ImportedRig | null { return rig; }
export function getState(): BakedState { return state; }

/** Every loaded file, the rig file first. */
export const files = (): ImportedRig[] => (rig ? [rig, ...extras.filter((e) => e.path !== rig!.path)] : extras);
const fileAt = (path: string): ImportedRig | undefined => files().find((f) => f.path === path);

/** The region an output plays and the file it comes from — its own choice, else the rig file's region
 *  exported for it, else nothing. THE one door: every window gets its map through here. */
export function sourceFor(surfaceId: string): { file: ImportedRig; region: MpcdiRegion } | undefined {
  const a = assign[surfaceId];
  if (a && 'none' in a) return undefined;
  if (a && 'file' in a) {
    const f = fileAt(a.file);
    const region = f?.regions.find((r) => r.id === a.region);
    return f && region ? { file: f, region } : undefined;
  }
  const region = rig?.regions.find((r) => r.id === surfaceId);
  return rig && region ? { file: rig, region } : undefined;
}
export function regionFor(surfaceId: string): MpcdiRegion | undefined { return sourceFor(surfaceId)?.region; }

export function set(next: ImportedRig | null): void { rig = next; emit(); pushToProjectors(); }
export function setExtras(next: ImportedRig[]): void { extras = next; emit(); pushToProjectors(); }
export function setAssign(next: Record<string, CalibAssign>): void { assign = next; emit(); pushToProjectors(); }
/** Everything off: the rig file, the extra files and every choice. */
export function clearAll(): void { rig = null; extras = []; assign = {}; emit(); pushToProjectors(); }

/**
 * The outputs' regions come from more than one export. A blend is solved for one set of projectors, so
 * soft edges taken from different exports were never made to add up — worth saying, not refusing: a
 * venue may well blend a pair from one file and run a third projector on its own.
 */
export function mixedExports(surfaceIds: string[]): string[] {
  const used = new Set<string>();
  for (const id of surfaceIds) { const s = sourceFor(id); if (s) used.add(s.file.path); }
  return used.size > 1 ? [...used] : [];
}

/**
 * Hand each output's map to its projector window — and hand a `null` to every output that has none,
 * which is the half that is easy to forget: withdrawing a calibration has to reach the window too, or
 * it keeps warping through the map it was last given and the operator sees a change that did not take.
 *
 * Called on every store change AND whenever an output appears, because a window opened after the
 * import would otherwise never be told. That is not a hypothetical: outputs are enabled from the
 * Outputs panel long after a venue's file is loaded.
 *
 * A map is ~10 MB at native raster, so this is deliberately edge-triggered — once per change, never
 * per frame.
 */
export function pushToProjectors(): void {
  const outs = (getHost()?.projectorOutputs.list() ?? []) as Array<{ surfaceId: string }>;
  for (const o of outs) pushToProjector(o.surfaceId);
}

/**
 * One output's map — or an explicit `null` if it has none.
 *
 * Separate from the sweep above because the two triggers are different EVENTS, and the difference is
 * what made an imported calibration silently not arrive: the outputs-list subscription fires when an
 * output is ENABLED, which is before its window exists and before its bridge port is up, so the map is
 * sent into nothing. A window announces it can receive by saying `ready`, and that is when this runs.
 *
 * Enabling an output after loading a venue's file is the ordinary order of events, so without the
 * per-window push a show machine's projector plays undeformed content and the import panel still
 * reports the map as loaded — true, and useless.
 */
export function pushToProjector(surfaceId: string): void {
  const r = regionFor(surfaceId);
  // Only a 'uv' region is playable here. A 'world' map parses and describes real geometry, but the
  // projector has no venue to resolve it against — sending it would silently do nothing, so it is
  // withdrawn instead and `describe()` says why.
  const playable = r && r.geo.kind === 'uv';
  sendToProjector(surfaceId, {
    t: 'bakedMap',
    // The blend travels with the geometry: a rig file's alpha maps are what stop its overlaps doubling.
    map: playable ? { w: r.geo.w, h: r.geo.h, uv: r.geo.xyz, ...(r.alpha ? { alpha: r.alpha } : {}) } : null,
  });
}

/**
 * A short, honest description of what was loaded. Reports COVERAGE per region — how many projector
 * pixels actually landed on geometry — because that is the one number that separates a usable map
 * from a file that parsed cleanly and describes nothing. A region can be well-formed, correctly
 * sized, and 0% covered, which happens when the pose is wrong or the venue moved after the bake.
 */
export function describe(r: ImportedRig, nameOf: (id: string) => string = (id) => id): string[] {
  return r.regions.map((g) => {
    const n = g.geo.w * g.geo.h;
    let hits = 0;
    for (let i = 0; i < g.geo.xyz.length; i += 3) if (Number.isFinite(g.geo.xyz[i])) hits++;
    const pct = n ? Math.round((100 * hits) / n) : 0;
    const density = g.projW && g.geo.w ? (g.geo.w / g.projW) : 0;
    // A grid far coarser than the raster interpolates across silhouettes — see projectorBake.ts.
    const note = density >= 0.9 ? 'native raster' : `${g.geo.w}×${g.geo.h} grid — coarse, edges will soften`;
    // Kind is not a detail: a 'world' map cannot be played without the venue, so an operator who
    // imported one needs to know before wondering why the output is black.
    const kind = g.geo.kind === 'uv' ? 'uv map' : 'world map — needs the venue to replay';
    // Named the way the operator knows the projector (the region id is a surface id — "55a30igmj"
    // for an output added from Projection Outputs).
    return `${nameOf(g.id)}: ${g.projW}×${g.projH}, ${pct}% covered (${note}, ${kind})`;
  });
}
