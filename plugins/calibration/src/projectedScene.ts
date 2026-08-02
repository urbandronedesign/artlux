import * as THREE from 'three';
import type { Scene3D, ProjectorCalibration } from '../../../shared/protocol';
import { cameraPose, glProjectionMatrix } from './cvCamera';

// Structural rather than `ProjectorOutput[]`, so the editor can pass its lighter `projectorCalibs`
// prop and the App can pass the real outputs — both windows resolve through ONE function, which is
// the whole point (two implementations of this matrix would drift and the symptom would be content
// landing in different places in the editor and on the wall).
type CalibratedOutput = { surfaceId: string; calibration?: ProjectorCalibration | null };

// Resolve every model's LIVE projection source (SceneModel.uvProjFrom — the surfaceId of a calibrated
// output) into the concrete matrix + eye the shader consumes.
//
// Done on the way OUT rather than written into the document, for two reasons. The projector's solved
// pose is the source of truth: baking it back would mean a re-solve silently disagreeing with a stale
// copy, which is exactly the class of bug the frozen `uvProjView` bake had. And a PROJECTOR WINDOW
// CANNOT DO THIS ITSELF — it is sent only its own calibration, so a mesh projected from output B could
// never be resolved inside output A's window. Main holds every calibration, so it resolves once, at
// the scene push, and both windows are driven by this one function.
//
// Returns the SAME object when nothing needs resolving, so the common case costs one `.some()` and
// does not invalidate any identity-compared prop downstream.

const NEAR = 0.05, FAR = 200; // the clip range CalibCamera renders with — keep them in step

const sameNums = (a: readonly number[] | undefined, b: readonly number[]): boolean =>
  !!a && a.length === b.length && a.every((v, i) => v === b[i]);

export function resolveProjectedScene(scene: Scene3D, outputs: readonly CalibratedOutput[]): Scene3D {
  const models = scene.models;
  if (!models?.length || !models.some((m) => m.uvProjFrom)) return scene;

  // One projector can drive many meshes; solve its matrix once per publish.
  const cache = new Map<string, { view: number[]; eye: [number, number, number] } | null>();
  const resolve = (surfaceId: string) => {
    if (cache.has(surfaceId)) return cache.get(surfaceId)!;
    const cal = outputs.find((o) => o.surfaceId === surfaceId)?.calibration;
    // No solve = nothing to project from. Left null so the model falls back to whatever `uvProjView`
    // it already carries (a previous bake), or to authored UVs — never to a wrong matrix.
    if (!cal || cal.poseRms == null) { cache.set(surfaceId, null); return null; }
    const { position, quaternion } = cameraPose(cal.rotation, cal.translation as [number, number, number]);
    const world = new THREE.Matrix4().compose(
      new THREE.Vector3(position[0], position[1], position[2]),
      new THREE.Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3]),
      new THREE.Vector3(1, 1, 1),
    );
    // Exactly what CalibCamera renders with: the intrinsic GL projection times the inverse camera
    // world matrix. Anything else here and the content would land where the projector is NOT looking.
    const viewProj = new THREE.Matrix4()
      .fromArray(glProjectionMatrix(cal.intrinsics, cal.imageSize, NEAR, FAR))
      .multiply(world.clone().invert());
    const out = { view: viewProj.toArray(), eye: [position[0], position[1], position[2]] as [number, number, number] };
    cache.set(surfaceId, out);
    return out;
  };

  // IDEMPOTENT ON PURPOSE. A model whose resolved values already match is returned BY IDENTITY, and
  // an unchanged scene returns the very object it was given. Without this the function allocates a
  // fresh SceneModel every call, and a caller that runs per frame — this renderer repaints per frame
  // during playback — churns the identity of every 3D object 60×/s. That cost ~14 fps once already,
  // from a caller three files away. Correctness must not depend on the caller memoizing.
  let changed = false;
  const next = models.map((m) => {
    if (!m.uvProjFrom) return m;
    const r = resolve(m.uvProjFrom);
    if (!r) return m;
    if (sameNums(m.uvProjView, r.view) && sameNums(m.uvProjEye, r.eye)) return m;
    changed = true;
    return { ...m, uvProjView: r.view, uvProjEye: r.eye };
  });
  return changed ? { ...scene, models: next } : scene;
}
