import React, { useRef, useState } from 'react';
import { StateMachine, SmState, SmTransition, SmAction, SmActionKind, SmTriggerKind, Marker, VideoLayer } from '../../types';
import { X, Plus, Star, Trash2, ArrowRight } from 'lucide-react';

export interface SceneRef { id: string; name: string }
export interface CueRef { id: string; name: string }

interface Props {
  sm: StateMachine;
  markers: Marker[];
  layers: VideoLayer[];
  scenes: SceneRef[];
  cues: CueRef[];
  onChange: (sm: StateMachine) => void;
  onClose: () => void;
}

const NODE_W = 132;
const NODE_H = 50;
const ACTION_KINDS: SmActionKind[] = ['play', 'pause', 'stop', 'seek', 'setLoop', 'jumpMarker', 'recallScene', 'fireCue'];
const TRIGGER_KINDS: SmTriggerKind[] = ['manual', 'afterDelay', 'atTime', 'onMarker', 'onClipEnd'];

const uid = () => crypto.randomUUID();

// Modal node-graph editor for the control-layer FSM. States are draggable nodes (x/y persisted);
// transitions are edges authored by selecting a source then clicking a target. The inspector edits
// the selected state's entry actions or the selected transition's trigger. Every edit commits via
// onChange (node drags commit on release).
export const StateGraphEditor: React.FC<Props> = ({ sm, markers, layers, scenes, cues, onChange, onClose }) => {
  const [sel, setSel] = useState<{ kind: 'state' | 'transition'; id: string } | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null); // source state while drawing a transition
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const patch = (next: Partial<StateMachine>) => onChange({ ...sm, ...next });
  const patchState = (id: string, p: Partial<SmState>) => patch({ states: sm.states.map(s => s.id === id ? { ...s, ...p } : s) });
  const patchTransition = (id: string, p: Partial<SmTransition>) => patch({ transitions: sm.transitions.map(t => t.id === id ? { ...t, ...p } : t) });

  const addState = () => {
    const n = sm.states.length;
    const st: SmState = { id: uid(), name: `State ${n + 1}`, x: 40 + (n % 4) * (NODE_W + 30), y: 40 + Math.floor(n / 4) * (NODE_H + 40), entry: [] };
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
  const onNodeClick = (id: string) => {
    if (linkFrom && linkFrom !== id) {
      const tr: SmTransition = { id: uid(), from: linkFrom, to: id, trigger: { kind: 'manual' } };
      patch({ transitions: [...sm.transitions, tr] });
      setLinkFrom(null); setSel({ kind: 'transition', id: tr.id });
      return;
    }
    setSel({ kind: 'state', id });
  };

  // Node drag (commit on release).
  const startNodeDrag = (e: React.PointerEvent, st: SmState) => {
    e.stopPropagation();
    const c = canvasRef.current; if (!c) return;
    const r = c.getBoundingClientRect();
    const offX = e.clientX - (r.left + st.x), offY = e.clientY - (r.top + st.y);
    const move = (ev: PointerEvent) => setDrag({ id: st.id, x: Math.max(0, ev.clientX - r.left - offX), y: Math.max(0, ev.clientY - r.top - offY) });
    const up = (ev: PointerEvent) => {
      const x = Math.max(0, ev.clientX - r.left - offX), y = Math.max(0, ev.clientY - r.top - offY);
      patchState(st.id, { x, y }); setDrag(null);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const nodePos = (s: SmState) => (drag && drag.id === s.id ? { x: drag.x, y: drag.y } : { x: s.x, y: s.y });
  const selState = sel?.kind === 'state' ? sm.states.find(s => s.id === sel.id) ?? null : null;
  const selTrans = sel?.kind === 'transition' ? sm.transitions.find(t => t.id === sel.id) ?? null : null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center" onPointerDown={onClose}>
      <div className="w-[860px] h-[560px] bg-surface-0 border border-line-1 rounded-[var(--r-md)] shadow-xl flex flex-col overflow-hidden" onPointerDown={e => e.stopPropagation()}>
        <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-line-1 bg-surface-1">
          <span className="text-[12px] text-fg-1 font-medium">State machine — logic</span>
          <button onClick={addState} className="flex items-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-[11px] text-fg-1 hover:bg-surface-3"><Plus size={12} /> State</button>
          {linkFrom && <span className="text-[10px] text-accent">click a target state to connect…</span>}
          <button onClick={onClose} className="ml-auto inline-flex items-center justify-center h-6 w-6 rounded text-fg-2 hover:text-fg-1 hover:bg-surface-2"><X size={14} /></button>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* canvas */}
          <div ref={canvasRef} className="relative flex-1 overflow-auto bg-surface-0" onPointerDown={() => { setSel(null); setLinkFrom(null); }}>
            <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ minWidth: 1200, minHeight: 800 }}>
              <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--accent, #5b9bff)" /></marker></defs>
              {sm.transitions.map(t => {
                const a = sm.states.find(s => s.id === t.from), b = sm.states.find(s => s.id === t.to);
                if (!a || !b) return null;
                const pa = nodePos(a), pb = nodePos(b);
                const x1 = pa.x + NODE_W / 2, y1 = pa.y + NODE_H / 2, x2 = pb.x + NODE_W / 2, y2 = pb.y + NODE_H / 2;
                return <line key={t.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke={sel?.id === t.id ? '#5b9bff' : '#6b7280'} strokeWidth={sel?.id === t.id ? 2 : 1.5} markerEnd="url(#arrow)" />;
              })}
            </svg>
            {sm.states.map(s => {
              const p = nodePos(s);
              const isInit = sm.initialStateId === s.id;
              const selected = sel?.kind === 'state' && sel.id === s.id;
              return (
                <div key={s.id} onPointerDown={(e) => startNodeDrag(e, s)} onClick={(e) => { e.stopPropagation(); onNodeClick(s.id); }}
                  className={`absolute rounded-md border px-2 py-1 cursor-grab select-none ${selected ? 'border-accent bg-accent/15' : 'border-line-1 bg-surface-2'} ${linkFrom === s.id ? 'ring-2 ring-accent' : ''}`}
                  style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}>
                  <div className="flex items-center gap-1">
                    {isInit && <Star size={11} className="text-accent shrink-0" fill="currentColor" />}
                    <span className="text-[11px] text-fg-1 truncate">{s.name}</span>
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <span className="text-[9px] text-fg-3">{s.entry.length} action{s.entry.length === 1 ? '' : 's'}</span>
                    <button onClick={(e) => { e.stopPropagation(); setLinkFrom(s.id); }} title="Draw transition from here"
                      className="text-[9px] text-fg-3 hover:text-accent inline-flex items-center gap-0.5"><ArrowRight size={10} /> link</button>
                  </div>
                </div>
              );
            })}
            {sm.states.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-fg-3 text-[12px] italic pointer-events-none">Add a state to begin</div>}
          </div>

          {/* inspector */}
          <div className="w-72 shrink-0 border-l border-line-1 bg-surface-1 overflow-auto p-3 text-[11px]">
            {selState && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-fg-2 font-medium">State</span>
                  <button onClick={() => removeState(selState.id)} className="text-fg-3 hover:text-red-400 inline-flex items-center gap-1"><Trash2 size={12} /></button>
                </div>
                <label className="block">
                  <span className="text-fg-3 text-[10px]">Name</span>
                  <input value={selState.name} onChange={(e) => patchState(selState.id, { name: e.target.value })}
                    className="w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none" />
                </label>
                <button onClick={() => patch({ initialStateId: selState.id })}
                  className={`w-full inline-flex items-center justify-center gap-1 px-2 py-1 rounded border ${sm.initialStateId === selState.id ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:text-fg-1'}`}>
                  <Star size={12} /> {sm.initialStateId === selState.id ? 'Initial state' : 'Set as initial'}
                </button>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-fg-3 text-[10px]">Entry actions</span>
                    <button onClick={() => patchState(selState.id, { entry: [...selState.entry, { kind: 'play' }] })} className="text-accent hover:underline inline-flex items-center gap-0.5"><Plus size={11} /> add</button>
                  </div>
                  <div className="space-y-2">
                    {selState.entry.map((a, i) => (
                      <ActionRow key={i} action={a} markers={markers} scenes={scenes} cues={cues}
                        onChange={(na) => patchState(selState.id, { entry: selState.entry.map((x, j) => j === i ? na : x) })}
                        onRemove={() => patchState(selState.id, { entry: selState.entry.filter((_, j) => j !== i) })} />
                    ))}
                    {selState.entry.length === 0 && <div className="text-fg-3 italic">No actions — this state just waits for a transition.</div>}
                  </div>
                </div>
              </div>
            )}

            {selTrans && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-fg-2 font-medium">Transition</span>
                  <button onClick={() => { patch({ transitions: sm.transitions.filter(t => t.id !== selTrans.id) }); setSel(null); }} className="text-fg-3 hover:text-red-400"><Trash2 size={12} /></button>
                </div>
                <div className="text-fg-3">
                  {sm.states.find(s => s.id === selTrans.from)?.name} <ArrowRight size={10} className="inline" /> {sm.states.find(s => s.id === selTrans.to)?.name}
                </div>
                <label className="block">
                  <span className="text-fg-3 text-[10px]">Trigger</span>
                  <select value={selTrans.trigger.kind} onChange={(e) => patchTransition(selTrans.id, { trigger: { kind: e.target.value as SmTriggerKind } })}
                    className="w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none">
                    {TRIGGER_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
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
                  <SelectField label="Track" value={selTrans.trigger.layerId ?? ''} options={layers.map(l => ({ v: l.id, l: l.name }))}
                    onChange={(v) => patchTransition(selTrans.id, { trigger: { ...selTrans.trigger, layerId: v } })} />
                )}
                {selTrans.trigger.kind === 'manual' && <div className="text-fg-3 italic">Fires from the state-lane button (or an external trigger).</div>}
              </div>
            )}

            {!selState && !selTrans && <div className="text-fg-3 italic">Select a state or transition to edit it. Use a node's “link” to connect states.</div>}
          </div>
        </div>
      </div>
    </div>
  );
};

const NumField: React.FC<{ label: string; value: number; onChange: (v: number) => void }> = ({ label, value, onChange }) => (
  <label className="block">
    <span className="text-fg-3 text-[10px]">{label}</span>
    <input type="number" step="0.1" value={value} onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      className="w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none" />
  </label>
);

const SelectField: React.FC<{ label: string; value: string; options: { v: string; l: string }[]; onChange: (v: string) => void }> = ({ label, value, options, onChange }) => (
  <label className="block">
    <span className="text-fg-3 text-[10px]">{label}</span>
    <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none">
      <option value="">— pick —</option>
      {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  </label>
);

const ActionRow: React.FC<{ action: SmAction; markers: Marker[]; scenes: SceneRef[]; cues: CueRef[]; onChange: (a: SmAction) => void; onRemove: () => void }> = ({ action, markers, scenes, cues, onChange, onRemove }) => (
  <div className="border border-line-1 rounded p-1.5 bg-surface-0 space-y-1.5">
    <div className="flex items-center gap-1">
      <select value={action.kind} onChange={(e) => onChange({ kind: e.target.value as SmActionKind })}
        className="flex-1 bg-surface-1 border border-line-1 rounded px-1 py-0.5 text-fg-1 focus:border-accent outline-none">
        {ACTION_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
      </select>
      <button onClick={onRemove} className="text-fg-3 hover:text-red-400"><Trash2 size={11} /></button>
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
