import React, { useEffect, useRef, useState } from 'react';
import { timeline as engine } from '../../services/timeline';
import { useEditor } from '../../state/EditorStore';

// Timing monitor — the clocks an operator watches while firing cues.
//
// There are TWO clocks and conflating them is the classic mistake this panel exists to prevent (see
// docs/AUDIO.md): the SHOW clock runs continuously and does not restart on a scene recall, while the
// bound timeline's PLAYHEAD is per-document and does. A cue that looks early is almost always the
// operator reading the wrong one.
//
// Everything here is written IMPERATIVELY on a rAF, into refs — no per-frame React state. The renderer
// already repaints per frame during playback; a setState per tick here would re-render the panel (and
// anything above it) at frame rate for a readout the eye samples a few times a second. Only the state
// NAME goes through React, because it changes rarely. Same discipline as the StatusBar's show chip.

const mmss = (s: number) => {
  const v = Math.max(0, s);
  const m = Math.floor(v / 60), sec = Math.floor(v % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

const Row: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({ label, children, hint }) => (
  <div className="flex items-baseline justify-between gap-2" title={hint}>
    <span className="text-micro text-fg-3 uppercase tracking-wider">{label}</span>
    <span className="num text-fg-1">{children}</span>
  </div>
);

export const TimingPanel: React.FC = () => {
  const { scenes, stateMachine, activeSceneId } = useEditor();
  const [stateId, setStateId] = useState<string | null>(null);

  const showRef = useRef<HTMLSpanElement>(null);
  const headRef = useRef<HTMLSpanElement>(null);
  const stateRef = useRef<HTMLSpanElement>(null);

  useEffect(() => engine.subscribeSmState(setStateId), []);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (showRef.current) showRef.current.textContent = mmss(engine.getShowTime());
      if (headRef.current) headRef.current.textContent = mmss(engine.getPlayhead());
      if (stateRef.current) stateRef.current.textContent = mmss(engine.getSmElapsedSec());
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const state = stateMachine.states.find((s) => s.id === stateId) ?? null;
  const scene = scenes.find((s) => s.id === activeSceneId) ?? null;

  return (
    <div className="p-3 space-y-2.5 text-xs">
      <Row label="Show clock" hint="Runs continuously — a scene recall does NOT restart it">
        <span ref={showRef}>00:00</span>
      </Row>
      <Row label="Playhead" hint="The BOUND timeline's own position — restarts on a scene recall">
        <span ref={headRef}>00:00</span>
      </Row>

      <div className="border-t border-line-1 pt-2 space-y-2.5">
        <Row label="On air">
          <span className="text-mini" style={scene?.accent ? { color: scene.accent } : undefined}>
            {scene ? scene.name : '—'}
          </span>
        </Row>
        <Row label="State" hint={state?.lockSec ? `locked for ${state.lockSec}s after entry` : undefined}>
          <span className="text-mini">{stateMachine.enabled ? (state?.name ?? '—') : 'off'}</span>
        </Row>
        <Row label="In state">
          <span ref={stateRef}>00:00</span>
        </Row>
      </div>
    </div>
  );
};

// The transport state, on the section header — the one thing you want visible with Timing collapsed.
export const TimingHeaderActions: React.FC = () => {
  const { isVideoPlaying } = useEditor();
  return (
    <span className={`text-micro px-1.5 rounded ${isVideoPlaying ? 'bg-ok/20 text-ok' : 'bg-surface-2 text-fg-3'}`}>
      {isVideoPlaying ? 'PLAYING' : 'STOPPED'}
    </span>
  );
};
