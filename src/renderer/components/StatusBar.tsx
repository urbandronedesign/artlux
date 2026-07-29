import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { telemetry } from '../services/telemetry';
import { PanelLeft, PanelRight, Activity, Wifi, Workflow, Hourglass } from 'lucide-react';
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
        </div>
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
