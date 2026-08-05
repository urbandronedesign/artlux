import type { MpcdiRegion } from '../../../shared/protocol';

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

let rig: ImportedRig | null = null;
const subs = new Set<() => void>();

export function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }
const emit = (): void => { subs.forEach((f) => f()); };

export function get(): ImportedRig | null { return rig; }

/** The map for one output, or undefined — regions are keyed by the surfaceId they were exported for. */
export function regionFor(surfaceId: string): MpcdiRegion | undefined {
  return rig?.regions.find((r) => r.id === surfaceId);
}

export function set(next: ImportedRig | null): void { rig = next; emit(); }

/**
 * A short, honest description of what was loaded. Reports COVERAGE per region — how many projector
 * pixels actually landed on geometry — because that is the one number that separates a usable map
 * from a file that parsed cleanly and describes nothing. A region can be well-formed, correctly
 * sized, and 0% covered, which happens when the pose is wrong or the venue moved after the bake.
 */
export function describe(r: ImportedRig): string[] {
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
    return `${g.id}: ${g.projW}×${g.projH}, ${pct}% covered (${note}, ${kind})`;
  });
}
