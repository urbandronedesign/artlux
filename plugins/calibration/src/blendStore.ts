// The rig's dense scans, held for as long as the app is running.
//
// computeBlendMaps needs EVERY projector's dense per-pixel 3D map at once — that is the whole idea:
// alpha for projector A at a surface point depends on who else lights that point. But a scan produces
// one projector's map, and the wizard calibrates one projector at a time, so without somewhere to put
// them the two maps never coexist in the process and the blend can never be solved. (That is exactly
// what happened: solveGeometry returned a denseMap, the wizard stored the calibration and dropped it
// on the floor, and blendCompute.ts sat there with zero callers.)
//
// Session-scoped by design. A dense map is 10^4–10^5 points and is invalid the moment the projector
// moves; the ~20 KB DERIVED blend is what gets persisted onto the output. What survives a restart is
// the sidecar written by calibArtifacts, which this store reloads on demand — see blendController.

export interface RigScan {
  /** The projector raster the scan was decoded in (projector px). */
  raster: [number, number];
  /** Flat projector-pixel pairs + aligned world XYZ triples, straight from solveGeometry. */
  denseMap: { proj: number[]; world: number[] };
  capturedAt: string;
  /** True when this came off disk rather than from a scan in this session — surfaced in the UI. */
  fromDisk?: boolean;
}

const scans = new Map<string, RigScan>();
const subs = new Set<() => void>();

function emit(): void { subs.forEach((f) => f()); }

export function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }

export function put(surfaceId: string, scan: RigScan): void { scans.set(surfaceId, scan); emit(); }
export function get(surfaceId: string): RigScan | undefined { return scans.get(surfaceId); }
export function has(surfaceId: string): boolean { return scans.has(surfaceId); }
export function ids(): string[] { return [...scans.keys()]; }
export function drop(surfaceId: string): void { if (scans.delete(surfaceId)) emit(); }

/** Everything goes when a different project is opened — these maps describe THAT venue's geometry. */
export function clear(): void { if (scans.size) { scans.clear(); emit(); } }

/** Rough memory cost, for the UI to be honest about what it is holding. */
export function sampleCount(surfaceId: string): number {
  const s = scans.get(surfaceId);
  return s ? s.denseMap.proj.length / 2 : 0;
}
