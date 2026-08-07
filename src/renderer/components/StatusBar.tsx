import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { telemetry } from '../services/telemetry';
import { PanelLeft, PanelRight, Activity, Wifi, Workflow, Hourglass, Circle } from 'lucide-react';
import * as takeRecorder from '../services/takeRecorder';
import { helpBus, help as helpTip, type HelpText, type HelpLang } from '../services/helpBus';
import { Tooltip } from './ui/Tooltip';
import { timeline as engine } from '../services/timeline';
import * as bootGate from '../services/bootGate';
import { StateMachine } from '../types';

// The Edit / Perform / Calib preset switcher that used to live here was REMOVED: workspace contexts
// replaced it. A preset only toggled panel VISIBILITY; a context also decides what is IN the panels,
// and it is switched from the ContextRail down the left edge. See components/shell/ContextRail.tsx.

interface Props {
  help: string;
  lang: HelpLang;
  connected: boolean;
  // renderFps + outputStats are deliberately NOT props: they tick once a second, and taking them from
  // App made every App render (and therefore every panel, viewport and the 3D scene) rebuild twice a
  // second at idle. They are read from services/telemetry below, so only this bar re-renders for them.
  // The two column toggles are FALLBACK-SHELL ONLY, and they are rendered only when a handler is
  // passed. Under the dockable workspace (the default) `showLeft`/`showRight` are read by nothing:
  // a browser or inspector column exists because the dock tree has one, and each dock group carries
  // its own collapse chevron. The buttons kept flipping the flags, recolouring themselves and moving
  // nothing — a control that answers is worse than no control. App passes them only with docking off.
  leftOpen?: boolean;
  onToggleLeft?: () => void;
  rightOpen?: boolean;
  onToggleRight?: () => void;
  targetIp: string;
  stateMachine: StateMachine; // project-level show machine — current state + elapsed readout
}

// Always-visible readout of the running show machine: active state name + elapsed time. The machine
// runs on a standalone clock (it can be live with the timeline stopped), so this lives in the main
// chrome, not just the timeline lane. Elapsed is written imperatively via rAF to avoid a per-frame
// React re-render of App; only the state NAME goes through React (changes rarely).
const ShowStateChip: React.FC<{ sm: StateMachine }> = ({ sm }) => {
  const [currentId, setCurrentId] = useState<string | null>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  useEffect(() => engine.subscribeSmState(setCurrentId), []);
  const state = sm.states.find(s => s.id === currentId) ?? null;
  const visible = sm.enabled && !!state;
  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    const tick = () => {
      const el = elapsedRef.current;
      if (el) {
        const s = Math.max(0, Math.floor(engine.getSmElapsedSec()));
        el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible]);
  if (!visible || !state) return null;
  const lock = state.lockSec ? ` · lock ${state.lockSec}s` : '';
  return (
    <>
      <Tooltip id="general.show-state">
        <div className="flex items-center gap-1.5" title={`State machine — in "${state.name}"${lock}`} {...helpTip('general.show-state')}>
          <Workflow size={12} className="text-accent" />
          {/* Polite live region: the state NAME changes rarely, so AT announces show transitions.
              (Elapsed ticks every frame and is deliberately NOT announced.) */}
          <span className="text-fg-2 truncate max-w-[140px]" role="status" aria-live="polite">{state.name}</span>
          <span ref={elapsedRef} className="num text-fg-3" aria-hidden="true">00:00</span>
        </div>
      </Tooltip>
      <div className="h-3 w-px bg-line-2" />
    </>
  );
};

// THE COLD START, VISIBLE. Between opening a project and the show machine being armed, the app is
// deliberately doing nothing — it is waiting for the opening look to decode (services/bootGate). Without
// a readout that reads as "the app ignored my project", so the operator opens it again. Only rendered
// while the gate is actually holding; it costs one subscription and re-renders ~10×/s for a second or
// two, then never again.
const BootChip: React.FC = () => {
  const [p, setP] = useState(bootGate.get());
  useEffect(() => bootGate.subscribe(setP), []);
  if (!p.booting) return null;
  const what = p.pending.length ? p.pending.slice(0, 6).join('\n') : 'starting…';
  return (
    <>
      <Tooltip id="general.preloading">
        <div className="flex items-center gap-1.5" title={`Preloading show content — the state machine starts when it is decoded:\n${what}`} {...helpTip('general.preloading')}>
          <Hourglass size={12} className="text-warn" />
          <span className="text-fg-2">Preloading</span>
          <span className="num text-fg-3">{p.ready}/{p.total}</span>
          {/* WHAT it is doing, not just how far along. A fraction that sits at 12/47 for four seconds
              reads as a hang; "decoding" reads as work. One word, so the chip stays a chip. */}
          <span className="text-fg-3">· {p.phase}</span>
        </div>
      </Tooltip>
      <div className="h-3 w-px bg-line-2" />
    </>
  );
};

// RECORDING, VISIBLE EVERYWHERE — and stoppable from here.
//
// The status bar is rendered outside the workspace shell, so this is one of only two surfaces in the
// app that appear in EVERY context, Calibration and Preferences included. That matters because those
// two declare no bottom drawer: before the recorders left the timeline there was no way to reach one
// from either, and now that a keyboard shortcut can arm a take from anywhere, a REC light you cannot
// switch off would be a trap. Hence a <button>, not a readout.
//
// Two channels, for the reason telemetry.ts spells out: WHETHER it is armed goes through React (twice
// per take, in this component only); HOW LONG is written into a ref by a 200 ms interval and never
// enters React at all. When nothing is armed the effect returns early, so the idle cost is one Set
// membership and zero timers.
//
// The two clocks are separate on purpose: the recorders are independent singletons with their own
// start times, and both can be armed at once. One merged clock would be a lie.
//
// ⚠ THE DESTINATION IS POLLED, NOT RENDERED. It rides the clock's interval rather than React for a
// reason that is easy to miss: this component only re-renders on start/stop, so a destination read
// during render is frozen at ARM TIME — and the bound document is exactly the thing that moves while
// you are not looking. An FSM advancing a scene mid-take (observed: armed against "Scene 1", the show
// stepped to "Scene 2", the take landed there) would leave the chip naming a document the take is no
// longer going to. Same failure Timeline's `audioOwnerName` documents, in the dangerous direction: the
// operator reads a promise about where their work is going and it is out of date.
const RecChip: React.FC = () => {
  const rec = useSyncExternalStore(takeRecorder.subscribe, takeRecorder.getRec);
  const btnRef = useRef<HTMLButtonElement>(null);
  const destRef = useRef<HTMLSpanElement>(null);
  const lightRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const armed = rec.lighting || rec.tracking;
  useEffect(() => {
    if (!armed) return;
    const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s) % 60).padStart(2, '0')}`;
    const tick = () => {
      // Per KIND, because the two land in different places by design: a tracking take always goes to
      // the project's media library, a lighting take to the document you are authoring. With both
      // armed, name both rather than picking one.
      const parts: string[] = [];
      if (takeRecorder.getRec().lighting) parts.push(takeRecorder.destination('lighting'));
      if (takeRecorder.getRec().tracking) parts.push(takeRecorder.destination('tracking'));
      const dest = parts.join(' + ');
      // textContent, so a changed destination re-announces on the aria-live region without a render.
      if (destRef.current && destRef.current.textContent !== dest) destRef.current.textContent = dest;
      if (btnRef.current) btnRef.current.title = `Recording into ${dest} — click to stop`;
      if (lightRef.current) lightRef.current.textContent = fmt(takeRecorder.elapsed('lighting'));
      if (trackRef.current) trackRef.current.textContent = fmt(takeRecorder.elapsed('tracking'));
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [armed]);
  if (!armed) return null;
  return (
    <>
      <Tooltip id="general.recording">
        <button
          ref={btnRef}
          onClick={() => takeRecorder.stopAll()}
          {...helpTip('general.recording')}
          className="flex items-center gap-1.5 h-5 px-1.5 rounded-sm text-danger bg-danger/15 ring-1 ring-danger/50"
        >
          <Circle size={9} className="fill-danger animate-pulse shrink-0" />
          {/* Polite live region on WHAT is recording and WHERE IT WILL LAND — never on a clock. */}
          <span role="status" aria-live="polite" className="truncate max-w-[220px]">
            {rec.lighting && rec.tracking ? 'REC lighting + tracking' : rec.lighting ? 'REC lighting' : 'REC tracking'}
            {' → '}<span ref={destRef} />
          </span>
          {rec.lighting && <span ref={lightRef} className="num" aria-hidden="true">00:00</span>}
          {rec.tracking && <span ref={trackRef} className="num" aria-hidden="true">00:00</span>}
        </button>
      </Tooltip>
      <div className="h-3 w-px bg-line-2" />
    </>
  );
};

export const StatusBar: React.FC<Props> = ({ help, lang, connected, leftOpen, onToggleLeft, rightOpen, onToggleRight, targetIp, stateMachine }) => {
  const { renderFps, outputStats } = useSyncExternalStore(telemetry.subscribe, telemetry.get);
  const [hint, setHint] = useState<HelpText | null>(null);
  useEffect(() => helpBus.subscribe(setHint), []);

  return (
  <div className="h-7 shrink-0 bg-surface-1 border-t border-line-1 flex items-center justify-between px-3 text-xs text-fg-2 select-none">
    <div className="flex items-center gap-3 min-w-0">
      {onToggleLeft && (
        <Tooltip id="general.toggle-left-panel">
          <button
            onClick={onToggleLeft}
            title="Toggle left panel"
            aria-label="Toggle left panel"
            className={`inline-flex items-center justify-center h-5 w-5 rounded-sm hover:text-fg-1 hover:bg-surface-3 ${leftOpen ? 'text-accent' : 'text-fg-3'}`}
            {...helpTip('general.toggle-left-panel')}
          >
            <PanelLeft size={13} />
          </button>
        </Tooltip>
      )}
      {onToggleRight && (
        <Tooltip id="general.toggle-right-panel">
          <button
            onClick={onToggleRight}
            title="Toggle right panel"
            aria-label="Toggle right panel"
            className={`inline-flex items-center justify-center h-5 w-5 rounded-sm hover:text-fg-1 hover:bg-surface-3 ${rightOpen ? 'text-accent' : 'text-fg-3'}`}
            {...helpTip('general.toggle-right-panel')}
          >
            <PanelRight size={13} />
          </button>
        </Tooltip>
      )}
      <span className={`truncate ${hint ? 'text-fg-2' : 'text-fg-3'}`}>{hint ? hint[lang] : help}</span>
    </div>

    <div className="flex items-center gap-4 shrink-0">
      {/* First in the cluster: while a take is running it is the most show-critical thing on this bar. */}
      <RecChip />
      <BootChip />
      <ShowStateChip sm={stateMachine} />
      <Tooltip id="general.render-fps">
        <div className="flex items-center gap-1.5" title="Render FPS" {...helpTip('general.render-fps')}>
          <Activity size={12} className="text-ok" />
          <span className="num">{renderFps.toFixed(0)} FPS</span>
        </div>
      </Tooltip>
      <div className="h-3 w-px bg-line-2" />
      <Tooltip id="general.output-connection">
        {/* Honest state: LIVE means packets are actually flowing (pps > 0), not merely that the socket
            is configured. "READY" = socket up but no frames yet — previously both read as LIVE. */}
        {(() => {
          const flowing = connected && !!outputStats && outputStats.pps > 0;
          const label = !connected ? 'OFFLINE' : flowing ? 'LIVE' : 'READY';
          const color = flowing ? 'text-ok' : connected ? 'text-warn' : 'text-fg-3';
          const tip = !connected ? `Output off — Target: ${targetIp}`
            : flowing ? `Sending — Target: ${targetIp}`
            : `Socket ready, no frames yet — Target: ${targetIp}`;
          return (
            <div className="flex items-center gap-1.5" title={tip} {...helpTip('general.output-connection')}>
              <Wifi size={12} className={color} />
              <span className={color}>{label}</span>
            </div>
          );
        })()}
      </Tooltip>
      {outputStats && (outputStats.pps > 0 || outputStats.universes > 0) && (
        <>
          <div className="h-3 w-px bg-line-2" />
          <Tooltip id="general.engine-stats">
            <span className="num text-fg-3" title="Native engine: frames/s · packets/s · universes" {...helpTip('general.engine-stats')}>
              {outputStats.fps}Hz · {outputStats.pps}pps · {outputStats.universes}u
            </span>
          </Tooltip>
        </>
      )}
    </div>

    {/* Screen-reader status. The visual chips update imperatively / every frame; this is the one place
        the show-critical connection state is announced. Assertive because a mid-show output drop is
        exactly what an operator must not miss. Text is stable across renders, so AT speaks it only when
        it actually flips — the per-frame FPS is intentionally never announced. */}
    <span className="sr-only" role="status" aria-live="assertive">
      {!connected ? 'Art-Net output offline'
        : (outputStats && outputStats.pps > 0) ? 'Art-Net output live, sending frames'
        : 'Art-Net output ready, no frames yet'}
    </span>
  </div>
  );
};
