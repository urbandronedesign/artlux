import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Scene3D, SceneModel } from '../../../shared/protocol';
import { buildPlacedModel, applyModelTransform } from '@/components/Simulator3D/venuePlacement'; // host helper — see ProjectorScene
import { registerVenueMesh, unregisterVenueMesh } from './venueRaycast';

// Venue meshes for a window that has no 3D viewport — i.e. the whole point of an unattended install.
//
// THE BLOCKER THIS REMOVES. In --broadcast (and --headless) App returns null, so Simulator3D never
// mounts, so ModelObject — the only thing that ever called registerVenueMesh — never runs, so
// venueRaycast's registry is empty and solveGeometry aborts with "no venue model loaded". The entire
// markerless calibration pipeline was therefore unable to run in the exact mode a permanent
// installation runs in. Not a limitation of the maths: the raycaster is plain CPU three.js
// (Raycaster + updateMatrixWorld), with no renderer, no canvas and no WebGL context anywhere near it.
// The coupling to the editor's viewport was incidental. So we load the GLBs ourselves and register
// the same placed groups.
//
// DOUBLE REGISTRATION IS IMPOSSIBLE BY CONSTRUCTION, not by a guard: in the editor ModelObject is the
// sole registrar (it must be — the operator drags models live and R3F owns that group), and in a
// show-engine window no ModelObject can exist. The two are mutually exclusive, over the same
// model.id keyspace, so venueRaycast needs no change at all.

const loader = new GLTFLoader();

interface Entry { model: SceneModel; group: THREE.Group }
const placed = new Map<string, Entry>();
const inFlight = new Set<string>();
let errors = 0;
let active = false;

export interface RegistrarStatus { models: number; registered: number; errors: number; active: boolean }
export function status(): RegistrarStatus {
  return { models: placed.size + inFlight.size, registered: placed.size, errors, active };
}
/** Are there venue meshes to raycast against? The precondition for any unattended solve. */
export function isReady(): boolean { return placed.size > 0; }

// Strip everything the raycaster does not need. A venue GLB's textures can be hundreds of megabytes
// and this process is expected to stay up for a year; geometry is the only thing a ray intersects.
const SHARED_MAT = new THREE.MeshBasicMaterial();
function stripMaterials(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      for (const k of Object.keys(m) as (keyof THREE.Material)[]) {
        const v = (m as unknown as Record<string, unknown>)[k as string];
        if (v && typeof v === 'object' && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
      }
      m.dispose();
    }
    mesh.material = SHARED_MAT;
  });
}

function dispose(entry: Entry): void {
  entry.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if ((mesh as { isMesh?: boolean }).isMesh) mesh.geometry?.dispose();
  });
}

const wanted = (s: Scene3D): SceneModel[] =>
  (s.models ?? []).filter((m) => m.kind !== 'plane' && !!m.path && m.visible);

// Same transform, no reload: moving a model must not re-parse its GLB, and re-placing in place keeps
// the registered object identity (venueRaycast holds the reference).
const sameGeometry = (a: SceneModel, b: SceneModel): boolean => a.path === b.path;

export async function reconcile(scene: Scene3D): Promise<void> {
  if (!active) return;
  const models = wanted(scene);
  const keep = new Set(models.map((m) => m.id));

  for (const [id, entry] of [...placed]) {
    if (keep.has(id)) continue;
    unregisterVenueMesh(id);
    dispose(entry);
    placed.delete(id);
  }

  for (const model of models) {
    const cur = placed.get(model.id);
    if (cur && sameGeometry(cur.model, model)) {
      // Transform-only change — re-place the existing group in place rather than reparsing the GLB.
      // Same call ModelObject makes, so the editor and this window cannot place a model differently.
      applyModelTransform(cur.group, model);
      cur.model = model;
      continue;
    }
    if (inFlight.has(model.id)) continue;
    inFlight.add(model.id);
    try {
      const bytes = await window.artlux?.readModel?.(model.path);
      if (!bytes) { errors++; continue; }
      const buf = (bytes as Uint8Array).buffer.slice(0) as ArrayBuffer;
      const gltf = await loader.parseAsync(buf, '');
      stripMaterials(gltf.scene);
      const group = buildPlacedModel(gltf.scene, model);
      const old = placed.get(model.id);
      if (old) { unregisterVenueMesh(model.id); dispose(old); }
      placed.set(model.id, { model, group });
      registerVenueMesh(model.id, group);
    } catch (e) {
      errors++;
      // Draco/KTX2-compressed GLBs need a decoder a bare GLTFLoader has not been given. Say so loudly:
      // silently having no venue mesh means every later recalibration aborts with a misleading reason.
      console.warn(`[calib] venue mesh "${model.path}" failed to load headlessly — ` +
        `if it is Draco/KTX2 compressed, re-export it uncompressed: ${(e as Error).message}`);
    } finally {
      inFlight.delete(model.id);
    }
  }
}

/** Start reconciling. Only meaningful in a show-engine window; the editor's ModelObject owns the rest. */
export function start(getScene: () => Scene3D, subscribe: (cb: () => void) => () => void): () => void {
  active = true;
  let unsub: (() => void) | null = null;
  void reconcile(getScene());
  unsub = subscribe(() => { void reconcile(getScene()); });
  return () => {
    active = false;
    unsub?.();
    for (const [id, entry] of placed) { unregisterVenueMesh(id); dispose(entry); }
    placed.clear();
  };
}
