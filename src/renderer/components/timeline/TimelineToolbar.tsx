import React from 'react';
import { Play, Pause, Plus, ZoomIn, ZoomOut, Maximize, Minimize, Scan, Scissors, MousePointer2, Magnet, Flag, Repeat, Workflow, Square, LogIn, LogOut } from 'lucide-react';

interface Props {
  playing: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  onSetIn: () => void;
  onSetOut: () => void;
  hasRegion: boolean;   // an in/out region exists — Loop honours it instead of [0, Length)
  timeRef: React.RefObject<HTMLSpanElement>;
  duration: number;
  onChangeDuration: (d: number) => void;
  fps: number;
  onChangeFps: (f: number) => void;
  tool: 'select' | 'blade';
  onSetTool: (t: 'select' | 'blade') => void;
  snapEnabled: boolean;
  onToggleSnap: () => void;
  onAddMarker: () => void;
  onZoom: (factor: number) => void;
  onZoomFit: () => void;
  onAddTrack: () => void;
  loop: boolean;
  onToggleLoop: () => void;
  smEnabled: boolean;
  onToggleSm: () => void;
  onEditLogic: () => void;
  maximized: boolean;
  onToggleMax: () => void;
}

const TBtn: React.FC<{ active?: boolean; title: string; onClick: () => void; children: React.ReactNode }> = ({ active, title, onClick, children }) => (
  <button title={title} onClick={onClick} className={`p-1.5 rounded-sm ${active ? 'bg-accent text-black' : 'bg-surface-2 text-fg-2 hover:text-fg-1'}`}>{children}</button>
);

// A number field that holds a local DRAFT and commits on BLUR / ENTER only — never per keystroke.
//
// Length and FPS are LIVE TRANSPORT inputs: the engine re-reads timelineEnd(data) and fps every frame.
// Committed per keystroke, every transient value you type is published THROUGH the running show —
// retyping 600 → 900 commits `duration = 9` on the first keystroke, and select-all + Delete commits the
// empty string's fallback of 1. Either one puts the end behind a live playhead, which used to teleport
// the playhead backwards on the projectors, stop the transport, and pulse the state machine's
// 'onTimelineEnd' edge — the wrong scene on stage, from a text edit. (services/timeline.ts's setData
// now also refuses to let a document edit fire that edge; this is the other half: don't publish an edit
// the user hasn't finished making.) Same rule the loop-region drag already follows: hold a draft,
// commit once. Escape reverts. `null` draft ⇒ not editing ⇒ the prop is shown, so a clamped or rejected
// entry visibly snaps back.
//
// The draft is mirrored in a REF because Enter blurs (committing via onBlur) and Escape blurs after
// discarding: both run before React re-renders, so a state-only draft would still read its pre-discard
// value in the onBlur closure and commit the very edit the user just cancelled.
const NumField: React.FC<{
  value: number;
  onCommit: (n: number) => void;
  min: number;
  max?: number;
  step?: number;
  integer?: boolean;
  className: string;
}> = ({ value, onCommit, min, max, step = 1, integer, className }) => {
  const [draft, setDraft] = React.useState<string | null>(null);
  const draftRef = React.useRef<string | null>(null);
  const set = (v: string | null) => { draftRef.current = v; setDraft(v); };
  // THE DOCUMENT CHANGED UNDER ME → DISCARD THE DRAFT.
  //
  // <TimelinePanel> carries no React `key`, so it does NOT remount when the bound scene changes — this
  // component instance, and its draft, survive a document swap. The FSM hopping A→B mid-edit repoints
  // `activeTimeline` at scene B's timeline while an unblurred draft of "90" is still sitting in the
  // Length field: the field keeps showing 90 over B's authored Length of 5, and the next blur commits
  // 90 into SCENE B — destroying its authored Length and persisting it, so B dwells 90 s and its
  // onTimelineEnd hop is 85 s late. The timeline the operator meant to edit is never touched.
  // Snapping to the incoming document's value is the correct read of "the thing I was editing is gone",
  // and it is exactly what Escape already does.
  React.useEffect(() => { set(null); }, [value]);
  const commit = () => {
    const d = draftRef.current;
    if (d == null) return;              // untouched, or already discarded/committed this tick
    set(null);
    const raw = integer ? parseInt(d, 10) : parseFloat(d);
    if (!Number.isFinite(raw)) return;  // empty / garbage — keep the last good value
    const n = Math.max(min, max != null ? Math.min(max, raw) : raw);
    if (n !== value) onCommit(n);
  };
  return (
    <input
      type="number" min={min} max={max} step={step}
      value={draft ?? String(value)}
      onChange={(e) => set(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        // Both branches blur SYNCHRONOUSLY. useTimelineKeys listens on `window`, so it runs after this
        // synthetic handler — by which time document.activeElement is <body> and its "don't fire while
        // typing in an INPUT" guard no longer trips. Escape would therefore ALSO reach the timeline's
        // global handler and switch the tool to Select; Enter is inert today but is one key binding away
        // from the same trap. Stop the native event here so the window listener never sees it.
        if (e.key === 'Enter') { e.stopPropagation(); e.currentTarget.blur(); }              // commits via onBlur
        else if (e.key === 'Escape') { e.stopPropagation(); set(null); e.currentTarget.blur(); } // discard, then onBlur no-ops
      }}
      className={className}
    />
  );
};
const NUM_INPUT = 'bg-surface-0 border border-line-1 rounded px-1.5 py-0.5 text-right num text-mini focus:border-accent focus:outline-none';

export const TimelineToolbar: React.FC<Props> = ({ playing, onTogglePlay, onStop, timeRef, duration, onChangeDuration, fps, onChangeFps, tool, onSetTool, snapEnabled, onToggleSnap, onAddMarker, onSetIn, onSetOut, hasRegion, onZoom, onZoomFit, onAddTrack, loop, onToggleLoop, smEnabled, onToggleSm, onEditLogic, maximized, onToggleMax }) => (
  <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-line-1 bg-surface-1">
    {/* ── transport: what is PLAYING ── */}
    <TBtn active={playing} title="Play / Pause (Space)" onClick={onTogglePlay}>
      {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
    </TBtn>
    <TBtn title="Stop — pause and return to the in-point" onClick={onStop}><Square size={13} fill="currentColor" /></TBtn>
    <TBtn active={loop} title={hasRegion ? 'Loop the in/out region (Shift+L)' : 'Loop the whole timeline, 0 → Length (Shift+L)'} onClick={onToggleLoop}>
      <Repeat size={13} />
    </TBtn>
    <TBtn title="Set in-point at the playhead (I)" onClick={onSetIn}><LogIn size={13} /></TBtn>
    <TBtn title="Set out-point at the playhead (O)" onClick={onSetOut}><LogOut size={13} /></TBtn>
    <span ref={timeRef} className="num text-mini text-fg-1 tabular-nums w-44">00:00:00:00 / 00:00:00:00</span>

    {/* ── tools: what I am DOING ── */}
    <div className="w-px h-5 bg-line-1 mx-0.5" />
    <TBtn active={tool === 'select'} title="Select tool (V)" onClick={() => onSetTool('select')}><MousePointer2 size={13} /></TBtn>
    <TBtn active={tool === 'blade'} title="Blade tool (B)" onClick={() => onSetTool('blade')}><Scissors size={13} /></TBtn>
    <TBtn active={snapEnabled} title="Snapping (S)" onClick={onToggleSnap}><Magnet size={13} /></TBtn>
    <TBtn title="Add marker at playhead (M)" onClick={onAddMarker}><Flag size={13} /></TBtn>

    <div className="w-px h-5 bg-line-1 mx-0.5" />
    <TBtn active={smEnabled} title="State machine: enable control layer" onClick={onToggleSm}><Workflow size={13} /></TBtn>
    <button onClick={onEditLogic} className="px-2 py-1 rounded-sm bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-mini">Edit logic</button>

    {/* ── document + view: what I am EDITING ── */}
    <div className="ml-auto flex items-center gap-2">
      <div className="flex items-center gap-1">
        <span className="text-fg-3 text-micro">FPS</span>
        <NumField value={fps} onCommit={onChangeFps} min={1} max={120} step={1} integer className={`w-11 ${NUM_INPUT}`} />
      </div>
      <div className="flex items-center gap-1">
        <span className="text-fg-3 text-micro" title="The end of the timeline. Playback stops here — or loops, if Loop is on. Committed on Enter / when you leave the field.">Length</span>
        <NumField value={duration} onCommit={onChangeDuration} min={1} step={1} className={`w-14 ${NUM_INPUT}`} />
        <span className="text-fg-3 text-micro">s</span>
      </div>
      <div className="flex items-center gap-1">
        <button onClick={() => onZoom(1 / 1.5)} className="p-1 rounded text-fg-2 hover:text-fg-1" title="Zoom out (- / wheel)"><ZoomOut size={13} /></button>
        <button onClick={onZoomFit} className="p-1 rounded text-fg-2 hover:text-fg-1" title="Zoom to fit"><Scan size={12} /></button>
        <button onClick={() => onZoom(1.5)} className="p-1 rounded text-fg-2 hover:text-fg-1" title="Zoom in (+ / wheel)"><ZoomIn size={13} /></button>
      </div>
      <button onClick={onAddTrack} className="flex items-center gap-1 px-2 py-1 rounded-sm bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-mini"><Plus size={12} /> Track</button>
      <TBtn title={maximized ? 'Restore (F)' : 'Maximize (F)'} onClick={onToggleMax}>{maximized ? <Minimize size={13} /> : <Maximize size={13} />}</TBtn>
    </div>
  </div>
);
