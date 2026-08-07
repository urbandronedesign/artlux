import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { StateMachine, SmState, SmTransition, SmRegion, SmAction, SmActionKind, SmTrigger, SmTriggerKind, Marker, VideoLayer } from '../../types';
import { timeline as engine } from '../../services/timeline';
import { smTriggerRegistry } from '../../host/registries';
import { nextNumberedName } from '@artlux/sdk/renderer';
import { Plus, Star, Trash2, ArrowRight, Wand2, SquareDashed, Film, Snowflake, Zap, Maximize2, ZoomIn, Network } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { help } from '../../services/helpBus';
import { keymap } from '../../shortcuts/keymapStore';

// `holdsAtEnd` = this scene's timeline ends by FREEZING on its last frame (Timeline.holdAtEnd, Loop
// off) rather than by stopping. It is what a `requireEnd` transition out of this state waits for, so
// the node has to show it: a gated edge leaving a state that never holds is a show that stops here.
export interface SceneRef { id: string; name: string; clipCount?: number; holdsAtEnd?: boolean }
export interface CueRef { id: string; name: string }

interface Props {
  sm: StateMachine;
  markers: Marker[];
  layers: VideoLayer[];
  scenes: SceneRef[];
  cues: CueRef[];
  onChange: (sm: StateMachine) => void;
  /** Push the pre-mutation document onto the undo stack (App.recordHistory). Called by patch() —
      the single write chokepoint — so no gesture can forget it. Optional like Stage's. */
  onRecordHistory?: () => void;
  /** Leave the editor — jumping to the timeline. Absent when it IS the workbench (its own context). */
  onClose?: () => void;
  onEditTimeline?: (sceneId: string) => void; // enter author mode on a state's timeline (closes the graph)
}

// AutomataUI-style node-graph editor for the project-level "Show" machine over scenes.
//
// WAS a fixed-size centred modal (and, briefly, a draggable one). It is now the `machine`
// workspace context's viewport: a show graph is an authoring surface you work in for a long
// time and it wants the whole window, which no dialog can give it. Only the chrome changed. States are
// circular nodes (each can bind a Scene, recalled on entry); the initial state is drawn as the cyan
// Init node and the live/active state gets an orange ring. Transitions are bezier edges with draggable
// control handles, an auto-derived label + a [transition-time] badge (the scene crossfade on arrival).
// Regions are resizable group boxes that move their member states. Double-click empty canvas to add a
// state, drag a node's link nub onto another node to connect, Ctrl+click an edge to fire it manually.

const R = 34;                 // state node radius
const D = R * 2;
const ACTION_KINDS: SmActionKind[] = ['play', 'pause', 'stop', 'seek', 'setLoop', 'jumpMarker', 'recallScene', 'fireCue'];
// The CORE kinds only. Plugin-owned sources ('plugin' kind — a LiDAR trigger zone, a camera pose, a
// DMX level) are appended at render time from the registry, one entry per registered source, so this
// list never has to learn about them. The dropdown's value for those is `plugin:<source>`; nothing
// but this file's two small helpers below ever sees that encoding.
const TRIGGER_KINDS: SmTriggerKind[] = ['manual', 'afterDelay', 'atTime', 'onMarker', 'onClipEnd', 'onTimelineEnd'];
const triggerValue = (t: SmTrigger): string => (t.kind === 'plugin' ? `plugin:${t.source ?? ''}` : t.kind);
const triggerFromValue = (v: string, prev: SmTrigger): SmTrigger =>
  // Switching to a plugin source keeps nothing from the old trigger but its identity — the params of
  // an `atTime` mean nothing to a zone rule, and carrying them over would persist junk into the file.
  v.startsWith('plugin:') ? { kind: 'plugin', source: v.slice(7), params: prev.source === v.slice(7) ? prev.params : {} }
    : { kind: v as SmTriggerKind };
const uid = () => crypto.randomUUID();

type Vec = { x: number; y: number };
const C = (s: SmState): Vec => ({ x: s.x + R, y: s.y + R });
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
const length = (a: Vec) => Math.hypot(a.x, a.y) || 1;
const norm = (a: Vec): Vec => mul(a, 1 / length(a));
const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const defaultC = (a: Vec, b: Vec): [Vec, Vec] => [lerp(a, b, 0.33), lerp(a, b, 0.66)];
const rim = (c: Vec, toward: Vec): Vec => add(c, mul(norm(sub(toward, c)), R));
const bezAt = (p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec => {
  const u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
  return { x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x, y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y };
};
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

type Drag =
  | { kind: 'node'; id: string; x: number; y: number }
  | { kind: 'region'; id: string; x: number; y: number }
  | { kind: 'regionSize'; id: string; w: number; h: number }
  | { kind: 'handle'; id: string; which: 'c1' | 'c2' };

export const StateGraphEditor: React.FC<Props> = ({ sm, markers, layers, scenes, cues, onChange, onRecordHistory, onClose, onEditTimeline }) => {
  const [sel, setSel] = useState<{ kind: 'state' | 'transition' | 'region'; id: string } | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);     // source state while drawing a transition
  const [linkTo, setLinkTo] = useState<Vec | null>(null);            // live cursor (canvas coords) while linking
  const [drag, setDrag] = useState<Drag | null>(null);
  // The open-workspace camera (Stage.tsx pattern): an overflow-hidden viewport and a
  // translate/scale content layer, unbounded in every direction — negative coords included.
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [firedId, setFiredId] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const regions = sm.regions ?? [];

  // Live "current state" ring + fired-edge pulse driven render-free by the engine.
  useEffect(() => engine.subscribeSmState(setActiveId), []);
  useEffect(() => engine.subscribeSmFired((id) => {
    setFiredId(id);
    const t = window.setTimeout(() => setFiredId((cur) => (cur === id ? null : cur)), 450);
    return () => window.clearTimeout(t);
  }), []);

  // RECORD FIRST, THEN COMMIT (the scene3d.tsx doctrine), coalesced: a live bezier-handle drag and
  // a typing burst patch many times per second and must land as ONE undo step; 500ms of quiet
  // starts the next step. The record lives here — the single write chokepoint — so no gesture,
  // current or future, can forget it. Known trade: two discrete gestures finished within 500ms
  // coalesce, and a handle drag paused >500ms mid-gesture records a second step. Both benign.
  const lastEditTs = useRef(0);
  const patch = (next: Partial<StateMachine>) => {
    const now = performance.now();
    if (now - lastEditTs.current > 500) onRecordHistory?.();
    lastEditTs.current = now;
    onChange({ ...sm, ...next });
  };
  const patchState = (id: string, p: Partial<SmState>) => patch({ states: sm.states.map(s => s.id === id ? { ...s, ...p } : s) });
  const patchTransition = (id: string, p: Partial<SmTransition>) => patch({ transitions: sm.transitions.map(t => t.id === id ? { ...t, ...p } : t) });
  const patchRegion = (id: string, p: Partial<SmRegion>) => patch({ regions: regions.map(r => r.id === id ? { ...r, ...p } : r) });

  const toCanvas = (clientX: number, clientY: number): Vec => {
    const el = viewportRef.current; if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    // viewRef, NOT state: every drag below runs in window-level closures captured at drag start,
    // and a wheel-zoom mid-drag would otherwise leave them converting through a stale transform.
    const v = viewRef.current;
    return { x: (clientX - r.left - v.x) / v.scale, y: (clientY - r.top - v.y) / v.scale };
  };
  const viewCentre = (): Vec => {
    const el = viewportRef.current; if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return toCanvas(r.left + r.width / 2, r.top + r.height / 2);
  };
  const regionAt = (c: Vec): string | undefined =>
    [...regions].reverse().find(r => c.x >= r.x && c.x <= r.x + r.w && c.y >= r.y && c.y <= r.y + r.h)?.id;

  // --- create / delete ---
  const addStateAt = (x: number, y: number) => {
    // Numbered from what is TAKEN — this graph is edited by deleting nodes as much as by adding them,
    // and two `State 3` bubbles on one canvas is exactly the wrong place to have to guess.
    const st: SmState = { id: uid(), name: nextNumberedName('State', sm.states), x: x - R, y: y - R, entry: [], regionId: regionAt({ x, y }) };
    patch({ states: [...sm.states, st], initialStateId: sm.initialStateId ?? st.id });
    setSel({ kind: 'state', id: st.id });
  };
  const removeState = (id: string) => {
    patch({
      states: sm.states.filter(s => s.id !== id),
      transitions: sm.transitions.filter(t => t.from !== id && t.to !== id),
      initialStateId: sm.initialStateId === id ? (sm.states.find(s => s.id !== id)?.id ?? null) : sm.initialStateId,
    });
    setSel(null);
  };
  const addRegion = () => {
    // The NAME comes from what is taken; the x/y stagger deliberately still rides the count — it is a
    // cascade so a new region does not land exactly on the last one, not an identity. Anchored on the
    // current view centre: on an unbounded canvas "near the origin" can be anywhere but on screen.
    const c = viewCentre();
    const r: SmRegion = { id: uid(), name: nextNumberedName('Region', regions), x: c.x - 180 + regions.length * 30, y: c.y - 160 + regions.length * 30, w: 360, h: 320 };
    patch({ regions: [...regions, r] });
    setSel({ kind: 'region', id: r.id });
  };
  const removeRegion = (id: string) => {
    patch({ regions: regions.filter(r => r.id !== id), states: sm.states.map(s => s.regionId === id ? { ...s, regionId: undefined } : s) });
    setSel(null);
  };
  const removeTransition = (id: string) => { patch({ transitions: sm.transitions.filter(t => t.id !== id) }); setSel(null); };
  // A GLOBAL RULE — no source node, so it cannot be created by dragging a link nub the way an edge is.
  // Starts `manual` (inert until an operator picks a trigger) and targets the initial state, because a
  // rule that fired the moment it was created would hijack a running show mid-authoring.
  const addGlobalRule = () => {
    const to = sm.initialStateId ?? sm.states[0]?.id;
    if (!to) return;
    const t: SmTransition = { id: uid(), from: '', to, fromAny: true, trigger: { kind: 'manual' } };
    patch({ transitions: [...sm.transitions, t] });
    setSel({ kind: 'transition', id: t.id });
  };

  // One node per scene THAT DOES NOT HAVE ONE YET, each pre-bound to its scene — a top-up sync,
  // not an append: running it twice used to duplicate the whole graph, which is exactly wrong for
  // the workflow it exists for (capture more scenes, come back, build again). Laid out
  // TOP-TO-BOTTOM: a show reads as a flow, and the canvas is unbounded so there is no square to
  // wrap into. Anchored at the current view centre, then fitted, so it lands where you look.
  const boundSceneIds = new Set(sm.states.map(s => s.sceneId).filter(Boolean));
  const unboundScenes = scenes.filter(sc => !boundSceneIds.has(sc.id));
  const buildFromScenes = () => {
    if (!unboundScenes.length) return;
    const c = viewCentre();
    const states: SmState[] = unboundScenes.map((sc, i) => ({
      id: uid(), name: sc.name, sceneId: sc.id, entry: [],
      x: c.x - R, y: c.y - R + i * (D + 90),
    }));
    const all = [...sm.states, ...states];
    patch({ states: all, initialStateId: sm.initialStateId ?? states[0]?.id ?? null });
    fitViewTo(all, regions);
  };

  // Tidy — relayout the whole graph as a top-to-bottom flow: layers by BFS depth from the initial
  // state (BFS, not longest-path — show graphs loop back to attract states constantly, and BFS is
  // cycle-safe with no back-edge bookkeeping), unreachable islands in trailing layers, siblings
  // spread symmetrically about x=0. Regions are ignored for placement and membership is RE-DERIVED
  // from where each node lands — the same spatial rule node drag-drop enforces. Hand-curved
  // beziers are cleared: a curve authored against the old geometry is noise after a relayout.
  const tidy = () => {
    if (!sm.states.length) return;
    const succ = new Map<string, string[]>();
    for (const t of sm.transitions) {
      if (t.fromAny || t.from === t.to) continue; // a global rule has no source; a self-loop says nothing about depth
      const l = succ.get(t.from); if (l) l.push(t.to); else succ.set(t.from, [t.to]);
    }
    const depth = new Map<string, number>();
    const bfs = (root: string, d0: number) => {
      depth.set(root, d0);
      const q = [root];
      while (q.length) {
        const id = q.shift()!;
        for (const n of succ.get(id) ?? []) if (!depth.has(n)) { depth.set(n, depth.get(id)! + 1); q.push(n); }
      }
    };
    const init = sm.states.find(s => s.id === sm.initialStateId) ?? sm.states[0];
    bfs(init.id, 0);
    for (const s of sm.states) if (!depth.has(s.id)) bfs(s.id, Math.max(...depth.values()) + 1);
    const layers = new Map<number, SmState[]>();
    for (const s of sm.states) { const d = depth.get(s.id)!; const l = layers.get(d); if (l) l.push(s); else layers.set(d, [s]); }
    const gapX = D + 60, gapY = D + 90;
    const pos = new Map<string, Vec>();
    for (const [d, row] of layers) row.forEach((s, j) => pos.set(s.id, { x: (j - (row.length - 1) / 2) * gapX - R, y: d * gapY - R }));
    const states = sm.states.map(s => { const p = pos.get(s.id)!; return { ...s, x: p.x, y: p.y, regionId: regionAt({ x: p.x + R, y: p.y + R }) }; });
    const transitions = sm.transitions.map(t => (t.fromAny || (t.c1 == null && t.c2 == null)) ? t : { ...t, c1: undefined, c2: undefined });
    patch({ states, transitions }); // ONE patch — `sm` is the pre-patch prop
    fitViewTo(states, regions);
  };

  // --- drags (commit on release for node/region/resize; handles patch live) ---
  const beginNodeDrag = (e: React.PointerEvent, s: SmState) => {
    if (e.button !== 0) return; // before stopPropagation, so middle-drag bubbles up and pans
    e.stopPropagation();
    const start = toCanvas(e.clientX, e.clientY); const off = { x: start.x - s.x, y: start.y - s.y };
    // Commit only if the pointer actually MOVED (Stage doctrine): a plain click selects, and must
    // not push an identical array into App — since patch() records history, a no-op commit here is
    // a junk undo step that eats the operator's next Ctrl+Z.
    const sx = e.clientX, sy = e.clientY; let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) <= 2) return;
      moved = true;
      const c = toCanvas(ev.clientX, ev.clientY); setDrag({ kind: 'node', id: s.id, x: c.x - off.x, y: c.y - off.y });
    };
    const up = (ev: PointerEvent) => {
      if (moved) {
        const c = toCanvas(ev.clientX, ev.clientY); const x = c.x - off.x, y = c.y - off.y;
        patchState(s.id, { x, y, regionId: regionAt({ x: x + R, y: y + R }) });
      }
      setDrag(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    setSel({ kind: 'state', id: s.id });
  };
  const beginRegionDrag = (e: React.PointerEvent, r: SmRegion) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const start = toCanvas(e.clientX, e.clientY); const off = { x: start.x - r.x, y: start.y - r.y };
    const members = sm.states.filter(s => s.regionId === r.id).map(s => ({ id: s.id, dx: s.x - r.x, dy: s.y - r.y }));
    const sx = e.clientX, sy = e.clientY; let moved = false; // same moved-latch as beginNodeDrag
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) <= 2) return;
      moved = true;
      const c = toCanvas(ev.clientX, ev.clientY); setDrag({ kind: 'region', id: r.id, x: c.x - off.x, y: c.y - off.y });
    };
    const up = (ev: PointerEvent) => {
      if (moved) {
        const c = toCanvas(ev.clientX, ev.clientY); const x = c.x - off.x, y = c.y - off.y;
        patch({ regions: regions.map(rr => rr.id === r.id ? { ...rr, x, y } : rr), states: sm.states.map(s => { const m = members.find(mm => mm.id === s.id); return m ? { ...s, x: x + m.dx, y: y + m.dy } : s; }) });
      }
      setDrag(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    setSel({ kind: 'region', id: r.id });
  };
  const beginRegionResize = (e: React.PointerEvent, r: SmRegion) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY; let moved = false; // same moved-latch as beginNodeDrag
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) <= 2) return;
      moved = true;
      const c = toCanvas(ev.clientX, ev.clientY); setDrag({ kind: 'regionSize', id: r.id, w: Math.max(140, c.x - r.x), h: Math.max(120, c.y - r.y) });
    };
    const up = (ev: PointerEvent) => { if (moved) { const c = toCanvas(ev.clientX, ev.clientY); patchRegion(r.id, { w: Math.max(140, c.x - r.x), h: Math.max(120, c.y - r.y) }); } setDrag(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const beginHandleDrag = (e: React.PointerEvent, t: SmTransition, which: 'c1' | 'c2') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setDrag({ kind: 'handle', id: t.id, which });
    const move = (ev: PointerEvent) => { const c = toCanvas(ev.clientX, ev.clientY); patchTransition(t.id, { [which]: c } as Partial<SmTransition>); };
    const up = () => { setDrag(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  // Drag a node's link nub onto another node to create a transition — or onto empty canvas to
  // create the target state right there (the downward-authoring accelerator: pull the show flow
  // out of a node and the next state materializes where you let go).
  const beginLink = (e: React.PointerEvent, fromId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    setLinkFrom(fromId); setLinkTo(toCanvas(e.clientX, e.clientY));
    const move = (ev: PointerEvent) => setLinkTo(toCanvas(ev.clientX, ev.clientY));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      const tgt = (ev.target as HTMLElement)?.closest('[data-node]')?.getAttribute('data-node');
      if (tgt && tgt !== fromId) {
        const tr: SmTransition = { id: uid(), from: fromId, to: tgt, trigger: { kind: 'manual' } };
        patch({ transitions: [...sm.transitions, tr] }); setSel({ kind: 'transition', id: tr.id });
      } else if (!tgt && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) {
        // The 8px guard keeps a stray click on the nub from spawning a state; the rect check
        // keeps a drop that wandered into the inspector (or off the window) from creating one.
        const r = viewportRef.current?.getBoundingClientRect();
        if (r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
          const c = toCanvas(ev.clientX, ev.clientY);
          const st: SmState = { id: uid(), name: nextNumberedName('State', sm.states), x: c.x - R, y: c.y - R, entry: [], regionId: regionAt(c) };
          const tr: SmTransition = { id: uid(), from: fromId, to: st.id, trigger: { kind: 'manual' } };
          // ONE patch for both arrays — `sm` here is the pre-patch prop; two sequential patches
          // would have the second clobber the first.
          patch({ states: [...sm.states, st], transitions: [...sm.transitions, tr] });
          setSel({ kind: 'state', id: st.id });
        }
      }
      setLinkFrom(null); setLinkTo(null);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  // Left-drag on empty canvas pans; middle-drag pans from ANYWHERE (every element-level handler
  // ignores non-left buttons, so a middle press falls through to the viewport). A drag-less left
  // click is the deselect gesture — decided on release, so panning never clears the selection.
  const beginViewportPan = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault(); // a middle press would otherwise start Windows autoscroll
    const btn = e.button, sx = e.clientX, sy = e.clientY, v0 = { ...viewRef.current };
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) <= 3) return; // click slop
      moved = true;
      setView({ x: v0.x + (ev.clientX - sx), y: v0.y + (ev.clientY - sy), scale: v0.scale });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (!moved && btn === 0) { setSel(null); setLinkFrom(null); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  // Zoom around the cursor — one synchronous updater, same math and [0.1, 5] clamp as the Stage
  // (Stage.tsx handleWheel), so the app's two 2D workspaces share one navigation feel. Plain wheel
  // on purpose: with the old scroll-document gone there is nothing else for the wheel to do, and
  // the previous Ctrl+wheel habit still lands here (the modifier is simply ignored).
  //
  // A NATIVE non-passive listener, not React's onWheel: React binds wheel passively at the root,
  // so a preventDefault there is a console-warning no-op and the wheel would ALSO scroll whatever
  // scrollable pane the dock has put around us. Mount-once is safe — the handler reads no state
  // (functional setView only), which is exactly what the old version's `[scale]` re-subscribe
  // dep bug got wrong.
  useEffect(() => {
    const el = viewportRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setView(prev => {
        const ns = Math.min(5, Math.max(0.1, prev.scale + -e.deltaY * 0.001));
        if (ns === prev.scale) return prev;
        // The canvas point under the cursor stays under it: v' = m − (m − v)·(s'/s).
        const k = ns / prev.scale;
        return { x: mx - (mx - prev.x) * k, y: my - (my - prev.y) * k, scale: ns };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // Fit takes explicit arrays because Tidy / Build-from-scenes must frame positions they JUST
  // computed — inside those handlers the `sm` prop is still the pre-patch graph.
  const fitViewTo = (states: SmState[], regs: SmRegion[]) => {
    const el = viewportRef.current; if (!el) return;
    const { width: vw, height: vh } = el.getBoundingClientRect();
    if (vw <= 0 || vh <= 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of states) { minX = Math.min(minX, s.x); minY = Math.min(minY, s.y); maxX = Math.max(maxX, s.x + D); maxY = Math.max(maxY, s.y + D); }
    for (const g of regs) { minX = Math.min(minX, g.x); minY = Math.min(minY, g.y); maxX = Math.max(maxX, g.x + g.w); maxY = Math.max(maxY, g.y + g.h); }
    if (!Number.isFinite(minX)) { setView({ x: 0, y: 0, scale: 1 }); return; }
    const PAD = 32; // screen px of breathing room on every side
    // Capped at 1×, not the wheel's 5×: fit is for SEEING the graph, and one lone 68px node blown
    // up to fill the pane is not a view anyone asked for. The floor matches the wheel's, so fit
    // can never land somewhere the wheel can't reach.
    const scale = Math.min(Math.max(Math.min((vw - 2 * PAD) / (maxX - minX || 1), (vh - 2 * PAD) / (maxY - minY || 1)), 0.1), 1);
    setView({ x: vw / 2 - scale * (minX + maxX) / 2, y: vh / 2 - scale * (minY + maxY) / 2, scale });
  };
  const fitView = () => fitViewTo(sm.states, regions);
  const resetView = () => setView({ x: 0, y: 0, scale: 1 });
  // Frame the graph once, when states FIRST exist — not blindly at mount: if the app boots straight
  // into this context the editor mounts before the project's graph arrives, and a mount-only fit
  // would frame an empty canvas and then leave a graph authored around x=0 half off screen. (rAF:
  // the dock pane needs a layout pass before it has a size.)
  const didAutoFit = useRef(false);
  useLayoutEffect(() => {
    if (didAutoFit.current || !sm.states.length) return;
    didAutoFit.current = true;
    const id = requestAnimationFrame(fitView);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once, on first non-empty graph
  }, [sm.states.length]);

  // Delete the selection with Del/Backspace, frame the graph with F (unless typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = document.activeElement?.tagName;
      if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
      if (keymap.matches(e, 'stategraph.fitView')) { e.preventDefault(); fitView(); return; }
      if (!keymap.matches(e, 'stategraph.deleteSelected')) return;
      if (!sel) return; e.preventDefault();
      if (sel.kind === 'state') removeState(sel.id);
      else if (sel.kind === 'transition') removeTransition(sel.id);
      else removeRegion(sel.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, sm]); // the handlers close over the selection and the graph — no dep array meant a re-bind every render


  // --- the radial link nub ---
  // The nub RIDES THE NODE'S RIM toward the cursor while you hover, so a link can start in any
  // direction — the edges themselves were always omnidirectional (rim() is radial); only the
  // authoring gesture was pinned to the right edge. Positioned by direct style writes, never
  // React state: the renderer repaints per-frame during playback, and a setState per mousemove
  // would re-render the whole editor at pointer rate. At rest it parks at the right edge —
  // always visible, so the affordance stays discoverable without knowing to hover.
  const NUB = 7; // half the nub's 14px box
  const nubRefs = useRef(new Map<string, HTMLDivElement>());
  const placeNub = (e: React.PointerEvent, s: SmState) => {
    if (drag) return; // mid-drag the committed centre is stale — leave the nub parked
    const el = nubRefs.current.get(s.id); if (!el) return;
    const d = sub(toCanvas(e.clientX, e.clientY), C(s));
    const u = Math.hypot(d.x, d.y) < 1 ? { x: 1, y: 0 } : norm(d); // cursor on the centre → right edge
    el.style.left = `${R + u.x * R - NUB}px`;
    el.style.top = `${R + u.y * R - NUB}px`;
  };
  const parkNub = (s: SmState) => {
    const el = nubRefs.current.get(s.id); if (!el) return;
    el.style.left = `${D - NUB}px`; el.style.top = `${R - NUB}px`;
  };

  // --- live positions (drag overrides) ---
  const nodePos = (s: SmState): Vec => (drag?.kind === 'node' && drag.id === s.id ? { x: drag.x, y: drag.y } : { x: s.x, y: s.y });
  const regionBox = (r: SmRegion) => {
    if (drag?.kind === 'region' && drag.id === r.id) return { ...r, x: drag.x, y: drag.y };
    if (drag?.kind === 'regionSize' && drag.id === r.id) return { ...r, w: drag.w, h: drag.h };
    return r;
  };
  const memberOffset = (s: SmState): Vec => {
    if (drag?.kind === 'region' && s.regionId === drag.id) { const r = regions.find(rr => rr.id === drag.id)!; return { x: drag.x - r.x, y: drag.y - r.y }; }
    return { x: 0, y: 0 };
  };
  const liveCenter = (s: SmState): Vec => { const p = nodePos(s); const o = memberOffset(s); return { x: p.x + o.x + R, y: p.y + o.y + R }; };

  // Rules evaluated from every state — they have no source node, so the canvas cannot draw them and the
  // inspector lists them instead. `globalTargets` is what puts the ⚡ badge on the states they can reach.
  const globalRules = sm.transitions.filter(t => t.fromAny);
  const globalTargets = new Set(globalRules.map(t => t.to));

  const selState = sel?.kind === 'state' ? sm.states.find(s => s.id === sel.id) ?? null : null;
  const selTrans = sel?.kind === 'transition' ? sm.transitions.find(t => t.id === sel.id) ?? null : null;
  const selRegion = sel?.kind === 'region' ? regions.find(r => r.id === sel.id) ?? null : null;
  // RESOLVED scene of the selected state — a set-but-unresolvable sceneId means the scene was
  // deleted, and the inspector must say so (the bare <select> renders BLANK for a dead value).
  const selStateScene = selState?.sceneId ? scenes.find(sc => sc.id === selState.sceneId) : undefined;

  const trLabel = (t: SmTransition) => {
    const to = sm.states.find(s => s.id === t.to);
    // A plugin trigger describes ITSELF ("Entrance: someone enters") — "toReaction" says where the
    // edge goes but not what fires it, and for a live trigger that is the half worth reading.
    const src = t.trigger.kind === 'plugin' ? smTriggerRegistry.get(t.trigger.source ?? '') : undefined;
    const desc = src?.describe?.(t.trigger.params ?? {});
    const base = desc ?? (to ? `to${cap(to.name.replace(/\s+/g, ''))}` : 'transition');
    // The `requireEnd` guard changes WHEN an edge can fire, so it belongs on the edge itself — reading
    // a graph should not require selecting every transition to discover which ones are gated.
    const label = t.requireEnd ? `⏱ ${base}` : base;
    return t.fadeSec != null ? `${label} [${t.fadeSec}]` : label;
  };

  return (
    <div className="w-full h-full bg-surface-0 flex flex-col overflow-hidden">
        <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-line-1 bg-surface-1">
          <span className="text-xs text-fg-1 font-medium">Show machine — states &amp; scenes</span>
          <Tooltip id="timeline.sm-add-state">
            {/* Drops at the CURRENT view centre — the old hard-coded document centre could be
                anywhere off screen once the canvas became unbounded. */}
            <button onClick={() => { const c = viewCentre(); addStateAt(c.x, c.y); }} {...help('timeline.sm-add-state')} className="flex items-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-mini text-fg-1 hover:bg-surface-3"><Plus size={12} /> State</button>
          </Tooltip>
          <Tooltip id="timeline.sm-add-region">
            <button onClick={addRegion} {...help('timeline.sm-add-region')} className="flex items-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-mini text-fg-1 hover:bg-surface-3"><SquareDashed size={12} /> Region</button>
          </Tooltip>
          <Tooltip id="timeline.sm-build-from-scenes">
            <button onClick={buildFromScenes} disabled={!unboundScenes.length}
              title={!scenes.length ? 'No scenes captured yet' : unboundScenes.length ? `Add a state for each scene without one (${unboundScenes.length})` : 'Every scene already has a state'}
              {...help('timeline.sm-build-from-scenes')}
              className="flex items-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-mini text-fg-1 hover:bg-surface-3 disabled:opacity-40"><Wand2 size={12} /> Build from scenes</button>
          </Tooltip>
          <Tooltip id="timeline.sm-tidy">
            <button onClick={tidy} disabled={!sm.states.length} title={sm.states.length ? 'Lay the graph out top-to-bottom from the initial state' : 'Nothing to lay out'}
              {...help('timeline.sm-tidy')}
              className="flex items-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-mini text-fg-1 hover:bg-surface-3 disabled:opacity-40"><Network size={12} /> Tidy</button>
          </Tooltip>
          <Tooltip id="timeline.sm-add-global-rule">
            <button onClick={addGlobalRule} disabled={!sm.states.length} title={sm.states.length ? 'A rule evaluated from EVERY state — for a trigger that must work whatever the show is doing' : 'Add a state first'}
              {...help('timeline.sm-add-global-rule')}
              className="flex items-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-mini text-fg-1 hover:bg-surface-3 disabled:opacity-40"><Zap size={12} /> Global rule</button>
          </Tooltip>
          <div className="w-px h-5 bg-line-2 mx-1"></div>
          {/* Same chrome as the Stage viewport: Fit is the primary recovery gesture on an unbounded
              canvas (you WILL lose the graph off screen), with plain reset kept reachable. */}
          <Tooltip id="timeline.sm-fit">
            <button onClick={(e) => (e.altKey ? resetView() : fitView())}
              title="Fit view to graph (Alt-click: reset view)" aria-label="Fit view to graph"
              {...help('timeline.sm-fit')}
              className="p-1.5 rounded-sm border bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1 transition-colors"><Maximize2 size={13} /></button>
          </Tooltip>
          <Tooltip id="timeline.sm-reset-view">
            <button onClick={resetView} title="Reset view" aria-label="Reset view"
              {...help('timeline.sm-reset-view')}
              className="p-1.5 rounded-sm border bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1 transition-colors"><ZoomIn size={13} /></button>
          </Tooltip>
          {linkFrom && <span className="text-micro text-accent">drag onto a target state to connect…</span>}
          <span className="ml-auto text-micro text-fg-3">dbl-click empty: add · dbl-click state: fire · drag nub: link · Ctrl+click edge: fire · drag: pan · wheel: zoom · F: fit</span>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* canvas — an open workspace: overflow-hidden viewport + translate/scale content layer
              (the Stage.tsx camera), unbounded in every direction, negative coordinates included. */}
          <div ref={viewportRef} className="relative flex-1 overflow-hidden bg-surface-0"
            onPointerDown={beginViewportPan}
            onDoubleClick={(e) => { if ((e.target as HTMLElement).closest('[data-node]')) return; const c = toCanvas(e.clientX, e.clientY); addStateAt(c.x, c.y); }}>
              {/* Canvas-locked grid, drawn in screen space on the UNtransformed viewport. The Stage's
                  inset:-200% grid div (Stage.tsx) surrounds a finite document; there is no document
                  here, so any fixed-size div could be panned off. A background repositioned by
                  view.x/y is unbounded by construction: canvas point p renders at view + p·scale,
                  so gridlines at canvas multiples of 40 stay locked to the graph. */}
              <div aria-hidden className="absolute inset-0 pointer-events-none" style={{
                backgroundImage: 'linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)',
                backgroundSize: `${40 * view.scale}px ${40 * view.scale}px`,
                backgroundPosition: `${view.x}px ${view.y}px`,
              }} />
              {/* The content layer is deliberately ZERO-SIZED — children position absolutely and
                  overflow freely, which is what makes the workspace edge-less. */}
              <div className="absolute top-0 left-0" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: '0 0' }}>
                {/* regions (behind everything) */}
                {regions.map(r => {
                  const b = regionBox(r); const selected = selRegion?.id === r.id;
                  return (
                    <div key={r.id} className={`absolute rounded-lg border ${selected ? 'border-accent' : 'border-line-2'} bg-surface-1/30`} style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
                      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); setSel({ kind: 'region', id: r.id }); }}>
                      <div className="absolute -top-0.5 left-0 right-3 h-6 flex items-center px-2 cursor-grab text-mini text-fg-2" onPointerDown={(e) => beginRegionDrag(e, r)}>{r.name}</div>
                      <div className="absolute bottom-0 right-0 w-3 h-3 cursor-nwse-resize" onPointerDown={(e) => beginRegionResize(e, r)}>
                        <div className="absolute bottom-0.5 right-0.5 w-2 h-2 border-r-2 border-b-2 border-fg-3" />
                      </div>
                    </div>
                  );
                })}

                {/* transition edges — a nominal 1×1 box with overflow:visible, so edges render (and
                    hit-test — Chromium hit-tests overflowing SVG content) at any coordinate. */}
                <svg className="absolute top-0 left-0" width={1} height={1} style={{ overflow: 'visible' }}>
                  <defs>
                    <marker id="sm-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="currentColor" /></marker>
                  </defs>
                  {sm.transitions.map(t => {
                    const a = sm.states.find(s => s.id === t.from), b = sm.states.find(s => s.id === t.to);
                    if (!a || !b) return null;
                    const ca = liveCenter(a), cb = liveCenter(b);
                    const [d1, d2] = defaultC(ca, cb);
                    const c1 = t.c1 ?? d1, c2 = t.c2 ?? d2;
                    const p0 = rim(ca, c1), p3 = rim(cb, c2);
                    const mid = bezAt(p0, c1, c2, p3, 0.5);
                    const selected = sel?.kind === 'transition' && sel.id === t.id;
                    const fired = firedId === t.id;
                    const color = fired ? '#ef4444' : selected ? '#5b9bff' : (activeId === t.from ? '#7dd3fc' : '#6b7280');
                    return (
                      <g key={t.id} style={{ color }}>
                        <path d={`M${p0.x},${p0.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p3.x},${p3.y}`} fill="none" stroke="transparent" strokeWidth={14}
                          style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                          onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); if (e.ctrlKey || e.metaKey) engine.triggerSmTransition(t.id); else setSel({ kind: 'transition', id: t.id }); }} />
                        <path d={`M${p0.x},${p0.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p3.x},${p3.y}`} fill="none" stroke="currentColor"
                          strokeWidth={selected || fired ? 2.5 : 1.6} markerEnd="url(#sm-arrow)" pointerEvents="none" />
                        {/* label + transition-time badge */}
                        <g transform={`translate(${mid.x},${mid.y})`} pointerEvents="none">
                          <rect x={-trLabel(t).length * 3.2 - 5} y={-9} width={trLabel(t).length * 6.4 + 10} height={16} rx={3} fill="#1b1d23" stroke="#2b2f38" />
                          <text textAnchor="middle" dy={3} fontSize={10} fill="#c8ccd4">{trLabel(t)}</text>
                        </g>
                        {/* bezier control handles (only when selected) */}
                        {selected && (
                          <>
                            <line x1={p0.x} y1={p0.y} x2={c1.x} y2={c1.y} stroke="#f5a623" strokeWidth={0.75} strokeDasharray="3 3" />
                            <line x1={p3.x} y1={p3.y} x2={c2.x} y2={c2.y} stroke="#f5a623" strokeWidth={0.75} strokeDasharray="3 3" />
                            <circle cx={c1.x} cy={c1.y} r={6} fill="#f5a623" style={{ cursor: 'grab', pointerEvents: 'all' }} onPointerDown={(e) => beginHandleDrag(e, t, 'c1')} />
                            <circle cx={c2.x} cy={c2.y} r={6} fill="#f5a623" style={{ cursor: 'grab', pointerEvents: 'all' }} onPointerDown={(e) => beginHandleDrag(e, t, 'c2')} />
                          </>
                        )}
                      </g>
                    );
                  })}
                  {/* live link preview */}
                  {linkFrom && linkTo && (() => {
                    const a = sm.states.find(s => s.id === linkFrom); if (!a) return null;
                    const ca = liveCenter(a); const p0 = rim(ca, linkTo);
                    return <line x1={p0.x} y1={p0.y} x2={linkTo.x} y2={linkTo.y} stroke="#5b9bff" strokeWidth={1.5} strokeDasharray="4 3" />;
                  })()}
                </svg>

                {/* state nodes */}
                {sm.states.map(s => {
                  const p = nodePos(s); const o = memberOffset(s);
                  const left = p.x + o.x, top = p.y + o.y;
                  const isInit = sm.initialStateId === s.id;
                  const isActive = activeId === s.id;
                  const selected = sel?.kind === 'state' && sel.id === s.id;
                  const scene = scenes.find(sc => sc.id === s.sceneId);
                  // A dead binding must LOOK different from no binding: without this, a node whose
                  // scene was deleted is pixel-identical to an unbound one, and the show silently
                  // loses a look (handleRemoveScene never touches the graph — by design).
                  const sceneMissing = !!s.sceneId && !scene;
                  return (
                    <div key={s.id} data-node={s.id} onPointerDown={(e) => beginNodeDrag(e, s)}
                      onPointerMove={(e) => placeNub(e, s)} onPointerLeave={() => parkNub(s)}
                      onDoubleClick={(e) => { e.stopPropagation(); if (!sm.enabled) patch({ enabled: true }); engine.enterSmState(s.id); }}
                      title="Double-click to fire this state"
                      className={`absolute rounded-full flex flex-col items-center justify-center text-center cursor-grab select-none border-2
                        ${isInit ? 'bg-state-init/85 text-black border-state-init' : 'bg-surface-2 text-fg-1 border-line-1'}
                        ${selected ? 'ring-2 ring-accent' : ''} ${isActive ? 'ring-4 ring-state-active' : ''}`}
                      style={{ left, top, width: D, height: D }}>
                      <span className="text-micro font-medium leading-tight px-1 truncate max-w-[60px]">{s.name.toUpperCase()}</span>
                      {s.lockSec != null && <span className={`text-micro ${isInit ? 'text-black/70' : 'text-fg-3'}`}>[{s.lockSec}]</span>}
                      {scene && <span className={`inline-flex items-center gap-0.5 text-micro ${isInit ? 'text-black/70' : 'text-accent'}`}><Film size={8} /> {scene.name}</span>}
                      {sceneMissing && <span title="The bound scene was deleted — entering this state recalls nothing. Rebind or clear it in the inspector." className="text-micro text-warn">⚠ scene missing</span>}
                      {/* Per-state timeline build status: empty vs populated. The third case — "↩ global",
                          a scene with no timeline of its own — was deleted on 2026-07-14: every scene owns
                          one now (types.ts), so there is no such state left to label. */}
                      {scene && <span className={`text-micro ${isInit ? 'text-black/60' : 'text-fg-3'}`}>{scene.clipCount ? `${scene.clipCount} clip${scene.clipCount === 1 ? '' : 's'}` : 'empty'}</span>}
                      {/* This state ENDS BY HOLDING its last frame — the thing a gated (⏱) edge out of
                          it waits for. Pinned to the node's edge rather than stacked in the body: the
                          node is 68px across and its four text rows are already full. */}
                      {scene?.holdsAtEnd && (
                        <span title="This state's timeline holds its last frame at the end — the show keeps running. Transitions marked ⏱ wait for it."
                          className="absolute -top-1 -left-1 w-3.5 h-3.5 rounded-full bg-warn text-black flex items-center justify-center"><Snowflake size={9} /></span>
                      )}
                      {/* Reachable from ANYWHERE by a global rule. Without this the canvas would quietly
                          under-report the graph: an edge-less state that the show can jump into at any
                          moment looks, on the canvas, like a state nothing can reach. */}
                      {globalTargets.has(s.id) && (
                        <span title="A global rule can enter this state from anywhere — see Global rules in the inspector."
                          className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-warn text-black flex items-center justify-center"><Zap size={9} /></span>
                      )}
                      {/* link nub — see placeNub above; left/top as an inline default so the
                          imperative rim writes compose with (and override) the parked spot */}
                      <div title="Drag onto another state to connect — or onto empty canvas to create a new linked state there"
                        onPointerDown={(e) => beginLink(e, s.id)}
                        ref={(el) => { if (el) nubRefs.current.set(s.id, el); else nubRefs.current.delete(s.id); }}
                        className="absolute w-3.5 h-3.5 rounded-full bg-accent border border-surface-0 cursor-crosshair"
                        style={{ left: D - NUB, top: R - NUB }} />
                    </div>
                  );
                })}
              </div>
              {/* Empty-state hint lives on the VIEWPORT (the content layer is zero-sized, so
                  inset-0 inside it would be a zero-sized box). */}
              {sm.states.length === 0 && regions.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center text-fg-3 text-xs italic pointer-events-none">
                  Double-click to add a state, or “Build from scenes”.
                </div>
              )}
          </div>

          {/* inspector */}
          <div className="w-72 shrink-0 border-l border-line-1 bg-surface-1 overflow-auto p-3 text-mini">
            {/* MACHINE-WIDE POLICY — shown regardless of selection because it belongs to no node/edge.
                The unattended "reached its end, nobody came, go home" safety net (StateMachine.idleResetSec).
                Presented in MINUTES (the way a venue thinks about it) but stored as seconds. */}
            <div className="mb-3 pb-3 border-b border-line-1 space-y-1">
              <div className="flex items-center gap-1">
                <Star size={12} className="text-fg-3" />
                <span className="text-fg-2 font-medium">Show machine</span>
              </div>
              <NumField
                label="Auto-reset to initial after (min) — 0 = off"
                helpId="timeline.sm-idle-reset"
                value={sm.idleResetSec ? Math.round((sm.idleResetSec / 60) * 100) / 100 : 0}
                onChange={(v) => patch({ idleResetSec: v > 0 ? Math.round(v * 60) : undefined })} />
              <div className="text-fg-3 text-micro leading-snug">
                {sm.idleResetSec
                  ? <>If a state reaches its end and holds with no transition for {Math.round(sm.idleResetSec)}s, return to <span className="text-fg-2">{sm.states.find(s => s.id === sm.initialStateId)?.name ?? 'the initial state'}</span>. Needs the state to <span className="text-fg-2">Hold at end</span>.</>
                  : <>Off. Set a timeout so an unattended show returns to its initial state if it ends and nobody advances it. Only states that <span className="text-fg-2">Hold at end</span> can trigger it.</>}
              </div>
            </div>
            {/* GLOBAL RULES — listed, never drawn. A rule with no source node is not an edge, and
                inventing one (from where? every node?) would misrepresent how it fires. Pinned above the
                selection inspector because it is the one part of the graph the canvas cannot show. */}
            {globalRules.length > 0 && (
              <div className="mb-3 pb-3 border-b border-line-1 space-y-1">
                <div className="flex items-center gap-1">
                  <Zap size={12} className="text-warn" />
                  <span className="text-fg-2 font-medium">Global rules</span>
                  <span className="text-fg-3 text-micro">from any state</span>
                </div>
                {globalRules.map(t => (
                  <button key={t.id} onClick={() => setSel({ kind: 'transition', id: t.id })}
                    className={`w-full text-left px-1.5 py-1 rounded border ${sel?.kind === 'transition' && sel.id === t.id ? 'border-accent bg-surface-2' : 'border-line-1 bg-surface-0'}`}>
                    <span className="text-fg-1">{trLabel(t)}</span>
                    <span className="text-fg-3"> → {sm.states.find(s => s.id === t.to)?.name ?? '?'}</span>
                  </button>
                ))}
              </div>
            )}
            {selState && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-fg-2 font-medium">State</span>
                  <button onClick={() => removeState(selState.id)} className="text-fg-3 hover:text-danger inline-flex items-center gap-1"><Trash2 size={12} /></button>
                </div>
                <label className="block">
                  <span className="text-fg-3 text-micro">Name</span>
                  <input value={selState.name} onChange={(e) => patchState(selState.id, { name: e.target.value })}
                    className="w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none" />
                </label>
                <Tooltip id="timeline.sm-set-initial">
                  <button onClick={() => patch({ initialStateId: selState.id })}
                    {...help('timeline.sm-set-initial')}
                    className={`w-full inline-flex items-center justify-center gap-1 px-2 py-1 rounded border ${sm.initialStateId === selState.id ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:text-fg-1'}`}>
                    <Star size={12} /> {sm.initialStateId === selState.id ? 'Initial state' : 'Set as initial'}
                  </button>
                </Tooltip>
                {/* The dead-binding warning sits ABOVE the picker because the picker itself shows
                    BLANK for an unresolvable value — indistinguishable from "never bound". */}
                {selState.sceneId && !selStateScene && (
                  <div className="text-warn italic text-micro">
                    ⚠ Bound to a scene that no longer exists — entering this state recalls nothing.
                    Pick a new scene below, or{' '}
                    <button onClick={() => patchState(selState.id, { sceneId: undefined })} className="underline not-italic hover:text-fg-1">clear the binding</button>.
                  </div>
                )}
                <SelectField label="Scene (recalled on entry)" helpId="timeline.sm-state-scene" value={selState.sceneId ?? ''} options={scenes.map(s => ({ v: s.id, l: s.name }))}
                  onChange={(v) => patchState(selState.id, { sceneId: v || undefined })} />
                {/* Author this state's own timeline: recalls its look live and binds the editor to it.
                    Gated on the RESOLVED scene — with a dead binding it rendered and silently
                    no-opped (enterAuthor bails when the scene is gone). */}
                {selStateScene && onEditTimeline && (
                  <Tooltip id="timeline.sm-edit-timeline">
                    <button onClick={() => { onEditTimeline(selState.sceneId!); onClose?.(); }}
                      {...help('timeline.sm-edit-timeline')}
                      className="w-full inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3"><Film size={12} /> Edit timeline</button>
                  </Tooltip>
                )}
                <NumField label="Lock time (s) — dwell before auto transitions" helpId="timeline.sm-lock-time" value={selState.lockSec ?? 0} onChange={(v) => patchState(selState.id, { lockSec: v || undefined })} />

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-fg-3 text-micro">Entry actions</span>
                    <Tooltip id="timeline.sm-add-action">
                      <button onClick={() => patchState(selState.id, { entry: [...selState.entry, { kind: 'play' }] })} {...help('timeline.sm-add-action')} className="text-accent hover:underline inline-flex items-center gap-0.5"><Plus size={11} /> add</button>
                    </Tooltip>
                  </div>
                  <div className="space-y-2">
                    {selState.entry.map((a, i) => (
                      <ActionRow key={i} action={a} markers={markers} scenes={scenes} cues={cues}
                        onChange={(na) => patchState(selState.id, { entry: selState.entry.map((x, j) => j === i ? na : x) })}
                        onRemove={() => patchState(selState.id, { entry: selState.entry.filter((_, j) => j !== i) })} />
                    ))}
                    {selState.entry.length === 0 && <div className="text-fg-3 italic">No extra actions — entering recalls the bound scene (if set).</div>}
                  </div>
                </div>
              </div>
            )}

            {selTrans && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-fg-2 font-medium">Transition</span>
                  <button onClick={() => removeTransition(selTrans.id)} className="text-fg-3 hover:text-danger"><Trash2 size={12} /></button>
                </div>
                <div className="text-fg-3">
                  {selTrans.fromAny
                    ? <span className="text-warn">⚡ any state</span>
                    : sm.states.find(s => s.id === selTrans.from)?.name}
                  {' '}<ArrowRight size={10} className="inline" />{' '}
                  {/* A GLOBAL RULE'S TARGET IS EDITABLE HERE and nowhere else: it has no source node, so
                      it was never drawn as an edge you could re-drag onto a different state. */}
                  {selTrans.fromAny
                    ? (
                      <select value={selTrans.to} onChange={(e) => patchTransition(selTrans.id, { to: e.target.value })}
                        className="bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-fg-1 focus:border-accent outline-none">
                        {sm.states.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    )
                    : sm.states.find(s => s.id === selTrans.to)?.name}
                </div>
                {selTrans.fromAny && (
                  <div className="text-fg-3 italic text-micro">
                    A <span className="text-warn">global rule</span> — evaluated from every state. The
                    current state’s own transitions are tried first, and it is skipped while
                    “{sm.states.find(s => s.id === selTrans.to)?.name}” is already the current state.
                  </div>
                )}
                <label className="block">
                  <span className="text-fg-3 text-micro">Trigger</span>
                  <Tooltip id="timeline.sm-trigger">
                    <select value={triggerValue(selTrans.trigger)}
                      onChange={(e) => patchTransition(selTrans.id, { trigger: triggerFromValue(e.target.value, selTrans.trigger) })}
                      {...help('timeline.sm-trigger')}
                      className="w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none">
                      {TRIGGER_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                      {/* Plugin-owned sources, listed by their own label. A show that reacts to the ROOM
                          is authored here, next to the timeline triggers, not in a separate world. */}
                      {smTriggerRegistry.all().map(t => <option key={t.source} value={`plugin:${t.source}`}>{t.label}</option>)}
                    </select>
                  </Tooltip>
                </label>
                {selTrans.trigger.kind === 'afterDelay' && (
                  <NumField label="Seconds after entering" value={selTrans.trigger.seconds ?? 0} onChange={(v) => patchTransition(selTrans.id, { trigger: { ...selTrans.trigger, seconds: v } })} />
                )}
                {selTrans.trigger.kind === 'atTime' && (
                  <NumField label="Timeline time (s)" value={selTrans.trigger.time ?? 0} onChange={(v) => patchTransition(selTrans.id, { trigger: { ...selTrans.trigger, time: v } })} />
                )}
                {selTrans.trigger.kind === 'onMarker' && (
                  <SelectField label="Marker" value={selTrans.trigger.markerId ?? ''} options={markers.map(m => ({ v: m.id, l: m.note || `${m.time.toFixed(1)}s` }))}
                    onChange={(v) => patchTransition(selTrans.id, { trigger: { ...selTrans.trigger, markerId: v } })} />
                )}
                {selTrans.trigger.kind === 'onClipEnd' && (
                  <>
                    <SelectField label="Track" value={selTrans.trigger.layerId ?? ''} options={layers.map(l => ({ v: l.id, l: l.name }))}
                      onChange={(v) => patchTransition(selTrans.id, { trigger: { ...selTrans.trigger, layerId: v } })} />
                    <div className="text-fg-3 italic">A clip that runs to the end of the timeline never opens a gap — use onTimelineEnd for &lsquo;the show finished&rsquo;.</div>
                  </>
                )}
                {/* onTimelineEnd takes no parameter — it fires on the frame the timeline ends. */}
                {selTrans.trigger.kind === 'onTimelineEnd' && <div className="text-fg-3 italic">Fires when the timeline reaches its end with Loop OFF. A loop wrap is not an end.</div>}
                {/* A PLUGIN-OWNED TRIGGER edits its own params. The host mounts whatever the source
                    registered and knows nothing about what it configures — that is the entire seam.
                    A source with no Inspector is parameterless; a source that is not registered (its
                    plugin is off, or the file is from a newer build) says so rather than silently
                    showing an empty box for a trigger that will never fire. */}
                {selTrans.trigger.kind === 'plugin' && (() => {
                  const src = smTriggerRegistry.get(selTrans.trigger.source ?? '');
                  if (!src) return <div className="text-warn italic">Unknown trigger source “{selTrans.trigger.source}” — its plugin is not active, so this transition can never fire.</div>;
                  if (!src.Inspector) return <div className="text-fg-3 italic">{src.label} — no parameters.</div>;
                  return <src.Inspector params={selTrans.trigger.params ?? {}}
                    onChange={(params) => patchTransition(selTrans.id, { trigger: { ...selTrans.trigger, params } })} />;
                })()}
                {selTrans.trigger.kind === 'manual' && <div className="text-fg-3 italic">Fires from the state-lane button, Ctrl+click on the edge, or OSC.</div>}
                {/* THE GUARD, not a trigger: the trigger above still has to fire, this decides whether
                    it MAY. It is the piece that makes a live trigger (a person walking into a LiDAR
                    zone) safe on a state that is showing a film — without it the film gets cut. */}
                <Tooltip id="timeline.sm-require-end">
                  <label className="flex items-start gap-2 cursor-pointer" {...help('timeline.sm-require-end')}>
                    <input type="checkbox" checked={!!selTrans.requireEnd} className="mt-0.5"
                      onChange={(e) => patchTransition(selTrans.id, { requireEnd: e.target.checked || undefined })} />
                    <span>
                      <span className="text-fg-2">Only after the state has finished</span>
                      <span className="block text-fg-3 text-micro">
                        Holds the <span className="text-fg-2">automatic</span> trigger until the source
                        state&rsquo;s timeline is holding its last frame (Hold at end, in the timeline
                        toolbar). A manual/OSC/tablet trigger still fires — it is flagged early, not blocked.
                        A state that loops, or has no hold, never satisfies this.
                      </span>
                    </span>
                  </label>
                </Tooltip>
                <NumField label="Transition time (s) — scene crossfade on arrival" helpId="timeline.sm-fade" value={selTrans.fadeSec ?? 0} onChange={(v) => patchTransition(selTrans.id, { fadeSec: v || undefined })} />
              </div>
            )}

            {selRegion && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-fg-2 font-medium">Region</span>
                  <button onClick={() => removeRegion(selRegion.id)} className="text-fg-3 hover:text-danger"><Trash2 size={12} /></button>
                </div>
                <label className="block">
                  <span className="text-fg-3 text-micro">Name</span>
                  <input value={selRegion.name} onChange={(e) => patchRegion(selRegion.id, { name: e.target.value })}
                    className="w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none" />
                </label>
                <div className="text-fg-3 italic">A group box that organizes states. Drag it to move its members; drag the corner to resize.</div>
              </div>
            )}

            {!selState && !selTrans && !selRegion && <div className="text-fg-3 italic">Select a state, transition or region to edit it. Bind each state to a scene; a transition's time is the crossfade.</div>}
          </div>
        </div>
    </div>
  );
};

// `helpId` (optional) opts a single instance into the rich help system: the host <input>/<select> is
// wrapped in a Tooltip and carries the registry id. Left off, the field renders exactly as before.
const NumField: React.FC<{ label: string; value: number; onChange: (v: number) => void; helpId?: string }> = ({ label, value, onChange, helpId }) => {
  const input = (
    <input type="number" step="0.1" value={value} onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      {...(helpId ? help(helpId) : {})}
      className="w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none" />
  );
  return (
    <label className="block">
      <span className="text-fg-3 text-micro">{label}</span>
      {helpId ? <Tooltip id={helpId}>{input}</Tooltip> : input}
    </label>
  );
};

const SelectField: React.FC<{ label: string; value: string; options: { v: string; l: string }[]; onChange: (v: string) => void; helpId?: string }> = ({ label, value, options, onChange, helpId }) => {
  const select = (
    <select value={value} onChange={(e) => onChange(e.target.value)} {...(helpId ? help(helpId) : {})}
      className="w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none">
      <option value="">— pick —</option>
      {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
  return (
    <label className="block">
      <span className="text-fg-3 text-micro">{label}</span>
      {helpId ? <Tooltip id={helpId}>{select}</Tooltip> : select}
    </label>
  );
};

const ActionRow: React.FC<{ action: SmAction; markers: Marker[]; scenes: SceneRef[]; cues: CueRef[]; onChange: (a: SmAction) => void; onRemove: () => void }> = ({ action, markers, scenes, cues, onChange, onRemove }) => (
  <div className="border border-line-1 rounded p-1.5 bg-surface-0 space-y-1.5">
    <div className="flex items-center gap-1">
      <select value={action.kind} onChange={(e) => onChange({ kind: e.target.value as SmActionKind })}
        className="flex-1 bg-surface-1 border border-line-1 rounded px-1 py-0.5 text-fg-1 focus:border-accent outline-none">
        {ACTION_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
      </select>
      <button onClick={onRemove} className="text-fg-3 hover:text-danger"><Trash2 size={11} /></button>
    </div>
    {action.kind === 'seek' && <NumField label="Seek to (s)" value={action.seekTo ?? 0} onChange={(v) => onChange({ ...action, seekTo: v })} />}
    {action.kind === 'setLoop' && (
      <label className="flex items-center gap-1.5 text-fg-2">
        <input type="checkbox" checked={!!action.loopOn} onChange={(e) => onChange({ ...action, loopOn: e.target.checked })} /> loop on
      </label>
    )}
    {action.kind === 'jumpMarker' && (
      <SelectField label="Marker" value={action.markerId ?? ''} options={markers.map(m => ({ v: m.id, l: m.note || `${m.time.toFixed(1)}s` }))}
        onChange={(v) => onChange({ ...action, markerId: v })} />
    )}
    {action.kind === 'recallScene' && (
      <>
        <SelectField label="Scene" value={action.sceneId ?? ''} options={scenes.map(s => ({ v: s.id, l: s.name }))}
          onChange={(v) => onChange({ ...action, sceneId: v })} />
        {/* Same dead-binding honesty as the state's own Scene field (the select renders blank). */}
        {action.sceneId && !scenes.some(s => s.id === action.sceneId) && (
          <div className="text-warn italic text-micro">⚠ This scene no longer exists — the action does nothing.</div>
        )}
      </>
    )}
    {action.kind === 'fireCue' && (
      <SelectField label="Cue" value={action.cueId ?? ''} options={cues.map(c => ({ v: c.id, l: c.name }))}
        onChange={(v) => onChange({ ...action, cueId: v })} />
    )}
  </div>
);
