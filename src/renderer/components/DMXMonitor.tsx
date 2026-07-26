import React, { useMemo, useRef, useEffect } from 'react';
import { Fixture, FixtureProfile } from '../types';
import { dmxSignal } from '../services/dmxSignal';
import { fixtureFootprint, resolveMode } from '../services/addressing';

interface DMXMonitorProps {
  fixtures: Fixture[];
  /** Resolved DMX profiles — a profiled fixture shows a named channel table, not a pixel strip. */
  fixtureProfiles?: ReadonlyMap<string, FixtureProfile>;
}

// Wire footprint = DMX channels a fixture occupies. Delegates to addressing.ts, the single owner of
// that formula, so a profiled fixture (a moving head, whose footprint is its MODE's) reads the same
// span here as the patch, the collision detector and the packer.
// NB: the live pixel *canvas* in FixtureStrip indexes the canonical RGBW buffer and intentionally
// stays *4 — do NOT swap those to this.
const wireChannels = (f: Fixture, profiles?: ReadonlyMap<string, FixtureProfile>) => fixtureFootprint(f, profiles);

// Live pixel strip + intensity-shaded value readout, fed off the dmxSignal bus.
const FixtureStrip: React.FC<{ fixture: Fixture; offset: number }> = ({ fixture, offset }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(offset);

  useEffect(() => { offsetRef.current = offset; }, [offset]);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    cvs.width = fixture.ledCount;
    cvs.height = 1;
    const imgData = ctx.createImageData(fixture.ledCount, 1);
    const data = imgData.data;

    const unsubscribe = dmxSignal.subscribe((packet) => {
      const allPixels = packet.pixels;
      const startIdx = offsetRef.current * 4;
      const endIdx = startIdx + fixture.ledCount * 4;
      if (endIdx > allPixels.length) return;

      let ptr = 0;
      let peak = 0;
      for (let i = startIdx; i < endIdx; i += 4) {
        // Canonical pixels are RGBW: the white channel (i+3) holds the neutral
        // component pulled out of RGB by the RGBW-subtract shader. Fold it back in
        // so whites read as white in the preview (W is 0 for RGB/NONE fixtures).
        const w = allPixels[i + 3];
        const r = Math.min(255, allPixels[i] + w);
        const g = Math.min(255, allPixels[i + 1] + w);
        const b = Math.min(255, allPixels[i + 2] + w);
        data[ptr] = r; data[ptr + 1] = g; data[ptr + 2] = b; data[ptr + 3] = 255;
        ptr += 4;
        const m = Math.max(r, g, b);
        if (m > peak) peak = m;
      }
      ctx.putImageData(imgData, 0, 0);
      // Intensity meter: width + value shaded by peak channel.
      if (meterRef.current) {
        const pct = Math.round((peak / 255) * 100);
        meterRef.current.style.width = `${pct}%`;
        meterRef.current.style.opacity = `${0.35 + (peak / 255) * 0.65}`;
      }
    });

    return () => unsubscribe();
  }, [fixture.ledCount]);

  return (
    <div className="space-y-1">
      <canvas
        ref={canvasRef}
        className="w-full h-7 bg-surface-0 rounded-sm border border-line-2"
        style={{ imageRendering: 'pixelated' }}
      />
      <div className="h-1 w-full bg-surface-0 rounded-full overflow-hidden">
        <div ref={meterRef} className="h-full bg-accent rounded-full" style={{ width: '0%' }} />
      </div>
    </div>
  );
};

// A PROFILED fixture's live channel table.
//
// The pixel strip above is the wrong instrument for a moving head: it has one "pixel", and what the
// operator needs to see is Pan/Tilt/Gobo by NAME against the address each one occupies. This reads
// the real packed universes off the same bus the output uses, so the number shown is the byte that
// actually left the machine — not a re-derivation that could disagree with it.
const ProfileChannels: React.FC<{ fixture: Fixture; profile: FixtureProfile }> = ({ fixture, profile }) => {
  const mode = resolveMode(profile, fixture.profileMode);
  const cellsRef = useRef<(HTMLSpanElement | null)[]>([]);

  const rows = useMemo(() => {
    if (!mode) return [];
    const byKey = new Map(profile.channels.map((c) => [c.key, c]));
    // Slot order IS address order, so the table reads down the fixture's DMX footprint.
    return mode.slots.map((slot, i) => {
      const abs = fixture.universe * 512 + (fixture.startAddress - 1) + i;
      return {
        address: (abs % 512) + 1,
        universe: Math.floor(abs / 512),
        label: slot ? (byKey.get(slot.channelKey)?.label ?? slot.channelKey) : '—',
        fine: !!slot && slot.byte > 0,
      };
    });
  }, [profile, mode, fixture.universe, fixture.startAddress]);

  // Written imperatively, like the pixel canvas above: this repaints at frame rate and must not
  // re-render React while it does.
  useEffect(() => dmxSignal.subscribe(({ destinations }) => {
    for (let i = 0; i < rows.length; i++) {
      const el = cellsRef.current[i];
      if (!el) continue;
      let value: number | undefined;
      for (const dest of Object.values(destinations)) {
        const arr = dest.universes[rows[i].universe];
        if (arr) { value = arr[rows[i].address - 1]; break; }
      }
      const text = value === undefined ? '–' : String(value);
      if (el.textContent !== text) el.textContent = text;
      el.style.opacity = value ? String(0.45 + (value / 255) * 0.55) : '0.35';
    }
  }), [rows]);

  if (!mode) return <div className="text-micro text-fg-3 italic">Profile mode unavailable.</div>;

  return (
    <div className="grid grid-cols-[2.2rem_1fr_2.2rem] gap-x-1.5 gap-y-0.5 text-micro">
      {rows.map((r, i) => (
        <React.Fragment key={`${r.universe}.${r.address}`}>
          <span className="num text-fg-3 text-right">{r.address}</span>
          <span className={`truncate ${r.fine ? 'text-fg-3 italic' : 'text-fg-2'}`} title={r.label}>
            {r.fine ? `${r.label} (fine)` : r.label}
          </span>
          <span ref={(el) => { cellsRef.current[i] = el; }} className="num text-fg-1 text-right tabular-nums">–</span>
        </React.Fragment>
      ))}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: React.ReactNode; tone?: string }> = ({ label, value, tone = 'text-fg-1' }) => (
  <div className="flex items-baseline gap-1.5">
    <span className="text-micro uppercase tracking-wider text-fg-3">{label}</span>
    <span className={`num text-sm ${tone}`}>{value}</span>
  </div>
);

export const DMXMonitor: React.FC<DMXMonitorProps> = ({ fixtures, fixtureProfiles }) => {
  const stats = useMemo(() => {
    const channels = fixtures.reduce((acc, f) => acc + wireChannels(f, fixtureProfiles), 0);
    const touchedUniverses = new Set<number>();
    fixtures.forEach((f) => {
      const startAbs = f.universe * 512 + (f.startAddress - 1);
      const endAbs = startAbs + wireChannels(f, fixtureProfiles) - 1;
      for (let u = Math.floor(startAbs / 512); u <= Math.floor(endAbs / 512); u++) touchedUniverses.add(u);
    });
    return { channels, universes: touchedUniverses.size };
  }, [fixtures, fixtureProfiles]);

  const fixtureOffsets = useMemo(() => {
    const offsets: Record<string, number> = {};
    let current = 0;
    fixtures.forEach((f) => { offsets[f.id] = current; current += f.ledCount; });
    return offsets;
  }, [fixtures]);

  return (
    <div className="h-full flex flex-col bg-surface-0 text-fg-1">
      {/* Compact stat bar */}
      <div className="shrink-0 flex items-center gap-5 px-3 h-9 border-b border-line-1 bg-surface-1">
        <Stat label="Fixtures" value={fixtures.length} />
        <Stat label="Channels" value={stats.channels} />
        <Stat label="Universes" value={stats.universes} />
        <span className="ml-auto flex items-center gap-1.5 text-micro uppercase tracking-wider text-fg-3">
          <span className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse" /> Live
        </span>
      </div>

      {/* Fixture grid */}
      {fixtures.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-fg-3 text-xs italic">No fixtures patched.</div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 content-start">
          {fixtures.map((fixture) => {
            const startAbs = fixture.universe * 512 + (fixture.startAddress - 1);
            const endAbs = startAbs + wireChannels(fixture, fixtureProfiles) - 1;
            const startU = Math.floor(startAbs / 512);
            const endU = Math.floor(endAbs / 512);
            const uDisplay = startU === endU ? `${startU}` : `${startU}-${endU}`;
            const profile = fixture.profileId ? fixtureProfiles?.get(fixture.profileId) : undefined;
            return (
              <div key={fixture.id} className="bg-surface-1 border border-line-1 rounded-md p-2.5 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <span className="text-xs font-medium text-fg-1 truncate">{fixture.name}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="num text-micro text-fg-2 bg-surface-0 px-1.5 py-0.5 rounded-sm border border-line-2">U:{uDisplay}.{fixture.startAddress}</span>
                    <span className="num text-micro text-fg-2 bg-surface-0 px-1.5 py-0.5 rounded-sm border border-line-2">
                      {profile ? `${wireChannels(fixture, fixtureProfiles)}ch` : `${fixture.ledCount}px`}
                    </span>
                  </div>
                </div>
                {profile
                  ? <ProfileChannels fixture={fixture} profile={profile} />
                  : <FixtureStrip fixture={fixture} offset={fixtureOffsets[fixture.id]} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
