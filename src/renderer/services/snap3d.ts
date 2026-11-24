// OBJECT SNAPS (Osnaps) — the renderer-independent half (plans/3d-workbench.md Phase 3, §2 design rule:
// the core stays when E4 replaces the r3f renderer; only the adapter, Simulator3D/snapQuery.ts, goes).
//
// What lives here: the snap KINDS and which ones are on (a per-machine preference, like the four-view
// layout — it is how this operator works, not part of the show), the ranking rule that picks ONE
// candidate out of everything near the cursor, and the fixture geometry (where a bar's ends are).
// Nothing here knows about meshes, cameras or React.
import * as THREE from 'three';

/** The toggles the operator sees (Rhino's Osnap bar). */
export type OsnapKind = 'end' | 'mid' | 'edge' | 'face' | 'center' | 'fixture';
export const OSNAP_KINDS: OsnapKind[] = ['end', 'mid', 'edge', 'face', 'center', 'fixture'];
export const OSNAP_LABEL: Record<OsnapKind, string> = {
  end: 'End', mid: 'Mid', edge: 'Edge', face: 'Face', center: 'Centre', fixture: 'Fixture',
};
export const OSNAP_HINT: Record<OsnapKind, string> = {
  end: 'Corners of a model or screen',
  mid: 'The middle of a model edge',
  edge: 'Anywhere along a model edge',
  face: 'Anywhere on a surface',
  center: 'The centre of a model or screen',
  fixture: 'Both ends and the centre of a fixture — chain bars end to end',
};

/** What a candidate IS — finer than the toggles: a fixture has ends and a centre. */
export type SnapPointKind = 'end' | 'mid' | 'edge' | 'face' | 'center' | 'fixtureEnd' | 'fixtureCenter';
export const SNAP_POINT_LABEL: Record<SnapPointKind, string> = {
  end: 'End', mid: 'Mid', edge: 'Edge', face: 'Face', center: 'Centre', fixtureEnd: 'Fixture end', fixtureCenter: 'Fixture centre',
};
const TOGGLE_OF: Record<SnapPointKind, OsnapKind> = {
  end: 'end', mid: 'mid', edge: 'edge', face: 'face', center: 'center', fixtureEnd: 'fixture', fixtureCenter: 'fixture',
};
export const toggleOf = (k: SnapPointKind): OsnapKind => TOGGLE_OF[k];

export interface SnapCandidate {
  kind: SnapPointKind;
  point: THREE.Vector3;
  /** Screen distance from the cursor, css px. */
  px: number;
  /** World normal of the surface (Face only) — for "align to surface", the next step. */
  normal?: THREE.Vector3;
}

/** Within this screen radius a candidate captures the drag — the same 22 px the calibration snap uses. */
export const CAPTURE_PX = 22;

/**
 * ONE winner. A POINT (end, mid, centre, a fixture's end or centre) inside the capture radius beats any
 * edge or face, nearest first — a corner you are aiming at must not lose to the edge it sits on, which
 * is always nearer by a pixel. Then an edge, then the face under the cursor. Ties between point kinds
 * at the same distance go to ends: they are what bars are chained and screens aligned by.
 */
const POINT_RANK: Partial<Record<SnapPointKind, number>> = { fixtureEnd: 0, end: 0, fixtureCenter: 1, mid: 1, center: 2 };
export function pickBest(cands: SnapCandidate[]): SnapCandidate | null {
  let best: SnapCandidate | null = null;
  for (const c of cands) {
    if (c.px > CAPTURE_PX || POINT_RANK[c.kind] === undefined) continue;
    if (!best || c.px < best.px - 0.5 || (Math.abs(c.px - best.px) <= 0.5 && POINT_RANK[c.kind]! < POINT_RANK[best.kind]!)) best = c;
  }
  if (best) return best;
  for (const c of cands) if (c.kind === 'edge' && c.px <= CAPTURE_PX && (!best || c.px < best.px)) best = c;
  if (best) return best;
  return cands.find((c) => c.kind === 'face') ?? null;
}

// ── The settings: on/off and which kinds, per machine ────────────────────────────────────────────
/** `align`: a drop on a Face snap also TURNS the selection to lie flat against that surface (Phase 3 step 2). */
export interface OsnapSettings { on: boolean; kinds: OsnapKind[]; align: boolean }
const KEY = 'artlux.osnap';
const DEFAULT: OsnapSettings = { on: true, kinds: ['end', 'mid', 'center', 'fixture'], align: true };
let settings: OsnapSettings = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && typeof raw.on === 'boolean' && Array.isArray(raw.kinds)) {
      return { on: raw.on, kinds: raw.kinds.filter((k: unknown): k is OsnapKind => OSNAP_KINDS.includes(k as OsnapKind)), align: raw.align !== false };
    }
  } catch { /* blocked storage: defaults */ }
  return { ...DEFAULT, kinds: [...DEFAULT.kinds] };
})();
const subs = new Set<() => void>();
export const getOsnap = (): OsnapSettings => settings;
export function setOsnap(patch: Partial<OsnapSettings>): void {
  settings = { ...settings, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* per-machine convenience only */ }
  subs.forEach((f) => f());
}
export function toggleOsnapKind(k: OsnapKind): void {
  const has = settings.kinds.includes(k);
  setOsnap({ kinds: has ? settings.kinds.filter((x) => x !== k) : [...settings.kinds, k] });
}
export function subscribeOsnap(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }

// ── Fixture geometry ─────────────────────────────────────────────────────────────────────────────
/**
 * A fixture's snap points from its LED positions (world xyz triples, LED order). The ENDS are the
 * physical ends of the run — half an LED pitch past the first and last LED — not the end LEDs: two bars
 * chained end to end then keep ONE pitch across the joint, which is the whole point of chaining them.
 * The centre is the mean of the LEDs. A single LED is its own centre and has no ends.
 */
export function fixtureSnapPoints(leds: Float32Array): { ends: THREE.Vector3[]; centre: THREE.Vector3 } | null {
  const n = leds.length / 3;
  if (n < 1) return null;
  const at = (i: number) => new THREE.Vector3(leds[i * 3], leds[i * 3 + 1], leds[i * 3 + 2]);
  const centre = new THREE.Vector3();
  for (let i = 0; i < n; i++) centre.add(at(i));
  centre.divideScalar(n);
  if (n < 2) return { ends: [], centre };
  const a = at(0), a2 = at(1), b = at(n - 1), b2 = at(n - 2);
  return {
    ends: [a.clone().addScaledVector(a.clone().sub(a2), 0.5), b.clone().addScaledVector(b.clone().sub(b2), 0.5)],
    centre,
  };
}

/** Closest point to `p` on segment a–b, written into `out`. */
export function closestOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const ab = _ab.subVectors(b, a);
  const len2 = ab.lengthSq();
  const t = len2 > 0 ? Math.min(1, Math.max(0, _ap.subVectors(p, a).dot(ab) / len2)) : 0;
  return out.copy(a).addScaledVector(ab, t);
}
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();
