// Audio Bed panel — authors the GLOBAL audio bed (ProjectData.audio → AudioMix). The bed survives
// scene swaps and rides the main transport playhead (the plugins/audio scheduler plays it). Tracks hold
// clips; drag an audio asset from the Media library onto a track to add a clip at the current playhead
// (its duration comes from decoding the file). Reads/writes the bed through host.audio (getMix/setMix/
// subscribe). Per-scene audio (stingers/cues) is a later phase and rides the scene timeline instead.
import React, { useEffect, useRef, useState } from 'react';
import { X, Plus, Music, Trash2, Volume2, VolumeX, AlertTriangle, Play, Pause, SkipBack, Orbit, Sliders } from 'lucide-react';
import { useDraggable, type PanelProps } from '@artlux/sdk/renderer';
import { getAudioHost } from './audioHost';
import { audioClient } from './audioClient';
import { EffectChain, type Effect } from './EffectChain';
import { MASTER_BUS_ID } from './effectDefs';

interface Spatial { x: number; y: number; z: number }
interface Clip { id: string; trackId: string; name: string; path: string; start: number; duration: number; inPoint: number; gain?: number; mute?: boolean; spatial?: Spatial; effects?: Effect[] }
interface Track { id: string; name: string; gain?: number; mute?: boolean }
interface Bus { id: string; name: string; gain?: number; effects?: Effect[] }
interface Mix { tracks: Track[]; clips: Clip[]; buses: Bus[] }

// Metres shown across the positioner pad (listener at the centre).
const RANGE = 3;

// Top-down positioner: horizontal = x (left/right), vertical = z (up = IN FRONT of the listener).
// Ambisonic encoding places the source from this; height (y) is a separate slider.
const SpatialPad: React.FC<{ x: number; z: number; onChange: (x: number, z: number) => void }> = ({ x, z, onChange }) => {
  const ref = useRef<HTMLDivElement>(null);
  const set = (clientX: number, clientY: number) => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const px = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const py = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    onChange(Number(((px - 0.5) * 2 * RANGE).toFixed(2)), Number(((0.5 - py) * 2 * RANGE).toFixed(2)));
  };
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    set(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => set(ev.clientX, ev.clientY);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div ref={ref} onPointerDown={onDown} title="Drag to place the source (top-down; up = in front of the listener)"
      className="relative w-24 h-24 rounded border border-line-1 bg-surface-0 cursor-crosshair shrink-0">
      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-line-1/60" />
      <div className="absolute top-1/2 left-0 right-0 h-px bg-line-1/60" />
      <div className="absolute left-1/2 top-1/2 w-1.5 h-1.5 -ml-[3px] -mt-[3px] rounded-full bg-fg-3" title="listener" />
      <span className="absolute top-0.5 left-1/2 -translate-x-1/2 text-[9px] leading-none text-fg-3/70">front</span>
      <div className="absolute w-2.5 h-2.5 -ml-[5px] -mt-[5px] rounded-full bg-accent"
        style={{ left: `${((x / RANGE) * 0.5 + 0.5) * 100}%`, top: `${(0.5 - (z / RANGE) * 0.5) * 100}%` }} />
    </div>
  );
};

const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `a-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
const emptyMix = (): Mix => ({ tracks: [], clips: [], buses: [] });
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? 'audio';
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export const AudioBedPanel: React.FC<PanelProps> = ({ onClose }) => {
  const host = getAudioHost();
  const [mix, setMixState] = useState<Mix>(() => (host?.audio.getMix() as Mix) ?? emptyMix());
  const [meter, setMeter] = useState({ peak: 0, rms: 0, peakL: 0, peakR: 0 });
  const [clipping, setClipping] = useState(false);
  const clipUntil = useRef(0); // hold the warning ~1.5 s — a transient overshoot would otherwise flash past
  const [transport, setTransport] = useState({ playing: false, playhead: 0, duration: 0 });
  const [error, setError] = useState<string | null>(null);
  const [openSpatial, setOpenSpatial] = useState<string | null>(null); // clip id whose positioner is open
  const [openFx, setOpenFx] = useState<string | null>(null);           // clip id whose effect chain is open
  const [openMaster, setOpenMaster] = useState(false);
  const peakHold = useRef(0);
  const holdL = useRef(0);
  const holdR = useRef(0);
  // Synchronously-fresh mirror of the bed. `host.audio.getMix()` reads App's audioMixRef, which only
  // refreshes on a React render — so two drops resolving in the same turn would both read the pre-edit
  // bed and the second would clobber the first. Every write path updates this ref immediately instead.
  const mixRef = useRef<Mix>(mix);
  // Floating (non-blocking) window — draggable by its header so it can be moved clear of the Media library.
  const { positionerStyle, handleProps } = useDraggable();

  // Sync from host (external edits / project load) → repaint.
  useEffect(() => {
    if (!host) return;
    return host.audio.subscribe(() => {
      const m = (host.audio.getMix() as Mix) ?? emptyMix();
      mixRef.current = m;
      setMixState(m);
    });
  }, [host]);

  // Master meter (~10 Hz) with peak-hold decay.
  useEffect(() => {
    if (!host) return;
    const iv = setInterval(() => {
      audioClient.getMeters().then((m) => {
        peakHold.current = Math.max(peakHold.current * 0.9, m.peak);
        holdL.current = Math.max(holdL.current * 0.9, m.peakL ?? 0);
        holdR.current = Math.max(holdR.current * 0.9, m.peakR ?? 0);
        setMeter({ peak: peakHold.current, rms: m.rms, peakL: holdL.current, peakR: holdR.current });
        if (m.clipped) clipUntil.current = Date.now() + 1500; // engine-latched: catches every block, not 1 in 10
        setClipping(Date.now() < clipUntil.current);
      }).catch(() => {});
      const st = host.show.getStatus(); // the bed rides the MAIN transport — mirror it here
      setTransport({ playing: st.playing, playhead: st.playhead, duration: st.duration });
    }, 100);
    return () => clearInterval(iv);
  }, [host]);

  // Every mutation builds a fresh bed and writes it back (host normalizes + persists + notifies the player).
  const commit = (next: Mix) => { mixRef.current = next; setMixState(next); host?.audio.setMix(next); };

  const addTrack = () => {
    const cur = mixRef.current;
    commit({ ...cur, tracks: [...cur.tracks, { id: uid(), name: `Track ${cur.tracks.length + 1}`, gain: 1, mute: false }] });
  };
  const removeTrack = (id: string) => commit({ ...mix, tracks: mix.tracks.filter((t) => t.id !== id), clips: mix.clips.filter((c) => c.trackId !== id) });
  const patchTrack = (id: string, p: Partial<Track>) => commit({ ...mix, tracks: mix.tracks.map((t) => (t.id === id ? { ...t, ...p } : t)) });
  const removeClip = (id: string) => commit({ ...mix, clips: mix.clips.filter((c) => c.id !== id) });
  const patchClip = (id: string, p: Partial<Clip>) => commit({ ...mix, clips: mix.clips.map((c) => (c.id === id ? { ...c, ...p } : c)) });

  // The master bus is materialised on FIRST EDIT, not by default — a project that never touches master
  // keeps `buses: []`, so an untouched bed persists exactly as it did before P3.
  const DEFAULT_MASTER: Bus = { id: MASTER_BUS_ID, name: 'Master', gain: 1, effects: [] };
  const master: Bus = mix.buses.find((b) => b.id === MASTER_BUS_ID) ?? DEFAULT_MASTER; // for RENDER only
  const patchMaster = (p: Partial<Bus>) => {
    // Base the patch on mixRef (synchronously fresh), NOT on `master` above, which derives from React
    // state and is a render behind. Spreading the stale one would drop a sibling field edited earlier in
    // the same turn — patch the gain then the effects and the gain would snap back. Same reason addClip
    // reads mixRef.
    const cur = mixRef.current;
    const has = cur.buses.some((b) => b.id === MASTER_BUS_ID);
    const next: Bus = { ...(cur.buses.find((b) => b.id === MASTER_BUS_ID) ?? DEFAULT_MASTER), ...p };
    commit({ ...cur, buses: has ? cur.buses.map((b) => (b.id === MASTER_BUS_ID ? next : b)) : [...cur.buses, next] });
  };

  const addClip = async (trackId: string, asset: { type?: string; path?: string }) => {
    if (asset?.type !== 'audio' || !asset.path) return;
    const start = Math.max(0, host?.show.getStatus().playhead ?? 0);
    const clipId = uid();
    let meta = null as { durationSec: number } | null;
    try {
      meta = await audioClient.loadClip(clipId, asset.path); // decode → real duration (also preloads it)
    } catch {
      meta = null; // loadClip REJECTS on an undecodable/missing source — never let it escape as a silent no-op
    }
    if (!meta || !(meta.durationSec > 0)) {
      setError(`Couldn't load "${baseName(asset.path)}" — the audio engine is unavailable, or the file is missing/undecodable.`);
      return;
    }
    const cur = mixRef.current; // synchronously-fresh bed (see mixRef)
    // The track may have been deleted while the file was decoding — don't orphan an invisible-but-audible clip.
    if (!cur.tracks.some((t) => t.id === trackId)) { audioClient.unloadClip(clipId); return; }
    setError(null);
    commit({ ...cur, clips: [...cur.clips, { id: clipId, trackId, name: baseName(asset.path), path: asset.path, start, duration: meta.durationSec, inPoint: 0, gain: 1, mute: false }] });
  };

  const onDrop = (trackId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/artlux-asset');
    if (!raw) return;
    try { void addClip(trackId, JSON.parse(raw)); } catch { /* not an asset payload */ }
  };
  const allowDrop = (e: React.DragEvent) => { if (e.dataTransfer.types.includes('application/artlux-asset')) e.preventDefault(); };

  if (!host) return null;
  const clipsOf = (tid: string) => mix.clips.filter((c) => c.trackId === tid).sort((a, b) => a.start - b.start);
  const pct = (v: number) => `${Math.min(100, Math.round(v * 100))}%`;
  // Scrub range: at least the timeline's length, but always far enough to reach the last bed clip.
  const scrubMax = Math.max(10, transport.duration, ...mix.clips.map((c) => c.start + c.duration));

  return (
    // NOT a blocking modal: authoring the bed means dragging audio assets IN from the Media library, so the
    // full-screen container is pointer-events-none (the library + the rest of the editor stay live) and only
    // the window itself takes pointer events. Drag the header to move it clear of whatever it covers.
    <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center">
      <div style={positionerStyle} className="pointer-events-auto">
      <div role="dialog" aria-label="Audio Bed"
        className="w-[720px] max-w-[94vw] h-[70vh] max-h-[84vh] flex flex-col bg-surface-1 border border-line-2 rounded-lg shadow-e3 animate-modal-in">
        {/* header — drag handle */}
        <div {...handleProps} className="h-11 px-3 flex items-center gap-2 border-b border-line-1 bg-surface-2 shrink-0 cursor-move select-none">
          <Music size={14} className="text-fg-2 shrink-0" />
          <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider shrink-0">Audio Bed</span>

          {/* Transport. The bed has NO clock of its own — it rides the MAIN timeline transport (same
              controls as the Timeline panel / Space). These drive that transport via host.show. */}
          <div className="flex items-center gap-1 ml-2 shrink-0">
            <button onClick={() => host.show.transport({ kind: 'seek', sec: 0 })} title="Return to start"
              className="p-1 rounded-sm bg-surface-3 text-fg-2 hover:text-fg-1"><SkipBack size={12} /></button>
            <button onClick={() => host.show.transport({ kind: transport.playing ? 'pause' : 'play' })}
              title={transport.playing ? 'Pause (Space)' : 'Play (Space)'}
              className={`p-1 rounded-sm ${transport.playing ? 'bg-accent text-black' : 'bg-surface-3 text-fg-2 hover:text-fg-1'}`}>
              {transport.playing ? <Pause size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
            </button>
            <span className="text-micro text-fg-2 tabular-nums w-9">{fmt(transport.playhead)}</span>
          </div>
          {/* Scrub the main playhead (seek) — the bed re-syncs to it. */}
          <input type="range" min={0} max={scrubMax} step={0.05} value={Math.min(transport.playhead, scrubMax)}
            onChange={(e) => host.show.transport({ kind: 'seek', sec: Number(e.target.value) })}
            title="Scrub the playhead" className="flex-1 min-w-[80px] accent-accent" />

          {/* L / R meters — the stereo image visibly shifts as you drag a source around the pad. */}
          <div className="w-20 shrink-0 space-y-0.5" title={`L ${meter.peakL.toFixed(3)} · R ${meter.peakR.toFixed(3)}`}>
            <div className="h-1.5 rounded bg-surface-3 overflow-hidden"><div className="h-full bg-accent transition-[width] duration-75" style={{ width: pct(meter.peakL) }} /></div>
            <div className="h-1.5 rounded bg-surface-3 overflow-hidden"><div className="h-full bg-accent transition-[width] duration-75" style={{ width: pct(meter.peakR) }} /></div>
          </div>
          <button onClick={addTrack} className="shrink-0 inline-flex items-center gap-1 px-2 h-7 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 text-mini"><Plus size={12} /> Track</button>
          <button onClick={onClose} className="text-fg-3 hover:text-fg-1 ml-1"><X size={16} /></button>
        </div>

        {error && (
          <div className="px-3 py-1.5 flex items-center gap-2 border-b border-line-1 bg-warn/10 text-warn text-micro shrink-0">
            <AlertTriangle size={12} className="shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="hover:text-fg-1"><X size={12} /></button>
          </div>
        )}

        {/* body */}
        <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
          {mix.tracks.length === 0 ? (
            <div className="text-fg-3 text-mini italic px-1 py-6 text-center">
              No tracks. Add a track, then drag audio clips from the Media library onto it.
            </div>
          ) : mix.tracks.map((t) => (
            <div key={t.id} className="border border-line-1 rounded bg-surface-1">
              {/* track header */}
              <div className="h-9 px-2 flex items-center gap-2 border-b border-line-1 bg-surface-2">
                <input value={t.name} onChange={(e) => patchTrack(t.id, { name: e.target.value })}
                  className="bg-transparent outline-none text-mini text-fg-1 w-40 truncate" />
                <button onClick={() => patchTrack(t.id, { mute: !t.mute })} title={t.mute ? 'Unmute' : 'Mute'}
                  className={`inline-flex items-center justify-center w-6 h-6 rounded border ${t.mute ? 'border-danger/50 text-danger bg-danger/10' : 'border-line-1 text-fg-3 hover:text-fg-1'}`}>
                  {t.mute ? <VolumeX size={12} /> : <Volume2 size={12} />}
                </button>
                <input type="range" min={0} max={1.5} step={0.01} value={t.gain ?? 1} onChange={(e) => patchTrack(t.id, { gain: Number(e.target.value) })}
                  title={`gain ${(t.gain ?? 1).toFixed(2)}`} className="w-28 accent-accent" />
                <span className="text-micro text-fg-3 w-8">{(t.gain ?? 1).toFixed(2)}</span>
                <button onClick={() => removeTrack(t.id)} title="Remove track" className="ml-auto text-fg-3 hover:text-danger"><Trash2 size={13} /></button>
              </div>
              {/* clips + drop zone */}
              <div onDrop={onDrop(t.id)} onDragOver={allowDrop} className="min-h-[44px] p-1.5 space-y-1">
                {clipsOf(t.id).length === 0 ? (
                  <div className="text-micro text-fg-3/70 italic px-1 py-1.5">Drag an audio asset here…</div>
                ) : clipsOf(t.id).map((c) => (
                  <div key={c.id}>
                    <div className="flex items-center gap-2 px-2 h-8 rounded bg-surface-2 border border-line-1">
                      <Music size={11} className="text-fg-3 shrink-0" />
                      <span className="text-micro text-fg-1 truncate w-32" title={c.name}>{c.name}</span>
                      <label className="text-micro text-fg-3 flex items-center gap-1">@
                        <input type="number" min={0} step={0.1} value={Number(c.start.toFixed(2))}
                          onChange={(e) => { const v = e.target.value; if (v === '') return; const n = Number(v); if (Number.isFinite(n)) patchClip(c.id, { start: Math.max(0, n) }); }}
                          className="w-14 bg-surface-1 border border-line-1 rounded px-1 text-fg-1 outline-none" />s
                      </label>
                      <span className="text-micro text-fg-3/80">{fmt(c.duration)}</span>
                      <button onClick={() => patchClip(c.id, { mute: !c.mute })} title={c.mute ? 'Unmute' : 'Mute'}
                        className={`inline-flex items-center justify-center w-5 h-5 rounded ${c.mute ? 'text-danger' : 'text-fg-3 hover:text-fg-1'}`}>{c.mute ? <VolumeX size={11} /> : <Volume2 size={11} />}</button>
                      <input type="range" min={0} max={1.5} step={0.01} value={c.gain ?? 1} onChange={(e) => patchClip(c.id, { gain: Number(e.target.value) })} title={`gain ${(c.gain ?? 1).toFixed(2)}`} className="w-20 accent-accent" />
                      <button onClick={() => setOpenSpatial(openSpatial === c.id ? null : c.id)} title="Spatial position (3D)"
                        className={`inline-flex items-center justify-center w-5 h-5 rounded ${c.spatial ? 'text-accent' : 'text-fg-3 hover:text-fg-1'}`}><Orbit size={12} /></button>
                      <button onClick={() => setOpenFx(openFx === c.id ? null : c.id)} title="Effects (insert chain)"
                        className={`inline-flex items-center justify-center w-5 h-5 rounded ${c.effects?.length ? 'text-accent' : 'text-fg-3 hover:text-fg-1'}`}><Sliders size={12} /></button>
                      <button onClick={() => removeClip(c.id)} title="Remove clip" className="ml-auto text-fg-3 hover:text-danger"><Trash2 size={12} /></button>
                    </div>

                    {/* Insert chain on this source. It runs BEFORE spatialisation, so a reverb here puts
                        the source in a room and then the room is placed with it — which is what you want. */}
                    {openFx === c.id && (
                      <div className="mt-1 px-2 py-2 rounded bg-surface-1 border border-line-1">
                        <EffectChain scope="clip" effects={c.effects ?? []} onChange={(fx) => patchClip(c.id, { effects: fx })} />
                      </div>
                    )}

                    {/* Spatial positioner — ambisonic encode + binaural HRTF decode. Drag the pad to move
                        the source around the listener; you'll hear it move and see the L/R meters shift. */}
                    {openSpatial === c.id && (
                      <div className="mt-1 px-2 py-2 rounded bg-surface-1 border border-line-1 flex items-center gap-3">
                        <label className="flex items-center gap-1.5 text-micro text-fg-2 shrink-0">
                          <input type="checkbox" checked={!!c.spatial} className="accent-accent"
                            onChange={(e) => patchClip(c.id, { spatial: e.target.checked ? { x: 0, y: 0, z: 1 } : undefined })} />
                          Spatial
                        </label>
                        {c.spatial ? (
                          <>
                            <SpatialPad x={c.spatial.x} z={c.spatial.z}
                              onChange={(x, z) => patchClip(c.id, { spatial: { ...(c.spatial as Spatial), x, z } })} />
                            <div className="flex flex-col items-center gap-1 shrink-0">
                              <span className="text-[9px] leading-none text-fg-3">height</span>
                              <input type="range" min={-2} max={2} step={0.1} value={c.spatial.y}
                                onChange={(e) => patchClip(c.id, { spatial: { ...(c.spatial as Spatial), y: Number(e.target.value) } })}
                                className="w-20 accent-accent" />
                            </div>
                            <span className="text-micro text-fg-3 tabular-nums">
                              x {c.spatial.x.toFixed(1)} · y {c.spatial.y.toFixed(1)} · z {c.spatial.z.toFixed(1)} m
                            </span>
                          </>
                        ) : (
                          <span className="text-micro text-fg-3 italic">Off — the clip plays flat (unspatialised) into the mix.</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {/* Master strip — the fader + insert chain on the DECODED output (after the ambisonic field has
            been rendered to headphones or speakers). This is where a limiter to protect the rig goes. */}
        <div className="border-t border-line-1 shrink-0">
          <div className="h-9 px-3 flex items-center gap-2">
            <span className="text-mini font-semibold text-fg-2 shrink-0">Master</span>
            <button onClick={() => setOpenMaster(!openMaster)} title="Master effects"
              className={`inline-flex items-center gap-1 px-1.5 h-6 rounded border border-line-1 text-micro ${master.effects?.length ? 'text-accent' : 'text-fg-3 hover:text-fg-1'}`}>
              <Sliders size={11} /> FX{master.effects?.length ? ` (${master.effects.length})` : ''}
            </button>
            <input type="range" min={0} max={1.5} step={0.01} value={master.gain ?? 1}
              onChange={(e) => patchMaster({ gain: Number(e.target.value) })}
              title={`master gain ${(master.gain ?? 1).toFixed(2)}`} className="w-28 accent-accent" />
            <span className="text-micro text-fg-3 w-8 tabular-nums">{(master.gain ?? 1).toFixed(2)}</span>
            {/* A reverb with a big room and a hot wet level really can push past full scale — that clips
                the output. Better to see it here than to hear it on the amp. */}
            {clipping && (
              <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded bg-danger/15 text-danger text-micro">
                <AlertTriangle size={10} /> clipping
              </span>
            )}
            <span className="ml-auto text-micro text-fg-3">
              Clips play when the playhead is over them. Drag audio in from the Media library.
            </span>
          </div>
          {openMaster && (
            <div className="px-3 pb-2">
              <EffectChain scope="master" effects={master.effects ?? []} onChange={(fx) => patchMaster({ effects: fx })} />
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
};
