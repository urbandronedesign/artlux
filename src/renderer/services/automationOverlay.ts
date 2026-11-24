// The live automation overlay for CORE (visual) params — the twin of transitions.ts.
//
// An imperative singleton the Stage frame pump lays over committed state each frame, so a curve animates
// at display rate WITHOUT React re-renders and WITHOUT ever touching the saved project. The authored
// value (what the slider last wrote) stays exactly where the user put it; the curve only shadows it while
// its lane owns the path. Disable the lane and the authored value is simply visible again — no restore
// step, because nothing was ever overwritten.
//
// This is the CORE half. Plugin namespaces (audio) own their own override layer behind the
// AutomationTargetProvider contract — core never reaches into them.
import { StateView, setByPath, isGeometryPath } from './paramPath';

const values = new Map<string, number>(); // targetPath → live sampled value
let geomDirty = false;
let paramDirty = false;

export function set(path: string, v: number): void {
  values.set(path, v);
  if (isGeometryPath(path)) geomDirty = true;
  else paramDirty = true;
}
// A release must ALSO mark dirty. Dropping a lane empties the overlay, so isActive() is already false on
// the very frame the authored value has to be restored — without this the consumer never re-uploads it
// and the LEDs stay stranded at the last automated value, forever.
export function release(path: string): void {
  if (!values.delete(path)) return;
  if (isGeometryPath(path)) geomDirty = true;
  else paramDirty = true;
}
export function clear(): void {
  if (values.size === 0) return;
  values.clear();
  geomDirty = true;
  paramDirty = true;
}

/** Does a lane currently own this path? transitions.ts asks, so a fade can LAND on a curve, not fight it. */
export function owns(path: string): boolean { return values.has(path); }
export function isActive(): boolean { return values.size > 0; }
/** E3f: the rest of every owned path under `prefix` (`fixtures.<id>.dmx.` → that light's lane-owned channel keys). */
export function ownedUnder(prefix: string): string[] {
  const out: string[] = [];
  for (const p of values.keys()) if (p.startsWith(prefix)) out.push(p.slice(prefix.length));
  return out;
}

/** True if a geometry / non-geometry leaf moved since the last frame was consumed (the GPU mapper needs to know). */
export function geometryAnimating(): boolean { return geomDirty; }
export function paramsAnimating(): boolean { return paramDirty; }
export function consumeDirty(): void { geomDirty = false; paramDirty = false; }

/** Lay the automated values over committed state. A pass-through when nothing is automated. */
export function apply(base: StateView): StateView {
  if (values.size === 0) return base;
  let v = base;
  for (const [path, val] of values) v = setByPath(v, path, val);
  return v;
}

/**
 * E3d — the same, LEAVING OUT the paths `skip` names (the native engine evaluates those lanes itself, so its
 * document carries the authored value and does not change every frame of a curve). Returns `base` itself —
 * the same arrays — when every automated path is skipped, which is what keeps the document unsent.
 */
export function applyExcept(base: StateView, skip: (path: string) => boolean): StateView {
  let v = base;
  for (const [path, val] of values) if (!skip(path)) v = setByPath(v, path, val);
  return v;
}

/** The value a lane holds on `path` right now (undefined when no lane owns it). */
export function value(path: string): number | undefined { return values.get(path); }
