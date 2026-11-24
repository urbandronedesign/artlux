import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { Fixture } from '../../types';
import { authoredRot, effectivePos, effectiveRot, effectiveScale, computeLedPositions } from '../../services/led3dLayout';
import { getOsnap, pickBest, fixtureSnapPoints, SNAP_POINT_LABEL, type SnapCandidate } from '../../services/snap3d';
import { getSnap, getLivePreview } from '../../services/scene3dQuality';
import { gizmoDelta, gestureSummary, type GizmoBasis, type GizmoStart } from './gizmoDelta';
import { setPreview, clearPreview, beginPreview, type FixtureTransform } from './fixturePreview';
import { gizmoHeld, holdOrbit, swallowNextClick } from './GizmoOrbitGuard';
import { paneViewAt } from './MultiView';
import { pressHit, pointerRay, querySnap, snapCandidates, warmSnapData } from './snapQuery';

// DRAG THE OBJECT ITSELF, WITH OBJECT SNAPS (plans/3d-workbench.md Phase 3; owner, 2026-11-24: "Drag the
// object" — Rhino's drag). Press on something that is ALREADY selected and drag it:
//   - THE BASE POINT is the point you pressed — pulled onto that object's own end, corner or centre
//     when one is within the capture radius (owner decision §6.3: the grabbed point, not Blender's
//     "closest"). That is what lets a LED bar be grabbed BY ITS END and chained onto another.
//   - THE TARGET is the object snap under the cursor (services/snap3d — End, Mid, Edge, Face, Centre,
//     Fixture), or, with nothing to snap to, the point under the cursor on the floor-level plane through
//     the base (a flat pane: the view's plane), on the grid step when the magnet is on.
//   - The selection moves by target − base. Alt bypasses object snaps; Ctrl inverts the grid, as it
//     does for the gizmo; Esc puts it back.
//
// It COMMITS THROUGH THE SAME PATHS AS THE GIZMO, so a drag is one undo step and nothing new reaches the
// document: fixtures through gizmoDelta + the preview channel (fixturePreview — live LEDs and bodies, the
// header readout) and one onCommit on release; models and screens by moving their group live and one
// onCommit on release. Each selected thing REGISTERS how it is dragged (registerDragTarget) — this file
// knows no model or fixture internals.
//
// POINTER RATE STAYS OUT OF REACT: window listeners, module state, and a marker element written with
// direct style writes. The orbit is switched off for the press (GizmoOrbitGuard.holdOrbit, which also
// restores it on release) and the click that ends a drag is swallowed — the two lessons of the gizmo.

export interface DragTarget {
  /** Does this intersection belong to the thing being dragged? */
  owns(hit: THREE.Intersection): boolean;
  /** Model / screen groups it moves (searched for the base point; excluded as targets). */
  groups(): THREE.Object3D[];
  /** Fixtures it moves (their ends/centre can be the base point; excluded as targets). */
  fixtures(): Fixture[];
  begin(): void;
  /**
   * Move by this world delta from where the drag began — and, when `turn` is given, first turn by
   * `turn.q` about `turn.pivot` (the base point): PLACE ON A SURFACE. Every point p of the selection
   * goes to  q·(p − pivot) + pivot + delta, and every orientation to  q · orientation.
   */
  move(delta: THREE.Vector3, turn?: { q: THREE.Quaternion; pivot: THREE.Vector3 }): void;
  /**
   * The direction the thing FACES, in world space, as it was when the drag began — a fixture's LEDs
   * and a screen's picture both face their local +Z. Absent = it is never turned onto a surface
   * (a venue model has no front).
   */
  facing?(): THREE.Vector3;
  /** Release: commit if anything moved. */
  end(): void;
  /** Esc: put everything back, commit nothing. */
  cancel(): void;
}
const targets = new Set<DragTarget>();
export function registerDragTarget(t: DragTarget): () => void { targets.add(t); return () => { targets.delete(t); }; }

/** Model / screen groups in the scene (tagged userData.modelId by ModelObject / PlaneObject). */
function modelGroups(scene: THREE.Scene): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  scene.traverse((o) => { if (o.userData?.modelId && o.visible) out.push(o); });
  return out.filter((g) => !out.some((h) => h !== g && isUnder(g, h)));   // top-level only
}
function isUnder(o: THREE.Object3D | null, root: THREE.Object3D): boolean {
  for (let p = o; p; p = p.parent) if (p === root) return true;
  return false;
}

const DRAG_PX = 4;
const DEG = Math.PI / 180;
const IDENTITY = new THREE.Quaternion();
const _plane = new THREE.Plane();
const _n = new THREE.Vector3();
const _hit = new THREE.Vector3();

interface Pending {
  target: DragTarget;
  cam: THREE.Camera;
  /** The pane's rect, canvas-relative css px (the whole canvas in one view). */
  rect: { x: number; y: number; w: number; h: number };
  canvas: DOMRect;
  sx: number; sy: number;
  base: THREE.Vector3;
  baseKind: string | null;
  started: boolean;
}

export const ObjectDrag: React.FC<{ fixtures: Fixture[]; enabled: boolean }> = ({ fixtures, enabled }) => {
  const get = useThree((s) => s.get);
  const allFixtures = useRef(fixtures); allFixtures.current = fixtures;
  const on = useRef(enabled); on.current = enabled;

  useEffect(() => {
    const { gl } = get();
    const host = gl.domElement.parentElement ?? gl.domElement;
    // The snap marker: a ring and its name, positioned by direct style writes (never React state).
    const marker = document.createElement('div');
    marker.className = 'pointer-events-none absolute z-10 flex items-center gap-1';
    marker.style.display = 'none';
    marker.innerHTML = '<div style="width:10px;height:10px;margin:-5px 0 0 -5px;border:2px solid var(--accent, #27b6c4);border-radius:2px"></div>'
      + '<span class="text-micro px-1 rounded-sm bg-surface-1/90 text-fg-1 border border-line-2" style="margin-top:-5px"></span>';
    host.appendChild(marker);
    const label = marker.querySelector('span') as HTMLSpanElement;
    const showMarker = (c: SnapCandidate | null, p: Pending) => {
      if (!c) { marker.style.display = 'none'; return; }
      const v = c.point.clone().project(p.cam);
      const hr = host.getBoundingClientRect();
      marker.style.left = `${p.canvas.left - hr.left + p.rect.x + ((v.x + 1) / 2) * p.rect.w}px`;
      marker.style.top = `${p.canvas.top - hr.top + p.rect.y + ((1 - v.y) / 2) * p.rect.h}px`;
      label.textContent = SNAP_POINT_LABEL[c.kind];
      marker.style.display = 'flex';
    };

    let pending: Pending | null = null;

    const viewAt = (e: PointerEvent) => {
      const { camera } = get();
      const canvas = gl.domElement.getBoundingClientRect();
      const x = e.clientX - canvas.left, y = e.clientY - canvas.top;
      const pv = paneViewAt(x, y, canvas.width, canvas.height, camera);
      const rect = pv?.rect ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
      return { canvas, rect, cam: pv?.cam ?? camera, px: x - rect.x, py: y - rect.y };
    };

    const onDown = (e: PointerEvent) => {
      pending = null;
      pressOnSelection = false;
      if (!on.current || e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || gizmoHeld() || !targets.size) return;
      if (!(e.target instanceof Node) || !(e.target === gl.domElement || host.contains(e.target))) return;
      const { scene, controls } = get();
      const v = viewAt(e);
      if (v.px < 0 || v.py < 0 || v.px > v.rect.w || v.py > v.rect.h) return;
      const extra: THREE.Object3D[] = [];
      scene.traverse((o) => { if (typeof o.userData?.fixtureIdAt === 'function' && o.visible) extra.push(o); });
      const hit = pressHit(v.cam, v.px, v.py, v.rect.w, v.rect.h, modelGroups(scene), extra);
      if (!hit) return;
      const target = [...targets].find((t) => t.owns(hit));
      if (!target) return;
      // The BASE POINT: the point pressed, pulled onto the object's own end / corner / centre.
      const own = pickBest(snapCandidates({
        camera: v.cam, x: v.px, y: v.py, w: v.rect.w, h: v.rect.h,
        models: target.groups(), fixtures: target.fixtures(), kinds: ['end', 'mid', 'center', 'fixture'],
      }));
      pending = { target, cam: v.cam, rect: v.rect, canvas: v.canvas, sx: e.clientX, sy: e.clientY,
        base: own ? own.point.clone() : hit.point.clone(), baseKind: own ? SNAP_POINT_LABEL[own.kind] : null, started: false };
      pressOnSelection = true;
      holdOrbit(controls);   // the orbit never hears this press; the guard restores it on release
      for (const g of modelGroups(scene)) warmSnapData(g);
    };

    const onMove = (e: PointerEvent) => {
      const p = pending;
      if (!p) return;
      if (!p.started) {
        if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < DRAG_PX) return;
        p.started = true;
        p.target.begin();
      }
      const { scene } = get();
      const canvas = gl.domElement.getBoundingClientRect();
      const px = e.clientX - canvas.left - p.rect.x, py = e.clientY - canvas.top - p.rect.y;
      const os = getOsnap();
      const exclude = new Set(p.target.groups());
      const dragged = new Set(p.target.fixtures().map((f) => f.id));
      const snap = os.on && !e.altKey ? querySnap({
        camera: p.cam, x: px, y: py, w: p.rect.w, h: p.rect.h,
        models: modelGroups(scene).filter((g) => !exclude.has(g)),
        fixtures: allFixtures.current.filter((f) => !dragged.has(f.id)),
        kinds: os.kinds,
      }) : null;
      let to: THREE.Vector3 | null = snap ? snap.point.clone() : null;
      if (!to) {
        // No snap: the plane through the base. Perspective — the floor-level plane (Rhino's CPlane),
        // or one facing the camera when the view grazes it; a flat pane — the view's own plane.
        const ray = pointerRay(p.cam, px, py, p.rect.w, p.rect.h);
        const o = p.cam as THREE.OrthographicCamera;
        if (o.isOrthographicCamera) p.cam.getWorldDirection(_n);
        else if (Math.abs(ray.direction.y) > 0.12) _n.set(0, 1, 0);
        else { p.cam.getWorldDirection(_n); _n.y = 0; _n.normalize(); }
        _plane.setFromNormalAndCoplanarPoint(_n, p.base);
        if (!ray.intersectPlane(_plane, _hit)) return;
        to = _hit.clone();
        const g = getSnap();
        if (e.ctrlKey ? !g.on : g.on) {
          // The grid step, on the delta, in the plane's axes (a flat pane's plane holds world axes).
          const d = to.sub(p.base);
          const step = g.move || 0.01;
          d.set(Math.round(d.x / step) * step, Math.round(d.y / step) * step, Math.round(d.z / step) * step);
          to = d.add(p.base);
        }
      }
      // PLACE ON A SURFACE (Phase 3 step 2): a Face snap carries the surface's normal (turned toward the
      // viewer by snapQuery). With "Turn to face the surface" on, the selection turns by the SMALLEST
      // rotation that brings its front onto that normal — so a bar keeps its run direction as near as
      // the wall allows, and a screen lies flush, picture outward. About the base point, so the point
      // you grabbed is still the one that lands.
      const front = p.target.facing?.();
      if (snap?.kind === 'face' && snap.normal && os.align && front) {
        const q = new THREE.Quaternion().setFromUnitVectors(front.clone().normalize(), snap.normal.clone().normalize());
        p.target.move(to.sub(p.base), { q, pivot: p.base });
      } else {
        p.target.move(to.sub(p.base));
      }
      showMarker(snap, p);
    };

    const finish = (commit: boolean) => {
      const p = pending;
      pending = null;
      pressOnSelection = false;
      marker.style.display = 'none';
      if (!p?.started) return;
      if (commit) p.target.end(); else p.target.cancel();
      swallowNextClick();
    };
    const onUp = () => finish(true);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && pending?.started) { e.stopPropagation(); finish(false); } };

    // DIAGNOSTIC (read-only): the last drag's base point label — a test reads it.
    const w = window as unknown as Record<string, unknown>;
    w.__artluxObjectDrag = () => {
      // Where each fixture's ends / centre and each model's box corners are — world and client px in
      // the single view — so a test can press on one and drop it on another.
      const { camera, scene } = get();
      const canvas = gl.domElement.getBoundingClientRect();
      const scr = (v: THREE.Vector3) => { const p = v.clone().project(camera); return [canvas.left + ((p.x + 1) / 2) * canvas.width, canvas.top + ((1 - p.y) / 2) * canvas.height]; };
      const r3 = (v: THREE.Vector3) => v.toArray().map((n) => Math.round(n * 1000) / 1000);
      return {
        targets: targets.size, pending: !!pending, started: !!pending?.started, base: pending?.baseKind ?? null,
        fixtures: allFixtures.current.map((f) => {
          const fp = fixtureSnapPoints(computeLedPositions(f));
          const er = effectiveRot(f);
          return { id: f.id, name: f.name, rot: [er.x, er.y, er.z].map((v) => Math.round(v / DEG * 10) / 10), ends: (fp?.ends ?? []).map((e) => ({ w: r3(e), s: scr(e) })), centre: fp ? { w: r3(fp.centre), s: scr(fp.centre) } : null };
        }),
        models: modelGroups(scene).map((g) => {
          const b = new THREE.Box3().setFromObject(g);
          const corners = [b.min, b.max].flatMap((a) => [b.min, b.max].flatMap((c) => [b.min, b.max].map((d) => new THREE.Vector3(a.x, c.y, d.z))));
          return { id: g.userData.modelId, rot: [g.rotation.x, g.rotation.y, g.rotation.z].map((v) => Math.round(v / DEG * 10) / 10), corners: corners.map((c) => ({ w: r3(c), s: scr(c) })) };
        }),
      };
    };

    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      if (pending?.started) pending.target.cancel();
      pending = null;
      marker.remove();
      delete w.__artluxObjectDrag;
    };
  }, [get]);

  return null;
};

/** True from a press on the selection until its release — MarqueePicker stands aside meanwhile (its
 *  listener is on the canvas, so it runs after ObjectDrag's window capture listener has decided). */
let pressOnSelection = false;
export function objectDragPending(): boolean { return pressOnSelection; }

/**
 * The SELECTED FIXTURES as a drag target — the same preview and commit as FixtureGizmo (gizmoDelta,
 * translate), so a drag is the gizmo's free move with a different way of reading the pointer.
 */
export const FixtureDragTarget: React.FC<{
  fixtures: Fixture[];
  onRecordHistory: () => void;
  onCommit: (updates: Array<{ id: string } & FixtureTransform>) => void;
}> = ({ fixtures, onRecordHistory, onCommit }) => {
  const anchor = useMemo(() => new THREE.Object3D(), []);
  const cb = useRef({ onRecordHistory, onCommit }); cb.current = { onRecordHistory, onCommit };
  const ids = fixtures.map((f) => f.id).join(',');
  useEffect(() => {
    if (!fixtures.length) return;
    const idSet = new Set(fixtures.map((f) => f.id));
    let start: GizmoStart[] = [];
    let last: Array<{ id: string } & FixtureTransform> | null = null;
    // A plain move is the gizmo's translate (gizmoDelta, so the two can never disagree). A TURN is the
    // gizmo's rotate composed the same way — a world delta premultiplied onto the AUTHORED trim
    // (gizmoDelta's note on why the delta form) — but about the grabbed point, not the centroid.
    const transforms = (d: THREE.Vector3, turn?: { q: THREE.Quaternion; pivot: THREE.Vector3 }) => {
      if (!turn) { anchor.position.copy(basis.centroid).add(d); anchor.quaternion.identity(); return gizmoDelta(start, basis, anchor, 'translate'); }
      const e = new THREE.Euler();
      const qs = new THREE.Quaternion();
      return start.map((st) => {
        const p = st.pos.clone().sub(turn.pivot).applyQuaternion(turn.q).add(turn.pivot).add(d);
        e.setFromQuaternion(turn.q.clone().multiply(qs.setFromEuler(st.rot)), 'XYZ');
        return { id: st.id, position3D: { x: p.x, y: p.y, z: p.z }, rotation3D: { pitch: e.x / DEG, yaw: e.y / DEG, roll: e.z / DEG } };
      });
    };
    let basis: GizmoBasis = { centroid: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) };
    let moved = false;
    let front = new THREE.Vector3(0, 0, 1);
    return registerDragTarget({
      // The ACTIVE fixture's front (the first selected): its LEDs face local +Z (FixtureBodies sits the
      // housing behind them, along -Z). One direction for the group, so a row turns as one.
      facing: () => front.clone(),
      owns: (hit) => {
        const at = hit.object.userData?.fixtureIdAt as ((i: number) => string | undefined) | undefined;
        return typeof at === 'function' && hit.instanceId != null && idSet.has(at(hit.instanceId) ?? '');
      },
      groups: () => [],
      fixtures: () => fixtures,
      begin: () => {
        const c = new THREE.Vector3();
        for (const f of fixtures) c.add(effectivePos(f));
        c.divideScalar(fixtures.length);
        anchor.position.copy(c);
        basis = { centroid: c.clone(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) };
        start = fixtures.map((f) => ({ id: f.id, pos: effectivePos(f), rot: authoredRot(f), scale: effectiveScale(f) }));
        front = new THREE.Vector3(0, 0, 1).applyEuler(effectiveRot(fixtures[0]));
        last = null;
        moved = false;
        beginPreview(getLivePreview());
      },
      move: (d, turn) => {
        if (!moved) { moved = true; cb.current.onRecordHistory(); }
        last = transforms(d, turn);
        // The readout's anchor: the centroid carried the same way, turned by the same rotation.
        anchor.position.copy(basis.centroid);
        if (turn) anchor.position.sub(turn.pivot).applyQuaternion(turn.q).add(turn.pivot);
        anchor.position.add(d);
        anchor.quaternion.copy(turn ? turn.q : IDENTITY);
        setPreview(last, gestureSummary(start, basis, anchor, turn ? 'rotate' : 'translate'));
      },
      end: () => {
        clearPreview();
        if (moved && last) cb.current.onCommit(last);
      },
      cancel: () => { clearPreview(); last = null; },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, ids, fixtures]);
  return null;
};

/** A selected model or screen as a drag target: its group moves live, one commit on release. */
export function useModelDragTarget(
  selected: boolean, group: THREE.Object3D,
  commit: () => void, onRecordHistory: () => void,
  /** A screen has a front (its picture, local +Z) and is turned onto a surface; a venue model is not. */
  hasFront = false,
): void {
  const cb = useRef({ commit, onRecordHistory }); cb.current = { commit, onRecordHistory };
  useEffect(() => {
    if (!selected) return;
    const start = new THREE.Vector3();
    const startQ = new THREE.Quaternion();
    let moved = false;
    return registerDragTarget({
      ...(hasFront ? { facing: () => new THREE.Vector3(0, 0, 1).applyQuaternion(startQ) } : {}),
      owns: (hit) => isUnder(hit.object, group),
      groups: () => [group],
      fixtures: () => [],
      begin: () => { start.copy(group.position); startQ.copy(group.quaternion); moved = false; },
      move: (d, turn) => {
        if (!moved) { moved = true; cb.current.onRecordHistory(); }
        // The delta is in WORLD space; a model's group sits directly in the scene (no scaled parent).
        group.position.copy(start);
        if (turn) group.position.sub(turn.pivot).applyQuaternion(turn.q).add(turn.pivot);
        group.position.add(d);
        group.quaternion.copy(turn ? turn.q.clone().multiply(startQ) : startQ);
      },
      end: () => { if (moved) cb.current.commit(); },
      cancel: () => { group.position.copy(start); group.quaternion.copy(startQ); },
    });
  }, [selected, group, hasFront]);
}
