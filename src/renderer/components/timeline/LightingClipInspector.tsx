import React from 'react';
import { X } from 'lucide-react';
import type {
  ChannelRole, Fixture, FixtureGroup, FixtureProfile, LightingClip, LightingForm, LightingPhaseMode, LightingTake, VideoClip,
} from '../../types';
import { groupKind, profileOf } from '../../services/fixtureKind';
import { ROLES_GENERATABLE } from '../../services/lightingTake';

// The inspector for a LIGHTING clip — where a movement becomes a look.
//
// Four questions, in the order an operator actually asks them:
//   1. WHAT moves        — a generated form, or a recorded take
//   2. WHO moves         — which ordered fixture group
//   3. HOW it spreads    — phase, mode, mirror
//   4. HOW MUCH          — amplitude and bias
//
// The spread controls are the reason this feature exists. Without them a clip drives forty heads in
// unison, which is one look; with them the same clip is a chase, a wave, a fan or a symmetric
// split — which is most of what a light show is made of.

const FORMS: LightingForm[] = ['sine', 'triangle', 'ramp', 'square', 'random'];
const MODES: LightingPhaseMode[] = ['spread', 'wing', 'block', 'random'];

// Sensible centre/amplitude per role, so switching what a clip drives does not leave a pan-shaped
// value (270°) sitting on a 0..1 dimmer.
const ROLE_DEFAULTS: Partial<Record<ChannelRole, { centre: number; amplitude: number }>> = {
  pan: { centre: 270, amplitude: 60 },
  tilt: { centre: 130, amplitude: 40 },
  zoom: { centre: 20, amplitude: 10 },
};
const defaultsFor = (role: ChannelRole) => ROLE_DEFAULTS[role] ?? { centre: 0.5, amplitude: 0.5 };

const isAngle = (role: ChannelRole) => role === 'pan' || role === 'tilt' || role === 'zoom';

interface Props {
  clip: VideoClip;
  groups: FixtureGroup[];
  /** The rig, so a group's KIND can be derived — a lighting clip drives lights only. */
  fixtures: Fixture[];
  /** Resolved profiles, to turn a role into the channel key a lane would name. */
  fixtureProfiles?: ReadonlyMap<string, FixtureProfile>;
  /** targetPaths of the ENABLED automation lanes — a lane outranks this clip, so it is worth saying. */
  lanePaths?: ReadonlySet<string>;
  takes: LightingTake[];
  onChange: (patch: Partial<LightingClip>) => void;
  onClose: () => void;
}

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center justify-between gap-2 text-mini">
    <span className="text-fg-2 shrink-0">{label}</span>
    {children}
  </div>
);

const sel = 'flex-1 min-w-0 bg-surface-0 border border-line-1 rounded-sm px-1 py-0.5 text-fg-1 focus:border-accent focus:outline-none';
const num = 'w-16 bg-surface-0 border border-line-1 rounded-sm px-1 py-0.5 text-right text-fg-1 num focus:border-accent focus:outline-none';

export const LightingClipInspector: React.FC<Props> = ({ clip, groups, fixtures, fixtureProfiles, lanePaths, takes, onChange, onClose }) => {
  const l = clip.lighting ?? {};
  const usingTake = !!l.takeId;
  const role = l.effect?.role ?? 'pan';
  const group = groups.find((g) => g.id === l.groupId);
  const kind = group ? groupKind(group, fixtures) : null;

  // ── WHICH ROLES IS A LANE ALREADY WINNING? ─────────────────────────────────────────────────
  // A lighting clip ranks BELOW an automation lane (profile default < authored dmx < clip < pose cue
  // < lane < live override), so a lane drawn on `fixtures.<id>.dmx.pan` silently beats this clip's
  // pan for that fixture. Nothing said so, and the symptom is the worst kind: the clip is configured
  // correctly, the rig does something else, and the reason is on a different lane in a different
  // panel. Said here, where the clip is authored.
  const shadowed = React.useMemo(() => {
    if (!group || !lanePaths?.size) return [];
    const roles = new Set<ChannelRole>();
    for (const id of group.fixtureIds) {
      const f = fixtures.find((x) => x.id === id);
      const profile = f ? profileOf(f, fixtureProfiles) : undefined;
      if (!profile) continue;
      for (const ch of profile.channels) {
        if (ch.role && lanePaths.has(`fixtures.${id}.dmx.${ch.key}`)) roles.add(ch.role);
      }
    }
    return [...roles];
  }, [group, fixtures, fixtureProfiles, lanePaths]);
  const groupWarning =
    kind === 'mixed' ? 'This group mixes LED and light fixtures — only the lights will be driven.'
    : kind === 'pixel' ? 'This group holds no light fixtures — a lighting clip drives nothing here.'
    : kind === 'empty' ? 'This group is empty.'
    : null;

  return (
    <div className="absolute top-2 right-2 z-30 w-64 bg-surface-1/95 backdrop-blur-sm border border-line-1 rounded-md p-2.5 shadow-e2 space-y-2"
      onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between">
        <span className="text-micro font-bold uppercase tracking-wider text-fg-3 truncate">{clip.name}</span>
        <button onClick={onClose} className="text-fg-3 hover:text-fg-1" title="Close"><X size={12} /></button>
      </div>

      {/* 1. WHAT MOVES */}
      <Row label="Source">
        <select
          className={sel}
          value={usingTake ? `take:${l.takeId}` : 'effect'}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'effect') {
              const d = defaultsFor(role);
              onChange({ takeId: undefined, effect: { form: 'sine', role, centre: d.centre, amplitude: d.amplitude, periodSec: 4 } });
            } else {
              onChange({ takeId: v.slice('take:'.length), effect: undefined });
            }
          }}
        >
          <option value="effect">Generated</option>
          {takes.map((t) => <option key={t.id} value={`take:${t.id}`}>{t.name}</option>)}
        </select>
      </Row>

      {!usingTake && l.effect && (
        <>
          <Row label="Form">
            <select className={sel} value={l.effect.form}
              onChange={(e) => onChange({ effect: { ...l.effect!, form: e.target.value as LightingForm } })}>
              {FORMS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </Row>
          <Row label="Drives">
            <select className={sel} value={role}
              onChange={(e) => {
                const r = e.target.value as ChannelRole;
                const d = defaultsFor(r);
                // Re-seed centre/amplitude with the new role's units — 270 means "straight ahead"
                // for pan and "far past full" for a dimmer.
                onChange({ effect: { ...l.effect!, role: r, centre: d.centre, amplitude: d.amplitude } });
              }}>
              {ROLES_GENERATABLE.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Row>
          <Row label={isAngle(role) ? 'Centre °' : 'Centre'}>
            <input type="number" className={num} step={isAngle(role) ? 5 : 0.05} value={l.effect.centre}
              onChange={(e) => onChange({ effect: { ...l.effect!, centre: parseFloat(e.target.value) || 0 } })} />
          </Row>
          <Row label={isAngle(role) ? 'Swing °' : 'Swing'}>
            <input type="number" className={num} step={isAngle(role) ? 5 : 0.05} value={l.effect.amplitude}
              onChange={(e) => onChange({ effect: { ...l.effect!, amplitude: parseFloat(e.target.value) || 0 } })} />
          </Row>
          <Row label="Period s">
            <input type="number" className={num} step={0.25} min={0.05} value={l.effect.periodSec}
              onChange={(e) => onChange({ effect: { ...l.effect!, periodSec: Math.max(0.05, parseFloat(e.target.value) || 1) } })} />
          </Row>
        </>
      )}

      {/* 2. WHO MOVES */}
      <div className="pt-1 border-t border-line-1" />
      <Row label="Group">
        <select className={sel} value={l.groupId ?? ''} onChange={(e) => onChange({ groupId: e.target.value || undefined })}>
          <option value="">— none —</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.fixtureIds.length})</option>)}
        </select>
      </Row>
      {!l.groupId && (
        // Not a warning about a bad value — a statement about why nothing is happening. A clip with
        // no group is silent, and that is by far the most likely reason someone stares at a rig that
        // will not move.
        <div className="text-micro text-warn">Pick a group — a clip with no group drives nothing.</div>
      )}
      {/* A lighting clip is authored in ROLE space (pan in degrees, dimmer 0..1), and a role value
          has nowhere to land on LED tape — so a mixed group is driven only in part, silently. Said
          here rather than refused: the fix is the operator's (split the group, or accept it). */}
      {groupWarning && <div className="text-micro text-warn">{groupWarning}</div>}
      {shadowed.length > 0 && (
        <div className="text-micro text-warn">
          Overridden by an automation lane: {shadowed.join(", ")} — a lane always wins, so this clip's
          {shadowed.length === 1 ? " value" : " values"} for {shadowed.length === 1 ? "it" : "them"} will not reach the rig.
        </div>
      )}
      {group && group.fixtureIds.length < 2 && (
        <div className="text-micro text-fg-3">One fixture: phase and mirror have nothing to spread across.</div>
      )}

      {/* 3. HOW IT SPREADS */}
      <Row label="Phase s">
        <input type="number" className={num} step={0.05} min={0} value={l.phase ?? 0}
          onChange={(e) => onChange({ phase: Math.max(0, parseFloat(e.target.value) || 0) })} />
      </Row>
      <Row label="Spread">
        <select className={sel} value={l.phaseMode ?? 'spread'}
          onChange={(e) => onChange({ phaseMode: e.target.value as LightingPhaseMode })}>
          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Row>
      {(l.phaseMode === 'wing') && (
        <Row label="Wings">
          <input type="number" className={num} step={1} min={1} value={l.wings ?? 2}
            onChange={(e) => onChange({ wings: Math.max(1, Math.round(parseFloat(e.target.value) || 2)) })} />
        </Row>
      )}
      {(l.phaseMode === 'block') && (
        <Row label="Blocks">
          <input type="number" className={num} step={1} min={1} value={l.blocks ?? 2}
            onChange={(e) => onChange({ blocks: Math.max(1, Math.round(parseFloat(e.target.value) || 2)) })} />
        </Row>
      )}
      <label className="flex items-center justify-between gap-2 text-mini cursor-pointer select-none">
        <span className="text-fg-2">Mirror pan</span>
        <input type="checkbox" checked={!!l.mirror} onChange={(e) => onChange({ mirror: e.target.checked })}
          className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
      </label>

      {/* 4. HOW MUCH */}
      <Row label="Scale">
        <input type="number" className={num} step={0.1} value={l.scale ?? 1}
          onChange={(e) => onChange({ scale: parseFloat(e.target.value) || 0 })} />
      </Row>
      <Row label="Offset">
        <input type="number" className={num} step={isAngle(role) ? 5 : 0.05} value={l.offset ?? 0}
          onChange={(e) => onChange({ offset: parseFloat(e.target.value) || 0 })} />
      </Row>
    </div>
  );
};
