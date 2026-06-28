// Build MPCDI regions (for export) from ArtLux calibrations. The MPCDI geometry warp is the per-
// projector-pixel 3D surface map; we regenerate it from a stored ProjectorCalibration by raycasting a
// grid of projector pixels onto the loaded venue mesh (each projector pixel → world ray → venue hit),
// the symmetric counterpart of the camera-side sampling. Optional per-projector blend map → alpha.

import type { MpcdiRegion, ProjectorCalibration } from '../../../shared/protocol';
import { cameraPixelRayWorld } from './cvCamera';
import { raycastVenueBatch, hasVenueMeshes } from './venueRaycast';
import type { BlendMap } from './blendCompute';

function blendToAlpha(b: BlendMap): { w: number; h: number; data: Uint8Array } {
  const data = new Uint8Array(b.data.length);
  for (let i = 0; i < b.data.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(b.data[i] * 255)));
  return { w: b.w, h: b.h, data };
}

// One MPCDI region from a calibration. `gw` is the geometry-grid width (height follows the raster
// aspect); MPCDI consumers interpolate, so a modest grid suffices. Returns null if no venue is loaded.
export function regionFromCalibration(id: string, cal: ProjectorCalibration, blend?: BlendMap, gw = 64): MpcdiRegion | null {
  if (!hasVenueMeshes()) return null;
  const [pw, ph] = cal.imageSize;
  if (!pw || !ph) return null;
  const gh = Math.max(1, Math.round((gw * ph) / pw));
  const dist = cal.distortion ?? [0, 0, 0, 0, 0];
  const t = cal.translation as [number, number, number];
  const rays = new Array<{ origin: [number, number, number]; dir: [number, number, number] }>(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const u = ((x + 0.5) / gw) * pw, v = ((y + 0.5) / gh) * ph;
    rays[y * gw + x] = cameraPixelRayWorld(cal.intrinsics, dist, cal.rotation, t, u, v);
  }
  const hits = raycastVenueBatch(rays);
  const xyz = new Float32Array(gw * gh * 3);
  for (let i = 0; i < gw * gh; i++) {
    const h = hits[i];
    if (h) { xyz[i * 3] = h[0]; xyz[i * 3 + 1] = h[1]; xyz[i * 3 + 2] = h[2]; }
    else { xyz[i * 3] = NaN; xyz[i * 3 + 1] = NaN; xyz[i * 3 + 2] = NaN; }
  }
  const region: MpcdiRegion = { id, projW: pw, projH: ph, geo: { w: gw, h: gh, xyz } };
  if (blend) region.alpha = blendToAlpha(blend);
  return region;
}
