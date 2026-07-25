// One automation lane: a keyframe curve over the same time axis as the clips.
//
// The polyline is drawn by sampling `sampleLane` — the SAME function the engine samples in its frame
// loop — so the curve you SEE is literally the curve you HEAR. A separate drawing routine would be free
// to disagree with the audio, and eventually would.
//
// Editing follows the clip conventions: drag with a local `draft` and commit ONCE on pointerup, never
// per pointermove (a commit re-enters App → setScenes → timelineEngine.setData → recompile + a full bed
// re-sync; doing that 60×/s while dragging would be brutal).
import React, { useMemo, useRef, useState } from 'react';
import type { AutomationLane as Lane, Keyframe } from '../../types';
import type { AutomationTargetDef } from '@artlux/sdk/renderer';
import { sampleLane, normValue, denormValue, BEZ_DEFAULT } from '../../services/automation';
import { GUTTER, clamp } from './geometry';
import { Trash2, Zap, ZapOff, Diamond, AlertTriangle } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { help } from '../../services/helpBus';

export const AUTO_LANE_H = 64;
const PAD = 8; // px of headroom top/bottom so a keyframe at min/max is still grabbable

interface Props {
  lane: Lane;
  def?: AutomationTargetDef;       // absent ⇒ the target no longer exists (clip deleted, plugin off)
  pxPerSec: number;
  width: number;
  // WHICH CLOCK THIS LANE'S TIME AXIS IS. A 'scene' lane gets the playhead; a 'global' (BASE) lane gets the
  // SHOW clock, because that is what the engine samples it on. The caller picks — see Timeline.tsx.
  playhead: number;
  // WHERE THE LANE LIVES. 'global' = a lane of the GLOBAL timeline, drawn here because it is the base layer
  // and it is STILL DRIVING this parameter underneath the bound scene. Without it the panel would be blank
  // while a house fade slid the master with no visible cause.
  origin: 'scene' | 'global';
  // A scene lane owns the same targetPath, so timeline.ts:519 has filtered this base lane OUT: it is not
  // applying. Draw it as overridden, or the operator sees two lanes both claiming the same parameter.
  shadowed: boolean;
  docKey: string;                  // identity of the BOUND document — see the discard below
  // ABSENT ⇒ READ-ONLY. A global lane is edited on the Global pill, where it lives; patchLane resolves by id
  // out of the BOUND document, so a write from a scene would silently find nothing. No handler, no edit —
  // structurally, not by a disabled flag someone can forget to check.
  onChange?: (lane: Lane) => void;
  onRemove?: () => void;
  onSnap: (t: number) => number;   // reuse the timeline's snapping
  onSeek: (clientX: number) => void;
}

export const AutomationLane: React.FC<Props> = ({ lane, def, pxPerSec, width, playhead, origin, shadowed, docKey, onChange, onRemove, onSnap, onSeek }) => {
  const readOnly = !onChange;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Keyframe[] | null>(null);
  const draftRef = useRef<Keyframe[] | null>(null);
  draftRef.current = draft;
  const [sel, setSel] = useState<number | null>(null);
  // ⚠ THE DOCUMENT CAN REBIND UNDER A LIVE POINTER — AND THIS LANE SURVIVES IT.
  //
  // <TimelinePanel> has no React `key`, so a recall does not remount it; and a cloned scene's automation
  // lane carries the SAME id (Capture Scene deep-clones), so `key={lane.id}` reconciles this very
  // instance onto the incoming document's lane — draft and all. The `up` handler below lives on `window`
  // and is removed only inside itself, so unmounting would not have saved us either: it still runs.
  // A keyframe drag must therefore refuse to commit across a rebind, keyed on WHICH DOCUMENT IS BOUND
  // (identity), never on the lane's value — the clone makes the values equal, which is what made the
  // first version of this fix, elsewhere in the tree, completely inert.
  const docKeyRef = useRef(docKey); docKeyRef.current = docKey;
  // Belt to the braces below: drop a live drag's draft the moment the document changes, so the curve on
  // screen is the bound document's and not the departed one's.
  React.useEffect(() => { setDraft(null); setSel(null); }, [docKey]);

  const h = lane.height ?? AUTO_LANE_H;
  const kfs = draft ?? lane.keyframes;
  const enabled = lane.enabled !== false;

  // ⚠ EVERY HOOK IN THIS COMPONENT RUNS **ABOVE** THE `!def` BAIL — INCLUDING THE `path` MEMO. MOVING IT
  // BACK BELOW IS A WHITE SCREEN.
  //
  // `def` is not a constant: Timeline resolves it from the LIVE target registry and re-enumerates at 1 Hz
  // (its `defsTick`) for the express purpose of noticing that "a lane whose target was just deleted"
  // stopped being bound. So `def` goes defined → undefined UNDER A MOUNTED LANE, in the ordinary course
  // of use: delete the bed clip (or the surface, or the effect) that an existing lane automates and the
  // target it names is gone within the second. The lane itself is deliberately KEPT — dropping it would
  // silently discard the user's curve — and simply re-renders through the "target missing" branch below.
  //
  // With the memo sitting after that early return, THAT render called one FEWER HOOK than the last one,
  // and React throws `Rendered fewer hooks than expected` — IN RENDER. There is no ErrorBoundary anywhere
  // in this renderer, so React 19 unmounts the tree: white screen, black projector, silent room, from
  // deleting a clip. Hoisting the hooks makes the hook count constant across both branches.
  const min = def?.min ?? 0;
  const max = def?.max ?? 1;
  const log = def?.log ?? false;
  const valueToY = (v: number) => PAD + (1 - normValue(v, min, max, log)) * (h - 2 * PAD);
  const yToValue = (y: number) => denormValue(1 - (y - PAD) / (h - 2 * PAD), min, max, log);
  const quant = (v: number) => {
    const s = def?.step ?? 0;
    return s > 0 ? Math.round(v / s) * s : v;
  };

  // Sample the curve across the lane — the engine's own function, so the drawing cannot drift from the
  // sound. Memoized, and the point count is CAPPED: the timeline is unbounded (its width grows as the
  // playhead advances), so a fixed 2px step would keep adding points forever, and this runs on every
  // render — including every pointermove of a keyframe drag.
  const path = useMemo(() => {
    if (!def || kfs.length === 0) return '';   // no axis to draw against — the bail below renders instead
    const step = Math.max(2, width / 1200);
    const cur = { i: -1 };
    const pts: string[] = [];
    for (let x = 0; x <= width; x += step) {
      const v = sampleLane(kfs, x / pxPerSec, cur, log);
      pts.push(`${x.toFixed(1)},${valueToY(v).toFixed(1)}`);
    }
    return `M${pts.join(' L')}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, kfs, width, pxPerSec, log, min, max, h]);

  // A lane whose target vanished keeps its data (never silently dropped — that would be losing the
  // user's work), but it can't be drawn against an axis it no longer has.
  if (!def) {
    return (
      <div className={`flex border-b border-line-1 bg-surface-1/40 ${origin === 'global' ? 'opacity-60' : ''}`}>
        <div className="sticky left-0 z-20 shrink-0 bg-surface-1 border-r border-line-1 flex items-center gap-1.5 px-2" style={{ width: GUTTER, height: 28 }}>
          <AlertTriangle size={12} className="text-warn shrink-0" />
          <span className="text-micro text-fg-3 truncate" title={lane.targetPath}>target missing</span>
          {origin === 'global' && <span className="shrink-0 px-1 rounded bg-surface-2 text-micro text-fg-2" title="This lane belongs to the GLOBAL timeline. Switch to the Global pill to delete it.">GLOBAL</span>}
          {/* No dead button: `onRemove` is absent on a global lane, so React would render a Trash icon that
              silently does nothing when clicked. Hide it — the operator deletes it on the Global pill. */}
          {!readOnly && <button onClick={onRemove} className="ml-auto text-fg-3 hover:text-danger"><Trash2 size={12} /></button>}
        </div>
        <div className="relative text-micro text-fg-3/70 italic px-2 flex items-center" style={{ width, height: 28 }}>
          {lane.targetPath} — the clip or effect it drives is gone. The curve is kept; delete the lane to discard it.
        </div>
      </div>
    );
  }

  // ⚠ THE READ-ONLY GUARD IS EXPLICIT, AND IT HAS TO BE — THERE IS NO COMPILER BEHIND IT.
  // `onChange` is optional (absent ⇒ a GLOBAL lane, seen from a scene, which is edited on the Global pill).
  // This repo does NOT enable `strict` / `strictNullChecks` (tsconfig.json), so tsc will happily compile
  // `onChange(...)` on a possibly-undefined prop and say nothing. Every write path therefore checks for
  // itself: without these guards, dragging a keyframe on a global lane would call `undefined(...)` and take
  // the whole timeline panel down with it. "No handler ⇒ structurally inert" is only true under strictNullChecks.
  const commit = (next: Keyframe[]) => {
    if (!onChange) return;
    onChange({ ...lane, keyframes: next.slice().sort((a, b) => a.t - b.t) });
  };

  const dragKf = (i: number) => (e: React.PointerEvent) => {
    if (readOnly) return;       // a global lane is not draggable from a scene
    if (e.button !== 0) return; // middle-drag pans the timeline
    e.stopPropagation();
    e.preventDefault();
    setSel(i);
    const el = bodyRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const base = lane.keyframes;
    const doc = docKeyRef.current;   // the document this gesture STARTED on
    const move = (ev: PointerEvent) => {
      if (doc !== docKeyRef.current) return;   // rebound mid-drag — the gesture is dead; don't re-arm the draft
      const next = base.slice();
      // Clamp between the neighbours so the array stays sorted — the sampler's cursor depends on it.
      const lo = i > 0 ? base[i - 1].t + 0.001 : 0;
      const hi = i < base.length - 1 ? base[i + 1].t - 0.001 : Number.MAX_SAFE_INTEGER;
      const t = ev.shiftKey ? base[i].t : clamp(onSnap((ev.clientX - rect.left) / pxPerSec), lo, hi);
      const v = ev.altKey ? base[i].v : quant(clamp(yToValue(ev.clientY - rect.top), min, max));
      next[i] = { ...base[i], t: Math.max(0, t), v };
      setDraft(next);
    };
    const done = (allowCommit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      // ONE commit, on release — and OUTSIDE the state updater. Committing inside setDraft(d => ...)
      // would issue a render-phase update to App, which React 19 StrictMode double-invokes.
      const d = draftRef.current;
      setDraft(null);
      if (!allowCommit || !d) return;
      if (doc !== docKeyRef.current) return;   // the document rebound mid-drag → ABANDON, never merge
      commit(d);
    };
    const up = () => done(true);
    // pointercancel = the system took the gesture away (a touchscreen pan takeover); pointerup will never
    // arrive. Tear down and abandon — leaving the listeners live let the keyframe follow an unpressed
    // cursor and the next click anywhere commit it.
    const cancel = () => done(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  const addAt = (e: React.MouseEvent) => {
    if (readOnly) return;   // see the note on commit(): no strictNullChecks, so every write path guards itself
    const el = bodyRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const t = Math.max(0, onSnap((e.clientX - rect.left) / pxPerSec));
    const v = quant(clamp(yToValue(e.clientY - rect.top), min, max));
    commit([...lane.keyframes, { t, v, curve: 'linear' }]);
  };

  const removeKf = (i: number) => {
    if (readOnly) return;
    if (lane.keyframes.length <= 1) return; // a lane always holds at least one key — remove the lane instead
    commit(lane.keyframes.filter((_, j) => j !== i));
  };

  // Clicking a segment cycles the LEFT key's curve. Order: linear → hold → bezier.
  const cycleCurve = (i: number) => {
    if (readOnly) return;
    const k = lane.keyframes[i];
    const next: Keyframe['curve'] = k.curve === 'linear' ? 'hold' : k.curve === 'hold' ? 'bezier' : 'linear';
    commit(lane.keyframes.map((x, j) => (j === i ? { ...x, curve: next, ...(next === 'bezier' ? BEZ_DEFAULT : {}) } : x)));
  };

  const live = kfs.length ? sampleLane(kfs, playhead, { i: -1 }, log) : def.def;
  const fmt = (v: number) => `${(def.step ?? 0) >= 1 ? Math.round(v) : Number(v.toFixed(2))}${def.unit ? ` ${def.unit}` : ''}`;

  // A GLOBAL lane seen from a scene is dimmed; a SHADOWED one (a scene lane owns the same targetPath, so
  // timeline.ts:519 has filtered this one out of the compile) is dimmed harder and struck through. That
  // second state is the whole point: without it the operator would see two lanes both claiming to drive the
  // master, with nothing saying which one wins — worse than seeing none.
  const dim = origin === 'global' ? (shadowed ? 'opacity-30' : 'opacity-60') : '';

  return (
    <div className={`flex border-b border-line-1 ${enabled ? 'bg-surface-1/40' : 'bg-surface-1/20'} ${dim}`}>
      {/* gutter */}
      <div className="sticky left-0 z-20 shrink-0 bg-surface-1 border-r border-line-1 flex flex-col justify-center gap-0.5 px-2 py-1" style={{ width: GUTTER, height: h }}>
        <div className="flex items-center gap-1">
          <Tooltip id="timeline.automation-enable">
            <button onClick={() => onChange?.({ ...lane, enabled: !enabled })} disabled={readOnly}
              title={readOnly
                ? 'This lane belongs to the GLOBAL timeline — switch to the Global pill to change it.'
                : enabled ? 'Lane ON — it owns this parameter (click to release it back to manual)' : 'Lane OFF — the parameter is manual again'}
              {...help('timeline.automation-enable')}
              className={`${enabled ? 'text-accent' : 'text-fg-3'} ${readOnly ? 'cursor-default' : 'hover:text-fg-1'}`}>
              {enabled ? <Zap size={11} /> : <ZapOff size={11} />}
            </button>
          </Tooltip>
          <span className={`text-micro truncate ${shadowed ? 'text-fg-3 line-through' : 'text-fg-1'}`} title={lane.targetPath}>{def.label}</span>
          {/* WHY THIS LANE IS ON SCREEN AT ALL. It is not this scene's — it belongs to the GLOBAL timeline and
              rides the SHOW clock, and it is what is moving this parameter underneath the scene. Say so, or the
              operator watches their master slide with no visible cause. */}
          {origin === 'global' && (
            <span
              className={`shrink-0 px-1 rounded bg-surface-2 text-micro ${shadowed ? 'text-fg-3 line-through' : 'text-fg-2'}`}
              title={shadowed
                ? 'GLOBAL lane — it rides the SHOW clock and normally runs underneath every scene. But THIS SCENE has its own lane on the same parameter, which overrides it, so right now the global one is NOT applying.'
                : 'GLOBAL lane — it belongs to the global timeline and rides the SHOW clock, so it keeps running underneath every scene. This is what is driving the parameter. Edit it on the Global pill.'}>
              GLOBAL
            </span>
          )}
          {!readOnly && (
            <>
              <Tooltip id="timeline.automation-add-key">
                <button onClick={() => commit([...lane.keyframes.filter(k => Math.abs(k.t - playhead) > 0.001), { t: Math.max(0, playhead), v: quant(live), curve: 'linear' }])}
                  title="Add a keyframe at the playhead, holding the current value" {...help('timeline.automation-add-key')} className="ml-auto text-fg-3 hover:text-fg-1">
                  <Diamond size={11} />
                </button>
              </Tooltip>
              <Tooltip id="timeline.automation-remove-lane">
                <button onClick={onRemove} title="Remove lane" {...help('timeline.automation-remove-lane')} className="text-fg-3 hover:text-danger"><Trash2 size={11} /></button>
              </Tooltip>
            </>
          )}
        </div>
        <div className="text-micro leading-none text-fg-3 truncate" title={def.group}>{def.group}</div>
        {/* The readout is sampled at whichever clock the CALLER handed us as `playhead` — the SHOW clock for a
            global lane, the playhead for a scene lane — so it prints the number the engine is actually
            applying, not a number computed against the wrong axis. */}
        <div className="text-micro leading-none text-fg-2 tabular-nums">{fmt(live)}</div>
      </div>

      {/* body */}
      <div ref={bodyRef} className="relative" style={{ width, height: h, opacity: enabled ? 1 : 0.4 }}
        onDoubleClick={addAt}
        onPointerDown={(e) => { if (e.button === 0 && e.detail === 1) onSeek(e.clientX); }}>
        <svg width={width} height={h} className="absolute inset-0 pointer-events-none">
          <line x1={0} y1={valueToY(max)} x2={width} y2={valueToY(max)} className="stroke-line-1/40" strokeWidth={1} />
          <line x1={0} y1={valueToY(min)} x2={width} y2={valueToY(min)} className="stroke-line-1/40" strokeWidth={1} />
          <path d={path} fill="none" stroke={lane.color ?? 'currentColor'} className="text-accent" strokeWidth={1.5} />
        </svg>
        {/* keyframes */}
        {kfs.map((k, i) => {
          // Shown while this key is being DRAGGED or is selected (`sel` is set on pointerdown and persists),
          // and on hover. The wrapper's box is 0×0, so it is not a hit target and cannot steal the body's
          // click-to-seek or double-click-to-add; only the diamond and the (inert) label are.
          const active = sel === i;
          const flip = k.t * pxPerSec > width - 70;   // near the right edge — put the label on the other side
          return (
            <div key={i} className="absolute group" style={{ left: k.t * pxPerSec, top: valueToY(k.v) }}>
              {/* ⚠ THE VALUE, WHERE THE OPERATOR IS LOOKING — AND THE `title` BELOW IS NOT A SUBSTITUTE.
                  A native tooltip needs a still hover of about a second, and THE BROWSER SUPPRESSES IT
                  OUTRIGHT ONCE A DRAG BEGINS — so the number was guaranteed to be missing at the one moment
                  it matters: while you are setting it. You dragged a diamond up and down and simply could
                  not see what level you were writing. This is a real element, so it survives the drag; it
                  reads `k.v`, which is the DRAFT while dragging (`kfs = draft ?? lane.keyframes`), so it
                  tracks the thumb. The time comes with it because a drag moves both axes at once. */}
              <span
                className={`absolute top-0 -translate-y-1/2 ${flip ? 'right-2' : 'left-2'} z-10 px-1 rounded border border-line-1 bg-surface-0/95 text-micro leading-tight text-fg-1 tabular-nums whitespace-nowrap pointer-events-none transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                {fmt(k.v)} <span className="text-fg-3">· {k.t.toFixed(2)}s</span>
              </span>
              <Tooltip id="timeline.automation-keyframe">
                <div onPointerDown={dragKf(i)}
                  onContextMenu={(e) => { e.preventDefault(); removeKf(i); }}
                  onClick={(e) => { if (e.altKey) { e.stopPropagation(); removeKf(i); } }}
                  onDoubleClick={(e) => { e.stopPropagation(); cycleCurve(i); }}
                  {...help('timeline.automation-keyframe')}
                  title={`${fmt(k.v)} @ ${k.t.toFixed(2)}s · ${k.curve ?? 'linear'}\ndrag to move (shift = value only, alt = time only) · double-click: curve · right-click: delete`}
                  className={`absolute left-0 top-0 -ml-[4.5px] -mt-[4.5px] w-[9px] h-[9px] rotate-45 cursor-pointer ${active ? 'bg-fg-1 border border-fg-1' : 'bg-accent border border-accent'}`} />
              </Tooltip>
            </div>
          );
        })}
      </div>
    </div>
  );
};
