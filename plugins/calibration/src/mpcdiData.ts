// Build MPCDI regions (for export) from ArtLux calibrations. The MPCDI geometry warp is the per-
// projector-pixel 3D surface map; we regenerate it from a stored ProjectorCalibration by raycasting a
// grid of projector pixels onto the loaded venue mesh (each projector pixel → world ray → venue hit),
// the symmetric counterpart of the camera-side sampling. Optional per-projector blend map → alpha.

import type { MpcdiRegion, ProjectorCalibration } from '../../../shared/protocol';
import * as THREE from 'three';
import { cameraPixelRayWorld, cameraPose, glProjectionMatrix } from './cvCamera';
import { requestBake } from '@/components/Simulator3D/projectorBake'; // host module — the GPU bake
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

/**
 * Every calibrated output in the rig, as MPCDI regions — the unit a calibration file should actually
 * be written in.
 *
 * ⚠ ONE FILE PER RIG, NOT PER PROJECTOR. Blend is only meaningful for the exact set it was solved
 * with — `ProjectorBlend.rigIds` exists to say so — so a per-projector file either drops the blend or
 * ships one that silently assumes neighbours it cannot name. Geometry alone would survive being split
 * up; the moment two projectors overlap, the file has to describe the overlap, and that is a property
 * of the pair.
 *
 * Returns the regions plus the outputs that were SKIPPED and why, because "exported 2 regions" reads
 * identically to "exported 2 of your 4 projectors" unless something says otherwise.
 */
export async function regionsForRig(
  outputs: Array<{ surfaceId: string; calibration?: ProjectorCalibration; blend?: { w: number; h: number; alpha: number[]; black?: number[] } }>,
  gw = 64,
): Promise<{ regions: MpcdiRegion[]; skipped: Array<{ surfaceId: string; why: string }>; baked: number }> {
  const regions: MpcdiRegion[] = [];
  const skipped: Array<{ surfaceId: string; why: string }> = [];
  let baked = 0;
  for (const o of outputs) {
    if (!o.calibration) { skipped.push({ surfaceId: o.surfaceId, why: 'not calibrated' }); continue; }
    // GPU FIRST, AT NATIVE RASTER. The raycast path below is a fallback, not a peer: it is brute-force
    // CPU intersection, so it only affords a 64-wide grid — one sample per ~20×20 projector pixels,
    // which interpolates straight across every silhouette. See projectorBake.ts.
    const [pw, ph] = o.calibration.imageSize;
    if (pw > 0 && ph > 0) {
      const viewProj = projectorViewProj(o.calibration);
      const map = viewProj ? await requestBake(viewProj, pw, ph) : null;
      if (map && map.hits > 0) {
        const region: MpcdiRegion = { id: o.surfaceId, projW: pw, projH: ph, geo: { w: map.w, h: map.h, xyz: map.xyz } };
        if (o.blend) region.alpha = blendToAlpha({ surfaceId: o.surfaceId, w: o.blend.w, h: o.blend.h, data: Float32Array.from(o.blend.alpha) } as never);
        regions.push(region);
        baked++;
        continue;
      }
    }
    // The stored blend is a plain array on the document; BlendMap is the solver's Float32 form. Same
    // numbers, different container — convert rather than teach regionFromCalibration two shapes.
    const blend = o.blend
      ? { surfaceId: o.surfaceId, w: o.blend.w, h: o.blend.h, data: Float32Array.from(o.blend.alpha) }
      : undefined;
    const r = regionFromCalibration(o.surfaceId, o.calibration, blend as never, gw);
    if (!r) { skipped.push({ surfaceId: o.surfaceId, why: 'no venue model loaded' }); continue; }
    regions.push(r);
  }
  return { regions, skipped, baked };
}

/**
 * The projector's view-projection, as the bake camera needs it: the solved OpenCV intrinsics as a GL
 * projection, times the world→camera view from the pose. Same pair `ProjectorScene` renders with, so
 * a baked map and the live preview describe the same picture — two derivations would drift, and the
 * symptom would be a file that disagrees with what the operator just approved on the wall.
 */
function projectorViewProj(cal: ProjectorCalibration): number[] | null {
  const [w, h] = cal.imageSize;
  if (!w || !h) return null;
  const proj = new THREE.Matrix4().fromArray(glProjectionMatrix(cal.intrinsics, cal.imageSize, 0.05, 500));
  const { position, quaternion } = cameraPose(cal.rotation, cal.translation as [number, number, number]);
  const view = new THREE.Matrix4()
    .compose(new THREE.Vector3(...position), new THREE.Quaternion(...quaternion), new THREE.Vector3(1, 1, 1))
    .invert();
  return proj.multiply(view).toArray();
}
