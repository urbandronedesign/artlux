// THE 3D VIEWPOINT, readable and settable from outside the canvas — for ArtLux Calibrator's AUDIENCE
// SEAT (suite plan Phase 3, decision 15): save where you are looking from, come back to it, judge the
// wall from where people will stand. The camera and its orbit target live inside the r3f Canvas, so the
// one component that can touch them (Simulator3D's ViewBridge) registers here; everyone else asks.
// Null when no 3D view is mounted — the caller says so rather than pretending to have saved a seat.

export interface View3D { position: [number, number, number]; target: [number, number, number] }

let impl: { capture(): View3D | null; apply(v: View3D): void } | null = null;

export function registerView(i: { capture(): View3D | null; apply(v: View3D): void }): () => void {
  impl = i;
  return () => { if (impl === i) impl = null; };
}
export const captureView = (): View3D | null => impl?.capture() ?? null;
export const applyView = (v: View3D): boolean => { if (!impl) return false; impl.apply(v); return true; };
