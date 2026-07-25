import React, { useEffect, useRef, useState } from 'react';
import { StateMachine, SmState, SmTransition, SmRegion, SmAction, SmActionKind, SmTrigger, SmTriggerKind, Marker, VideoLayer } from '../../types';
import { timeline as engine } from '../../services/timeline';
import { smTriggerRegistry } from '../../host/registries';
import { Plus, Star, Trash2, ArrowRight, Wand2, SquareDashed, Film, Snowflake, Zap } from 'lucide-react';
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
const CW = 2600, CH = 1700;   // canvas coordinate space
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
  | { kind: 'handle'; id: string; which: 'c1' | 'c2' }
  | { kind: 'pan' };

export const StateGraphEditor: React.FC<Props> = ({ sm, markers, layers, scenes, cues, onChange, onClose, onEditTimeline }) => {
  const [sel, setSel] = useState<{ kind: 'state' | 'transition' | 'region'; id: string } | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);     // source state while drawing a transition
  const [linkTo, setLinkTo] = useState<Vec | null>(null);            // live cursor (canvas coords) while linking
  const [drag, setDrag] = useState<Drag | null>(null);
  const [scale, setScale] = useState(1);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [firedId, setFiredId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const regions = sm.regions ?? [];

  // Live "current state" ring + fired-edge pulse driven render-free by the engine.
  useEffect(() => engine.subscribeSmState(setActiveId), []);
  useEffect(() => engine.subscribeSmFired((id) => {
    setFiredId(id);
    const t = window.setTimeout(() => setFiredId((cur) => (cur === id ? null : cur)), 450);
    return () => window.clearTimeout(t);
  }), []);

  const patch = (next: Partial<StateMachine>) => onChange({ ...sm, ...next });
  const patchState = (id: string, p: Partial<SmState>) => patch({ states: sm.states.map(s => s.id === id ? { ...s, ...p } : s) });
  const patchTransition = (id: string, p: Partial<SmTransition>) => patch({ transitions: sm.transitions.map(t => t.id === id ? { ...t, ...p } : t) });
  const patchRegion = (id: string, p: Partial<SmRegion>) => patch({ regions: regions.map(r => r.id === id ? { ...r, ...p } : r) });

  const toCanvas = (clientX: number, clientY: number): Vec => {
    const el = scrollRef.current; if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: (clientX - r.left + el.scrollLeft) / scale, y: (clientY - r.top + el.scrollTop) / scale };
  };
  const regionAt = (c: Vec): string | undefined =>
    [...regions].reverse().find(r => c.x >= r.x && c.x <= r.x + r.w && c.y >= r.y && c.y <= r.y + r.h)?.id;

  // --- create / delete ---
  const addStateAt = (x: number, y: number) => {
    const st: SmState = { id: uid(), name: `State ${sm.states.length + 1}`, x: x - R, y: y - R, entry: [], regionId: regionAt({ x, y }) };
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
    const r: SmRegion = { id: uid(), name: `Region ${regions.length + 1}`, x: 80 + regions.length * 30, y: 60 + regions.length * 30, w: 360, h: 320 };
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

  // One node per scene, laid out in a grid, each pre-bound to its scene — seeds a show graph fast.
  const buildFromScenes = () => {
    if (!scenes.length) return;
    const cols = Math.ceil(Math.sqrt(scenes.length));
    const gapX = D + 80, gapY = D + 70, ox = 90, oy = 90;
    const states: SmState[] = scenes.map((sc, i) => ({
      id: uid(), name: sc.name, sceneId: sc.id, entry: [],
      x: ox + (i % cols) * gapX, y: oy + Math.floor(i / cols) * gapY,
    }));
    patch({ states: [...sm.states, ...states], initialStateId: sm.initialStateId ?? states[0]?.id ?? null });
  };

  // --- drags (commit on release for node/region/resize; handles patch live) ---
  const beginNodeDrag = (e: React.PointerEvent, s: SmState) => {
    e.stopPropagation();
    const start = toCanvas(e.clientX, e.clientY); const off = { x: start.x - s.x, y: start.y - s.y };
    const move = (ev: PointerEvent) => { const c = toCanvas(ev.clientX, ev.clientY); setDrag({ kind: 'node', id: s.id, x: c.x - off.x, y: c.y - off.y }); };
    const up = (ev: PointerEvent) => {
      const c = toCanvas(ev.clientX, ev.clientY); const x = c.x - off.x, y = c.y - off.y;
      patchState(s.id, { x, y, regionId: regionAt({ x: x + R, y: y + R }) });
      setDrag(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    setSel({ kind: 'state', id: s.id });
  };
  const beginRegionDrag = (e: React.PointerEvent, r: SmRegion) => {
    e.stopPropagation();
    const start = toCanvas(e.clientX, e.clientY); const off = { x: start.x - r.x, y: start.y - r.y };
    const members = sm.states.filter(s => s.regionId === r.id).map(s => ({ id: s.id, dx: s.x - r.x, dy: s.y - r.y }));
    const move = (ev: PointerEvent) => { const c = toCanvas(ev.clientX, ev.clientY); setDrag({ kind: 'region', id: r.id, x: c.x - off.x, y: c.y - off.y }); };
    const up = (ev: PointerEvent) => {
      const c = toCanvas(ev.clientX, ev.clientY); const x = c.x - off.x, y = c.y - off.y;
      patch({ regions: regions.map(rr => rr.id === r.id ? { ...rr, x, y } : rr), states: sm.states.map(s => { const m = members.find(mm => mm.id === s.id); return m ? { ...s, x: x + m.dx, y: y + m.dy } : s; }) });
      setDrag(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    setSel({ kind: 'region', id: r.id });
  };
  const beginRegionResize = (e: React.PointerEvent, r: SmRegion) => {
    e.stopPropagation();
    const move = (ev: PointerEvent) => { const c = toCanvas(ev.clientX, ev.clientY); setDrag({ kind: 'regionSize', id: r.id, w: Math.max(140, c.x - r.x), h: Math.max(120, c.y - r.y) }); };
    const up = (ev: PointerEvent) => { const c = toCanvas(ev.clientX, ev.clientY); patchRegion(r.id, { w: Math.max(140, c.x - r.x), h: Math.max(120, c.y - r.y) }); setDrag(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const beginHandleDrag = (e: React.PointerEvent, t: SmTransition, which: 'c1' | 'c2') => {
    e.stopPropagation();
    setDrag({ kind: 'handle', id: t.id, which });
    const move = (ev: PointerEvent) => { const c = toCanvas(ev.clientX, ev.clientY); patchTransition(t.id, { [which]: c } as Partial<SmTransition>); };
    const up = () => { setDrag(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  // Drag a node's link nub onto another node to create a transition.
  const beginLink = (e: React.PointerEvent, fromId: string) => {
    e.stopPropagation();
    setLinkFrom(fromId); setLinkTo(toCanvas(e.clientX, e.clientY));
    const move = (ev: PointerEvent) => setLinkTo(toCanvas(ev.clientX, ev.clientY));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      const tgt = (ev.target as HTMLElement)?.closest('[data-node]')?.getAttribute('data-node');
      if (tgt && tgt !== fromId) {
        const tr: SmTransition = { id: uid(), from: fromId, to: tgt, trigger: { kind: 'manual' } };
        patch({ transitions: [...sm.transitions, tr] }); setSel({ kind: 'transition', id: tr.id });
      }
      setLinkFrom(null); setLinkTo(null);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  // Pan with the middle mouse button; Ctrl/Cmd-wheel zooms around the cursor (plain wheel scrolls).
  const beginPan = (e: React.PointerEvent) => {
    if (e.button !== 1) return; e.preventDefault();
    const el = scrollRef.current!; const sx = e.clientX, sy = e.clientY, l = el.scrollLeft, t = el.scrollTop;
    const move = (ev: PointerEvent) => { el.scrollLeft = l - (ev.clientX - sx); el.scrollTop = t - (ev.clientY - sy); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = (e.clientX - r.left + el.scrollLeft) / scale, cy = (e.clientY - r.top + el.scrollTop) / scale;
      const next = Math.min(2, Math.max(0.4, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
      setScale(next);
      requestAnimationFrame(() => { el.scrollLeft = cx * next - (e.clientX - r.left); el.scrollTop = cy * next - (e.clientY - r.top); });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scale]);

  // Delete the selection with Del/Backspace (unless typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!keymap.matches(e, 'stategraph.deleteSelected')) return;
      const t = document.activeElement?.tagName;
      if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
      if (!sel) return; e.preventDefault();
      if (sel.kind === 'state') removeState(sel.id);
      else if (sel.kind === 'transition') removeTransition(sel.id);
      else removeRegion(sel.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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
            <button onClick={() => addStateAt(CW / 2, CH / 2)} {...help('timeline.sm-add-state')} className="flex items-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-mini text-fg-1 hover:bg-surface-3"><Plus size={12} /> State</button>
          </Tooltip>
          <Tooltip id="timeline.sm-add-region">
            <button onClick={addRegion} {...help('timeline.sm-add-region')} className="flex items-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-mini text-fg-1 hover:bg-surface-3"><SquareDashed size={12} /> Region</button>
          </Tooltip>
          <Tooltip id="timeline.sm-build-from-scenes">
            <button onClick={buildFromScenes} disabled={!scenes.length} title={scenes.length ? 'Create one state per scene' : 'No scenes captured yet'}
              {...help('timeline.sm-build-from-scenes')}
              className="flex items-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-mini text-fg-1 hover:bg-surface-3 disabled:opacity-40"><Wand2 size={12} /> Build from scenes</button>
          </Tooltip>
          <Tooltip id="timeline.sm-add-global-rule">
            <button onClick={addGlobalRule} disabled={!sm.states.length} title={sm.states.length ? 'A rule evaluated from EVERY state — for a trigger that must work whatever the show is doing' : 'Add a state first'}
              {...help('timeline.sm-add-global-rule')}
              className="flex items-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-mini text-fg-1 hover:bg-surface-3 disabled:opacity-40"><Zap size={12} /> Global rule</button>
          </Tooltip>
          {linkFrom && <span className="text-micro text-accent">drag onto a target state to connect…</span>}
          <span className="ml-auto text-micro text-fg-3">dbl-click empty: add · dbl-click state: fire · drag nub: link · Ctrl+click edge: fire · Ctrl+wheel: zoom</span>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* canvas */}
          <div ref={scrollRef} className="relative flex-1 overflow-auto bg-surface-0"
            onPointerDown={(e) => { beginPan(e); setSel(null); setLinkFrom(null); }}
            onDoubleClick={(e) => { if ((e.target as HTMLElement).closest('[data-node]')) return; const c = toCanvas(e.clientX, e.clientY); addStateAt(c.x, c.y); }}>
            <div className="relative" style={{ width: CW * scale, height: CH * scale }}>
              <div className="absolute top-0 left-0" style={{ width: CW, height: CH, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
                {/* regions (behind everything) */}
                {regions.map(r => {
                  const b = regionBox(r); const selected = selRegion?.id === r.id;
                  return (
                    <div key={r.id} className={`absolute rounded-lg border ${selected ? 'border-accent' : 'border-line-2'} bg-surface-1/30`} style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
                      onPointerDown={(e) => { e.stopPropagation(); setSel({ kind: 'region', id: r.id }); }}>
                      <div className="absolute -top-0.5 left-0 right-3 h-6 flex items-center px-2 cursor-grab text-mini text-fg-2" onPointerDown={(e) => beginRegionDrag(e, r)}>{r.name}</div>
                      <div className="absolute bottom-0 right-0 w-3 h-3 cursor-nwse-resize" onPointerDown={(e) => beginRegionResize(e, r)}>
                        <div className="absolute bottom-0.5 right-0.5 w-2 h-2 border-r-2 border-b-2 border-fg-3" />
                      </div>
                    </div>
                  );
                })}

                {/* transition edges */}
                <svg className="absolute inset-0" width={CW} height={CH} style={{ overflow: 'visible' }}>
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
                          onPointerDown={(e) => { e.stopPropagation(); if (e.ctrlKey || e.metaKey) engine.triggerSmTransition(t.id); else setSel({ kind: 'transition', id: t.id }); }} />
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
                  return (
                    <div key={s.id} data-node={s.id} onPointerDown={(e) => beginNodeDrag(e, s)}
                      onDoubleClick={(e) => { e.stopPropagation(); if (!sm.enabled) patch({ enabled: true }); engine.enterSmState(s.id); }}
                      title="Double-click to fire this state"
                      className={`absolute rounded-full flex flex-col items-center justify-center text-center cursor-grab select-none border-2
                        ${isInit ? 'bg-state-init/85 text-black border-state-init' : 'bg-surface-2 text-fg-1 border-line-1'}
                        ${selected ? 'ring-2 ring-accent' : ''} ${isActive ? 'ring-4 ring-state-active' : ''}`}
                      style={{ left, top, width: D, height: D }}>
                      <span className="text-micro font-medium leading-tight px-1 truncate max-w-[60px]">{s.name.toUpperCase()}</span>
                      {s.lockSec != null && <span className={`text-micro ${isInit ? 'text-black/70' : 'text-fg-3'}`}>[{s.lockSec}]</span>}
                      {scene && <span className={`inline-flex items-center gap-0.5 text-micro ${isInit ? 'text-black/70' : 'text-accent'}`}><Film size={8} /> {scene.name}</span>}
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
                      {/* link nub */}
                      <div title="Drag onto another state to connect" onPointerDown={(e) => beginLink(e, s.id)}
                        className="absolute -right-1.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-accent border border-surface-0 cursor-crosshair" />
                    </div>
                  );
                })}
                {sm.states.length === 0 && regions.length === 0 && (
                  <div className="absolute inset-0 flex items-center justify-center text-fg-3 text-xs italic pointer-events-none">
                    Double-click to add a state, or “Build from scenes”.
                  </div>
                )}
              </div>
            </div>
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
                <SelectField label="Scene (recalled on entry)" helpId="timeline.sm-state-scene" value={selState.sceneId ?? ''} options={scenes.map(s => ({ v: s.id, l: s.name }))}
                  onChange={(v) => patchState(selState.id, { sceneId: v || undefined })} />
                {/* Author this state's own timeline: recalls its look live and binds the editor to it. */}
                {selState.sceneId && onEditTimeline && (
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
      <SelectField label="Scene" value={action.sceneId ?? ''} options={scenes.map(s => ({ v: s.id, l: s.name }))}
        onChange={(v) => onChange({ ...action, sceneId: v })} />
    )}
    {action.kind === 'fireCue' && (
      <SelectField label="Cue" value={action.cueId ?? ''} options={cues.map(c => ({ v: c.id, l: c.name }))}
        onChange={(v) => onChange({ ...action, cueId: v })} />
    )}
  </div>
);
