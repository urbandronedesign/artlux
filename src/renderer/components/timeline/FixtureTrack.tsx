// THE FIXTURE SUPER TRACK — every parameter of one light, on one track, over the timeline's own axis.
//
// The problem it solves: a moving head has a dozen named parameters and the timeline could only ever
// show them as a FLAT LIST of unrelated lanes, each added one at a time from a global search popover
// that knows nothing about which fixture you are working on. Twelve lanes for one head, sorted by
// nothing, next to twelve more for the next head. Authoring a head meant knowing every parameter's
// name before you could reach it.
//
// So: one track per fixture, its parameters grouped the way an operator reads a fixture (Intensity,
// Position, Colour, Beam, Gobo — see CHANNEL_ATTRIBUTE, which lives against the role union so the two
// cannot drift), and EVERY parameter of the patched mode present whether or not it has a curve yet.
// That last part is the point: a parameter you cannot see is a parameter you do not know you have.
//
// ⚠ THE ROW SET IS profilePack.modeChannels, NOT A LOCAL DERIVATION. The inspector's channel strip
// answers the same question — "what parameters does this fixture have?" — and the two must agree
// channel-for-channel, or one of them is lying. Guarded.
//
// A row that HAS a curve renders the ordinary <AutomationLane>, unchanged: same gutter, same live
// readout, same editor. This component adds a header and an empty-row affordance around them and
// takes no part in drawing a curve.
import React, { useMemo, useState } from 'react';
import type { AutomationLane as Lane, Fixture, FixtureProfile, ProfileMode, ProfileChannel } from '../../types';
import { attributeOf, ATTRIBUTE_ORDER, type ChannelAttribute } from '../../types';
import { type AutomationTargetDef } from '@artlux/sdk/renderer';
import { modeChannels, channelValue, physicalValue, selectedRange } from '../../services/profilePack';
import { AutomationLane } from './AutomationLane';
import { GUTTER } from './geometry';
import { ChevronDown, ChevronRight, Plus, Lightbulb, Filter } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';

const HEADER_H = 30;
const EMPTY_ROW_H = 22;

export interface FixtureTrackLane {
  lane: Lane;
  origin: 'scene' | 'global';
  shadowed: boolean;
}

interface Props {
  fixture: Fixture;
  profile: FixtureProfile;
  mode: ProfileMode;
  /** Every lane already driving a channel of THIS fixture, scene and global alike. */
  lanes: FixtureTrackLane[];
  defs: ReadonlyMap<string, AutomationTargetDef>;
  pxPerSec: number;
  width: number;
  docKey: string;
  /** True when this track is on screen because the fixture is selected, not because it has curves. */
  selected: boolean;
  onChangeLane: (laneId: string, next: Lane) => void;
  onRemoveLane: (laneId: string) => void;
  /** Create a lane for this path, seeded with one key at the playhead holding the current value. */
  onAddLane: (path: string, seed: number) => void;
  onSnap: (t: number) => number;
  onSeek: (clientX: number) => void;
}

/** What a row shows when it has no curve yet: the value the fixture is parked at, in its own unit. */
function parkedAt(f: Fixture, channel: ProfileChannel): string {
  const v = channelValue(f, channel);
  const slot = selectedRange(channel, v);
  if (slot) return slot.label;                       // a wheel reads "Eclipse", never "0.42"
  const p = physicalValue(channel, v);
  return p !== null ? `${Math.round(p)}${channel.unit === 'deg' ? '°' : ''}` : `${Math.round(v * 100)}%`;
}

export const FixtureTrack: React.FC<Props> = ({
  fixture, profile, mode, lanes, defs, pxPerSec, width, docKey, selected,
  onChangeLane, onRemoveLane, onAddLane, onSnap, onSeek,
}) => {
  const [open, setOpen] = useState(true);
  // ONLY THE ROWS THAT CARRY KEYS. A patched mode can run to forty-one channels; once a look is
  // authored, four of them are the show and the rest are noise. This is the working view, and the
  // reason the default is still "all" is that a parameter you cannot see is one you do not know you
  // have — you go looking in `all`, and you work in `keyed`.
  const [keyedOnly, setKeyedOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<ChannelAttribute>>(() => new Set());

  const laneByPath = useMemo(() => {
    const m = new Map<string, FixtureTrackLane>();
    // A SCENE lane wins the row when both exist: the global one is shadowed and would draw over it.
    for (const l of lanes) if (l.origin === 'global' && !m.has(l.lane.targetPath)) m.set(l.lane.targetPath, l);
    for (const l of lanes) if (l.origin === 'scene') m.set(l.lane.targetPath, l);
    return m;
  }, [lanes]);

  // Every parameter the PATCHED MODE emits, in DMX order, 16-bit pairs collapsed to one row.
  const rows = useMemo(() => modeChannels(profile, mode).map(({ channel, offset }) => {
    const path = `fixtures.${fixture.id}.dmx.${channel.key}`;
    const hit = laneByPath.get(path);
    return {
      channel, offset, path, hit,
      keys: hit ? hit.lane.keyframes.length : 0,
      attribute: attributeOf(channel.role),
    };
  }), [profile, mode, fixture.id, laneByPath]);

  const shown = keyedOnly ? rows.filter((r) => r.keys > 0) : rows;
  const keyed = rows.filter((r) => r.keys > 0).length;

  const byAttribute = useMemo(() => {
    const m = new Map<ChannelAttribute, typeof shown>();
    for (const r of shown) {
      const list = m.get(r.attribute) ?? [];
      list.push(r);
      m.set(r.attribute, list);
    }
    // Reading order, coarse to fine — never Map insertion order, which is DMX order and puts a
    // fixture's shutter above its dimmer for no reason an operator would recognise.
    return ATTRIBUTE_ORDER.filter((a) => m.has(a)).map((a) => [a, m.get(a)!] as const);
  }, [shown]);

  return (
    <div className="border-b border-line-2">
      {/* ── header ─────────────────────────────────────────────────────────────────────────── */}
      <div className="flex bg-surface-2/60">
        <div className="sticky left-0 z-20 shrink-0 bg-surface-2 border-r border-line-1 flex items-center gap-1 px-2"
          style={{ width: GUTTER, height: HEADER_H }}>
          <button onClick={() => setOpen(!open)} className="text-fg-3 hover:text-fg-1 shrink-0"
            title={open ? 'Collapse this fixture' : 'Expand this fixture'}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <Lightbulb size={11} className={`shrink-0 ${selected ? 'text-accent' : 'text-fg-3'}`} />
          <span className="text-micro text-fg-1 truncate" title={`${profile.manufacturer} ${profile.model} — ${mode.name}`}>
            {fixture.name}
          </span>
          <Tooltip id="timeline.fixture-track-keyed">
            <button onClick={() => setKeyedOnly(!keyedOnly)}
              title={keyedOnly
                ? `Showing only the ${keyed} parameter(s) with keyframes. Click to show all ${rows.length}.`
                : `Showing all ${rows.length} parameters of this mode. Click to show only the ${keyed} with keyframes.`}
              className={`ml-auto shrink-0 inline-flex items-center gap-0.5 px-1 rounded text-micro ${keyedOnly ? 'bg-accent/15 text-accent' : 'text-fg-3 hover:text-fg-1'}`}>
              <Filter size={10} />{keyedOnly ? keyed : rows.length}
            </button>
          </Tooltip>
        </div>
        <div className="relative flex items-center px-2 text-micro text-fg-3" style={{ width, height: HEADER_H }}>
          {profile.manufacturer} {profile.model} · {mode.name} · ch {fixture.startAddress}–{fixture.startAddress + mode.footprint - 1}
          {keyed > 0 && <span className="ml-2 text-fg-2">{keyed} keyed</span>}
          {/* A super track rides the TIMELINE, not a clip: it does not slide, wrap, repeat or trim.
              Say so here rather than only in the docs — those are group verbs and an operator coming
              from a lighting clip will expect them. */}
          <span className="ml-auto opacity-60">@ timeline</span>
        </div>
      </div>

      {/* ── rows, grouped the way a fixture is read ─────────────────────────────────────────── */}
      {open && byAttribute.map(([attribute, list]) => {
        const shut = collapsed.has(attribute);
        return (
          <div key={attribute}>
            <div className="flex bg-surface-1/60">
              <button
                onClick={() => setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(attribute)) next.delete(attribute); else next.add(attribute);
                  return next;
                })}
                className="sticky left-0 z-20 shrink-0 bg-surface-1 border-r border-line-1 flex items-center gap-1 px-2 text-micro text-fg-3 hover:text-fg-1"
                style={{ width: GUTTER, height: 18 }}>
                {shut ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                <span className="tracking-wide">{attribute.toUpperCase()}</span>
                <span className="ml-auto opacity-70">{list.length}</span>
              </button>
              <div style={{ width, height: 18 }} />
            </div>
            {!shut && list.map((r) => (r.hit ? (
              <AutomationLane
                key={r.path}
                lane={r.hit.lane}
                def={defs.get(r.path)}
                pxPerSec={pxPerSec}
                width={width}
                origin={r.hit.origin}
                shadowed={r.hit.shadowed}
                clock={r.hit.origin === 'global' ? 'show' : 'playhead'}
                docKey={docKey}
                onSnap={onSnap}
                onSeek={onSeek}
                // A global lane is read-only from a scene, exactly as in the flat list: it lives on
                // the Global pill, and passing no handler is what makes it inert structurally.
                onChange={r.hit.origin === 'global' ? undefined : (next) => onChangeLane(r.hit!.lane.id, next)}
                onRemove={r.hit.origin === 'global' ? undefined : () => onRemoveLane(r.hit!.lane.id)}
              />
            ) : (
              // ── A PARAMETER WITH NO CURVE YET ───────────────────────────────────────────────
              // Present, named, addressed, and showing what the fixture is parked at — because the
              // whole promise of this track is that every parameter is visible. The `+` seeds a lane
              // with ONE key at the playhead holding that same value, so creating it changes nothing
              // about what the rig is doing.
              <div key={r.path} className="flex border-b border-line-1/50 group/row">
                <div className="sticky left-0 z-20 shrink-0 bg-surface-1/40 border-r border-line-1 flex items-center gap-1 px-2"
                  style={{ width: GUTTER, height: EMPTY_ROW_H }}>
                  <span className="text-micro text-fg-3 truncate" title={`${r.channel.label} — DMX ${fixture.startAddress + r.offset}`}>
                    {r.channel.label}
                  </span>
                  <span className="ml-auto shrink-0 text-micro text-fg-3/70 tabular-nums">{parkedAt(fixture, r.channel)}</span>
                  <button
                    onClick={() => onAddLane(r.path, channelValue(fixture, r.channel))}
                    title={`Start a curve on ${r.channel.label} at the playhead, holding its current value`}
                    className="shrink-0 text-fg-3 opacity-0 group-hover/row:opacity-100 hover:text-accent">
                    <Plus size={11} />
                  </button>
                </div>
                <div className="relative" style={{ width, height: EMPTY_ROW_H }}>
                  <div className="absolute left-0 right-0 top-1/2 border-t border-dashed border-line-1/40" />
                </div>
              </div>
            )))}
          </div>
        );
      })}

      {open && !shown.length && (
        <div className="flex">
          <div className="sticky left-0 z-20 shrink-0 bg-surface-1/40 border-r border-line-1" style={{ width: GUTTER, height: EMPTY_ROW_H }} />
          <div className="text-micro text-fg-3/70 italic px-2 flex items-center" style={{ width, height: EMPTY_ROW_H }}>
            No parameter of this fixture carries a keyframe yet — clear the filter to see all {rows.length}.
          </div>
        </div>
      )}
    </div>
  );
};
