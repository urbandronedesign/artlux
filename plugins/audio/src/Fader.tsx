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
  disabled?: boolean;
  /** Built from the live value, so the tooltip tracks the thumb too. */
  title?: (live: number) => string;
  className?: string;
  ariaLabel?: string;
  /** Rendered immediately after the slider, from the live value. */
  readout?: (live: number) => React.ReactNode;
  readoutClassName?: string;
}

export const Fader: React.FC<FaderProps> = ({
  value, min, max, step, onCommit, disabled, title, className, ariaLabel, readout, readoutClassName,
}) => {
  const [draft, setDraft] = useState<number | null>(null);
  // The draft is MIRRORED IN A REF and `commit` reads the REF, never the closure. A blur dispatched from
  // inside a handler that has just cleared the draft runs SYNCHRONOUSLY, in the same call stack, where the
  // batched setState has not landed yet — the closure would still hold the abandoned value and commit it.
  // (AudioLane's rename field documents the same trap.) A ref is written synchronously and cannot lie.
  const draftRef = useRef<number | null>(null);
  const set = (v: number | null) => { draftRef.current = v; setDraft(v); };
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
  const commit = () => {
    const d = draftRef.current;
    set(null);
    if (d !== null) onCommit(d);
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
