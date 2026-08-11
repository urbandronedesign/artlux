import React, { useState } from 'react';
import {
  Surface, SurfaceContent, PixelSource, LedShape, ColorOrder, RGBWMode, Layout3DType, Fixture,
} from '../../types';
import { AlertTriangle } from 'lucide-react';
import { ContentEditor } from '../../components/ContentEditor';
import { FixtureProfilePicker } from '../../components/FixtureProfilePicker';
import { Button, Field, Select, Slider } from '../../components/ui';
import { Tooltip } from '../../components/ui/Tooltip';
import { help } from '../../services/helpBus';
import { fixtureFootprint, resolveMode } from '../../services/addressing';
import { isPixel, profileOf } from '../../services/fixtureKind';
import { channelValue, physicalValue, selectedRange, valueForRange } from '../../services/profilePack';
import { effectivePosObj, effectiveRotObj, effectiveLayout, effectiveScale3 } from '../../services/led3dDefaults';
import { useEditor, useEditorActions } from '../../state/EditorStore';

// Parameter-column panels — the sections `InspectorPanel` used to render as one component.
//
// Beyond the decomposition, this fixes the panel's old gating rule. Every fixture section was
// wrapped in `!selectedSurface && selectedFixture`, so selecting a surface BLANKED the whole fixture
// inspector even though both were selected on the stage. Sections now declare `appliesTo` (see
// contexts/index.tsx) and the shell renders each one whose kind is live — a filter, not an XOR.
//
// The markup is otherwise unchanged. Section chrome + padding come from the shell.

const NumberInput: React.FC<{ label: string; value: number; onChange: (v: number) => void; step?: number }> =
({ label, value, onChange, step = 1 }) => (
  <div className="flex items-center justify-between text-xs gap-2">
    <label className="text-fg-2 cursor-e-resize w-16 truncate">{label}</label>
    <input
      type="number" step={step} value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none font-mono"
    />
  </div>
);

// Resolve the selected objects once. Sections render nothing when their object is gone — the shell's
// `appliesTo` filter already prevents that, so this is belt-and-braces for a mid-render deselect.
function useSelectedSurface(): Surface | null {
  const { surfaces, selectedSurfaceId } = useEditor();
  return surfaces.find((s) => s.id === selectedSurfaceId) ?? null;
}
function useSelectedFixture() {
  const { fixtures, selectedFixtureId } = useEditor();
  return fixtures.find((f) => f.id === selectedFixtureId) ?? null;
}

// ── Fixture ▸ DMX Profile (LIGHT FIXTURES ONLY) ─────────────────────────────────────────────
// WHICH HEAD IS THIS, AND IN WHICH MODE. The profile names the fixture's channels and its footprint
// is its mode's, so this section is the light's identity — not a control an LED strip has.
//
// IT USED TO BE OFFERED ON BOTH KINDS, as the door that CHANGED the kind: selecting an LED fixture
// showed "Choose a DMX profile…", and picking one converted the strip into a moving head in place.
// That door was a trap in both directions. Converting is not a small edit — it pins `ledCount` to 1,
// DROPS the surface link (a light samples nothing), seeds a whole `dmx` block and REPATCHES the rig,
// because a 14-channel head where a 120-channel strip used to be leaves a hole every fixture after
// it slides into. An operator who clicked it to *find out what a DMX profile is* — the reading the
// button invites, sitting at the top of the column of the thing they just selected — silently lost
// their mapping and moved everybody's addresses. The reverse button ("Clear") was the same trap
// mirrored: it turned an aimed head into a one-pixel strip bound to no surface.
//
// So the kind is now decided ONCE, where a fixture is CREATED: Library ▸ Light Fixtures adds a head
// from a profile, Add Fixture / LED Templates add a strip. Neither is destructive, because there is
// nothing yet to destroy. Getting it wrong costs a delete and a re-add instead of a silent repatch.
//
// `appliesTo: ['fixture.light']` — the body guard is only for a MIXED multi-selection, where the
// kind is live but the primary fixture is a pixel (same idiom as the Channels section).
export const FixtureProfilePanel: React.FC = () => {
  const { fixtureProfiles } = useEditor();
  const a = useEditorActions();
  const f = useSelectedFixture();
  const [picking, setPicking] = useState(false);
  if (!f || isPixel(f)) return null;

  const profile = profileOf(f, fixtureProfiles);
  const mode = profile ? resolveMode(profile, f.profileMode) : undefined;

  return (
    <>
      <div className="flex items-start justify-between gap-2 text-xs">
        <div className="min-w-0">
          {/* An UNRESOLVED profile is a real state, not an impossible one: the project may have
              travelled to a machine whose library lacks it. Say so plainly — the fixture is
              reserving no channels at all, which is exactly what would otherwise look like a
              patch that "just stopped working". "Change…" is the way out: re-point it at a profile
              this machine actually has. */}
          {profile ? (
            <>
              <div className="text-fg-3 truncate">{profile.manufacturer}</div>
              <div className="text-fg-1 truncate">{profile.model}</div>
            </>
          ) : (
            <div className="flex items-center gap-1.5 text-danger">
              <AlertTriangle size={12} className="shrink-0" />
              <span className="truncate" title={f.profileId}>Profile not found — occupies no channels</span>
            </div>
          )}
        </div>
        {profile?.verified === false && (
          <span className="shrink-0 flex items-center gap-1 text-mini text-warn" title="This profile has not been checked against the manufacturer's manual">
            <AlertTriangle size={11} /> Unverified
          </span>
        )}
      </div>

      {profile && profile.modes.length > 0 && (
        <Field label="Mode">
          <Select
            value={mode?.key ?? ''}
            onChange={(e) => a.setFixtureProfile(f.id, f.profileId!, e.target.value)}
          >
            {profile.modes.map((m) => (
              <option key={m.key} value={m.key}>{m.name} — {m.footprint}ch</option>
            ))}
          </Select>
        </Field>
      )}

      <div className="flex items-center justify-between text-mini text-fg-3">
        <span>Footprint</span>
        <span className="tabular-nums text-fg-2">
          {fixtureFootprint(f, fixtureProfiles)}ch · U{f.universe} @ {f.startAddress}
        </span>
      </div>

      {/* Swap this head for another head. No "Clear": turning a light back into a pixel fixture is
          the same in-place kind change in reverse, and with the pixel-side door closed it would be
          one-way — delete the fixture instead, which is what it means. */}
      <Button size="sm" variant="ghost" className="w-full mt-1" onClick={() => setPicking((p) => !p)}>
        {picking ? 'Cancel' : 'Change…'}
      </Button>

      {picking && (
        <div className="mt-1 pt-1 border-t border-line-1">
          <FixtureProfilePicker
            autoFocus
            selectedId={f.profileId}
            maxHeight="max-h-48"
            onPick={(profileId, modeKey) => { setPicking(false); a.setFixtureProfile(f.id, profileId, modeKey); }}
          />
        </div>
      )}
    </>
  );
};

// ── Fixture ▸ Channels ──────────────────────────────────────────────────────────────────────
// The live channel strip of a profiled fixture: one control per channel of the ACTIVE MODE, in DMX
// order, so what you see matches what goes on the wire address by address.
export const FixtureChannelsPanel: React.FC = () => {
  const { fixtureProfiles } = useEditor();
  const a = useEditorActions();
  const f = useSelectedFixture();
  if (!f || isPixel(f)) return null;
  const profile = fixtureProfiles.get(f.profileId!);
  const mode = profile ? resolveMode(profile, f.profileMode) : undefined;
  if (!profile || !mode) return null;

  // The channels this MODE actually emits, in slot order, de-duplicated across a 16-bit pair's two
  // slots — an operator adjusts "Pan", not "Pan" and "Pan fine".
  const seen = new Set<string>();
  const channels = mode.slots
    .filter((s): s is NonNullable<typeof s> => !!s && !seen.has(s.channelKey) && !!seen.add(s.channelKey))
    .map((s) => ({ slot: s, channel: profile.channels.find((c) => c.key === s.channelKey) }))
    .filter((e): e is { slot: NonNullable<typeof e.slot>; channel: NonNullable<typeof e.channel> } => !!e.channel);

  const set = (key: string, v: number) => a.updateFixture(f.id, { dmx: { ...(f.dmx ?? {}), [key]: v } });

  return (
    <>
      {channels.map(({ channel }) => {
        const value = channelValue(f, channel);
        const address = f.startAddress + mode.slots.findIndex((s) => s?.channelKey === channel.key);
        if (channel.ranges?.length) {
          // A wheel is a LIST, not a percentage. Showing "0.42" for a gobo is unusable; showing
          // "Eclipse" is what the manual prints.
          const current = selectedRange(channel, value);
          return (
            <div key={channel.key} className="flex items-center justify-between text-xs gap-2">
              <label className="text-fg-2 w-16 truncate" title={`${channel.label} — DMX ${address}`}>{channel.label}</label>
              <Select
                value={current ? String(current.from) : ''}
                onChange={(e) => set(channel.key, valueForRange({ from: Number(e.target.value), to: channel.ranges!.find((r) => r.from === Number(e.target.value))!.to }))}
              >
                {channel.ranges.map((r) => <option key={r.from} value={r.from}>{r.label}</option>)}
              </Select>
            </div>
          );
        }
        // Continuous. The readout is the channel's PHYSICAL value where it has one (270° reads far
        // better than 0.5 when aiming a head); the stored value stays normalised — see profilePack.
        const physical = physicalValue(channel, value);
        return (
          <Slider
            key={channel.key}
            label={channel.label}
            value={value}
            min={0}
            max={1}
            step={1 / (256 ** channel.resolution - 1)}
            format={(v) => {
              const p = physicalValue(channel, v);
              return p !== null ? `${Math.round(p)}${channel.unit === 'deg' ? '°' : ''}` : `${Math.round(v * 100)}%`;
            }}
            onChange={(v) => set(channel.key, v)}
          />
        );
      })}
      {!channels.length && <div className="text-mini text-fg-3">This mode emits no channels.</div>}
    </>
  );
};

// ── Surface ▸ Content ───────────────────────────────────────────────────────────────────────
export const SurfaceContentPanel: React.FC = () => {
  const { surfaces, timeline } = useEditor();
  const a = useEditorActions();
  const surface = useSelectedSurface();
  if (!surface) return null;
  const setContent = (patch: Partial<SurfaceContent>) =>
    a.updateSurface(surface.id, { content: { ...surface.content, ...patch } });
  const setContentType = (type: SurfaceContent['type']) =>
    a.updateSurface(surface.id, { content: { type } });
  return (
    <ContentEditor
      content={surface.content} onChange={setContent} onTypeChange={setContentType}
      layers={timeline.layers} surfaces={surfaces} selfId={surface.id}
    />
  );
};

// ── Surface ▸ Transform ─────────────────────────────────────────────────────────────────────
export const SurfaceTransformPanel: React.FC = () => {
  const a = useEditorActions();
  const s = useSelectedSurface();
  if (!s) return null;
  const set = (patch: Partial<Surface>) => a.updateSurface(s.id, patch);
  return (
    <>
      <NumberInput label="X" value={+s.x.toFixed(3)} step={0.01} onChange={(v) => set({ x: v })} />
      <NumberInput label="Y" value={+s.y.toFixed(3)} step={0.01} onChange={(v) => set({ y: v })} />
      <NumberInput label="Width" value={+s.width.toFixed(3)} step={0.01} onChange={(v) => set({ width: Math.max(0.01, v) })} />
      <NumberInput label="Height" value={+s.height.toFixed(3)} step={0.01} onChange={(v) => set({ height: Math.max(0.01, v) })} />
      <NumberInput label="Rotation" value={s.rotation} step={1} onChange={(v) => set({ rotation: v })} />
    </>
  );
};

// ── Fixture ▸ Mapping ───────────────────────────────────────────────────────────────────────
// ── Fixture ▸ Patch ─────────────────────────────────────────────────────────────────────────
// WHERE ON THE WIRE — the half of the old Mapping panel that means something for BOTH kinds.
//
// The channel count is read through fixtureFootprint() rather than recomputed, so the number an
// operator reads here is the number the patch actually reserves: a light's mode footprint, a pixel
// fixture's ledCount x channelsPerPixel, and 0 for a light whose profile did not resolve.
export const FixturePatchPanel: React.FC = () => {
  const { fixtureProfiles } = useEditor();
  const a = useEditorActions();
  const f = useSelectedFixture();
  if (!f) return null;
  const span = fixtureFootprint(f, fixtureProfiles);
  return (
    <>
      <NumberInput label="Universe" value={f.universe} step={1} onChange={(v) => a.updateFixture(f.id, { universe: Math.max(0, v) })} />
      <NumberInput label="Start Addr" value={f.startAddress} step={1} onChange={(v) => a.updateFixture(f.id, { startAddress: Math.max(1, v) })} />
      <div className="flex items-center justify-between text-mini text-fg-3 pt-1">
        <span>Channels</span>
        <span className="num text-fg-2">{span}</span>
      </div>
      {/* PAST WHAT THE DEVICE CAN SEND — a USB DMX widget drives ONE universe, so a fixture
          auto-patched beyond it has nowhere to go. Badged, because the alternative is a fixture
          that simply never lights and gives no reason why. */}
      {f.patchOverflow && (
        <div className="flex items-center gap-1.5 text-mini text-warn">
          <AlertTriangle size={11} className="shrink-0" />
          <span>Past this controller's last universe</span>
        </div>
      )}
    </>
  );
};

// ── Fixture ▸ Mapping (LED FIXTURES ONLY) ───────────────────────────────────────────────────
// WHAT IT SAMPLES. A light fixture samples nothing — frameEngine returns before any sampling for
// it — so a Surface dropdown, an LED count and a wiring direction are all meaningless on one. The
// panel is registered `appliesTo: ['fixture.pixel']`, which is why there is no guard in the body.
export const FixtureMappingPanel: React.FC = () => {
  const { surfaces } = useEditor();
  const a = useEditorActions();
  const f = useSelectedFixture();
  if (!f) return null;
  return (
    <>
      <div className="flex items-center justify-between text-xs gap-2">
        <label className="text-fg-2 w-16 truncate">Surface</label>
        <Tooltip id="general.fixture-surface">
          <select
            value={f.surfaceId ?? ''}
            onChange={(e) => a.updateFixture(f.id, { surfaceId: e.target.value || undefined })}
            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none"
            {...help('general.fixture-surface')}
          >
            <option value="">— none (off) —</option>
            {surfaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Tooltip>
      </div>
      <NumberInput label="LED Count" value={f.ledCount} step={1} onChange={(v) => a.updateFixture(f.id, { ledCount: Math.max(1, v) })} />
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-line-1">
        <Tooltip id="general.fixture-reverse">
          <span className="text-xs text-fg-2" {...help('general.fixture-reverse')}>Reverse Direction</span>
        </Tooltip>
        <input
          type="checkbox" checked={f.reverse}
          onChange={(e) => a.updateFixture(f.id, { reverse: e.target.checked })}
          className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0"
        />
      </div>
    </>
  );
};

// ── Fixture ▸ Segments ──────────────────────────────────────────────────────────────────────
// Per-segment effects were retired at S3 (effects live on surfaces); this authors the layout plus
// off/dead spans. An `off` segment outputs black (WebGPU mode -2) and stays a real, editable object
// in the list rather than an implicit uncovered hole.
export const FixtureSegmentsPanel: React.FC = () => {
  const a = useEditorActions();
  const f = useSelectedFixture();
  const [segSel, setSegSel] = useState(0);
  if (!f) return null;

  const segs = f.segments;
  const hasSegs = !!(segs && segs.length);
  const idx = Math.min(segSel, (segs?.length ?? 1) - 1);
  const vals = hasSegs ? segs![idx] : {
    source: f.source ?? PixelSource.MEDIA,
    effectId: f.effectId ?? 0,
    paletteId: f.paletteId ?? 0,
    speed: f.speed ?? 0.5,
    intensity: f.intensity ?? 0.5,
  };
  const setVals = (patch: Partial<typeof vals>) => {
    if (hasSegs) a.updateFixture(f.id, { segments: segs!.map((s, i) => i === idx ? { ...s, ...patch } : s) });
    else a.updateFixture(f.id, patch);
  };
  const enableSegments = () => {
    const half = Math.max(1, Math.floor(f.ledCount / 2));
    const base = { source: vals.source, effectId: vals.effectId, paletteId: vals.paletteId, speed: vals.speed, intensity: vals.intensity };
    a.updateFixture(f.id, { segments: [
      { ...base, start: 0, stop: half },
      { ...base, start: half, stop: f.ledCount },
    ] });
    setSegSel(0);
  };
  const addSegment = () => {
    const list = [...segs!];
    const last = list[list.length - 1];
    const mid = Math.floor((last.start + last.stop) / 2);
    if (mid <= last.start || mid >= last.stop) return;
    list[list.length - 1] = { ...last, stop: mid };
    list.push({ ...last, start: mid, stop: last.stop });
    a.updateFixture(f.id, { segments: list });
  };
  const removeSegment = (i: number) => {
    if (!segs || segs.length <= 1) { a.updateFixture(f.id, { segments: undefined }); return; }
    a.updateFixture(f.id, { segments: segs.filter((_, k) => k !== i) });
    setSegSel(0);
  };
  // Punch a dead span: split the current segment (or the whole fixture) into thirds, middle off.
  const insertGap = () => {
    const seed = { source: vals.source, effectId: vals.effectId, paletteId: vals.paletteId, speed: vals.speed, intensity: vals.intensity };
    const cur = hasSegs ? segs![idx] : { ...seed, start: 0, stop: f.ledCount };
    const len = cur.stop - cur.start;
    if (len < 3) return; // too short to carve a visible middle third
    const x = cur.start + Math.floor(len / 3);
    const y = cur.start + Math.floor((2 * len) / 3);
    const three = [
      { ...cur, start: cur.start, stop: x, off: false },
      { ...cur, start: x, stop: y, off: true },
      { ...cur, start: y, stop: cur.stop, off: false },
    ];
    a.updateFixture(f.id, { segments: hasSegs ? segs!.flatMap((s, i) => (i === idx ? three : [s])) : three });
    setSegSel(hasSegs ? idx + 1 : 1);
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-micro text-fg-3 uppercase tracking-wider">
          {hasSegs ? `${segs!.length} segments` : 'Whole fixture'}
        </span>
        <div className="flex gap-1">
          <Tooltip id="general.insert-gap">
            <button onClick={insertGap} title="Split into thirds and mark the middle as an off/dead span" className="text-micro px-1.5 py-0.5 rounded border border-line-2 text-fg-2 hover:bg-surface-3" {...help('general.insert-gap')}>Insert gap</button>
          </Tooltip>
          {hasSegs ? (
            <>
              <button onClick={addSegment} className="text-micro px-1.5 py-0.5 rounded border border-line-2 text-fg-2 hover:bg-surface-3">+ Split</button>
              <button onClick={() => a.updateFixture(f.id, { segments: undefined })} className="text-micro px-1.5 py-0.5 rounded border border-line-2 text-fg-2 hover:bg-surface-3">Merge</button>
            </>
          ) : (
            <button onClick={enableSegments} className="text-micro px-1.5 py-0.5 rounded border border-line-2 text-fg-2 hover:bg-surface-3">Split</button>
          )}
        </div>
      </div>

      {hasSegs && (
        <div className="space-y-1">
          {segs!.map((s, i) => (
            <div key={i} className={`flex items-center justify-between text-micro px-1.5 py-1 rounded border ${i === idx ? 'border-accent bg-accent/10' : 'border-line-1 bg-surface-2'}`}>
              <button className={`flex-1 text-left ${s.off ? 'text-fg-3 line-through' : 'text-fg-1'}`} onClick={() => setSegSel(i)}>
                Seg {i + 1} · LEDs {s.start}–{s.stop}{s.off ? ' · OFF' : ''}
              </button>
              <button aria-label={`Remove segment ${i + 1}`} className="text-fg-3 hover:text-danger px-1" onClick={() => removeSegment(i)}>✕</button>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <NumberInput label="Start" value={'start' in vals ? vals.start : 0} step={1} onChange={(v) => setVals({ start: Math.max(0, Math.round(v)) } as Partial<typeof vals>)} />
            <NumberInput label="Stop" value={'stop' in vals ? vals.stop : 0} step={1} onChange={(v) => setVals({ stop: Math.round(v) } as Partial<typeof vals>)} />
          </div>
          <label className="flex items-center gap-1.5 text-micro text-fg-2 cursor-pointer pt-1 select-none">
            <input
              type="checkbox" checked={'off' in vals ? !!vals.off : false}
              onChange={(e) => setVals({ off: e.target.checked } as Partial<typeof vals>)}
              className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0"
            />
            Off — dead span (LEDs output black)
          </label>
        </div>
      )}
    </>
  );
};

// ── Fixture ▸ 2D / Output ───────────────────────────────────────────────────────────────────
export const FixtureOutputPanel: React.FC = () => {
  const a = useEditorActions();
  const f = useSelectedFixture();
  if (!f) return null;
  const shape = f.shape ?? LedShape.LINE;
  return (
    <>
      <div className="grid grid-cols-2 gap-1">
        {([LedShape.LINE, LedShape.MATRIX] as const).map((sh) => (
          <button
            key={sh}
            onClick={() => a.updateFixture(f.id, { shape: sh })}
            className={`text-micro py-1.5 rounded border transition-all ${shape === sh ? 'bg-accent/10 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3'}`}
          >
            {sh === LedShape.LINE ? 'Line' : 'Matrix'}
          </button>
        ))}
      </div>

      {shape === LedShape.MATRIX && (
        <div className="space-y-2 pt-1">
          <NumberInput label="Cols" value={f.matrixWidth ?? 8} step={1} onChange={(v) => a.updateFixture(f.id, { matrixWidth: Math.max(1, v) })} />
          <NumberInput label="Rows" value={f.matrixHeight ?? 8} step={1} onChange={(v) => a.updateFixture(f.id, { matrixHeight: Math.max(1, v) })} />
          <div className="flex items-center justify-between">
            <Tooltip id="general.serpentine">
              <span className="text-xs text-fg-2" {...help('general.serpentine')}>Serpentine</span>
            </Tooltip>
            <input
              type="checkbox" checked={f.serpentine ?? false}
              onChange={(e) => a.updateFixture(f.id, { serpentine: e.target.checked })}
              className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0"
            />
          </div>
        </div>
      )}

      <div className="flex items-center justify-between text-xs gap-2 pt-1">
        <label className="text-fg-2 w-16 truncate">Color Order</label>
        <Tooltip id="general.color-order">
          <select
            value={f.colorOrder ?? ColorOrder.RGB}
            onChange={(e) => a.updateFixture(f.id, { colorOrder: e.target.value as ColorOrder })}
            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none"
            {...help('general.color-order')}
          >
            {Object.values(ColorOrder).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </Tooltip>
      </div>

      <div className="flex items-center justify-between text-xs gap-2">
        <label className="text-fg-2 w-16 truncate">Channels</label>
        <select
          value={f.channelsPerPixel ?? 4}
          onChange={(e) => a.updateFixture(f.id, { channelsPerPixel: parseInt(e.target.value) as 3 | 4 })}
          className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none"
        >
          <option value={3}>RGB (3)</option>
          <option value={4}>RGBW (4)</option>
        </select>
      </div>

      {(f.channelsPerPixel ?? 4) === 4 && (
        <div className="flex items-center justify-between text-xs gap-2">
          <label className="text-fg-2 w-16 truncate">White</label>
          <Tooltip id="general.rgbw-mode">
            <select
              value={f.rgbwMode ?? RGBWMode.SUBTRACT}
              onChange={(e) => a.updateFixture(f.id, { rgbwMode: e.target.value as RGBWMode })}
              className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none"
              {...help('general.rgbw-mode')}
            >
              <option value={RGBWMode.SUBTRACT}>Subtract min</option>
              <option value={RGBWMode.NONE}>None</option>
            </select>
          </Tooltip>
        </div>
      )}
    </>
  );
};

// ── Fixture ▸ Routing ───────────────────────────────────────────────────────────────────────
export const FixtureRoutingPanel: React.FC = () => {
  const { settings } = useEditor();
  const a = useEditorActions();
  const f = useSelectedFixture();
  if (!f) return null;
  return (
    <>
      <div className="flex items-center justify-between text-xs gap-2">
        <label className="text-fg-2 w-16 truncate">Protocol</label>
        <select
          value={f.output?.protocol ?? ''}
          onChange={(e) => a.updateFixture(f.id, { output: { ...f.output, protocol: (e.target.value || undefined) as ('artnet' | 'sacn' | undefined) } })}
          className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none"
        >
          <option value="">Default ({settings.protocol})</option>
          <option value="artnet">Art-Net</option>
          <option value="sacn">sACN (E1.31)</option>
        </select>
      </div>
      {(f.output?.protocol ?? settings.protocol) === 'sacn' && (
        <NumberInput
          label="Priority" value={f.output?.priority ?? 100} step={1}
          onChange={(v) => a.updateFixture(f.id, { output: { ...f.output, priority: Math.max(0, Math.min(200, Math.round(v))) } })}
        />
      )}
      <div className="flex items-center justify-between text-xs gap-2">
        <label className="text-fg-2 w-16 truncate">Target IP</label>
        <Tooltip id="general.fixture-target-ip">
          <input
            type="text" value={f.output?.ip ?? ''}
            onChange={(e) => a.updateFixture(f.id, { output: { ...f.output, ip: e.target.value || undefined } })}
            placeholder={settings.artNetIp + ' (default)'}
            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none font-mono"
            {...help('general.fixture-target-ip')}
          />
        </Tooltip>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-fg-2">Broadcast (override)</span>
        <input
          type="checkbox" checked={f.output?.broadcast ?? false}
          onChange={(e) => a.updateFixture(f.id, { output: { ...f.output, broadcast: e.target.checked } })}
          className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0"
        />
      </div>
      <div className="flex items-center justify-between">
        <Tooltip id="general.sparse-output">
          <span className="text-xs text-fg-2" title="Skip universes whose data is unchanged" {...help('general.sparse-output')}>Sparse output</span>
        </Tooltip>
        <input
          type="checkbox" checked={f.output?.sparse ?? false}
          onChange={(e) => a.updateFixture(f.id, { output: { ...f.output, sparse: e.target.checked } })}
          className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0"
        />
      </div>
      <div className="text-micro text-fg-3 font-mono">
        Blank IP → global target. Each fixture can address its own controller.
      </div>
    </>
  );
};

// ── Fixture ▸ Position (LIGHT FIXTURES ONLY) ────────────────────────────────────────────────
// WHERE IT HANGS. A light has no LED run, so `3D Layout` (spacing, arc sweep, matrix) is pixel-only
// — but that left a light with NO numeric position at all, reachable only by dragging the gizmo.
// A rigger works in numbers ("3 m up, 2 m stage left"), and a click-to-place is a first draft you
// then nudge exactly. So the position/rotation half of 3D Layout lives here too, for the kind that
// has no layout to go with it.
export const FixturePositionPanel: React.FC = () => {
  const a = useEditorActions();
  const f = useSelectedFixture();
  if (!f) return null;
  const p = effectivePosObj(f);
  const rot = effectiveRotObj(f);
  const setPos = (k: 'x' | 'y' | 'z', v: number) => a.updateFixture(f.id, { position3D: { ...p, [k]: v } });
  const setRot = (k: 'pitch' | 'yaw' | 'roll', v: number) => a.updateFixture(f.id, { rotation3D: { ...rot, [k]: v } });
  return (
    <>
      <div className="text-micro text-fg-3 uppercase tracking-wider">Position (m)</div>
      <NumberInput label="X" value={+p.x.toFixed(3)} step={0.05} onChange={(v) => setPos('x', v)} />
      <NumberInput label="Y" value={+p.y.toFixed(3)} step={0.05} onChange={(v) => setPos('y', v)} />
      <NumberInput label="Z" value={+p.z.toFixed(3)} step={0.05} onChange={(v) => setPos('z', v)} />
      <div className="text-micro text-fg-3 uppercase tracking-wider pt-1">Rotation (°)</div>
      <NumberInput label="Pitch" value={+rot.pitch.toFixed(1)} step={1} onChange={(v) => setRot('pitch', v)} />
      <NumberInput label="Yaw" value={+rot.yaw.toFixed(1)} step={1} onChange={(v) => setRot('yaw', v)} />
      <NumberInput label="Roll" value={+rot.roll.toFixed(1)} step={1} onChange={(v) => setRot('roll', v)} />
      {/* A head has no LED run to lay out, but it does have a body, and this is what sizes it — so the
          same three numbers belong here too rather than only on the pixel card. */}
      <ScaleFields f={f} />
    </>
  );
};

// Scale, per axis, in the FIXTURE's own frame — X along the LED line and the matrix columns, Y across
// the rows, Z through the housing. The gizmo's scale handles write the same three numbers (three drives
// them independently and always in local space), so this is the typed half of the same control rather
// than a second way to size a fixture.
//
// Shared by both position cards, because a light has no `3D Layout` section to put it in and its body
// is scaled by exactly this.
const ScaleFields: React.FC<{ f: Fixture }> = ({ f }) => {
  const a = useEditorActions();
  const s = effectiveScale3(f);
  // Always writes the per-axis field, and retires the legacy uniform one on the same edit — the same
  // rule the gizmo follows, so a fixture never carries two answers to how big it is.
  const set = (k: 'x' | 'y' | 'z', v: number) => a.updateFixture(f.id, {
    scaleXYZ: [k === 'x' ? v : s.x, k === 'y' ? v : s.y, k === 'z' ? v : s.z],
    scale3D: undefined,
  });
  return (
    <>
      <div className="text-micro text-fg-3 uppercase tracking-wider pt-1">Scale (×)</div>
      <NumberInput label="X" value={+s.x.toFixed(3)} step={0.05} onChange={(v) => set('x', Math.max(0.01, v))} />
      <NumberInput label="Y" value={+s.y.toFixed(3)} step={0.05} onChange={(v) => set('y', Math.max(0.01, v))} />
      <NumberInput label="Z" value={+s.z.toFixed(3)} step={0.05} onChange={(v) => set('z', Math.max(0.01, v))} />
    </>
  );
};

// ── Fixture ▸ 3D Layout ─────────────────────────────────────────────────────────────────────
export const FixtureLayout3DPanel: React.FC = () => {
  const a = useEditorActions();
  const f = useSelectedFixture();
  if (!f) return null;
  const p = effectivePosObj(f);
  const rot = effectiveRotObj(f);
  const L = effectiveLayout(f);
  const setPos = (k: 'x' | 'y' | 'z', v: number) => a.updateFixture(f.id, { position3D: { x: p.x, y: p.y, z: p.z, [k]: v } });
  const setRot = (k: 'pitch' | 'yaw' | 'roll', v: number) => a.updateFixture(f.id, { rotation3D: { ...rot, [k]: v } });
  const setLayout = (patch: Partial<typeof L>) => a.updateFixture(f.id, { layout3D: { ...L, ...patch } });
  return (
    <>
      <div className="text-micro text-fg-3 uppercase tracking-wider">Position (m)</div>
      <NumberInput label="X" value={+p.x.toFixed(3)} step={0.05} onChange={(v) => setPos('x', v)} />
      <NumberInput label="Y" value={+p.y.toFixed(3)} step={0.05} onChange={(v) => setPos('y', v)} />
      <NumberInput label="Z" value={+p.z.toFixed(3)} step={0.05} onChange={(v) => setPos('z', v)} />
      <div className="text-micro text-fg-3 uppercase tracking-wider pt-1">Rotation (°)</div>
      <NumberInput label="Pitch" value={+rot.pitch.toFixed(1)} step={1} onChange={(v) => setRot('pitch', v)} />
      <NumberInput label="Yaw" value={+rot.yaw.toFixed(1)} step={1} onChange={(v) => setRot('yaw', v)} />
      <NumberInput label="Roll" value={+rot.roll.toFixed(1)} step={1} onChange={(v) => setRot('roll', v)} />
      <ScaleFields f={f} />

      <div className="flex items-center justify-between text-xs gap-2 pt-1">
        <label className="text-fg-2 w-16 truncate">Layout</label>
        <select
          value={L.type}
          onChange={(e) => setLayout({ type: e.target.value as Layout3DType })}
          className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none"
        >
          <option value="line">Line</option>
          <option value="matrix">Matrix</option>
          <option value="arc">Arc</option>
        </select>
      </div>
      {L.type !== 'arc' && (
        <NumberInput label="Spacing" value={+L.ledSpacing.toFixed(4)} step={0.001} onChange={(v) => setLayout({ ledSpacing: Math.max(0.001, v) })} />
      )}
      {L.type === 'matrix' && (
        <>
          <NumberInput label="Cols" value={L.matrixCols} step={1} onChange={(v) => setLayout({ matrixCols: Math.max(1, Math.round(v)) })} />
          <NumberInput label="Rows" value={L.matrixRows} step={1} onChange={(v) => setLayout({ matrixRows: Math.max(1, Math.round(v)) })} />
          <div className="flex items-center justify-between">
            <Tooltip id="general.serpentine">
              <span className="text-xs text-fg-2" {...help('general.serpentine')}>Serpentine</span>
            </Tooltip>
            <input
              type="checkbox" checked={L.serpentine}
              onChange={(e) => setLayout({ serpentine: e.target.checked })}
              className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0"
            />
          </div>
        </>
      )}
      {L.type === 'arc' && (
        <>
          <NumberInput label="Radius" value={+L.arcRadius.toFixed(3)} step={0.05} onChange={(v) => setLayout({ arcRadius: Math.max(0.01, v) })} />
          <NumberInput label="Angle" value={L.arcAngle} step={5} onChange={(v) => setLayout({ arcAngle: v })} />
        </>
      )}
    </>
  );
};
