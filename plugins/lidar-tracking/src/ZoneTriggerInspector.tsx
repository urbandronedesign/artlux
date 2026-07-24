import React from 'react';
import { Plus, X } from 'lucide-react';
import * as zones from './zones';
import type { ZoneEdge, ZoneTriggerParams, ZoneTerm } from './zoneTriggers';

// The params editor the host mounts inside the state-graph editor's transition inspector when a
// transition's trigger is `lidar.zone`. The host renders no LiDAR-specific UI at all — it knows only
// that a registered trigger source may supply an Inspector — so everything an operator needs to
// configure a zone rule lives here, next to the rule.
//
// TWO MODES, because they answer different questions:
//   ONE ZONE      — "what should this zone do?"    (enter / leave / dwell / crowd)
//   COMBINATION   — "which parts of the room?"     (ALL/ANY of N zones, each optionally negated)
//
// ⚠ THE COMBINATION MODE IS ABOUT OCCUPANCY, NOT EVENTS, and the UI says so out loud. "Someone enters A"
// AND "someone enters B" would require both to happen on the SAME FRAME — never, in a real room. What an
// author means is "both zones have somebody in them", which is what this evaluates. See zoneTriggers.ts.
//
// Styled with the host's own token classes (bg-surface-0 / border-line-1 / text-fg-*) so it is
// indistinguishable from the core fields above it: a plugin's inspector that looked bolted on would
// teach operators that some triggers are second-class.

const EDGES: { v: ZoneEdge; l: string; hint: string }[] = [
  { v: 'enter', l: 'someone enters', hint: 'Fires when a person arrives — and only for an arrival AFTER this state began, so a visitor already standing in the zone does not re-fire it.' },
  { v: 'exit', l: 'everyone leaves', hint: 'Fires when the last person leaves (after the zone’s exit dwell).' },
  { v: 'occupiedFor', l: 'occupied for…', hint: 'Fires once somebody has stayed this long — a dwell, for "they are actually looking at it".' },
  { v: 'emptyFor', l: 'empty for…', hint: 'Fires once the zone has been empty this long — the usual way back to an attract loop.' },
  { v: 'countAtLeast', l: 'at least N people', hint: 'A crowd rule: fires when the headcount reaches N. Like every rule here it is armed once — it will not re-fire while the crowd stands there.' },
];

const FIELD = 'w-full mt-0.5 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none';

// A zone that this look does not listen to (Scene3D.activeZoneIds) can never satisfy a rule, and the
// rule is inert as a WHOLE — one unanswerable term poisons a combination. That is silent at runtime by
// design (an unknown condition must never fire), so it has to be loud here instead.
const InactiveWarning: React.FC<{ ids: string[] }> = ({ ids }) => {
  const dead = ids.filter((id) => id && !zones.isZoneActive(id));
  if (!dead.length) return null;
  const names = dead.map((id) => zones.getZones().find((z) => z.id === id)?.name ?? id);
  return (
    <div className="text-warn text-micro">
      Not active in the current scene: {names.join(', ')} — this rule cannot fire there.
      Turn the zone on for that scene in <span className="text-fg-2">Tracking ▸ Trigger Zones</span>.
    </div>
  );
};

export const ZoneTriggerInspector: React.FC<{ params: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void }> = ({ params, onChange }) => {
  const p = params as ZoneTriggerParams;
  const list = zones.getZones();
  const patch = (next: Partial<ZoneTriggerParams>) => onChange({ ...p, ...next } as Record<string, unknown>);
  const combo = !!p.terms?.length;
  const terms = p.terms ?? [];
  const setTerms = (t: ZoneTerm[]) => patch({ terms: t });

  return (
    <div className="space-y-2">
      {/* Mode. Switching to a combination SEEDS it from the single zone, so the rule you already had is
          the first term rather than something you have to retype. Switching back drops `terms`. */}
      <div className="flex gap-1">
        <button onClick={() => patch({ terms: undefined })}
          className={`flex-1 px-2 py-1 rounded border text-mini ${!combo ? 'bg-accent text-black border-accent' : 'bg-surface-2 border-line-1 text-fg-2'}`}>One zone</button>
        <button onClick={() => patch({ match: p.match ?? 'all', terms: terms.length ? terms : [{ zone: p.zoneId ?? list[0]?.id ?? '' }] })}
          className={`flex-1 px-2 py-1 rounded border text-mini ${combo ? 'bg-accent text-black border-accent' : 'bg-surface-2 border-line-1 text-fg-2'}`}>Combination</button>
      </div>

      {!list.length && <div className="text-warn text-micro">No zones yet — draw one in Tracking ▸ Trigger Zones.</div>}

      {!combo ? (
        <>
          <label className="block">
            <span className="text-fg-3 text-micro">Zone</span>
            <select value={p.zoneId ?? ''} onChange={(e) => patch({ zoneId: e.target.value })} className={FIELD}>
              <option value="">— pick a zone —</option>
              {list.map((z) => <option key={z.id} value={z.id}>{z.name} ({z.surface})</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-fg-3 text-micro">When</span>
            <select value={p.edge ?? 'enter'} onChange={(e) => patch({ edge: e.target.value as ZoneEdge })} className={FIELD}>
              {EDGES.map((e) => <option key={e.v} value={e.v}>{e.l}</option>)}
            </select>
          </label>
          {(p.edge === 'occupiedFor' || p.edge === 'emptyFor') && (
            <label className="block">
              <span className="text-fg-3 text-micro">Seconds</span>
              <input type="number" min={0} step={0.5} value={p.seconds ?? 0}
                onChange={(e) => patch({ seconds: Number(e.target.value) || 0 })} className={FIELD} />
            </label>
          )}
          {p.edge === 'countAtLeast' && (
            <label className="block">
              <span className="text-fg-3 text-micro">People</span>
              <input type="number" min={1} step={1} value={p.n ?? 1}
                onChange={(e) => patch({ n: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} className={FIELD} />
            </label>
          )}
          <div className="text-fg-3 italic text-micro">{EDGES.find((e) => e.v === (p.edge ?? 'enter'))?.hint}</div>
          <InactiveWarning ids={p.zoneId ? [p.zoneId] : []} />
        </>
      ) : (
        <>
          <label className="block">
            <span className="text-fg-3 text-micro">Fires when</span>
            <select value={p.match ?? 'all'} onChange={(e) => patch({ match: e.target.value as 'all' | 'any' })} className={FIELD}>
              <option value="all">ALL of these are true</option>
              <option value="any">ANY of these is true</option>
            </select>
          </label>
          <div className="space-y-1">
            {terms.map((t, i) => {
              const st = zones.getState(t.zone);
              return (
                <div key={i} className="flex items-center gap-1">
                  {/* Live occupancy, so the terms can be watched going true while walking the room. */}
                  <span className={`w-2 h-2 rounded-full shrink-0 ${st?.occupied ? 'bg-warn' : 'bg-line-1'}`}
                    title={st?.occupied ? `occupied (${st.count})` : 'empty'} />
                  <select value={t.zone} onChange={(e) => setTerms(terms.map((x, j) => j === i ? { ...x, zone: e.target.value } : x))}
                    className="flex-1 min-w-0 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none">
                    <option value="">— zone —</option>
                    {list.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                  </select>
                  <button onClick={() => setTerms(terms.map((x, j) => j === i ? { ...x, not: !x.not } : x))}
                    title={t.not ? 'NOT — this zone must be EMPTY' : 'this zone must be OCCUPIED'}
                    className={`px-1.5 py-1 rounded border text-micro shrink-0 ${t.not ? 'bg-warn/20 border-warn text-warn' : 'bg-surface-2 border-line-1 text-fg-3'}`}>NOT</button>
                  <button onClick={() => setTerms(terms.filter((_, j) => j !== i))}
                    className="text-fg-3 hover:text-red-400 shrink-0"><X size={12} /></button>
                </div>
              );
            })}
          </div>
          <button onClick={() => setTerms([...terms, { zone: list[0]?.id ?? '' }])}
            className="w-full inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-mini">
            <Plus size={12} /> Zone
          </button>
          <div className="text-fg-3 italic text-micro">
            A combination is about who is <span className="text-fg-2">standing where</span>, not about two
            things happening at once: it fires the moment the whole condition becomes true, and not again
            until it has been false. (Two arrivals could never coincide on the same frame.)
          </div>
          <InactiveWarning ids={terms.map((t) => t.zone)} />
        </>
      )}
    </div>
  );
};
