// Build MPCDI regions (for export) from ArtLux calibrations. The MPCDI geometry warp is the per-
// projector-pixel 3D surface map — which point of the venue each projector pixel lands on — plus an
// optional per-projector blend map as alpha.
//
// ── THE GPU BAKE IS THE ONLY PATH. THERE IS NO CPU FALLBACK, DELIBERATELY. ──────────────────────
//
// There used to be one: a grid of rays cast against the venue with three's Raycaster. It was removed
// rather than kept as a safety net, because it was not a lesser version of the same answer — it was a
// DIFFERENT answer, and silently so.
//
// It read from `venueRaycast`'s registry (`registerVenueMesh`, populated only while a model is
// visible); the bake reads the depth-pass casters (`registerDepthCaster`, unconditional, and holding
// the resolved GLB rather than the outer group). Measured on the same project, the same calibration,
// minutes apart: the raycast described a 0.46 m patch and claimed 100% of the raster was covered; the
// bake described the actual venue and reported 17%. Both files parsed. Both looked plausible. Only
// one agreed with what the projector was really lighting — the bake, because the live
// render-from-projector draws that same caster set.
//
// A fallback that quietly writes a file describing different geometry at a fortieth of the resolution
// is worse than no file: the operator gets an artefact that looks like a calibration. So a bake that
// cannot run is now a SKIPPED output with a reason, and the export says which ones it dropped.

import type { MpcdiRegion, ProjectorCalibration } from '../../../shared/protocol';
import * as THREE from 'three';
import { cameraPose, glProjectionMatrix } from './cvCamera';
import { requestBake, type UvSource } from '@/components/Simulator3D/projectorBake'; // host module — the GPU bake
import { getScene } from './calibHost';
import type { BlendMap } from './blendCompute';

function blendToAlpha(b: BlendMap): { w: number; h: number; data: Uint8Array } {
  const data = new Uint8Array(b.data.length);
  for (let i = 0; i < b.data.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(b.data[i] * 255)));
  return { w: b.w, h: b.h, data };
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
): Promise<{ regions: MpcdiRegion[]; skipped: Array<{ surfaceId: string; why: string }> }> {
  const regions: MpcdiRegion[] = [];
  const skipped: Array<{ surfaceId: string; why: string }> = [];
  for (const o of outputs) {
    if (!o.calibration) { skipped.push({ surfaceId: o.surfaceId, why: 'not calibrated' }); continue; }
    // GPU bake at the projector's native raster, or nothing — see the header for why there is no
    // second path. `hits > 0` is part of the test: a map that renders but touches no geometry is a
    // wrong pose or a moved venue, and writing it would file that as a calibration.
    const [pw, ph] = o.calibration.imageSize;
    if (pw > 0 && ph > 0) {
      const viewProj = projectorViewProj(o.calibration);
      const map = viewProj ? await requestBake(viewProj, pw, ph, uvSourceFor) : null;
      if (map && map.hits > 0) {
        const region: MpcdiRegion = {
          id: o.surfaceId, projW: pw, projH: ph,
          geo: { w: map.w, h: map.h, xyz: map.uv, kind: 'uv' },
        };
        if (o.blend) region.alpha = blendToAlpha({ surfaceId: o.surfaceId, w: o.blend.w, h: o.blend.h, data: Float32Array.from(o.blend.alpha) } as never);
        regions.push(region);
        continue;
      }
    }
    skipped.push({ surfaceId: o.surfaceId, why: 'GPU bake unavailable — is the 3D viewport open?' });
  }
  return { regions, skipped };
}

/**
 * How each venue model turns a fragment into a content coordinate — read from the DOCUMENT, because
 * that is where the operator set it (3D Scene ▸ model ▸ UVs).
 *
 * `usesProjectedUv`'s rule, restated: projected mode needs BOTH `uvMode === 'projected'` and a
 * 16-float matrix. A model carrying a stale `uvProjView` from an old "From view" bake while sitting
 * on Mesh UVs is the common case — the matrix survives the switch back on purpose, so that
 * present-vs-projected stays a two-click A/B — and baking it as projected would silently apply a
 * mapping the operator turned off.
 */
function uvSourceFor(modelId: string): UvSource {
  const m = (getScene().models ?? []).find((x) => x.id === modelId);
  return m && m.uvMode === 'projected' && m.uvProjView?.length === 16
    ? { mode: 'projected', matrix: m.uvProjView }
    : { mode: 'authored' };
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
