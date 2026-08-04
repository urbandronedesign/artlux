import React, { useMemo } from 'react';
import * as THREE from 'three';

// A polyline that renders on BOTH backends — the replacement for drei's <Line>.
//
// drei's Line is Line2/LineMaterial ("fat lines"): a mesh per line, and a WebGL-only material that
// three's node renderer rejects outright ("NodeBuilder: Material LineMaterial is not compatible"), so
// every drei line simply vanished on the WebGPU path. This uses THREE.Line with the core
// LineBasic/LineDashed materials, which both renderers understand.
//
// WHAT IS LOST: `lineWidth` above 1. That is a platform limit, not a shortcut — WebGL ignores
// linewidth on almost every driver, which is the reason Line2 exists at all. Every call site here
// asked for 1.4–3.5px, i.e. "a bit heavier", and the information those widths carried (a tracking
// zone being occupied) is carried by the dashed/solid distinction instead, which does survive.
export const PolyLine: React.FC<{
  /** Points in order. Repeat the first point at the end to close a loop. */
  points: Array<[number, number, number]>;
  color: string;
  /** Dashes need per-vertex distances, so the geometry is built differently — hence a prop, not CSS. */
  dashed?: boolean;
  dashSize?: number;
  gapSize?: number;
  opacity?: number;
}> = ({ points, color, dashed = false, dashSize = 0.12, gapSize = 0.08, opacity = 1 }) => {
  const line = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    const arr = new Float32Array(points.length * 3);
    points.forEach((p, i) => arr.set(p, i * 3));
    geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize, gapSize, transparent: opacity < 1, opacity, toneMapped: false })
      : new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, toneMapped: false });
    const l = new THREE.Line(geom, mat);
    // REQUIRED for dashes: the dash pattern is driven by a per-vertex distance attribute, and without
    // this call every vertex reads 0 and the line draws solid — silently, which is the trap.
    if (dashed) l.computeLineDistances();
    l.raycast = () => { /* overlays are never pick targets */ };
    return l;
    // Rebuilt when the shape or look changes; disposal is handled below.
  }, [points, color, dashed, dashSize, gapSize, opacity]);

  // A new Line means new GPU resources, so the previous one must be released — these rebuild whenever
  // a tracking zone moves, which is every time an operator drags one.
  React.useEffect(() => () => {
    line.geometry.dispose();
    (line.material as THREE.Material).dispose();
  }, [line]);

  return <primitive object={line} />;
};
