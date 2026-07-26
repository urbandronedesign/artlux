import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Fixture } from '../../types';
import { effectivePos } from '../../services/led3dLayout';

export interface MarqueeRect { x: number; y: number; w: number; h: number }

interface Props {
  fixtures: Fixture[];
  /** Live rectangle in CSS pixels relative to the canvas, or null when not dragging. */
  onRect: (rect: MarqueeRect | null) => void;
  /** Final selection. `additive` ⇒ the drag started with Shift and should extend the selection. */
  onSelect: (ids: string[], additive: boolean) => void;
  /** Ids already selected, so an additive drag can union rather than replace. */
  selectedIds: string[];
}

// Box-select for the 3D scene.
//
// There was no marquee anywhere in the renderer, which made a multi-selection something you could
// only build one ctrl-click at a time — and a rig is built in rows of twelve. This lives INSIDE the
// Canvas because it needs the live camera to project each fixture to screen space; the rectangle it
// reports back is drawn as a plain DOM overlay by Simulator3D.
//
// It selects on the fixture's ORIGIN, not its bounding box. That matches how the operator reads the
// scene (a fixture is "at" a point) and, more practically, it makes a small drag predictable: a box
// that merely clips the corner of a big housing does not sweep it in.
export const MarqueePicker: React.FC<Props> = ({ fixtures, onRect, onSelect, selectedIds }) => {
  const { camera, gl } = useThree();
  // Read through refs so the pointer handlers can stay bound for the life of the tool — rebinding
  // them every time a fixture moves would drop an in-flight drag.
  const fixturesRef = useRef(fixtures); fixturesRef.current = fixtures;
  const selectedRef = useRef(selectedIds); selectedRef.current = selectedIds;
  const onRectRef = useRef(onRect); onRectRef.current = onRect;
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect;

  useEffect(() => {
    const el = gl.domElement;
    let start: { x: number; y: number } | null = null;
    let additive = false;

    const local = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const rectOf = (a: { x: number; y: number }, b: { x: number; y: number }): MarqueeRect => ({
      x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y),
    });

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      start = local(e);
      additive = e.shiftKey || e.ctrlKey || e.metaKey;
      el.setPointerCapture(e.pointerId);
      onRectRef.current({ ...start, w: 0, h: 0 });
    };

    const move = (e: PointerEvent) => {
      if (!start) return;
      onRectRef.current(rectOf(start, local(e)));
    };

    const up = (e: PointerEvent) => {
      if (!start) return;
      const rect = rectOf(start, local(e));
      start = null;
      try { el.releasePointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      onRectRef.current(null);

      // A click rather than a drag: clear the selection, matching onPointerMissed on empty space.
      if (rect.w < 3 && rect.h < 3) { if (!additive) onSelectRef.current([], false); return; }

      const w = el.clientWidth, h = el.clientHeight;
      const v = new THREE.Vector3();
      const hits: string[] = [];
      for (const f of fixturesRef.current) {
        v.copy(effectivePos(f)).project(camera);
        // Behind the camera: `project` mirrors those to the front, which would sweep in fixtures
        // that are not on screen at all.
        if (v.z > 1) continue;
        const sx = (v.x * 0.5 + 0.5) * w;
        const sy = (-v.y * 0.5 + 0.5) * h;
        if (sx >= rect.x && sx <= rect.x + rect.w && sy >= rect.y && sy <= rect.y + rect.h) hits.push(f.id);
      }
      onSelectRef.current(
        additive ? [...new Set([...selectedRef.current, ...hits])] : hits,
        additive,
      );
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      onRectRef.current(null);
    };
  }, [camera, gl]);

  return null;
};
