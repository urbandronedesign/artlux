import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Circle, Square, Plus, X, Lightbulb, Trash2, GripVertical } from 'lucide-react';
import { trackingStore } from '@artlux/plugin-lidar-tracking';
import * as takeRecorder from '../../services/takeRecorder';
import { Tooltip } from '../../components/ui/Tooltip';
import { help } from '../../services/helpBus';
import { useEditor } from '../../state/EditorStore';
import { isLight } from '../../services/fixtureKind';
import type { ChannelRole, LightingTake, TrackingTakeRef } from '../../types';
import { BlobSparkline } from '../../components/timeline/BlobSparkline';

// THE TWO TAKE PANELS — where a performance is captured, and where the captured performances live.
//
// These used to be one 40px strip under the timeline toolbar (`TakesBin`), which meant recording a
// moving head required pulling up a drawer full of a clock you were not using. Both recorders capture
// INDEPENDENTLY OF THE TRANSPORT — they say so in their own headers — so the drawer was never where
// they belonged.
//
// They are TWO panels and not one because the two recorders are genuinely different instruments, and
// the old strip papered over it. A lighting take is scoped to THE SELECTED FIXTURES and their order is
// the show; a tracking take has no target at all, it swallows the whole live feed. A single panel needs
// an "arm" line that means something for one half and is noise for the other.
//
// Placement stays in the timeline: both libraries are drag sources for the lane drop handler, and the
// dock sits directly above the drawer, so a chip travels a short vertical distance to its lane.

const fmtClock = (s: number): string => {
  const t = Math.max(0, Math.floor(s));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

// ── Shared chrome ────────────────────────────────────────────────────────────────────────────────

const RecordButton: React.FC<{
  recording: boolean; disabled?: boolean; title: string; label: string; helpId: string;
  elapsed: () => number; onClick: () => void;
}> = ({ recording, disabled, title, label, helpId, elapsed, onClick }) => {
  // The clock never enters React — a 200 ms setState here would re-render the panel (and its take
  // list) for the length of the take. Same discipline as the StatusBar chip.
  const clockRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!recording) return;
    const tick = () => { if (clockRef.current) clockRef.current.textContent = fmtClock(elapsed()); };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [recording, elapsed]);
  return (
    <Tooltip id={helpId}>
      <button
        onClick={onClick}
        disabled={disabled}
        title={title}
        {...help(helpId)}
        className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-mini border disabled:opacity-40 disabled:cursor-not-allowed ${
          recording ? 'border-danger text-danger bg-danger/15 animate-pulse' : 'border-line-1 bg-surface-2 text-fg-1 hover:bg-surface-3'
        }`}
      >
        {recording ? <Square size={11} /> : <Circle size={11} className="text-danger fill-danger" />}
        {recording ? 'Stop' : label}
        {recording && <span ref={clockRef} className="num">00:00</span>}
      </button>
    </Tooltip>
  );
};

const CancelButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    onClick={onClick}
    title="Discard this recording — nothing is saved"
    className="inline-flex items-center gap-1 h-7 px-2 rounded text-mini border border-line-1 bg-surface-2 text-fg-3 hover:text-danger"
  >
    <X size={11} /> Cancel
  </button>
);

const LaneButton: React.FC<{ onClick: () => void; label: string; helpId: string }> = ({ onClick, label, helpId }) => (
  <Tooltip id={helpId}>
    <button onClick={onClick} title={`Add the ${label.toLowerCase()} to the timeline — takes are placed on it`}
      {...help(helpId)}
      className="inline-flex items-center gap-1 h-7 px-2 rounded text-mini border border-line-1 bg-surface-2 text-fg-2 hover:text-fg-1 hover:bg-surface-3">
      <Plus size={11} /> {label}
    </button>
  </Tooltip>
);

// A take row. Renaming is inline: takes are auto-named `Move 1` / `Take 1` at capture (you are busking,
// not typing), and until now there was no way to ever call one "Chorus sweep".
const TakeRow: React.FC<{
  id: string; name: string; helpId: string; title: string;
  meta: React.ReactNode; signature?: React.ReactNode;
  onRename: (name: string) => void; onRemove: () => void;
}> = ({ id, name, helpId, title, meta, signature, onRename, onRemove }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const commit = () => { setEditing(false); if (draft.trim() && draft !== name) onRename(draft); else setDraft(name); };
  return (
    <Tooltip id={helpId}>
      <div
        // The lane drop handler reads exactly this MIME. Lighting chips were never draggable before —
        // a lighting take could only be reached through a clip's Source dropdown.
        draggable={!editing}
        onDragStart={(e) => { e.dataTransfer.setData('application/artlux-take', id); e.dataTransfer.effectAllowed = 'copy'; }}
        title={title}
        {...help(helpId)}
        className="group relative flex items-center gap-2 h-8 px-2 rounded border border-line-1 bg-surface-2 hover:border-accent cursor-grab"
      >
        {signature}
        <GripVertical size={11} className="relative text-fg-3 shrink-0" />
        {editing ? (
          <input
            autoFocus value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(name); setEditing(false); } }}
            className="relative flex-1 min-w-0 bg-surface-3 text-fg-1 text-mini px-1 rounded outline-none ring-1 ring-accent"
          />
        ) : (
          <button onDoubleClick={() => { setDraft(name); setEditing(true); }} onClick={() => { setDraft(name); setEditing(true); }}
            title="Rename" className="relative flex-1 min-w-0 text-left text-mini text-fg-1 truncate no-press">
            {name}
          </button>
        )}
        <span className="relative text-micro text-fg-3 shrink-0 whitespace-nowrap">{meta}</span>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={onRemove} title="Delete take"
          className="relative text-fg-3 hover:text-danger opacity-0 group-hover:opacity-100 shrink-0"><Trash2 size={11} /></button>
      </div>
    </Tooltip>
  );
};

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-mini text-fg-3 italic px-1 py-2">{children}</div>
);

// ── Lighting ─────────────────────────────────────────────────────────────────────────────────────

// WHICH ROLES A TAKE ACTUALLY CARRIES. The recorder DROPS every role that never moved past its
// reduction tolerance, and that is not a detail — it is the reason clips layer: a pan-only busk yields
// a pan-only take, which leaves a colour clip underneath it alone. A take that silently pinned a dimmer
// would fight one, so the library says out loud what each take will drive.
const rolesOf = (t: LightingTake): ChannelRole[] => {
  const seen = new Set<ChannelRole>();
  for (const part of t.parts) for (const role of Object.keys(part.channels) as ChannelRole[]) seen.add(role);
  return [...seen];
};

export const LightingTakesDock: React.FC = () => {
  const { timeline, selectedFixtureIds, fixtures } = useEditor();
  const rec = useSyncExternalStore(takeRecorder.subscribe, takeRecorder.getRec);
  const takes = timeline.lightingTakes ?? [];
  const hasLane = timeline.layers.some((l) => l.kind === 'lighting');
  const n = selectedFixtureIds.length;
  // COUNT THE LIGHTS, NOT THE SELECTION. A lighting take is built from the resolved fixture SIGNAL —
  // pan/tilt/dimmer/colour in role space — which only a light fixture has. Select six LED strips and
  // the old count promised "6 fixtures · selection order is the take", you recorded, and got back
  // "nothing moved": a true message about the wrong thing. `isLight` is the one sanctioned answer to
  // "what kind is this" (services/fixtureKind), never an open-coded `f.profileId ?`.
  const lights = selectedFixtureIds.filter((id) => {
    const f = fixtures.find((x) => x.id === id);
    return f ? isLight(f) : false;
  }).length;

  return (
    <div className="p-2 space-y-2 text-xs">
      {/* THE ARM LINE. A lighting take captures exactly these fixtures IN THIS ORDER, and that order is
          what a later phase spread runs along — so it is stated before you press record, not after. */}
      <div className="flex items-baseline gap-1.5">
        <span className="text-micro text-fg-3 uppercase tracking-wider">Arm</span>
        <span className={`text-mini ${lights ? 'text-fg-1' : 'text-fg-3 italic'}`}>
          {lights ? `${lights} light${lights > 1 ? 's' : ''} · selection order is the take`
            : n ? `${n} selected, but no light fixtures — a take records moving heads`
            : 'select the lights to record'}
        </span>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <RecordButton
          recording={rec.lighting}
          // Disabled only when there is nothing to arm AND nothing running — never while recording, or
          // deselecting mid-take would take away the only stop button in this panel.
          disabled={!rec.lighting && lights === 0}
          label="Record move"
          helpId="timeline.lighting-record"
          title={lights === 0 && !rec.lighting
            ? 'Select light fixtures to record — their selection order becomes the take'
            : `Record the movement of ${lights} selected light(s)`}
          elapsed={() => takeRecorder.elapsed('lighting')}
          onClick={takeRecorder.toggleLighting}
        />
        {rec.lighting && <CancelButton onClick={takeRecorder.cancelLighting} />}
        {!hasLane && <LaneButton onClick={takeRecorder.addLightingLane} label="Lighting lane" helpId="timeline.lighting-add-lane" />}
      </div>

      <div className="space-y-1 pt-1">
        {takes.length === 0
          ? <Empty>No takes yet — select some moving heads, busk a look on them and press record.</Empty>
          : takes.map((t) => (
            <TakeRow
              key={t.id} id={t.id} name={t.name} helpId="timeline.lighting-take-chip"
              title={`${t.name} — ${fmtClock(t.duration)}, ${t.parts.length} part(s)\nDrag onto a lighting lane, or pick it in a lighting clip's Source.`}
              meta={<>
                <Lightbulb size={9} className="inline text-accent mr-1" />
                {fmtClock(t.duration)} · {t.parts.length}p · {rolesOf(t).join('·') || '—'}
              </>}
              onRename={(name) => takeRecorder.renameLightingTake(t.id, name)}
              onRemove={() => takeRecorder.removeLightingTake(t.id)}
            />
          ))}
      </div>
    </div>
  );
};

// ── Tracking ─────────────────────────────────────────────────────────────────────────────────────

// The live feed, so you can see the tracker is actually talking before you commit to a take. Subscribes
// to the store's own coalesced notification (one per rAF) but only re-renders when the COUNT changes.
const LiveBlobs: React.FC = () => {
  const [n, setN] = useState(() => trackingStore.getActiveBlobs().length);
  useEffect(() => trackingStore.subscribe(() => setN((prev) => {
    const next = trackingStore.getActiveBlobs().length;
    return next === prev ? prev : next;
  })), []);
  return (
    <span className={`text-mini ${n ? 'text-ok' : 'text-fg-3'}`}>
      {n ? `live: ${n} blob${n > 1 ? 's' : ''}` : 'no live blobs'}
    </span>
  );
};

const TrackingSignature: React.FC<{ t: TrackingTakeRef }> = ({ t }) => (
  // The same density signature the placed CLIP draws, reused rather than reinvented — so a take looks
  // in the library like it will look on the lane.
  <span className="absolute inset-0 rounded overflow-hidden opacity-40 pointer-events-none">
    <BlobSparkline path={t.path} inPoint={0} clipDuration={t.duration || 1} widthPx={280} heightPx={32} />
  </span>
);

export const TrackingTakesDock: React.FC = () => {
  const { timeline } = useEditor();
  const rec = useSyncExternalStore(takeRecorder.subscribe, takeRecorder.getRec);
  const takes = timeline.trackingTakes ?? [];
  const hasLane = timeline.layers.some((l) => l.kind === 'tracking');

  return (
    <div className="p-2 space-y-2 text-xs">
      <div className="flex items-center gap-1.5 flex-wrap">
        <RecordButton
          recording={rec.tracking}
          label="Record"
          helpId="timeline.take-record"
          title="Record the live tracker feed into a take — independent of the transport"
          elapsed={() => takeRecorder.elapsed('tracking')}
          onClick={takeRecorder.toggleTracking}
        />
        {rec.tracking && <CancelButton onClick={takeRecorder.cancelTracking} />}
        <LiveBlobs />
        {!hasLane && <LaneButton onClick={takeRecorder.addTrackingLane} label="Tracking lane" helpId="timeline.take-add-lane" />}
      </div>

      <div className="space-y-1 pt-1">
        {takes.length === 0
          ? <Empty>No takes yet — record the tracker feed, then drag a take onto the tracking lane to replay it.</Empty>
          : takes.map((t) => (
            <TakeRow
              key={t.id} id={t.id} name={t.name} helpId="timeline.take-chip"
              title={`${t.name} — ${fmtClock(t.duration)}\nDrag onto the tracking lane.`}
              signature={<TrackingSignature t={t} />}
              meta={fmtClock(t.duration)}
              onRename={(name) => takeRecorder.renameTrackingTake(t.id, name)}
              onRemove={() => takeRecorder.removeTrackingTake(t.id)}
            />
          ))}
      </div>
    </div>
  );
};
