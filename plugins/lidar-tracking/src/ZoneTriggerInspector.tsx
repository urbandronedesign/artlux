import React from 'react';
import { Plus, X } from 'lucide-react';
import * as zones from './zones';
import * as people from './people';
import { zoneLevel, termLevel, zonesUsedBy, type ZoneEdge, type ZoneTriggerParams, type ZoneTerm } from './zoneTriggers';

// The params editor the host mounts inside the state-graph editor's transition inspector when a
// transition's trigger is `lidar.zone`. The host renders no LiDAR-specific UI at all — it knows only
// that a registered trigger source may supply an Inspector — so everything an operator needs to
// configure a zone rule lives here, next to the rule.
//
// TWO MODES, because they answer different questions:
//   ONE ZONE      — "what should this zone do?"    (enter / leave / dwell / crowd)
//   COMBINATION   — "which parts of the room, each doing what?"
//
// ⚠ A TERM IS A STATE OF THE ROOM, NOT AN EVENT, and the UI says so out loud. Every term CAN now carry
// its own rule — "Zone 1 occupied for 5s AND Zone 2 empty" — but no term is an event of its own:
// "someone enters A" and "someone enters B" would need two arrivals on the same frame, which never
// happens in a real room. The arm-and-hold is on the whole SENTENCE, not on its words. A conjunction is
// therefore order-agnostic too; order belongs in the state graph. See zoneTriggers.ts.
//
// Styled with the host's own token classes (bg-surface-0 / border-line-1 / text-fg-*) so it is
// indistinguishable from the core fields above it: a plugin's inspector that looked bolted on would
// teach operators that some triggers are second-class.

// ONE TABLE, TWO VOICES. The rule is the row; the mode is the column. In ONE-ZONE mode a rule may be
// read as an EVENT ("someone enters") because arm-and-hold edge-detects that one level and nothing
// else. In a COMBINATION the same computation must be read as a STATE, because the arming is on the
// whole sentence — labelling a term "someone enters" would promise a per-term event the mechanism
// deliberately does not provide. Two tables would let the five values drift out of lockstep with
// ZoneEdge; `arg` also makes "which extra field does this rule need" a property of the rule rather
// than three hardcoded conditionals per mode.
const EDGES: { v: ZoneEdge; l: string; term: string; arg?: 'seconds' | 'n'; hint: string }[] = [
  { v: 'enter', l: 'someone enters', term: 'is occupied', hint: 'Fires when a person arrives — and only for an arrival AFTER this state began, so a visitor already standing in the zone does not re-fire it.' },
  { v: 'exit', l: 'everyone leaves', term: 'is empty', hint: 'Fires when the last person leaves (after the zone’s exit dwell).' },
  { v: 'occupiedFor', l: 'occupied for…', term: 'occupied for…', arg: 'seconds', hint: 'Fires once somebody has stayed this long — a dwell, for "they are actually looking at it".' },
  { v: 'emptyFor', l: 'empty for…', term: 'empty for…', arg: 'seconds', hint: 'Fires once the zone has been empty this long — the usual way back to an attract loop.' },
  { v: 'countAtLeast', l: 'at least N people', term: 'has N+ people', arg: 'n', hint: 'A crowd rule: fires when the headcount reaches N. Like every rule here it is armed once — it will not re-fire while the crowd stands there.' },
];
const edgeOf = (r: { edge?: ZoneEdge }) => EDGES.find((e) => e.v === (r.edge ?? 'enter')) ?? EDGES[0];

const WELL = 'bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent outline-none';
const FIELD = `w-full mt-0.5 ${WELL}`;

// NOT is not the opposite rule, and nothing said so before. Worth a per-rule title because the two
// cases genuinely differ: for enter/exit it IS the other rule, for the other three it is not.
const notTitle = (t: ZoneTerm): string => {
  const e = t.edge ?? 'enter';
  if (e === 'enter' || e === 'exit') return t.not ? 'NOT — same as picking the opposite rule here' : 'NOT — invert this term';
  if (t.not) return `NOT (${edgeOf(t).term}) is true when the zone is empty OR the condition has not lasted long enough — that is NOT the same as the opposite rule`;
  return 'NOT — invert this term. Careful: ¬(occupied for 5s) is not "empty for 5s"';
};

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

// A headcount rule says "people" and compares a count that is only in people while merging is on. On a
// LiDAR reporting ~2 blobs per person that makes the threshold mean half what was typed — the defect
// that had an operator entering 4 to mean two visitors. Warn where the number is entered.
const MergeOffWarning: React.FC = () => people.isMerging() ? null : (
  <span className="block mt-0.5 text-warn text-micro">
    Merge people is off, so this counts raw blobs. Turn it on in the 3D scene's tracking parameters,
    or this asks for half the visitors you typed.
  </span>
);

export const ZoneTriggerInspector: React.FC<{ params: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void }> = ({ params, onChange }) => {
  const p = params as ZoneTriggerParams;
  const list = zones.getZones();
  const patch = (next: Partial<ZoneTriggerParams>) => onChange({ ...p, ...next } as Record<string, unknown>);
  const combo = !!p.terms?.length;
  const terms = p.terms ?? [];
  const setTerms = (t: ZoneTerm[]) => patch({ terms: t });
  const patchTerm = (i: number, r: Partial<ZoneTerm>) => setTerms(terms.map((x, j) => (j === i ? { ...x, ...r } : x)));

  // ⚠ THE DOTS ANSWER "IS THIS TERM TRUE RIGHT NOW", AND THEY USED TO LIE. This component had no
  // subscription at all: it read zone state during render, and its parent re-renders on selection and
  // on state-machine events — never per frame. So in the ordinary case (select the transition, then
  // walk the room) the dot never updated again, while the docs claimed live occupancy.
  //
  // TWO CLOCKS, because one is not enough. zones.subscribe fires when somebody arrives or leaves; the
  // interval covers the DWELL rules, which come true on time alone with nothing to announce them.
  // 4 Hz is imperceptible for a debug light, on a component mounted only while a transition is selected.
  const [, bump] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    const un = zones.subscribe(bump);
    const iv = window.setInterval(bump, 250);
    return () => { un(); window.clearInterval(iv); };
  }, []);
  // The same clock zones.evaluate() stamps its dwells with, so a dot and a rule cannot disagree.
  const nowSec = performance.now() / 1000;

  // Three values, because "unanswerable" is not "false" — a zone this look does not listen to makes the
  // WHOLE rule inert, and a dot that showed it as merely-false would contradict the warning below.
  const Dot: React.FC<{ v: boolean | undefined; title: string }> = ({ v, title }) => (
    <span title={v === undefined ? `${title} — unanswerable here` : v ? `${title} — true now` : `${title} — false`}
      className={`w-2 h-2 rounded-full shrink-0 ${v === undefined ? 'border border-warn' : v ? 'bg-warn' : 'bg-line-1'}`} />
  );

  return (
    <div className="space-y-2">
      {/* Mode. Switching CARRIES THE RULE both ways, so changing mode no longer changes what fires —
          which is what this comment promised before and stopped delivering the moment a rule was more
          than a zone id. Back to One zone only folds a single term (there is nowhere to put the rest);
          `not` is deliberately not folded into the edge, which would be clever and surprising. */}
      <div className="flex gap-1">
        <button onClick={() => patch(terms.length === 1
          ? { terms: undefined, zoneId: terms[0].zone, edge: terms[0].edge, seconds: terms[0].seconds, n: terms[0].n }
          : { terms: undefined })}
          className={`flex-1 px-2 py-1 rounded border text-mini ${!combo ? 'bg-accent text-black border-accent' : 'bg-surface-2 border-line-1 text-fg-2'}`}>One zone</button>
        <button onClick={() => patch({ match: p.match ?? 'all', terms: terms.length ? terms : [{ zone: p.zoneId ?? list[0]?.id ?? '', edge: p.edge, seconds: p.seconds, n: p.n }] })}
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
          {/* Which extra field this rule needs is a property of the RULE (EDGES[].arg), not three
              hardcoded conditionals — the combination rows ask the same question of the same table. */}
          {edgeOf(p).arg === 'seconds' && (
            <label className="block">
              <span className="text-fg-3 text-micro">Seconds</span>
              <input type="number" min={0} step={0.5} value={p.seconds ?? 0}
                onChange={(e) => patch({ seconds: Number(e.target.value) || 0 })} className={FIELD} />
            </label>
          )}
          {edgeOf(p).arg === 'n' && (
            <label className="block">
              <span className="text-fg-3 text-micro">People</span>
              <input type="number" min={1} step={1} value={p.n ?? 1}
                onChange={(e) => patch({ n: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} className={FIELD} />
              <MergeOffWarning />
            </label>
          )}
          <div className="flex items-center gap-1.5 text-fg-3 italic text-micro">
            <Dot v={p.zoneId ? zoneLevel(p.zoneId, p, nowSec) : undefined} title="this rule" />
            <span>{edgeOf(p).hint}</span>
          </div>
          <InactiveWarning ids={zonesUsedBy(p)} />
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
          {/* A TERM IS A CARD, NOT A ROW. Six controls do not fit one line in the parameter column, and
              N flat rows merge into a wall. Line 1 answers WHICH ZONE (and whether its term is true
              right now); line 2 answers WHAT IT MUST BE DOING. NOT sits beside the rule, not beside the
              zone, because it negates the rule — next to the name it reads as "not this zone". */}
          <div className="space-y-1">
            {terms.map((t, i) => {
              const e = edgeOf(t);
              return (
                <div key={i} className="rounded border border-line-1 bg-surface-1 p-1 space-y-1">
                  <div className="flex items-center gap-1">
                    <Dot v={termLevel(t, nowSec)} title={zones.getZones().find((z) => z.id === t.zone)?.name ?? 'term'} />
                    <select value={t.zone} onChange={(ev) => patchTerm(i, { zone: ev.target.value })}
                      className={`flex-1 min-w-0 text-mini ${WELL}`}>
                      <option value="">— zone —</option>
                      {list.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                    </select>
                    <button onClick={() => setTerms(terms.filter((_, j) => j !== i))}
                      title="Remove this term" className="text-fg-3 shrink-0 px-1"><X size={12} /></button>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => patchTerm(i, { not: !t.not })} title={notTitle(t)}
                      className={`px-1.5 py-1 rounded border text-micro shrink-0 ${t.not ? 'bg-warn/20 border-warn text-warn' : 'bg-surface-2 border-line-1 text-fg-3'}`}>NOT</button>
                    <select value={t.edge ?? 'enter'} onChange={(ev) => patchTerm(i, { edge: ev.target.value as ZoneEdge })}
                      className={`flex-1 min-w-0 text-mini ${WELL}`}>
                      {EDGES.map((x) => <option key={x.v} value={x.v}>{x.term}</option>)}
                    </select>
                    {/* Unlabelled by design: the select immediately left of it ends in "for…" / "N+
                        people", so the unit is read off the sentence. title/aria-label carry it. */}
                    {e.arg === 'seconds' && (
                      <input type="number" min={0} step={0.5} value={t.seconds ?? 0} title="seconds" aria-label="seconds"
                        onChange={(ev) => patchTerm(i, { seconds: Number(ev.target.value) || 0 })}
                        className={`w-14 shrink-0 text-mini ${WELL}`} />
                    )}
                    {e.arg === 'n' && (
                      <input type="number" min={1} step={1} value={t.n ?? 1} title="people" aria-label="people"
                        onChange={(ev) => patchTerm(i, { n: Math.max(1, Math.floor(Number(ev.target.value) || 1)) })}
                        className={`w-14 shrink-0 text-mini ${WELL}`} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <button onClick={() => setTerms([...terms, { zone: list[0]?.id ?? '' }])}
            className="w-full inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-fg-1 text-mini">
            <Plus size={12} /> Zone
          </button>
          {terms.some((t) => t.edge === 'countAtLeast') && <MergeOffWarning />}
          <div className="text-fg-3 italic text-micro">
            Each term is a <span className="text-fg-2">state of the room</span>. The combination fires
            once, the moment the whole sentence becomes true, and not again until it has been false — a
            term is never an event of its own, because two arrivals could not coincide on one frame.
            It also does not care about order: whichever term completes the sentence fires it. For a
            real sequence, put a state between the two.
          </div>
          <InactiveWarning ids={zonesUsedBy(p)} />
        </>
      )}
    </div>
  );
};
