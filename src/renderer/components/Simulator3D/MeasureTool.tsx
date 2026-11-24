import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { Fixture } from '../../types';
import { getOsnap, SNAP_POINT_LABEL, type OsnapKind, type SnapCandidate } from '../../services/snap3d';
import { swallowNextClick } from './GizmoOrbitGuard';
import { paneViewAt } from './MultiView';
import { pointerRay, querySnap } from './snapQuery';
import { htmlPosition } from './htmlPosition';

// THE MEASURE TOOL (plans/3d-workbench.md Phase 3, owner decision §6.6). Click a point, click another:
// the distance between them, its X / Y / Z parts and its angle from the horizontal. Each click lands on
// the same object snaps as a drag (End, Mid, Edge, Face, Centre, Fixture) — with Face always offered
// here, because a measurement from "a point on that wall" is the common one — and, with nothing under
// the cursor, on the floor (y = 0). A third click starts a new measurement; Esc clears it.
//
// It is a MODE beside the transform tools (ruler button / M), not one of them: it changes what a click
// does and leaves the selection, the gizmo and the camera alone. A measuring click is never a pick (its
// click is swallowed); a drag still orbits. Nothing here touches React state at pointer rate: the line
// is one THREE.Line rewritten in place, the label and markers are DOM written by direct style.

const DRAG_PX = 4;
const _o = new THREE.Object3D();   // a point's stand-in for htmlPosition, reused every frame
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function fmt(m: number): string {
  const a = Math.abs(m);
  return a >= 10 ? `${m.toFixed(2)} m` : a >= 1 ? `${m.toFixed(3)} m` : `${(m * 1000).toFixed(0)} mm`;
}

export const MeasureTool: React.FC<{ fixtures: Fixture[] }> = ({ fixtures }) => {
  const get = useThree((s) => s.get);
  const fx = useRef(fixtures); fx.current = fixtures;
  // The line: A → B (or A → the cursor while choosing B). Drawn over everything — a measurement hidden
  // behind the wall it measures is no use.
  const line = useMemo(() => {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: '#ffd166', depthTest: false, transparent: true, toneMapped: false }));
    l.renderOrder = 20;
    l.frustumCulled = false;
    l.visible = false;
    l.raycast = () => {};
    return l;
  }, []);
  useEffect(() => () => { line.geometry.dispose(); (line.material as THREE.Material).dispose(); }, [line]);

  const st = useRef<{ a: THREE.Vector3 | null; b: THREE.Vector3 | null; hover: THREE.Vector3 | null; hoverKind: string | null }>({ a: null, b: null, hover: null, hoverKind: null });
  const dom = useRef<{ label: HTMLDivElement; mA: HTMLDivElement; mB: HTMLDivElement; host: HTMLElement } | null>(null);

  useEffect(() => {
    const { gl } = get();
    const host = gl.domElement.parentElement ?? gl.domElement;
    const mk = (cls: string, html = '') => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; d.style.display = 'none'; host.appendChild(d); return d; };
    const dot = 'pointer-events-none absolute z-10';
    const ring = '<div style="width:10px;height:10px;margin:-5px 0 0 -5px;border:2px solid #ffd166;border-radius:50%"></div>';
    const label = mk('pointer-events-none absolute z-10 text-micro px-1.5 py-0.5 rounded-sm bg-surface-1/90 text-fg-1 border border-line-2 whitespace-nowrap');
    const mA = mk(dot, ring), mB = mk(dot, ring);
    dom.current = { label, mA, mB, host };

    let down: { x: number; y: number } | null = null;
    const canvasPt = (e: PointerEvent) => {
      const { camera } = get();
      const c = gl.domElement.getBoundingClientRect();
      const x = e.clientX - c.left, y = e.clientY - c.top;
      const pv = paneViewAt(x, y, c.width, c.height, camera);
      const r = pv?.rect ?? { x: 0, y: 0, w: c.width, h: c.height };
      return { cam: pv?.cam ?? camera, px: x - r.x, py: y - r.y, r, inside: x >= 0 && y >= 0 && x <= c.width && y <= c.height };
    };
    const pointAt = (e: PointerEvent): { p: THREE.Vector3; kind: string | null } | null => {
      const v = canvasPt(e);
      if (!v.inside) return null;
      const { scene } = get();
      const models: THREE.Object3D[] = [];
      scene.traverse((o) => { if (o.userData?.modelId && o.visible) models.push(o); });
      const os = getOsnap();
      const kinds: OsnapKind[] = Array.from(new Set<OsnapKind>([...(os.on && !e.altKey ? os.kinds : []), 'face']));
      const s: SnapCandidate | null = querySnap({ camera: v.cam, x: v.px, y: v.py, w: v.r.w, h: v.r.h, models, fixtures: os.on && !e.altKey ? fx.current : [], kinds });
      if (s) return { p: s.point.clone(), kind: s.kind === 'face' ? null : SNAP_POINT_LABEL[s.kind] };
      const ray = pointerRay(v.cam, v.px, v.py, v.r.w, v.r.h);
      const hit = new THREE.Vector3();
      return ray.intersectPlane(_plane, hit) ? { p: hit, kind: null } : null;
    };
    const onDown = (e: PointerEvent) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; };
    const onUp = (e: PointerEvent) => {
      const d = down; down = null;
      if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_PX) return;   // a drag orbits
      if (!(e.target instanceof Node) || !(e.target === gl.domElement || host.contains(e.target))) return;
      const pt = pointAt(e);
      if (!pt) return;
      swallowNextClick();   // a measuring click is not a pick
      const s = st.current;
      if (!s.a || s.b) { s.a = pt.p; s.b = null; } else { s.b = pt.p; }
    };
    const onMove = (e: PointerEvent) => {
      const s = st.current;
      if (down) return;
      const pt = pointAt(e);
      s.hover = pt?.p ?? null;
      s.hoverKind = pt?.kind ?? null;
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && (st.current.a || st.current.b)) { st.current.a = st.current.b = null; e.stopPropagation(); } };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('keydown', onKey, true);
    // DIAGNOSTIC (read-only): the current measurement, for a test.
    const w = window as unknown as Record<string, unknown>;
    w.__artluxMeasure = () => { const s = st.current; return s.a && s.b ? { a: s.a.toArray(), b: s.b.toArray(), d: s.a.distanceTo(s.b), text: label.textContent } : { a: s.a?.toArray() ?? null, b: null }; };
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('keydown', onKey, true);
      label.remove(); mA.remove(); mB.remove();
      dom.current = null;
      delete w.__artluxMeasure;
    };
  }, [get]);

  // Per frame: the line and the DOM follow the camera (direct writes, no state).
  const _d = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    const s = st.current, d = dom.current;
    if (!d) return;
    const end = s.b ?? (s.a ? s.hover : null);
    const place = (el: HTMLElement, p: THREE.Vector3 | null) => {
      if (!p) { el.style.display = 'none'; return; }
      _o.position.copy(p); _o.updateMatrixWorld();
      const [x, y] = htmlPosition(_o, camera, size);
      const c = (get().gl.domElement.getBoundingClientRect()), h = d.host.getBoundingClientRect();
      el.style.left = `${x + c.left - h.left}px`; el.style.top = `${y + c.top - h.top}px`; el.style.display = 'block';
    };
    place(d.mA, s.a ?? s.hover);
    place(d.mB, s.a ? end : null);
    if (s.a && end) {
      const pos = line.geometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, s.a.x, s.a.y, s.a.z); pos.setXYZ(1, end.x, end.y, end.z); pos.needsUpdate = true;
      line.visible = true;
      _d.subVectors(end, s.a);
      const dist = _d.length();
      const horiz = Math.hypot(_d.x, _d.z);
      const ang = dist > 1e-6 ? (Math.atan2(Math.abs(_d.y), horiz) * 180) / Math.PI : 0;
      d.label.textContent = `${fmt(dist)}   ΔX ${fmt(_d.x)} · ΔY ${fmt(_d.y)} · ΔZ ${fmt(_d.z)} · ${ang.toFixed(1)}° from level${!s.b && s.hoverKind ? `   → ${s.hoverKind}` : ''}`;
      place(d.label, _d.clone().multiplyScalar(0.5).add(s.a));
      d.label.style.transform = 'translate(-50%, -140%)';
    } else {
      line.visible = false;
      d.label.textContent = s.hoverKind ?? '';
      place(d.label, s.hoverKind ? s.hover : null);
      d.label.style.transform = 'translate(10px, -50%)';
    }
  });

  return <primitive object={line} />;
};
