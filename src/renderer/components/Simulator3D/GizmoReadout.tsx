import React, { useEffect, useRef } from 'react';
import { subscribeGesture, getGesture, type GestureSummary } from './fixturePreview';

// WHAT THE DRAG AMOUNTS TO, IN NUMBERS, WHILE IT IS HAPPENING.
//
// A gizmo without one is an eyeballing tool: you can see the bar move, and you cannot tell whether it
// moved 240 mm or 260. This is the other half of "precisely" — the snap grid decides where a drag can
// land, and this says where it HAS landed, so a placement can be checked before letting go rather than
// read back afterwards in the inspector.
//
// IT DOES NOT RE-RENDER. The gesture channel fires at pointer rate, and this component's whole output
// is one line of text, so it subscribes and writes `textContent` on the node directly. Routing that
// through setState would re-render a component tree that owns a WebGL context sixty times a second to
// change a string — the same reason the preview itself lives outside React (see fixturePreview.ts).
//
// Empty between gestures rather than showing the last one: a stale delta reads as a live one.

const m = (v: number) => (Math.abs(v) < 0.0005 ? '0' : v.toFixed(3));
const d = (v: number) => (Math.abs(v) < 0.05 ? '0' : v.toFixed(1));
const x = (v: number) => `${v.toFixed(3)}×`;

/** One line describing the gesture — the same words the operator would use for it. */
export function describeGesture(g: GestureSummary): string {
  if (g.mode === 'translate') {
    const dist = Math.hypot(g.delta.x, g.delta.y, g.delta.z);
    return `Δ ${m(g.delta.x)} ${m(g.delta.y)} ${m(g.delta.z)} m · ${m(dist)} m · at ${m(g.at.x)} ${m(g.at.y)} ${m(g.at.z)}`;
  }
  if (g.mode === 'rotate') {
    return `Δ pitch ${d(g.turn.pitch)}° yaw ${d(g.turn.yaw)}° roll ${d(g.turn.roll)}°`;
  }
  // Scale means two different things and the readout is where that stops being a secret: one fixture
  // resizes its own layout, several spread apart from their common centre.
  const f = `${x(g.factor.x)} ${x(g.factor.y)} ${x(g.factor.z)}`;
  return g.count > 1 ? `spread ${f} · ${g.count} fixtures` : `scale ${f}`;
}

export const GizmoReadout: React.FC = () => {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const write = () => {
      const el = ref.current;
      if (!el) return;
      const g = getGesture();
      el.textContent = g ? describeGesture(g) : '';
    };
    write();                       // a gesture may already be running when this mounts
    return subscribeGesture(write);
  }, []);

  return <span ref={ref} className="ml-auto num text-micro text-fg-2 tabular-nums whitespace-nowrap" />;
};
