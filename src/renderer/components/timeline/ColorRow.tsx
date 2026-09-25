// ONE COLOUR, ON ONE ROW — the thing four 0..1 lanes could never be.
//
// The COLOUR group of a fixture track used to be three or four independent scalar rows (red, green,
// blue, white), each an identical grey polyline, with nothing on screen saying what they added up
// to. This row is the colour itself: what the fixture is making right now, what it was authored to
// make, and how that changes along the timeline.
//
// THE CONTROL IS DERIVED FROM THE FIXTURE, not chosen here. A tuneable-white head cannot make green,
// so it is offered a temperature and never a hue; a wheel head is offered its slots; a head with no
// colour channel gets no row at all. services/colorEngine owns that decision (`colorCapability`) —
// see plans/colour-track.md for the measurements behind it.
//
// ⚠ THE LIVE SWATCH IS A DOM WRITE, NOT STATE. It follows the rig at frame rate, and Timeline's
// standing rule is that a per-frame value never enters React: a clock in state was measured at
// 224 ms/s and removed, which is why AutomationLane's readout is written straight to a ref'd node.
// The same applies here, doubly — this repaints on every frame the rig changes colour.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ColorKey, ColorLane, ColorValue, Fixture, FixtureProfile, ProfileMode } from '../../types';
import {
  colorCapability, colorOf, hexToLinear, linearToHex, solveEmitters, temperatureColor, nearestSlot,
} from '../../services/colorEngine';
import { sampleColorLane } from '../../services/colorPlayback';
import * as fixtureSignal from '../../services/fixtureSignal';
import { timeline as engine } from '../../services/timeline';
import { GUTTER } from './geometry';
import { usePopoverAnchor } from './usePopoverAnchor';
import { Plus, X, Palette } from 'lucide-react';

export const COLOR_ROW_H = 34;

interface Props {
  fixture: Fixture;
  profile: FixtureProfile;
  mode: ProfileMode;
  /** The lane colouring this fixture, if one has been authored yet. */
  lane?: ColorLane;
  pxPerSec: number;
  width: number;
  docKey: string;
  onChange: (next: ColorLane) => void;
  onRemove: () => void;
  /** Create the lane, seeded with one key at the playhead holding what the fixture is doing now. */
  onAdd: (seed: ColorValue) => void;
  onSnap: (t: number) => number;
  onSeek: (clientX: number) => void;
  /** Per-channel lanes that are BEATING this row — see the badge. Empty when nothing is. */
  shadowedByLane?: Array<{ laneId: string; label: string; origin: 'scene' | 'global' }>;
  /** Delete one of those lanes, handing the channel back to the colour row. */
  onReleaseLane?: (laneId: string) => void;
}

/** The colour a fixture is making RIGHT NOW, read off the resolved signal rather than re-derived. */
function liveColorOf(fixtureId: string): string {
  const st = fixtureSignal.snapshot().get(fixtureId);
  return st ? linearToHex([st.r, st.g, st.b]) : '#000000';
}

export const ColorRow: React.FC<Props> = ({
  fixture, profile, mode, lane, pxPerSec, width, docKey, onChange, onRemove, onAdd, onSnap, onSeek,
  shadowedByLane = [], onReleaseLane,
}) => {
  const cap = useMemo(() => colorCapability(profile, mode), [profile, mode]);
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<ColorKey[] | null>(null);
  const swatchRef = useRef<HTMLSpanElement | null>(null);
  const [shadowOpen, setShadowOpen] = useState(false);
  const shadowAnchorRef = useRef<HTMLButtonElement | null>(null);
  const shadowBoxRef = useRef<HTMLDivElement | null>(null);
  const shadowPos = usePopoverAnchor(shadowOpen, shadowAnchorRef, {
    width: 224, estHeight: 160, boxRef: shadowBoxRef, onDismiss: () => setShadowOpen(false),
  });
  // Portalled and placed from a measured rect: an `absolute` popover inside a lane is sealed in the
  // gutter's stacking context and clipped by the scroller — the trap usePopoverAnchor documents.
  const keyAnchorRef = useRef<HTMLDivElement | null>(null);
  const keyBoxRef = useRef<HTMLDivElement | null>(null);
  const pos = usePopoverAnchor(selected !== null, keyAnchorRef, {
    width: 224, estHeight: 230, boxRef: keyBoxRef, onDismiss: () => setSelected(null),
  });

  // A structural edit while a drag is in flight would commit keys into a document that no longer
  // exists — the same guard CurveEditor keeps on docKey.
  useEffect(() => { setDraft(null); setSelected(null); }, [docKey]);

  // ── the live swatch: subscribed, written to the DOM, never setState ──────────────────────────
  useEffect(() => {
    const paint = () => {
      const el = swatchRef.current;
      if (el) el.style.background = liveColorOf(fixture.id);
    };
    paint();
    return fixtureSignal.subscribe(paint);
  }, [fixture.id]);

  const keys = draft ?? lane?.keys ?? [];

  // ── the strip ────────────────────────────────────────────────────────────────────────────────
  // Sampled through the SAME function the engine plays, so the fade you look at is the fade the rig
  // performs. Memoised because Timeline is deliberately not memoised and re-renders around 1 Hz —
  // the mistake AudioLane's waveform already had to fix.
  const stops = useMemo(() => {
    if (!lane || !keys.length) return [];
    const cursor = { i: 0 };
    const step = Math.max(6, width / 260);         // ~260 stops max, whatever the zoom
    const out: Array<{ offset: number; hex: string }> = [];
    for (let x = 0; x <= width; x += step) {
      const v = sampleColorLane({ ...lane, keys }, x / pxPerSec, cursor);
      out.push({ offset: (x / Math.max(1, width)) * 100, hex: v ? linearToHex(colorOf(v)) : '#000000' });
    }
    return out;
  }, [lane, keys, width, pxPerSec]);

  const gradientId = `colorlane-${fixture.id}`;

  const commit = (next: ColorKey[]) => {
    if (!lane) return;
    onChange({ ...lane, keys: [...next].sort((a, b) => a.t - b.t) });
    setDraft(null);
  };

  const patchSelected = (value: ColorValue) => {
    if (selected === null) return;
    commit(keys.map((k, i) => (i === selected ? { ...k, value } : k)));
  };

  const addKeyAt = (t: number) => {
    if (!lane) return;
    const at = onSnap(Math.max(0, t));
    const held = sampleColorLane(lane, at) ?? keys[0]?.value ?? { kind: 'rgb', rgb: [1, 1, 1] };
    // A NEW KEY HOLDS WHAT WAS ALREADY THERE — adding one must not change the look, only give you
    // somewhere to change it from. Same contract as the `+` on an empty automation row.
    commit([...keys, { t: at, value: held, curve: 'linear' }]);
  };

  // ── no colour at all ─────────────────────────────────────────────────────────────────────────
  // Not an empty row: a fixture with no colour channel has no colour to author, and a disabled
  // control that can never do anything is worse than nothing there.
  if (cap.control === 'none') return null;

  const selectedKey = selected !== null ? keys[selected] : undefined;
  const controlLabel = cap.control === 'mix' ? (cap.subtractive ? 'CMY' : cap.emitters.map((e) => e.role[0].toUpperCase()).join(''))
    : cap.control === 'temperature' ? (cap.cct ? 'CCT' : 'CW/WW')
      : 'Wheel';

  return (
    <div className="flex border-b border-line-1/50 group/color">
      {/* ── gutter ─────────────────────────────────────────────────────────────────────────── */}
      <div className="sticky left-0 z-20 shrink-0 bg-surface-1/40 border-r border-line-1 flex items-center gap-1.5 px-2"
        style={{ width: GUTTER, height: COLOR_ROW_H }}>
        <Palette size={11} className="shrink-0 text-fg-3" />
        <span className="text-micro text-fg-2">Colour</span>
        <span
          ref={swatchRef}
          title="What this fixture is making right now"
          className="w-3.5 h-3.5 rounded-sm border border-line-1 shrink-0"
        />
        {shadowedByLane.length > 0 ? (
          <button
            ref={shadowAnchorRef}
            onClick={() => setShadowOpen((v) => !v)}
            title={`${shadowedByLane.map((x) => x.label).join(', ')} — a curve on that channel wins over this row`}
            className="text-micro text-warn hover:text-warn/80 truncate">
            ▲ {shadowedByLane.length} shadowed
          </button>
        ) : (
          <span className="text-micro text-fg-3/70 truncate" title={`This mode mixes with ${controlLabel}`}>{controlLabel}</span>
        )}
        {lane ? (
          <button onClick={onRemove} title="Remove the colour lane (the fixture keeps its authored colour)"
            className="ml-auto shrink-0 text-fg-3 opacity-0 group-hover/color:opacity-100 hover:text-warn">
            <X size={11} />
          </button>
        ) : (
          <button
            onClick={() => {
              // Seeded from the LIVE colour, so creating the lane changes nothing about the rig.
              const st = fixtureSignal.snapshot().get(fixture.id);
              onAdd(cap.control === 'temperature'
                ? { kind: 'cct', t: 0.5 }
                : { kind: 'rgb', rgb: st ? [st.r, st.g, st.b] : [1, 1, 1] });
            }}
            title="Start a colour on this fixture at the playhead, holding the colour it is making now"
            className="ml-auto shrink-0 text-fg-3 opacity-0 group-hover/color:opacity-100 hover:text-accent">
            <Plus size={11} />
          </button>
        )}
      </div>

      {/* ── body: the gradient, and a diamond per key ──────────────────────────────────────── */}
      <div
        className="relative"
        style={{ width, height: COLOR_ROW_H }}
        onDoubleClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          addKeyAt((e.clientX - r.left) / pxPerSec);
        }}
        onPointerDown={(e) => { if (e.button === 0 && e.target === e.currentTarget) onSeek(e.clientX); }}
      >
        {!lane ? (
          <div className="absolute left-0 right-0 top-1/2 border-t border-dashed border-line-1/40" />
        ) : (
          <>
            <svg width={width} height={COLOR_ROW_H - 8} className="absolute left-0 top-1 pointer-events-none" preserveAspectRatio="none">
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
                  {stops.map((s, i) => <stop key={i} offset={`${s.offset}%`} stopColor={s.hex} />)}
                </linearGradient>
              </defs>
              <rect x={0} y={0} width={width} height={COLOR_ROW_H - 8} fill={`url(#${gradientId})`} rx={2} />
            </svg>
            {keys.map((k, i) => (
              <div
                key={`${k.t}-${i}`}
                ref={selected === i ? keyAnchorRef : undefined}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setSelected(i);
                  engine.seek(k.t);      // show the look this key makes, the way a pose key does
                }}
                title={`Colour key @ ${k.t.toFixed(2)}s — click to edit`}
                className="absolute w-2.5 h-2.5 rotate-45 border cursor-pointer pointer-events-auto"
                style={{
                  left: k.t * pxPerSec - 5,
                  top: COLOR_ROW_H / 2 - 5,
                  background: linearToHex(colorOf(k.value)),
                  borderColor: selected === i ? '#fff' : 'rgba(0,0,0,0.5)',
                }}
              />
            ))}
          </>
        )}
      </div>

      {/* ── WHAT IS WINNING, AND HOW TO TAKE IT BACK ──────────────────────────────────────────
          Naming the conflict is most of the fix; the button is the rest. Deleting the curve is the
          honest verb — there is no way to fold an arbitrary per-channel curve into a colour without
          inventing values nobody authored — so it says so, and undo covers it. */}
      {shadowOpen && createPortal(
        <>
          <div className="fixed inset-0 z-popover" onPointerDown={() => setShadowOpen(false)} />
          <div
            ref={shadowBoxRef}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            className="fixed z-popover bg-surface-0 border border-line-2 rounded shadow-e3 p-2 text-mini w-56"
            style={{ left: shadowPos?.left ?? 0, top: shadowPos?.top ?? 0, visibility: shadowPos ? 'visible' : 'hidden' }}>
            <div className="text-fg-2 mb-1">A curve wins over this row</div>
            <div className="text-micro text-fg-3 mb-1.5">
              A lane aimed at one channel is more specific than a colour, so it takes that channel.
              The colour still drives the rest.
            </div>
            {shadowedByLane.map((sx) => (
              <div key={sx.laneId} className="flex items-center gap-1.5 py-0.5">
                <span className="flex-1 truncate text-fg-1">{sx.label}</span>
                {sx.origin === 'global' ? (
                  // A global lane is read-only from inside a scene — the same rule the row itself
                  // follows by passing no handler. Saying where it lives beats a dead button.
                  <span className="text-micro text-fg-3" title="This curve lives on the Global document">Global</span>
                ) : (
                  <button
                    onClick={() => { onReleaseLane?.(sx.laneId); setShadowOpen(false); }}
                    title={`Delete the ${sx.label} curve so the Colour row drives it again. Undo restores it.`}
                    className="text-micro text-warn hover:text-warn/80">
                    Take back
                  </button>
                )}
              </div>
            ))}
          </div>
        </>,
        document.body,
      )}

      {/* ── the per-key editor ─────────────────────────────────────────────────────────────── */}
      {/* PORTALLED, like every other popover in this directory. The gutter beside it is
          `sticky left-0 z-20`, which creates a stacking context — a panel rendered in place would
          be sealed inside it and clipped by the scroller, with correct geometry and correct text
          and only the pixels wrong. See usePopoverAnchor's header for the three times that bit. */}
      {selectedKey && createPortal(
        <>
          <div className="fixed inset-0 z-popover" onPointerDown={() => setSelected(null)} />
          <div
            ref={keyBoxRef}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            // The portal leaves the timeline scroller's subtree, so React's synthetic wheel would
            // still travel the React tree and zoom the timeline underneath the open panel.
            onWheel={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); setSelected(null); } }}
            className="fixed z-popover bg-surface-0 border border-line-2 rounded shadow-e3 p-2 text-mini w-56"
            // Hidden until measured — a first paint at 0,0 flashes the panel in the window corner.
            style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-fg-2">Colour @ {selectedKey.t.toFixed(2)}s</span>
            <button onClick={() => setSelected(null)} className="text-fg-3 hover:text-fg-1"><X size={11} /></button>
          </div>

          <ColorControl cap={cap} value={selectedKey.value} onChange={patchSelected} />

          <div className="flex items-center gap-1 mt-2">
            <label className="text-fg-3 w-10">Ease</label>
            <select
              value={selectedKey.curve ?? 'linear'}
              onChange={(e) => commit(keys.map((k, i) => (i === selected ? { ...k, curve: e.target.value as ColorKey['curve'] } : k)))}
              className="flex-1 bg-surface-0 border border-line-1 rounded-sm px-1 py-0.5 text-mini">
              <option value="linear">linear</option>
              <option value="hold">hold</option>
              <option value="bezier">bezier</option>
            </select>
          </div>
          {/* NO PATH ON A TEMPERATURE. Two temperature keys interpolate ALONG the warm-cold line
              (colorPlayback.blend), which is the whole point — a colour space would bow the fade off
              a line the fixture cannot leave. Showing the control anyway would be a knob that does
              nothing, which is a claim the UI has no business making. */}
          {cap.control !== 'temperature' && (
          <div className="flex items-center gap-1 mt-1">
            <label className="text-fg-3 w-10" title="Which colours the fade passes THROUGH — a different axis from the easing">Path</label>
            <select
              value={selectedKey.space ?? 'oklab'}
              onChange={(e) => commit(keys.map((k, i) => (i === selected ? { ...k, space: e.target.value as ColorKey['space'] } : k)))}
              className="flex-1 bg-surface-0 border border-line-1 rounded-sm px-1 py-0.5 text-mini">
              <option value="oklab">oklab — even</option>
              <option value="hsv">hsv — round the wheel</option>
              <option value="rgb">rgb — straight line</option>
            </select>
          </div>
          )}

          <button
            onClick={() => { commit(keys.filter((_, i) => i !== selected)); setSelected(null); }}
            disabled={keys.length <= 1}
            className="mt-2 w-full text-mini text-warn/90 hover:text-warn disabled:opacity-40 disabled:hover:text-warn/90"
            title={keys.length <= 1 ? 'A lane keeps at least one key — remove the lane instead' : 'Delete this key'}>
            Delete key
          </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
};

/**
 * The control itself — the only part that differs per fixture, and the reason this row can be one
 * component rather than three.
 */
const ColorControl: React.FC<{
  cap: ReturnType<typeof colorCapability>;
  value: ColorValue;
  onChange: (v: ColorValue) => void;
}> = ({ cap, value, onChange }) => {
  if (cap.control === 'temperature') {
    const t = value.kind === 'cct' ? value.t : 0.5;
    return (
      <div>
        <div className="flex items-center gap-1.5">
          <span className="text-fg-3 text-micro">Warm</span>
          <input
            type="range" min={0} max={1} step={0.01} value={t}
            onChange={(e) => onChange({ kind: 'cct', t: parseFloat(e.target.value) })}
            className="flex-1"
          />
          <span className="text-fg-3 text-micro">Cold</span>
        </div>
        <div className="h-3 rounded-sm mt-1 border border-line-1"
          style={{ background: `linear-gradient(90deg, ${linearToHex(temperatureColor(0))}, ${linearToHex(temperatureColor(1))})` }} />
        {/* NOT KELVIN, and it must not pretend to be: no shipped profile declares a kelvin range,
            so a number here would be invented. See colorEngine.solveTemperature. */}
        <div className="text-micro text-fg-3/70 mt-0.5">{Math.round(t * 100)}% cold</div>
      </div>
    );
  }

  if (cap.control === 'wheel' && cap.wheel) {
    const slots = (cap.wheel.ranges ?? []).filter((r) => r.color);
    const current = nearestSlot(cap.wheel, colorOf(value));
    return (
      <div>
        <select
          value={current ? `${current.from}` : ''}
          onChange={(e) => {
            const slot = slots.find((s) => `${s.from}` === e.target.value);
            const rgb = slot?.color ? hexToLinear(slot.color) : null;
            if (rgb) onChange({ kind: 'rgb', rgb: [rgb[0], rgb[1], rgb[2]] });
          }}
          className="w-full bg-surface-0 border border-line-1 rounded-sm px-1 py-0.5 text-mini">
          {slots.map((s) => <option key={s.from} value={s.from}>{s.label}</option>)}
        </select>
        <div className="text-micro text-fg-3/70 mt-1">
          A wheel lands ON a slot — a colour between two is one the fixture cannot show.
        </div>
      </div>
    );
  }

  // 'mix' — the native picker, which is the app's standing choice for a colour (ColorField's header
  // explains why: the OS one already has an eyedropper on both platforms this ships to).
  const rgb = colorOf(value);
  const solved = solveEmitters(cap, rgb);
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={linearToHex(rgb)}
          onChange={(e) => {
            const lin = hexToLinear(e.target.value);
            if (lin) onChange({ kind: 'rgb', rgb: [lin[0], lin[1], lin[2]] });
          }}
          className="w-8 h-7 bg-transparent border border-line-1 rounded-sm cursor-pointer"
        />
        <span className="text-micro text-fg-3 tabular-nums">{linearToHex(rgb)}</span>
      </div>
      {/* WHAT THE RIG WILL ACTUALLY DO. Even a mixing head has a gamut, and a colour it cannot
          reach must not look authored — the operator sees the difference rather than discovering
          it in the room. */}
      {solved.error > 0.06 && (
        <div className="mt-1.5 flex items-center gap-1.5 text-micro text-warn">
          <span className="w-3 h-3 rounded-sm border border-line-1 shrink-0" style={{ background: linearToHex(solved.achieved) }} />
          this fixture can only get this close
        </div>
      )}
      <div className="text-micro text-fg-3/70 mt-1 truncate" title="What each emitter will be driven at">
        {cap.subtractive
          ? 'cyan / magenta / yellow flags'
          : cap.emitters.map((e) => `${e.role} ${Math.round((solved.values[e.role] ?? 0) * 100)}%`).join(' · ')}
      </div>
    </div>
  );
};
