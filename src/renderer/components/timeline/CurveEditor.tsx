// The BODY of a keyframe curve: the polyline, the diamonds, the drag, and the per-key editor.
//
// Extracted from AutomationLane so a second surface can draw a curve without a second implementation
// of any of it. The timeline's fixture super track needs one row per DMX channel of a selected head,
// and a fork of this file would disagree with the lane about bezier handles, about which neighbour a
// drag clamps against, or about which unit the typed field speaks — within a release, and invisibly,
// because both would still look like a curve.
//
// WHAT DELIBERATELY STAYED IN THE LANE, and must stay out of here:
//   · the GUTTER (label, enable, add-key, remove) — it is per-surface chrome, not curve editing;
//   · the "target missing" bail — a lane keeps a curve whose target vanished, which is a lane policy;
//   · the DOM-DIRECT LIVE READOUT. A shared component owning that would either force every caller
//     onto engine.subscribe or push a clock into React state, and "a clock never enters React state"
//     is invariant-guarded. Each caller keeps its own readout.
//
// CONTROLLED, NOT STATEFUL, ABOUT THE CURVE. `keyframes` is the committed array every write path
// edits from; `draft` is a drag in flight, owned by the CALLER, and drawn instead when present. That
// split is not ceremony — it is what the lane already did internally (`kfs = draft ?? lane.keyframes`
// for drawing, `lane.keyframes` as the base for every edit), and the caller has to see the draft
// anyway to keep its live readout tracking the thumb.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Keyframe } from '../../types';
import { toDisplay, fromDisplay, type AutomationTargetDef } from '@artlux/sdk/renderer';
import { sampleLane, normValue, denormValue, BEZ_DEFAULT } from '../../services/automation';
import { clamp } from './geometry';
import { Tooltip } from '../ui/Tooltip';
import { help } from '../../services/helpBus';
import { usePopoverAnchor } from './usePopoverAnchor';

/** px of headroom top/bottom so a keyframe at min/max is still grabbable. */
export const PAD = 8;

// Seeds the editor's value field. Enough places to hold any axis this app has, few enough that a
// stored 0.5000000000000001 (which is what a display round-trip on a 16-bit channel produces) does
// not land in the field looking like a bug the operator caused.
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/**
 * One value readout, in the unit the operator authors in.
 *
 * ONE function because a curve prints values twice — the caller's render-free live gutter (which
 * writes straight to the DOM) and the React keyframe list — and two formatters would eventually
 * disagree about the same number on the same lane. Exported for that gutter.
 *
 * Precision follows the SPAN, not the storage step: a 0..540° axis wants whole degrees, a 0..1
 * opacity wants two decimals, and the stored `step` (1/65535 for a 16-bit Pan) describes neither.
 */
export const fmtIn = (d: AutomationTargetDef, v: number): string => {
  const shown = toDisplay(d, v);
  const unit = d.display?.unit ?? d.unit;
  const whole = d.display ? Math.abs(d.display.max - d.display.min) >= 10 : (d.step ?? 0) >= 1;
  const n = whole ? Math.round(shown) : Number(shown.toFixed(2));
  return unit ? `${n} ${unit}` : `${n}`;
};

export interface CurveEditorProps {
  /** The COMMITTED keys — the base every write path edits from. Sorted ascending by t. */
  keyframes: Keyframe[];
  /** A drag in flight, owned by the caller. Drawn instead of `keyframes` when present. */
  draft: Keyframe[] | null;
  /** The axis, the units and the step. Never undefined here: the caller bails before mounting us. */
  def: AutomationTargetDef;
  width: number;
  height: number;
  pxPerSec: number;
  color?: string;
  /** No handler is not enough on its own — see the note on `commit`. */
  readOnly: boolean;
  /**
   * Identity of the BOUND DOCUMENT. A drag must refuse to commit across a rebind, and it must key on
   * WHICH DOCUMENT (identity) rather than on the curve's value — a cloned scene carries equal values,
   * which is what made the first version of this fix, elsewhere in the tree, completely inert.
   */
  docKey: string;
  onDraft: (next: Keyframe[] | null) => void;
  onCommit: (next: Keyframe[]) => void;
  onSnap: (t: number) => number;
  onSeek: (clientX: number) => void;
}

export const CurveEditor: React.FC<CurveEditorProps> = ({
  keyframes, draft, def, width, height: h, pxPerSec, color, readOnly, docKey,
  onDraft, onCommit, onSnap, onSeek,
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<number | null>(null);
  // WHICH KEYFRAME IS OPEN IN THE EDITOR (an index into the committed keys), and the two drafts its
  // inputs hold while they are being typed into. Drafts, not direct commits: every keystroke would
  // otherwise be a whole-document write — invariant 7 — and typing "-180" would commit "-", then
  // "-1", then "-18" on the way, each one clamped to the target's range and each a timeline re-render.
  const [editing, setEditing] = useState<number | null>(null);
  const [editV, setEditV] = useState('');
  const [editT, setEditT] = useState('');

  const docKeyRef = useRef(docKey); docKeyRef.current = docKey;
  // What we last handed the caller, so the release path can commit it without reading back through a
  // prop that may not have re-rendered yet.
  const draftRef = useRef<Keyframe[] | null>(draft); draftRef.current = draft;

  // The document can rebind under a live pointer: drop any selection and close the editor, so what is
  // on screen belongs to the bound document and not the departed one.
  useEffect(() => { setSel(null); setEditing(null); }, [docKey]);

  // ⚠ THE EDITOR MUST NOT OUTLIVE THE KEYFRAME IT NAMES. `editing` is an INDEX, and every write path
  // re-sorts the array — so a key deleted from under the panel (its own delete button, the alt-click,
  // a recall) would leave the index pointing at a DIFFERENT key, which the fields would then write.
  // Both the length changing and the index falling off the end close it. (setTime clamps between
  // neighbours, so a time edit cannot reorder and cannot strand the index on its own.)
  useEffect(() => {
    if (editing !== null && editing >= keyframes.length) setEditing(null);
  }, [editing, keyframes.length]);

  // ── WHERE THE KEYFRAME EDITOR IS DRAWN ──────────────────────────────────────────────────────────
  // PORTALLED AND PLACED FROM A MEASURED RECT, not `absolute` next to the diamond — see
  // usePopoverAnchor, whose header documents this exact trap being walked into three times in this
  // directory. This panel was the fourth: `absolute … z-20` inside a lane body that lives under the
  // ruler's `sticky top-0 z-30` and, when the timeline is maximised, inside a `fixed inset-0 z-50`.
  // Both are STACKING CONTEXTS, so the z-index stops meaning anything globally and the scroller's
  // overflow-auto clips whatever hangs outside the lane — which a value/time/curve panel always does.
  // Nothing throws; only the pixels are wrong.
  const kfAnchorRef = useRef<HTMLDivElement | null>(null);
  const kfBoxRef = useRef<HTMLDivElement | null>(null);
  const kfPos = usePopoverAnchor(editing !== null, kfAnchorRef, {
    width: 176, estHeight: 190, boxRef: kfBoxRef, onDismiss: () => setEditing(null),
  });

  const min = def.min ?? 0;
  const max = def.max ?? 1;
  const log = def.log ?? false;
  const kfs = draft ?? keyframes;

  const valueToY = (v: number) => PAD + (1 - normValue(v, min, max, log)) * (h - 2 * PAD);
  const yToValue = (y: number) => denormValue(1 - (y - PAD) / (h - 2 * PAD), min, max, log);
  const quant = (v: number) => {
    const s = def.step ?? 0;
    return s > 0 ? Math.round(v / s) * s : v;
  };

  // Sample the curve across the row — the ENGINE'S OWN function, so the drawing cannot drift from
  // what is applied. Memoized, and the point count is CAPPED: the timeline is unbounded (its width
  // grows as the playhead advances), so a fixed 2px step would keep adding points forever, and this
  // runs on every render — including every pointermove of a keyframe drag.
  const path = useMemo(() => {
    if (kfs.length === 0) return '';
    const step = Math.max(2, width / 1200);
    const cur = { i: -1 };
    const pts: string[] = [];
    for (let x = 0; x <= width; x += step) {
      const v = sampleLane(kfs, x / pxPerSec, cur, log);
      pts.push(`${x.toFixed(1)},${valueToY(v).toFixed(1)}`);
    }
    return `M${pts.join(' L')}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kfs, width, pxPerSec, log, min, max, h]);

  // ⚠ THE READ-ONLY GUARD IS EXPLICIT, AND IT HAS TO BE — THERE IS NO COMPILER BEHIND IT.
  // This repo does NOT enable `strict` / `strictNullChecks` (tsconfig.json), so tsc will happily
  // compile a call on a possibly-undefined handler and say nothing. Every write path therefore checks
  // for itself: without these guards, dragging a keyframe on a read-only row would take the whole
  // timeline panel down. "No handler ⇒ structurally inert" is only true under strictNullChecks.
  const commit = (next: Keyframe[]) => {
    if (readOnly) return;
    onCommit(next.slice().sort((a, b) => a.t - b.t));
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
    const base = keyframes;
    const doc = docKeyRef.current;   // the document this gesture STARTED on
    const move = (ev: PointerEvent) => {
      if (doc !== docKeyRef.current) return;   // rebound mid-drag — the gesture is dead
      const next = base.slice();
      // Clamp between the neighbours so the array stays sorted — the sampler's cursor depends on it.
      const lo = i > 0 ? base[i - 1].t + 0.001 : 0;
      const hi = i < base.length - 1 ? base[i + 1].t - 0.001 : Number.MAX_SAFE_INTEGER;
      const t = ev.shiftKey ? base[i].t : clamp(onSnap((ev.clientX - rect.left) / pxPerSec), lo, hi);
      const v = ev.altKey ? base[i].v : quant(clamp(yToValue(ev.clientY - rect.top), min, max));
      next[i] = { ...base[i], t: Math.max(0, t), v };
      draftRef.current = next;
      onDraft(next);
    };
    const done = (allowCommit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      // ONE commit, on release — and OUTSIDE any state updater. Committing inside one would issue a
      // render-phase update to App, which React 19 StrictMode double-invokes.
      const d = draftRef.current;
      draftRef.current = null;
      onDraft(null);
      if (!allowCommit || !d) return;
      if (doc !== docKeyRef.current) return;   // the document rebound mid-drag → ABANDON, never merge
      commit(d);
    };
    const up = () => done(true);
    // pointercancel = the system took the gesture away (a touchscreen pan takeover); pointerup will
    // never arrive. Tear down and abandon — leaving the listeners live let the keyframe follow an
    // unpressed cursor and the next click anywhere commit it.
    const cancel = () => done(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  const addAt = (e: React.MouseEvent) => {
    if (readOnly) return;   // see commit(): no strictNullChecks, so every write path guards itself
    const el = bodyRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const t = Math.max(0, onSnap((e.clientX - rect.left) / pxPerSec));
    const v = quant(clamp(yToValue(e.clientY - rect.top), min, max));
    commit([...keyframes, { t, v, curve: 'linear' }]);
  };

  const removeKf = (i: number) => {
    if (readOnly) return;
    if (keyframes.length <= 1) return; // a row always holds at least one key — remove the row instead
    commit(keyframes.filter((_, j) => j !== i));
  };

  // ⚠ THE CURVE USED TO BE A HIDDEN CYCLE ON DOUBLE-CLICK — linear → hold → bezier, one step per
  // click, with no way to see the three options or to go back except by going round. It is a NAMED
  // CHOICE in the keyframe editor now (the same double-click opens it), which is the same control
  // made legible rather than a control removed.
  const setCurve = (i: number, curve: Keyframe['curve']) => {
    if (readOnly) return;
    commit(keyframes.map((x, j) => (j === i ? { ...x, curve, ...(curve === 'bezier' ? BEZ_DEFAULT : {}) } : x)));
  };

  /**
   * TYPE THE NUMBER. A keyframe could only ever be DRAGGED, and a drag is a poor way to say 90° — the
   * pad is a few dozen pixels tall over the target's whole range, so one pixel is a coarse quantum on
   * anything with a wide axis and a value like "exactly -180" was unhittable.
   *
   * Clamped to the TARGET's declared range, not the drawing: `def.min`/`def.max` are what the
   * automation engine will accept, and a value typed outside them would be silently clamped later and
   * disagree with what the operator typed. Quantised to the target's step for the same reason a drag is.
   */
  const setValue = (i: number, shown: number) => {
    if (readOnly) return;
    if (!Number.isFinite(shown)) return;
    // ⚠ THE FIELD IS IN THE **DISPLAY** UNIT, THE KEYFRAME IS IN STORAGE, AND THIS IS THE SEAM.
    // A target may read in one unit and store in another (docs/TIMELINE.md — a Pan lane stores the
    // 0..1 fraction that lands in `Fixture.dmx` and reads 0..540°). The label above the diamond has
    // always printed `toDisplay`, so a field that took storage would have asked the operator to type
    // `0.5` under a label saying `270 °`. `fromDisplay` is the declared exact inverse; it is the
    // identity for every target that declares no `display`, which is all of audio.
    const v = quant(clamp(fromDisplay(def, shown), min, max));
    commit(keyframes.map((x, j) => (j === i ? { ...x, v } : x)));
  };

  const setTime = (i: number, raw: number) => {
    if (readOnly) return;
    if (!Number.isFinite(raw)) return;
    // Between the neighbours, exactly as a drag is — the sampler's cursor walks a SORTED array, and a
    // key typed past its neighbour would put the curve out of order rather than reorder it.
    const base = keyframes;
    const lo = i > 0 ? base[i - 1].t + 0.001 : 0;
    const hi = i < base.length - 1 ? base[i + 1].t - 0.001 : Number.MAX_SAFE_INTEGER;
    commit(base.map((x, j) => (j === i ? { ...x, t: Math.max(0, clamp(raw, lo, hi)) } : x)));
  };

  // Open on the key's CURRENT values, as strings — the inputs are drafts (see the state), and seeding
  // them from the live keyframe is what makes the editor a starting point rather than a blank form.
  const openEditor = (i: number) => {
    if (readOnly) return;
    const k = keyframes[i];
    if (!k) return;
    setSel(i);
    setEditV(String(round4(toDisplay(def, k.v))));   // in the unit the field reads — see setValue
    setEditT(k.t.toFixed(3));
    setEditing(i);
  };
  const closeEditor = () => setEditing(null);
  // Both fields land, then the panel closes. `onBlur` commits each field on its own for the ordinary
  // path (tab out, click away); this is the Enter/`done` path, where neither field has necessarily
  // blurred.
  const commitEditor = (i: number) => {
    setValue(i, parseFloat(editV));
    setTime(i, parseFloat(editT));
    closeEditor();
  };

  const fmt = (v: number) => fmtIn(def, v);
  // The axis as the keyframe editor's field speaks it — see setValue for why storage is not that unit.
  const dispMin = toDisplay(def, min);
  const dispMax = toDisplay(def, max);
  const dispUnit = def.display?.unit ?? def.unit;

  return (
    <div ref={bodyRef} className="relative" style={{ width, height: h }}
      onDoubleClick={addAt}
      onPointerDown={(e) => { if (e.button === 0 && e.detail === 1) onSeek(e.clientX); }}>
      <svg width={width} height={h} className="absolute inset-0 pointer-events-none">
        <line x1={0} y1={valueToY(max)} x2={width} y2={valueToY(max)} className="stroke-line-1/40" strokeWidth={1} />
        <line x1={0} y1={valueToY(min)} x2={width} y2={valueToY(min)} className="stroke-line-1/40" strokeWidth={1} />
        <path d={path} fill="none" stroke={color ?? 'currentColor'} className="text-accent" strokeWidth={1.5} />
      </svg>
      {/* keyframes */}
      {kfs.map((k, i) => {
        // Shown while this key is being DRAGGED or is selected (`sel` is set on pointerdown and
        // persists), and on hover. The wrapper's box is 0×0, so it is not a hit target and cannot
        // steal the body's click-to-seek or double-click-to-add; only the diamond and the (inert)
        // label are.
        const active = sel === i;
        const flip = k.t * pxPerSec > width - 70;   // near the right edge — label on the other side
        return (
          <div key={i} className="absolute group" style={{ left: k.t * pxPerSec, top: valueToY(k.v) }}>
            {/* ⚠ THE VALUE, WHERE THE OPERATOR IS LOOKING — AND THE `title` BELOW IS NOT A SUBSTITUTE.
                A native tooltip needs a still hover of about a second, and THE BROWSER SUPPRESSES IT
                OUTRIGHT ONCE A DRAG BEGINS — so the number was guaranteed to be missing at the one
                moment it matters: while you are setting it. You dragged a diamond up and down and
                simply could not see what level you were writing. This is a real element, so it
                survives the drag; it reads `k.v`, which is the DRAFT while dragging, so it tracks the
                thumb. The time comes with it because a drag moves both axes at once. */}
            <span
              className={`absolute top-0 -translate-y-1/2 ${flip ? 'right-2' : 'left-2'} z-10 px-1 rounded border border-line-1 bg-surface-0/95 text-micro leading-tight text-fg-1 tabular-nums whitespace-nowrap pointer-events-none transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
              {fmt(k.v)} <span className="text-fg-3">· {k.t.toFixed(2)}s</span>
            </span>
            <Tooltip id="timeline.automation-keyframe">
              {/* The editor is placed from THIS element's measured rect (usePopoverAnchor), so the
                  ref rides whichever diamond is open — one ref, never a list of them. */}
              <div ref={editing === i ? kfAnchorRef : undefined}
                onPointerDown={dragKf(i)}
                onContextMenu={(e) => { e.preventDefault(); removeKf(i); }}
                onClick={(e) => { if (e.altKey) { e.stopPropagation(); removeKf(i); } }}
                onDoubleClick={(e) => { e.stopPropagation(); openEditor(i); }}
                {...help('timeline.automation-keyframe')}
                title={`${fmt(k.v)} @ ${k.t.toFixed(2)}s · ${k.curve ?? 'linear'}\ndrag to move (shift = value only, alt = time only) · double-click: edit value, time and curve · right-click: delete`}
                className={`absolute left-0 top-0 -ml-[4.5px] -mt-[4.5px] w-[9px] h-[9px] rotate-45 cursor-pointer ${active ? 'bg-fg-1 border border-fg-1' : 'bg-accent border border-accent'}`} />
            </Tooltip>

            {/* ── THE KEYFRAME EDITOR ──────────────────────────────────────────────────────────────
                ⚠ EVERY POINTER EVENT IS STOPPED AT THIS BOX. The row underneath it seeks on
                pointerdown and ADDS A KEYFRAME on double-click — so a click into the value field
                would otherwise scrub the show, and a double-click to select a number would drop a new
                key behind the panel that is editing one. */}
            {editing === i && !readOnly && createPortal(
              <>
                {/* Click-away COMMITS, explicitly — not merely closes. Relying on the inputs' own
                    onBlur would be a coin toss: a pointerdown on a non-focusable backdrop does not
                    reliably blur first, and unmounting the portal can drop the event entirely, so a
                    number typed and then dismissed by clicking the timeline would vanish. Backdrop
                    before the box: they share the tier and DOM order decides, so the box is second. */}
                <div className="fixed inset-0 z-popover" onPointerDown={() => commitEditor(i)} />
                <div ref={kfBoxRef}
                  onPointerDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  // The portal leaves the timeline scroller's subtree, which kills its non-passive
                  // native wheel-zoom listener; this stops React's synthetic wheel travelling the
                  // React tree too, so spinning over the panel cannot zoom the timeline underneath it.
                  onWheel={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    // Enter commits whichever field has focus and closes; Escape abandons BOTH drafts.
                    if (e.key === 'Escape') { e.stopPropagation(); closeEditor(); }
                    if (e.key === 'Enter') { e.stopPropagation(); commitEditor(i); }
                  }}
                  // Hidden until measured — a first paint at 0,0 flashes the panel in the corner.
                  style={{ left: kfPos?.left ?? 0, top: kfPos?.top ?? 0, visibility: kfPos ? 'visible' : 'hidden' }}
                  className="fixed z-popover w-44 p-2 rounded border border-line-2 bg-surface-0 shadow-e3 space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-micro text-fg-3 w-9 shrink-0">value</span>
                    {/* min/max/step/unit ALL IN THE DISPLAY UNIT — the same seam setValue documents. A
                        `min={0} max={1}` under a field reading degrees would have the browser reject
                        every legal bearing. `step` goes free whenever a display map is in play: the
                        stored step (1/65535 for a 16-bit Pan) is not a step in the unit being typed. */}
                    <input autoFocus type="number" value={editV}
                      step={def.display ? 'any' : (def.step || 'any')}
                      min={Math.min(dispMin, dispMax)} max={Math.max(dispMin, dispMax)}
                      onChange={(e) => setEditV(e.target.value)}
                      onBlur={() => setValue(i, parseFloat(editV))}
                      className="flex-1 min-w-0 bg-surface-1 border border-line-1 rounded px-1 py-0.5 text-micro num text-fg-1 outline-none focus:border-accent" />
                    {dispUnit && <span className="text-micro text-fg-3 shrink-0">{dispUnit}</span>}
                  </div>
                  {/* The range is the TARGET's, and it is printed rather than only enforced: a value
                      typed outside it is clamped, and a clamp the operator did not expect reads as the
                      field ignoring them. */}
                  <div className="text-micro text-fg-3/70 leading-none">{fmt(min)} … {fmt(max)}</div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-micro text-fg-3 w-9 shrink-0">time</span>
                    <input type="number" value={editT} step={0.01} min={0}
                      onChange={(e) => setEditT(e.target.value)}
                      onBlur={() => setTime(i, parseFloat(editT))}
                      className="flex-1 min-w-0 bg-surface-1 border border-line-1 rounded px-1 py-0.5 text-micro num text-fg-1 outline-none focus:border-accent" />
                    <span className="text-micro text-fg-3 shrink-0">s</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-micro text-fg-3 w-9 shrink-0">curve</span>
                    <select value={k.curve ?? 'linear'}
                      onChange={(e) => setCurve(i, e.target.value as Keyframe['curve'])}
                      className="flex-1 min-w-0 bg-surface-1 border border-line-1 rounded px-1 py-0.5 text-micro text-fg-1 outline-none focus:border-accent">
                      <option value="linear">linear</option>
                      <option value="hold">hold</option>
                      <option value="bezier">bezier</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <button onClick={() => removeKf(i)} disabled={keyframes.length <= 1}
                      title={keyframes.length <= 1 ? 'A lane always holds at least one keyframe — remove the lane instead' : 'Delete this keyframe'}
                      className="text-micro text-fg-3 hover:text-danger disabled:opacity-40 disabled:cursor-not-allowed">delete</button>
                    <button onClick={() => commitEditor(i)}
                      className="ml-auto px-1.5 py-0.5 rounded bg-accent/15 text-accent text-micro hover:bg-accent/25">done</button>
                  </div>
                </div>
              </>,
              document.body,
            )}
          </div>
        );
      })}
    </div>
  );
};
