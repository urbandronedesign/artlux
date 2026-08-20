// A range input that DRAFTS LOCALLY AND COMMITS ONCE — invariant 7, in component form.
//
// React maps `onChange` on a range input to the DOM `input` event: it fires on EVERY POINTERMOVE of the
// thumb. In the mixer one commit is host.audio.setMix(next) → App.setAudioMix → a full App re-render,
// timelineEngine.recompileAutomation() (App.tsx's `useEffect(…, [audioMix])`), the audio host fan-out
// (syncLoaded + syncClips, i.e. an engine lock per clip) and a StateView rebuild. Riding a fader at 60 Hz
// pays that sixty times a second, on the bound document of a running show. So: the thumb moves against a
// LOCAL draft, and the document is written exactly once, on release.
//
// The commit triggers are the same three the timeline's audio-lane gutter uses (AudioLane.tsx) — pointerup,
// keyup (arrow keys), blur. Blur is the backstop: a range input takes focus on pointerdown, so a pointerup
// that lands outside the element (which is the one case pointerup can miss) is always followed by a blur as
// soon as the operator touches anything else.
//
// `readout` renders from the LIVE value — the draft while dragging — so the number under the fader tracks
// the thumb. It is a render of local state, not a document write.
import React, { useRef, useState } from 'react';

export interface FaderProps {
  /** The AUTHORED value (what the document holds). Shown whenever no drag/keypress is in flight. */
  value: number;
  min: number;
  max: number;
  step: number;
  /** Called ONCE per gesture, with the final value. This is the only write. */
  onCommit: (v: number) => void;
  /**
   * AUDITION — every draft value, i.e. on every pointermove. THIS IS NOT A WRITE, AND IT MUST NEVER
   * BECOME ONE. Invariant 7 is about the DOCUMENT (a setMix is an App re-render, an automation recompile
   * and an engine lock per clip); pushing one number straight at the engine so the operator can HEAR the
   * control move costs none of that.
   *
   * It is skipped for a gesture whose document rebound (see docKey) and for a disabled control, on the
   * same reasoning as the commit: a dead gesture must not be audible either.
   */
  onDraft?: (v: number) => void;
  disabled?: boolean;
  /** Built from the live value, so the tooltip tracks the thumb too. */
  title?: (live: number) => string;
  className?: string;
  ariaLabel?: string;
  /** Rendered immediately after the slider, from the live value. */
  readout?: (live: number) => React.ReactNode;
  readoutClassName?: string;
  /**
   * THE DOCUMENT THIS GESTURE BELONGS TO — supply it whenever the commit lands in a REBINDABLE document,
   * and leave it off when it does not.
   *
   * INVARIANT 7 SPLITS A GESTURE IN TWO: a pointerdown that opens a draft, and a pointerup, ONE OR MORE
   * SECONDS LATER, that writes it. In between, a recall can rebind the document under the panel — the FSM,
   * the scheduler, the cueBus (OSC / a tablet GO) and the scene pill all funnel into App.handleRecallScene
   * and none of them checks for an in-flight edit. In an unattended install that rebind is not exotic: it is
   * what the show DOES, on schedule.
   *
   * AND THE COMMIT CANNOT NOTICE ON ITS OWN, BECAUSE CLIP IDS ALIAS ACROSS SCENES. "Capture Scene"
   * structuredClones the bound timeline, ids and all, so the outgoing and incoming scenes hold
   * BYTE-IDENTICAL clip and effect ids. Every id-keyed guard downstream — the panel's "is this clip in the
   * container I am looking at", the host's "is this clip in the bound document" — therefore RESOLVES, and
   * the value the operator dialled on scene A is written into scene B. A value-keyed guard is just as inert
   * (the clone's values match too). Only IDENTITY catches it. This is core's `docKey`, in a fader:
   * Timeline.tsx:117 mints the same string and refuses the same way (`endDrag`: "a recall rebound the panel
   * mid-drag → ABANDON").
   *
   * Omitted ⇒ no guard, which is CORRECT for a control whose target is not rebindable — the BED
   * (ProjectData.audio) is one document, owned by App, and it survives every recall, so abandoning a bed
   * gesture on a recall would throw away an edit that had nowhere else to land.
   *
   * Read LIVE at both ends (never a polled mirror): latched when the gesture opens, re-read at the commit.
   */
  docKey?: () => string;
}

export const Fader: React.FC<FaderProps> = ({
  value, min, max, step, onCommit, onDraft, disabled, title, className, ariaLabel, readout, readoutClassName, docKey,
}) => {
  const [draft, setDraft] = useState<number | null>(null);
  // The draft is MIRRORED IN A REF and `commit` reads the REF, never the closure. A blur dispatched from
  // inside a handler that has just cleared the draft runs SYNCHRONOUSLY, in the same call stack, where the
  // batched setState has not landed yet — the closure would still hold the abandoned value and commit it.
  // (AudioLane's rename field documents the same trap.) A ref is written synchronously and cannot lie.
  const draftRef = useRef<number | null>(null);
  // The document the IN-FLIGHT gesture was made against (see docKey). A ref, for the same reason the draft
  // is one: `commit` runs synchronously inside a blur dispatched from a handler, before any setState lands.
  // It ALSO survives the re-render a recall causes — which is exactly why it has to be checked. React keys
  // this component on the effect's id (EffectChain) or on nothing at all (the clip's gain/height), and
  // Capture Scene aliases those ids too, so a rebind does NOT remount the fader and does NOT clear its draft.
  const gestureDoc = useRef<string | null>(null);
  // ⚠ `disabled` IS NOW DYNAMIC, AND IT CAN FLIP UNDER A LIVE POINTER.
  //
  // It used to be static per instance (a timeline row is read-only for its whole life; master and clip gain
  // had none at all). The mixer now disables a fader the moment an AUTOMATION LANE takes its path — and the
  // FSM, the scheduler and an OSC/tablet GO all recall scenes ON SCHEDULE, mid-drag, with nobody watching.
  // So a gesture that opened on a live fader can find itself on a DEAD one before the operator lets go.
  //
  // MIRRORED DURING RENDER, NOT IN AN EFFECT, AND THE TIMING IS THE WHOLE POINT: the browser blurs a focused
  // input the instant React writes `disabled` to the DOM — during the commit phase, BEFORE any effect runs —
  // and that blur calls commit() below. Only a ref written in the render body is already true by then.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  // …and if no blur arrives to close the gesture (the input was never focused), the draft would sit in state
  // and REAPPEAR ON THE THUMB the moment the lane released it — minutes later, a value nobody typed, which
  // the next blur would then commit. Drop it when the control dies.
  React.useEffect(() => {
    if (!disabled) return;
    draftRef.current = null; gestureDoc.current = null; setDraft(null);
  }, [disabled]);
  const set = (v: number | null) => {
    // A gesture OPENS on its first draft (a plain click fires no `input` event and opens nothing).
    if (v !== null && draftRef.current === null) gestureDoc.current = docKey ? docKey() : null;
    draftRef.current = v; setDraft(v);
    // …and the audition rides along, on exactly the gestures the commit would honour. Read the doc key
    // LIVE here, not the latched one: a rebind mid-drag kills the gesture from that moment on, and a
    // sound that goes on moving after the panel has been rebound is describing a document nobody is
    // looking at any more.
    if (v !== null && onDraft && !disabledRef.current && (!docKey || gestureDoc.current === docKey())) onDraft(v);
  };
  const live = draft ?? value;
  // A COMPLETED GESTURE **IS** A TAKEOVER, WHEREVER IT LANDS. The gate is "a gesture happened" — NOT
  // "the value differs from the document".
  //
  // `value` is the AUTHORED value. What is SOUNDING is `laneOvr ?? fade ?? authored`
  // (automationTargets.ts), and A FADE'S VALUE PERSISTS AFTER THE FADE LANDS, by design. So the fader can
  // sit at 1.00 over a 0.2 room — and `onCommit` is the ONLY door to releaseFade(), which is the only
  // thing that drops BOTH halves of the shadow (the fade-layer entry AND the leg, via dropFadeLeg).
  // Gating on `d !== value` made the ONE natural recovery gesture — grab it and put it back where it says
  // it is — the one gesture that does NOTHING: no commit, no release, the house stays ducked for the rest
  // of the session. (Arrow keys always move by `step`, so they can only land on 0.99/1.01 — they can never
  // put the operator back on the authored value either.) audio.master.gain and audio.clip.*.gain have no
  // second door; the mixer is their sole writer.
  //
  // Cost: one redundant, idempotent write per NO-OP gesture. INVARIANT 7 IS UNTOUCHED — the draft is still
  // local and this still fires exactly ONCE per gesture, never per pointermove. A plain click on the thumb
  // fires no `input` event at all, so `d` stays null and nothing is committed.
  //
  // ...UNLESS THE DOCUMENT REBOUND UNDER IT, in which case the gesture is DEAD and writes NOTHING — not
  // even the release (see docKey). Losing an edit the operator must redo is the cheap failure; writing it
  // into the scene that is on the projectors now is the expensive one.
  const commit = () => {
    const d = draftRef.current;
    const doc = gestureDoc.current;
    set(null);
    gestureDoc.current = null;
    if (d === null) return;
    // A LANE TOOK THE PATH MID-GESTURE → the control is DEAD → ABANDON, exactly as a rebind does below.
    // The house rule (see docKey): losing an edit the operator must redo is the cheap failure. Committing
    // would write their half-finished drag into the document as the authored value — a number they never
    // released the thumb on, silently persisted, and revealed only when the lane is switched off later.
    if (disabledRef.current) return;
    if (docKey && doc !== docKey()) return;   // a recall rebound the panel mid-gesture → ABANDON
    onCommit(d);
  };
  return (
    <>
      <input
        type="range" min={min} max={max} step={step}
        value={disabled ? value : live}
        disabled={disabled}
        aria-label={ariaLabel}
        title={title?.(live)}
        onChange={(e) => set(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className={`accent-accent disabled:opacity-40 disabled:cursor-not-allowed ${className ?? ''}`}
      />
      {readout && <span className={readoutClassName}>{readout(disabled ? value : live)}</span>}
    </>
  );
};
