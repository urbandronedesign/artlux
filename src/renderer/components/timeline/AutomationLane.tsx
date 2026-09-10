// One automation lane: a keyframe curve over the same time axis as the clips.
//
// THE CURVE ITSELF IS NOT HERE. Drawing, dragging, adding, deleting and the per-key editor live in
// <CurveEditor>, because the timeline's fixture super track draws the same curve for a DMX channel
// and two implementations would disagree about bezier handles or about which unit the typed field
// speaks — invisibly, since both would still look like a curve. What is left in this file is what is
// genuinely a LANE: the gutter, the live readout, the enable/remove verbs, and the policy for a lane
// whose target has vanished.
//
// The polyline is drawn (in the editor) by sampling `sampleLane` — the SAME function the engine
// samples in its frame loop — so the curve you SEE is literally the curve you HEAR. A separate
// drawing routine would be free to disagree with the audio, and eventually would.
//
// Editing follows the clip conventions: drag with a local `draft` and commit ONCE on pointerup, never
// per pointermove (a commit re-enters App → setScenes → timelineEngine.setData → recompile + a full
// bed re-sync; doing that 60×/s while dragging would be brutal). The draft is owned HERE rather than
// in the editor because this gutter's live readout has to sample it too — the number must track the
// thumb while you drag.
import React, { useEffect, useRef, useState } from 'react';
import type { AutomationLane as Lane, Keyframe } from '../../types';
import { type AutomationTargetDef } from '@artlux/sdk/renderer';
import { sampleLane } from '../../services/automation';
import { timeline as engine } from '../../services/timeline';
import { GUTTER } from './geometry';
import { Trash2, Zap, ZapOff, Diamond, AlertTriangle } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { help } from '../../services/helpBus';
import { CurveEditor, fmtIn } from './CurveEditor';

export const AUTO_LANE_H = 64;

interface Props {
  lane: Lane;
  def?: AutomationTargetDef;       // absent ⇒ the target no longer exists (clip deleted, plugin off)
  pxPerSec: number;
  width: number;
  // WHICH CLOCK THIS LANE'S TIME AXIS IS — the NAME of it, not a sample of it. A 'scene' lane rides the
  // playhead; a 'global' (BASE) lane rides the SHOW clock, because that is what the engine samples it on.
  // The caller picks — see Timeline.tsx.
  //
  // ⚠ THIS USED TO BE `playhead: number`, AND THAT NUMBER COST 224 ms/s. Timeline sampled both clocks on a
  // 100 ms setInterval and re-rendered ITSELF to deliver them — toolbar, ruler, every track header, every
  // clip, every lane, ten times a second, for ever, in eight of the nine contexts — to move a few
  // characters of text in this gutter. A clock is not state; it is a thing you read when you need it.
  clock: 'playhead' | 'show';
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

export const AutomationLane: React.FC<Props> = ({ lane, def, pxPerSec, width, clock, origin, shadowed, docKey, onChange, onRemove, onSnap, onSeek }) => {
  const readOnly = !onChange;
  const [draft, setDraft] = useState<Keyframe[] | null>(null);

  // ⚠ THE DOCUMENT CAN REBIND UNDER A LIVE POINTER — AND THIS LANE SURVIVES IT.
  //
  // <TimelinePanel> has no React `key`, so a recall does not remount it; and a cloned scene's automation
  // lane carries the SAME id (Capture Scene deep-clones), so `key={lane.id}` reconciles this very
  // instance onto the incoming document's lane — draft and all. The editor's `up` handler lives on
  // `window` and is removed only inside itself, so unmounting would not have saved us either: it still
  // runs. A keyframe drag must therefore refuse to commit across a rebind, keyed on WHICH DOCUMENT IS
  // BOUND (identity), never on the lane's value — the clone makes the values equal, which is what made
  // the first version of this fix, elsewhere in the tree, completely inert. (The editor enforces it;
  // `docKey` is what it keys on.)
  //
  // Belt to those braces: drop a live drag's draft the moment the document changes, so the curve on
  // screen is the bound document's and not the departed one's.
  useEffect(() => { setDraft(null); }, [docKey]);

  const h = lane.height ?? AUTO_LANE_H;
  const kfs = draft ?? lane.keyframes;
  const enabled = lane.enabled !== false;

  // ── THE LIVE READOUT IS RENDER-FREE, AND THAT IS THE ENTIRE POINT ────────────────────────────────
  //
  // The gutter prints the value this lane is applying right now. It is the ONLY thing the old `playhead`
  // number was for, and delivering it through React cost the whole panel ten renders a second (see the
  // prop's note). So the lane reads its own clock and writes its own text straight to the DOM — exactly
  // how Timeline has always drawn the 60 Hz playhead and timecode (its `engine.subscribe`). Invariant 3:
  // a clock never enters React state. It is also why the DRAFT is owned here and not in <CurveEditor>:
  // this readout has to see the keys being dragged.
  //
  // ⚠ THESE HOOKS SIT **ABOVE** THE `!def` BAIL. `def` is not a constant: Timeline resolves it from the
  // LIVE target registry and re-enumerates at 1 Hz (its `defsTick`) precisely to notice that "a lane
  // whose target was just deleted" stopped being bound. So `def` goes defined → undefined UNDER A
  // MOUNTED LANE in the ordinary course of use — delete the bed clip, surface or effect an existing lane
  // automates — and a render that calls FEWER hooks than the last one throws `Rendered fewer hooks than
  // expected`, in render, from deleting a clip. Hoisting keeps the hook count constant across both
  // branches. (Extracting the editor helped here rather than hurting: every hook the curve needs now
  // belongs to a component that either mounts or does not, so it cannot straddle this bail at all.)
  const liveRef = useRef<HTMLDivElement>(null);
  // Refs, not closure captures: the subscription is made once and must see TODAY's keyframes (the DRAFT
  // while a key is being dragged), today's axis, and today's clock.
  const kfsRef = useRef(kfs); kfsRef.current = kfs;
  const defRef = useRef(def); defRef.current = def;
  const clockRef = useRef(clock); clockRef.current = clock;
  // The value being applied RIGHT NOW, on THIS lane's own clock. Reading the clock here rather than being
  // handed a sample of it is also strictly more correct: the prop was up to 100 ms stale, and the "add a
  // keyframe here" button wrote that stale pair as the new key's t AND v.
  const liveNow = () => {
    const d = defRef.current;
    const t = clockRef.current === 'show' ? engine.getShowTime() : engine.getPlayhead();
    return kfsRef.current.length ? sampleLane(kfsRef.current, t, { i: -1 }, d?.log ?? false) : (d?.def ?? 0);
  };
  // FORMAT IN THE OPERATOR'S UNIT, NOT THE STORED ONE. A profiled channel STORES 0..1 — that is what
  // reaches `Fixture.dmx` and what the clamp works on — but is AUTHORED in degrees, so a Pan lane now
  // reads `270 deg` where a pose key for the same channel already read 270°. They were `0.50` and
  // `270°`: two units for one thing. `toDisplay` is the identity for every target that declares no
  // map, so nothing but a profiled channel changes.
  const fmtNow = (v: number) => {
    const d = defRef.current;
    if (!d) return String(Number(v.toFixed(2)));
    return fmtIn(d, v);
  };
  const liveNowRef = useRef(liveNow); liveNowRef.current = liveNow;
  const fmtNowRef = useRef(fmtNow); fmtNowRef.current = fmtNow;
  // Subscribed once. The engine ticks every frame even when paused, so this needs no timer of its own and
  // there is nothing to start or stop with the transport; the DOM is touched only when the text changes.
  useEffect(() => engine.subscribe(() => {
    const el = liveRef.current;
    if (!el) return;
    const txt = fmtNowRef.current(liveNowRef.current());
    if (el.textContent !== txt) el.textContent = txt;
  }), []);

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
  // itself: without these guards, adding a keyframe on a global lane would call `undefined(...)` and take
  // the whole timeline panel down with it. "No handler ⇒ structurally inert" is only true under strictNullChecks.
  const commit = (next: Keyframe[]) => {
    if (!onChange) return;
    onChange({ ...lane, keyframes: next.slice().sort((a, b) => a.t - b.t) });
  };
  const quant = (v: number) => {
    const s = def.step ?? 0;
    return s > 0 ? Math.round(v / s) * s : v;
  };

  // The value at MOUNT/RE-RENDER time — the readout's first paint, before the subscription's next tick
  // takes the element over. Everything live goes through `liveNow()`.
  const live = liveNow();
  const fmt = (v: number) => fmtIn(def, v);

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
                {/* Both the time AND the value are read at CLICK time, off this lane's own clock. They used
                    to come from a prop sampled on a 100 ms interval, so the key landed up to 100 ms — three
                    frames — behind where the operator clicked, holding the value from back there too. */}
                <button onClick={() => { const t = clock === 'show' ? engine.getShowTime() : engine.getPlayhead(); commit([...lane.keyframes.filter(k => Math.abs(k.t - t) > 0.001), { t: Math.max(0, t), v: quant(liveNow()), curve: 'linear' }]); }}
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
        {/* The readout is sampled on whichever clock the caller NAMED — the SHOW clock for a global lane,
            the playhead for a scene lane — so it prints the number the engine is actually applying, not a
            number computed against the wrong axis. React writes it once, per render; after that the
            subscription above owns this element's text and updates it without a render. */}
        <div ref={liveRef} className="text-micro leading-none text-fg-2 tabular-nums">{fmt(live)}</div>
      </div>

      {/* body — the curve, shared with every other surface that draws one */}
      <div style={{ opacity: enabled ? 1 : 0.4 }}>
        <CurveEditor
          keyframes={lane.keyframes}
          draft={draft}
          def={def}
          width={width}
          height={h}
          pxPerSec={pxPerSec}
          color={lane.color}
          readOnly={readOnly}
          docKey={docKey}
          onDraft={setDraft}
          onCommit={commit}
          onSnap={onSnap}
          onSeek={onSeek}
        />
      </div>
    </div>
  );
};
