import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { Fixture, FixtureProfile } from '../../types';
import { computeLedPositions, effectivePos, effectiveRot, meanScale, authoredRot, effectiveScale } from '../../services/led3dLayout';
import { gizmoDelta, gestureSummary, type GizmoBasis, type GizmoStart } from './gizmoDelta';
import { setPreview, clearPreview, beginPreview, type FixtureTransform } from './fixturePreview';
import { getLivePreview, type SnapSettings } from '../../services/scene3dQuality';
import { isResolvedLight } from '../../services/fixtureKind';
import { rigMetrics, mountShift } from '../../services/profileRig';
import { isLight } from '../../services/fixtureKind';
import type { SceneModel } from '../../../../shared/protocol';
import { findScreens } from './modelScreens';
import { usesProjectedUv, usesProjectedOcclusion, DEFAULT_BIAS_M } from './projectedMapping';

// E4a — THE ENGINE'S 3D VIEW, editor half (engine half: engine/artlux-engine/src/view3d.rs; plans/
// native-engine.md E4, plans/3d-workbench.md Phase 4).
//
// The detached 3D view is drawn by the NATIVE ENGINE in its own window — any screen, its own swapchain,
// nothing rebuilt when it moves (a GPU viewport cannot leave the editor window, native-engine.md §9a). The
// engine already has every surface's picture and the LED colours; what it does not have is WHERE THINGS
// ARE in 3D. This sends exactly that, read off the editor's own three.js scene — so a model's recentre, a
// gizmo drag's commit, a .blend reload all reach the engine as the world matrices the editor itself draws
// with, and nothing is re-derived on the other side:
//   - models: each venue GLB's file and the world matrix of its recentred root (ModelObject tags it
//     `userData.enginePath`), each screen's quad and the surface it shows (PlaneObject `enginePlane`);
//   - leds: every pixel fixture's LED world positions (led3dLayout.computeLedPositions — the editor's
//     InstancedLeds positions), in the order of their texels in the engine's composed buffer;
//   - lights: each light fixture's housing position and, for a light whose profile resolves, its BEAM's fixed
//     half — the lens apex in world space (effectivePos + the rig's lens offset turned by the fixture's rotation +
//     the mounting lift, exactly Beams.tsx), that base rotation, the pan / tilt mid-points and the lens half-angle.
//     The moving half (intensity, colour, pan, tilt, zoom) the ENGINE resolves itself each tick (E4b,
//     lightpack.rs Head::resolve); `beams` carries the look (haze, diagram cones, Rendered) and the selection;
//   - content: what every mesh of a venue file WEARS — a named screen's surface, the whole model's
//     surface through its UVs or PROJECTED from a projector (engineContent below);
//   - lines: the projector frustums (anything tagged `userData.engineLine`), in world space.
// Sent only while the view is open, at most four times a second, and only when it changed (one string
// compare). Pointer-rate work stays out of React: this is a timer, not state.

const PERIOD_MS = 250;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** One content source as the engine draws it: a surface's live picture (null = a binding the engine cannot
 *  draw, e.g. a timeline layer — dark, as the editor shows a binding with no frame), optionally projected. */
interface EngineSrc {
  surface: string | null;
  proj?: { view: number[]; eye: number[]; soft: number; cull: boolean; occlude: boolean; bias: number };
}

/**
 * What each mesh of a venue file wears, with the precedence modelScreens.assignContentMaterials applies
 * (a BOUND named screen wears its own; every other mesh the model's; neither → the file's material).
 * `mesh[i]` is the i-th Mesh of `root` in three's traversal order — the order the engine's loader walks
 * the file's (node, triangle primitive) pairs in — an index into `src`, or −1 for the file's own material.
 */
export function engineContent(root: THREE.Object3D, model: SceneModel): { src: EngineSrc[]; mesh: number[] } | null {
  const src: EngineSrc[] = [];
  let whole = -1;
  if (model.layerId || model.surfaceId) {
    whole = src.length;
    src.push({
      surface: model.layerId ? null : model.surfaceId!,
      proj: usesProjectedUv(model) ? {
        view: model.uvProjView!.map(r4), eye: (model.uvProjEye ?? [0, 0, 0]).map(r4),
        soft: model.uvProjSoft ?? 0, cull: !!model.uvProjCull,
        occlude: usesProjectedOcclusion(model), bias: model.uvProjBias ?? DEFAULT_BIAS_M,
      } : undefined,
    });
  }
  const screenSrc = new Map<string, number>();
  for (const [name, b] of Object.entries(model.screens ?? {})) {
    if (!b.layerId && !b.surfaceId) continue;
    screenSrc.set(name, src.length);
    src.push({ surface: b.layerId ? null : b.surfaceId! });
  }
  if (src.length === 0) return null;
  const screenOf = new Map<string, string>();
  for (const [name, meshes] of findScreens(root)) for (const m of meshes) screenOf.set(m.uuid, name);
  const mesh: number[] = [];
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    const s = screenOf.get(o.uuid);
    mesh.push((s !== undefined ? screenSrc.get(s) : undefined) ?? whole);
  });
  return { src, mesh };
}

function buildScene(scene: THREE.Scene, fixtures: Fixture[], beams: EngineBeams): string {
  const models: unknown[] = [];
  scene.updateMatrixWorld();
  scene.traverse((o) => {
    if (!o.userData?.modelId || !o.visible) return;
    const plane = o.userData.enginePlane as { surfaceId: string | null } | undefined;
    if (plane) {
      const mesh = o.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh | undefined;
      if (!mesh) return;
      const g = mesh.geometry as THREE.PlaneGeometry;
      models.push({ id: o.userData.modelId, kind: 'plane', surfaceId: plane.surfaceId, w: g.parameters?.width ?? 16 / 9, h: g.parameters?.height ?? 1, matrix: mesh.matrixWorld.elements.map(r4) });
      return;
    }
    o.traverse((c) => {
      if (typeof c.userData?.enginePath === 'string' && c.userData.enginePath) {
        const m = c.userData.engineModel as SceneModel | undefined;
        models.push({ id: o.userData.modelId, kind: 'glb', path: c.userData.enginePath, matrix: c.matrixWorld.elements.map(r4),
          content: m ? engineContent(c, m) : null });
      }
    });
  });
  // Projector frustums (ProjectorFrustum, the file-projector markers): world-space segments, colour
  // LINEAR (three keeps material colours in its linear working space; the engine's target is sRGB).
  const lines: number[] = [];
  const v = new THREE.Vector3();
  scene.traverseVisible((o) => {
    if (!o.userData?.engineLine || !(o as THREE.LineSegments).isLineSegments) return;
    const seg = o as THREE.LineSegments;
    const pos = seg.geometry.getAttribute('position');
    const col = ((Array.isArray(seg.material) ? seg.material[0] : seg.material) as THREE.LineBasicMaterial).color ?? new THREE.Color(1, 1, 1);
    if (!pos) return;
    for (let i = 0; i + 1 < pos.count; i += 2) {
      for (const k of [i, i + 1]) {
        v.fromBufferAttribute(pos, k).applyMatrix4(seg.matrixWorld);
        lines.push(r4(v.x), r4(v.y), r4(v.z), r4(col.r), r4(col.g), r4(col.b));
      }
    }
  });
  const leds = fixtures.filter((f) => !isLight(f) && (f.ledCount | 0) > 0).map((f) => ({ id: f.id, pos: Array.from(computeLedPositions(f), r4) }));
  const lights = fixtures.filter((f) => isLight(f)).map((f) => {
    const p = effectivePos(f);
    const out: Record<string, unknown> = { id: f.id, pos: [r4(p.x), r4(p.y), r4(p.z)] };
    if (isResolvedLight(f, beams.profiles)) {
      // Beams.tsx, the fixed half: the beam leaves the LENS, turned with the fixture, lifted by its mount.
      const rm = rigMetrics(beams.profiles.get(`${f.profileId}`)!);
      const scale = meanScale(f);
      const q = new THREE.Quaternion().setFromEuler(effectiveRot(f));
      const apex = new THREE.Vector3(rm.lens.x * scale, rm.lens.y * scale, rm.lens.z * scale).applyQuaternion(q).add(p);
      apex.y += mountShift(f.mount, rm, scale);
      Object.assign(out, { apex: [r4(apex.x), r4(apex.y), r4(apex.z)], q: [q.x, q.y, q.z, q.w].map((x) => Math.round(x * 1e6) / 1e6), panMid: rm.panMid, tiltMid: rm.tiltMid, lensHalf: rm.lensHalf });
    }
    return out;
  });
  const g = beams.gizmo && beams.gizmo.mode === 'translate' ? gizmoAnchor(beams.gizmo.fixtures, beams.gizmo.space, beams.gizmo.activeId) : null;
  return JSON.stringify({ models, leds, lights, lines, beams: { haze: r4(beams.haze), cones: beams.cones, rendered: beams.rendered, selected: beams.selected },
    grid: { visible: beams.grid, labels: beams.gridLabels },
    gizmo: g ? { at: [r4(g.at.x), r4(g.at.y), r4(g.at.z)], q: (g.space === 'local' ? [g.q.x, g.q.y, g.q.z, g.q.w] : [0, 0, 0, 1]).map((x) => Math.round(x * 1e6) / 1e6),
      snap: beams.gizmo!.snap?.on ? beams.gizmo!.snap.move : null } : null });
}

/**
 * E4b — WHERE THE GIZMO SITS, exactly as FixtureGizmo parks its anchor: the selection's centroid; oriented to the
 * ACTIVE fixture with "Object" axes, to a lone fixture's own rotation in "World" (three world-aligns translate
 * handles regardless), identity for a group. The engine draws the handles there; a drag comes back as an offset.
 */
export function gizmoAnchor(fixtures: readonly Fixture[], space: 'world' | 'local', activeId: string | null | undefined) {
  if (!fixtures.length) return null;
  const at = new THREE.Vector3();
  for (const f of fixtures) at.add(effectivePos(f));
  at.divideScalar(fixtures.length);
  const active = (activeId && fixtures.find((f) => f.id === activeId)) || fixtures[0];
  const e = space === 'local' ? effectiveRot(active) : fixtures.length === 1 ? effectiveRot(fixtures[0]) : new THREE.Euler();
  return { at, q: new THREE.Quaternion().setFromEuler(e), space };
}

// ── E4b: a drag on the ENGINE window's move gizmo, applied as the editor's own gizmo applies one ─────────────
// The same `gizmoDelta` as FixtureGizmo (the one definition of what a drag means), the same preview channel
// (fixturePreview: the editor's views follow at pointer rate, no document write), undo recorded on the FIRST
// movement, one commit on release. The engine sends only the offset; the anchor is re-derived here from the
// selection as it was at the grab, so the commit is measured against exactly what the editor had.
let engineGesture: { start: GizmoStart[]; basis: GizmoBasis; moved: boolean } | null = null;
export function applyEngineGizmo(
  phase: 'start' | 'move' | 'end', delta: [number, number, number],
  ctx: { fixtures: readonly Fixture[]; space: 'world' | 'local'; activeId: string | null | undefined; onRecordHistory: () => void; onCommit: (u: Array<{ id: string } & FixtureTransform>) => void },
): void {
  if (phase === 'start') {
    const a = gizmoAnchor(ctx.fixtures, ctx.space, ctx.activeId);
    if (!a) { engineGesture = null; return; }
    engineGesture = {
      basis: { centroid: a.at.clone(), quat: a.q.clone(), scale: new THREE.Vector3(1, 1, 1) },
      start: ctx.fixtures.map((f) => ({ id: f.id, pos: effectivePos(f), rot: authoredRot(f), scale: effectiveScale(f) })),
      moved: false,
    };
    beginPreview(getLivePreview());
    return;
  }
  const g = engineGesture;
  if (!g) return;
  const anchor = new THREE.Object3D();
  anchor.position.copy(g.basis.centroid).add(new THREE.Vector3(delta[0], delta[1], delta[2]));
  anchor.quaternion.copy(g.basis.quat);
  const moved = delta.some((x) => Math.abs(x) > 1e-9);
  if (phase === 'move') {
    if (!moved) return;
    if (!g.moved) { g.moved = true; ctx.onRecordHistory(); }
    setPreview(gizmoDelta(g.start, g.basis, anchor, 'translate'), gestureSummary(g.start, g.basis, anchor, 'translate'));
    return;
  }
  // end
  engineGesture = null;
  clearPreview();
  if (!moved) return;   // grabbed and let go where it was: nothing to record or commit
  if (!g.moved) ctx.onRecordHistory();
  ctx.onCommit(gizmoDelta(g.start, g.basis, anchor, 'translate'));
}

/** How the beams look, as the editor's Beams is told (Simulator3D): haze, the cone diagram, the Rendered look, and
 *  the heads being aimed (they get the whole diagram). */
export interface EngineBeams { profiles: ReadonlyMap<string, FixtureProfile>; haze: number; cones: boolean; rendered: boolean; selected: readonly string[];
  /** The editor's fixture gizmo: the selection it drives, its tool and axes, the snap — the engine draws Move. */
  gizmo?: { fixtures: readonly Fixture[]; mode: string; space: 'world' | 'local'; activeId: string | null | undefined; snap?: SnapSettings };
  /** The editor's floor grid and its numbers (scene3D.gridVisible / gridLabels) — the engine view follows them. */
  grid: boolean; gridLabels: boolean }

/** Mounted inside the Canvas while the engine's 3D view is open: keeps the engine's scene current. */
export const EngineViewLink: React.FC<{ fixtures: Fixture[]; beams: EngineBeams }> = ({ fixtures, beams }) => {
  const get = useThree((s) => s.get);
  const fx = useRef(fixtures); fx.current = fixtures;
  const bm = useRef(beams); bm.current = beams;
  useEffect(() => {
    let last = '';
    const send = () => {
      const json = buildScene(get().scene, fx.current, bm.current);
      if (json !== last) { last = json; window.artlux?.nativeEngineScene3d?.(json); }
    };
    send();
    const t = setInterval(send, PERIOD_MS);
    return () => clearInterval(t);
  }, [get]);
  return null;
};

/** Where the editor is looking from — the engine's view opens there. */
export function editorCamera(camera: THREE.Camera, controls: unknown): { position: number[]; target: number[]; fov: number } {
  const t = (controls as { target?: THREE.Vector3 } | null)?.target ?? new THREE.Vector3();
  const fov = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? (camera as THREE.PerspectiveCamera).fov : 50;
  return { position: camera.position.toArray(), target: t.toArray(), fov };
}

// The editor camera, for the header button (outside the Canvas). Module state: one Simulator3D (guarded).
let cameraNow: (() => { position: number[]; target: number[]; fov: number }) | null = null;
export function currentEditorCamera() { return cameraNow?.() ?? null; }
/** Always mounted inside the Canvas: lets the header read where the editor is looking from. */
export const EngineCameraBridge: React.FC = () => {
  const get = useThree((s) => s.get);
  useEffect(() => {
    cameraNow = () => { const { camera, controls } = get(); return editorCamera(camera, controls); };
    return () => { cameraNow = null; };
  }, [get]);
  return null;
};
