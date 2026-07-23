import React, { useEffect, useState } from 'react';
import { Play, Pause, Square, Workflow, Clapperboard } from 'lucide-react';
import type { PanelProps } from '@artlux/sdk/renderer';
import { getHost } from './showControlHost';

// The tablet's Control + States tabs, on the desktop — the operator deck for the Show context.
//
// Scenes and the state graph each have their own authoring workbench (`scenes`, `machine`); this is
// deliberately NOT those. It is the running-a-show surface: big scene pads, transport, and the live
// state with its manual transitions — the things you touch while the audience is in the room, in the
// one context you sit in while that is true.
//
// Everything routes through host.show, the same service the tablet's commands land on, so desktop and
// tablet stay in agreement by construction.

interface Scene { id: string; name: string; accent?: string }
interface SmState { id: string; name: string }
interface SmTransition { id: string; from: string; to: string; manual?: boolean }
interface Fsm { enabled?: boolean; states?: SmState[]; transitions?: SmTransition[] }

export const ShowControlDeck: React.FC<PanelProps> = () => {
  const host = getHost();
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [fsm, setFsm] = useState<Fsm>({});
  const [, force] = useState(0);

  useEffect(() => {
    const pull = () => {
      setScenes(((host?.show.getScenes() as Scene[]) ?? []).slice());
      setFsm((host?.show.getStateMachine() as Fsm) ?? {});
    };
    pull();
    return host?.show.subscribe(pull);
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [host]);

  // Status is a poll, not a subscription: it carries the playhead, so it changes every frame and a
  // subscription would re-render this panel at frame rate for a readout the eye samples ~4x a second.
  useEffect(() => { const t = setInterval(() => force((n) => n + 1), 250); return () => clearInterval(t); }, []);

  const status = host?.show.getStatus() as {
    playing?: boolean; activeSceneId?: string | null; currentStateId?: string | null; stateElapsedSec?: number;
  } | undefined;

  const activeState = (fsm.states ?? []).find((s) => s.id === status?.currentStateId) ?? null;
  const outgoing = (fsm.transitions ?? []).filter((t) => t.from === status?.currentStateId);
  const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  const btn = 'inline-flex items-center justify-center gap-1 h-8 px-3 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 text-mini';

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3 text-xs">
      {/* transport */}
      <div className="flex items-center gap-1.5">
        <button className={btn} onClick={() => host?.show.transport({ kind: 'play' })} title="Play"><Play size={13} /> Play</button>
        <button className={btn} onClick={() => host?.show.transport({ kind: 'pause' })} title="Pause"><Pause size={13} /> Pause</button>
        <button className={btn} onClick={() => host?.show.transport({ kind: 'stop' })} title="Stop"><Square size={12} /> Stop</button>
        <span className={`ml-auto text-micro px-2 py-1 rounded ${status?.playing ? 'bg-ok/20 text-ok' : 'bg-surface-2 text-fg-3'}`}>
          {status?.playing ? 'PLAYING' : 'STOPPED'}
        </span>
      </div>

      {/* scene pads */}
      <div>
        <div className="flex items-center gap-1.5 text-fg-2 mb-1.5">
          <Clapperboard size={12} className="text-accent" />
          <span className="text-micro font-semibold uppercase tracking-wider">Scenes</span>
        </div>
        {scenes.length === 0
          ? <div className="text-fg-3 italic text-mini">No scenes captured yet.</div>
          : <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
              {scenes.map((s) => {
                const live = s.id === status?.activeSceneId;
                return (
                  <button
                    key={s.id}
                    onClick={() => host?.show.recallScene(s.id)}
                    title={`Recall ${s.name}`}
                    className={`h-11 px-2 rounded border text-left truncate transition-colors ${
                      live ? 'border-accent bg-accent/15 text-fg-1' : 'border-line-1 bg-surface-2 text-fg-2 hover:bg-surface-3'}`}
                    style={s.accent && !live ? { borderLeftColor: s.accent, borderLeftWidth: 3 } : undefined}
                  >
                    <span className="text-mini">{s.name}</span>
                    {live && <span className="block text-micro text-accent">on air</span>}
                  </button>
                );
              })}
            </div>}
      </div>

      {/* state machine */}
      <div>
        <div className="flex items-center gap-1.5 text-fg-2 mb-1.5">
          <Workflow size={12} className="text-accent" />
          <span className="text-micro font-semibold uppercase tracking-wider">Show machine</span>
          <button
            onClick={() => host?.show.setFsmEnabled(!fsm.enabled)}
            className={`ml-auto px-1.5 h-5 rounded text-micro border ${fsm.enabled ? 'bg-ok/20 text-ok border-ok/40' : 'bg-surface-2 text-fg-3 border-line-1'}`}
          >{fsm.enabled ? 'Running' : 'Off'}</button>
        </div>
        {!activeState
          ? <div className="text-fg-3 italic text-mini">{fsm.states?.length ? 'Not in a state.' : 'No states defined.'}</div>
          : <div className="space-y-1.5">
              <div className="px-2 py-1.5 rounded border border-accent bg-accent/10 flex items-center gap-2">
                <span className="text-fg-1 flex-1 truncate">{activeState.name}</span>
                <span className="num text-micro text-fg-3">{mmss(status?.stateElapsedSec ?? 0)}</span>
              </div>
              {outgoing.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {outgoing.map((t) => {
                    const to = (fsm.states ?? []).find((s) => s.id === t.to);
                    return (
                      <button key={t.id} onClick={() => host?.show.triggerTransition(t.id)}
                        title={`Fire this transition now${t.manual ? '' : ' (also fires automatically)'}`}
                        className="px-2 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 text-micro">
                        → {to?.name ?? t.to}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>}
      </div>
    </div>
  );
};
