import React from 'react';
import { Play, Pause, Plus, ZoomIn, ZoomOut, Maximize, Minimize, Scan, Scissors, MousePointer2, Magnet, Flag, Repeat, Workflow, Square, LogIn, LogOut, AlertTriangle, Snowflake } from 'lucide-react';
import { fmtClock } from './geometry';
import { Tooltip } from '../ui/Tooltip';
import { help } from '../../services/helpBus';

interface Props {
  playing: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  onSetIn: () => void;
  onSetOut: () => void;
  hasRegion: boolean;   // an in/out region exists — Loop honours it instead of [0, Length)
  timeRef: React.RefObject<HTMLSpanElement>;
  // The audio bed's position (the SHOW clock) while a scene is bound and its lanes are therefore not
  // drawn. Painted imperatively by Timeline.tsx's engine subscription — never React state (invariant 3).
  bedTimeRef?: React.RefObject<HTMLSpanElement>;
  // Content authored past the document's LENGTH, and the one-click fix (Length → the content end). Absent
  // ⇒ nothing overruns. An audio clip does NOT extend Length, so without this the operator's only clue
  // that a clip will never be heard is that it is silent.
  //
  // `length`, NOT the playable end: an out-point OVERRIDES Length, and a deliberately narrowed loop
  // region is not an overrun (see Timeline.tsx's `lengthEnd`). The fix raises Length and NEVER touches
  // the in/out region — say so, because the operator is about to click it on a live show.
  overrun?: { at: number; length: number; onFix: () => void };
  // Identity of the timeline currently BOUND to the editor (a scene id, or the global sentinel). The
  // number fields hold an uncommitted draft; this is what tells them the document swapped under them.
  docKey: string;
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
  // HOLD AT END (Timeline.holdAtEnd): the state's picture freezes on its last frame instead of the
  // transport pausing, so the audio bed and the global automation play on underneath. `onEndStateHere`
  // is the one-click authoring verb — set the out-point at the playhead AND turn the hold on.
  holdAtEnd: boolean;
  onToggleHold: () => void;
  onEndStateHere: () => void;
  smEnabled: boolean;
  onToggleSm: () => void;
  onEditLogic: () => void;
  maximized: boolean;
  onToggleMax: () => void;
}

// `helpId`, when given, opts the button into the rich help system: it gains a hoverable tooltip with a
// "? Learn more" deep-link (Tooltip) and feeds the StatusBar/HelpPanel context line (help(id)). The
// native `title` stays as the accessible name and the fallback for buttons without an entry.
const TBtn: React.FC<{ active?: boolean; disabled?: boolean; title: string; helpId?: string; onClick: () => void; children: React.ReactNode }> = ({ active, disabled, title, helpId, onClick, children }) => {
  // `disabled` still renders the button (and keeps its tooltip — which is where the WHY lives, e.g.
  // "Loop is on, so the timeline never ends"), it just cannot be pressed. Hiding it instead would make
  // the control look unimplemented rather than inapplicable.
  const btn = (
    <button title={title} onClick={onClick} disabled={disabled} {...(helpId ? help(helpId) : {})}
      className={`p-1.5 rounded-sm ${disabled
        // Still shows ACTIVE when it is on-but-inapplicable (Hold authored while Loop is on), just muted:
        // the setting is real and comes back the moment Loop goes off, so painting it plain "off" would
        // be a lie about the document.
        ? `opacity-40 cursor-not-allowed ${active ? 'bg-accent text-black' : 'bg-surface-2 text-fg-3'}`
        : active ? 'bg-accent text-black' : 'bg-surface-2 text-fg-2 hover:text-fg-1'}`}>{children}</button>
  );
  return helpId ? <Tooltip id={helpId}>{btn}</Tooltip> : btn;
};

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
  docKey: string;   // identity of the BOUND document — see the discard effect below
  onCommit: (n: number) => void;
  min: number;
  max?: number;
  step?: number;
  integer?: boolean;
  className: string;
}> = ({ value, docKey, onCommit, min, max, step = 1, integer, className }) => {
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
  //
  // DEPEND ON `docKey`, NOT ONLY ON `value`. Keying the discard on the value alone fixes nothing in the
  // case that actually happens: Capture Scene deep-clones the timeline, so a scene's Length usually
  // EQUALS the global doc's, and `fps` is 30 in virtually every document ever made. Same value ⇒ the
  // effect never fires ⇒ the draft survives the very swap it exists to catch. `docKey` changes on every
  // rebind regardless of the numbers, so the discard is driven by "which document am I editing", which
  // is the actual question.
  React.useEffect(() => { set(null); }, [value, docKey]);
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

// Memoized for the same reason as the ruler: none of what it draws changes while a clip is being dragged,
// yet it was re-rendering on every pointer move at ~61 ms/s of the gesture. Its callbacks come from
// Timeline.tsx as one stable bag (useStableHandlers), because thirty inline arrows would defeat this.
const TimelineToolbarBase: React.FC<Props> = ({ playing, onTogglePlay, onStop, timeRef, bedTimeRef, overrun, docKey, duration, onChangeDuration, fps, onChangeFps, tool, onSetTool, snapEnabled, onToggleSnap, onAddMarker, onSetIn, onSetOut, hasRegion, onZoom, onZoomFit, onAddTrack, loop, onToggleLoop, holdAtEnd, onToggleHold, onEndStateHere, smEnabled, onToggleSm, onEditLogic, maximized, onToggleMax }) => (
  <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-line-1 bg-surface-1">
    {/* ── transport: what is PLAYING ── */}
    <TBtn active={playing} title="Play / Pause (Space)" helpId="timeline.play" onClick={onTogglePlay}>
      {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
    </TBtn>
    <TBtn title="Stop — pause and return to the in-point" helpId="timeline.stop" onClick={onStop}><Square size={13} fill="currentColor" /></TBtn>
    <TBtn active={loop} title={hasRegion ? 'Loop the in/out region (Shift+L)' : 'Loop the whole timeline, 0 → Length (Shift+L)'} helpId="timeline.loop" onClick={onToggleLoop}>
      <Repeat size={13} />
    </TBtn>
    {/* HOLD AT END — the third thing a clock can do when it runs out, next to wrap (Loop) and stop.
        Loop wins, so the toggle is inert while looping and says why. */}
    <TBtn active={holdAtEnd} disabled={loop} helpId="timeline.hold-at-end"
      title={loop
        ? 'Hold at end — unavailable while Loop is on: a looping timeline never reaches an end.'
        : 'Hold at end — freeze on the last frame instead of stopping. The transport keeps running, so the audio bed and the global automation play on, and the state machine is told the state has finished.'}
      onClick={onToggleHold}>
      <Snowflake size={13} />
    </TBtn>
    <TBtn title="Set in-point at the playhead (I)" helpId="timeline.set-in" onClick={onSetIn}><LogIn size={13} /></TBtn>
    <TBtn title="Set out-point at the playhead (O)" helpId="timeline.set-out" onClick={onSetOut}><LogOut size={13} /></TBtn>
    {/* The authoring verb for a tracker-driven show, in one click: this is where the state ENDS. Sets
        the out-point here AND turns the hold on — the two halves are useless apart. */}
    <Tooltip id="timeline.end-state">
      <button onClick={onEndStateHere} {...help('timeline.end-state')}
        title="End this state at the playhead — sets the out-point here and holds the last frame. The show keeps running; the state machine can then advance on a trigger."
        className="px-2 py-1 rounded-sm bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-mini whitespace-nowrap">End state here</button>
    </Tooltip>
    <span ref={timeRef} className="num text-mini text-fg-1 tabular-nums w-44">00:00:00:00 / 00:00:00:00</span>
    {bedTimeRef && (
      <span ref={bedTimeRef} className="text-micro text-fg-3 tabular-nums shrink-0"
        title="The audio bed's position — the SHOW clock. It does not restart when a scene is recalled, which is why its lanes are not drawn against this scene's ruler.">♪ BED 0:00</span>
    )}
    {overrun && (
      <button onClick={overrun.onFix}
        title={`Content runs to ${fmtClock(overrun.at)} but Length is ${fmtClock(overrun.length)}, so it will never be heard or seen. Click to set Length to ${fmtClock(overrun.at)}. Your in/out region is not touched.`}
        className="shrink-0 inline-flex items-center gap-1 px-1.5 h-5 rounded bg-warn/15 text-warn text-micro">
        <AlertTriangle size={10} /> past the end — Length → {fmtClock(overrun.at)}
      </button>
    )}

    {/* ── tools: what I am DOING ── */}
    <div className="w-px h-5 bg-line-1 mx-0.5" />
    <TBtn active={tool === 'select'} title="Select tool (V)" helpId="timeline.select-tool" onClick={() => onSetTool('select')}><MousePointer2 size={13} /></TBtn>
    <TBtn active={tool === 'blade'} title="Blade tool (B)" helpId="timeline.blade" onClick={() => onSetTool('blade')}><Scissors size={13} /></TBtn>
    <TBtn active={snapEnabled} title="Snapping (S)" helpId="timeline.snap" onClick={onToggleSnap}><Magnet size={13} /></TBtn>
    <TBtn title="Add marker at playhead (M)" helpId="timeline.add-marker" onClick={onAddMarker}><Flag size={13} /></TBtn>

    <div className="w-px h-5 bg-line-1 mx-0.5" />
    <TBtn active={smEnabled} title="State machine: enable control layer" helpId="timeline.state-machine" onClick={onToggleSm}><Workflow size={13} /></TBtn>
    <Tooltip id="timeline.edit-logic">
      <button onClick={onEditLogic} {...help('timeline.edit-logic')} title="Edit the state-machine logic" className="px-2 py-1 rounded-sm bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-mini">Edit logic</button>
    </Tooltip>

    {/* ── document + view: what I am EDITING ── */}
    <div className="ml-auto flex items-center gap-2">
      <div className="flex items-center gap-1">
        <Tooltip id="timeline.fps"><span className="text-fg-3 text-micro" {...help('timeline.fps')}>FPS</span></Tooltip>
        <NumField value={fps} docKey={docKey} onCommit={onChangeFps} min={1} max={120} step={1} integer className={`w-11 ${NUM_INPUT}`} />
      </div>
      <div className="flex items-center gap-1">
        <Tooltip id="timeline.length"><span className="text-fg-3 text-micro" {...help('timeline.length')} title="The end of the timeline. Playback stops here — or loops, if Loop is on. Committed on Enter / when you leave the field.">Length</span></Tooltip>
        <NumField value={duration} docKey={docKey} onCommit={onChangeDuration} min={1} step={1} className={`w-14 ${NUM_INPUT}`} />
        <span className="text-fg-3 text-micro">s</span>
      </div>
      <div className="flex items-center gap-1">
        <Tooltip id="timeline.zoom-out"><button onClick={() => onZoom(1 / 1.5)} {...help('timeline.zoom-out')} className="p-1 rounded text-fg-2 hover:text-fg-1" title="Zoom out (- / wheel)"><ZoomOut size={13} /></button></Tooltip>
        <Tooltip id="timeline.zoom-fit"><button onClick={onZoomFit} {...help('timeline.zoom-fit')} className="p-1 rounded text-fg-2 hover:text-fg-1" title="Zoom to fit"><Scan size={12} /></button></Tooltip>
        <Tooltip id="timeline.zoom-in"><button onClick={() => onZoom(1.5)} {...help('timeline.zoom-in')} className="p-1 rounded text-fg-2 hover:text-fg-1" title="Zoom in (+ / wheel)"><ZoomIn size={13} /></button></Tooltip>
      </div>
      <Tooltip id="timeline.add-track">
        <button onClick={onAddTrack} {...help('timeline.add-track')} title="Add a video track" className="flex items-center gap-1 px-2 py-1 rounded-sm bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-mini"><Plus size={12} /> Track</button>
      </Tooltip>
      <TBtn title={maximized ? 'Restore (F)' : 'Maximize (F)'} helpId="timeline.maximize" onClick={onToggleMax}>{maximized ? <Minimize size={13} /> : <Maximize size={13} />}</TBtn>
    </div>
  </div>
);
export const TimelineToolbar = React.memo(TimelineToolbarBase);
