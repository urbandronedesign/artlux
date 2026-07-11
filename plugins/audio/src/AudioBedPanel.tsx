// Audio Bed panel — authors the GLOBAL audio bed (ProjectData.audio → AudioMix). The bed survives
// scene swaps and rides the main transport playhead (the plugins/audio scheduler plays it). Tracks hold
// clips; drag an audio asset from the Media library onto a track to add a clip at the current playhead
// (its duration comes from decoding the file). Reads/writes the bed through host.audio (getMix/setMix/
// subscribe). Per-scene audio (stingers/cues) is a later phase and rides the scene timeline instead.
import React, { useEffect, useRef, useState } from 'react';
import { X, Plus, Music, Trash2, Volume2, VolumeX, AlertTriangle } from 'lucide-react';
import type { PanelProps } from '@artlux/sdk/renderer';
import { getAudioHost } from './audioHost';
import { audioClient } from './audioClient';

interface Clip { id: string; trackId: string; name: string; path: string; start: number; duration: number; inPoint: number; gain?: number; mute?: boolean }
interface Track { id: string; name: string; gain?: number; mute?: boolean }
interface Mix { tracks: Track[]; clips: Clip[]; buses: unknown[] }

const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `a-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
const emptyMix = (): Mix => ({ tracks: [], clips: [], buses: [] });
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? 'audio';
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export const AudioBedPanel: React.FC<PanelProps> = ({ onClose }) => {
  const host = getAudioHost();
  const [mix, setMixState] = useState<Mix>(() => (host?.audio.getMix() as Mix) ?? emptyMix());
  const [meter, setMeter] = useState({ peak: 0, rms: 0 });
  const [error, setError] = useState<string | null>(null);
  const peakHold = useRef(0);
  // Synchronously-fresh mirror of the bed. `host.audio.getMix()` reads App's audioMixRef, which only
  // refreshes on a React render — so two drops resolving in the same turn would both read the pre-edit
  // bed and the second would clobber the first. Every write path updates this ref immediately instead.
  const mixRef = useRef<Mix>(mix);

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
      audioClient.getMeters().then((m) => { peakHold.current = Math.max(peakHold.current * 0.9, m.peak); setMeter({ peak: peakHold.current, rms: m.rms }); }).catch(() => {});
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

  return (
    <div className="fixed inset-0 z-50 bg-black/60 animate-overlay-in flex items-center justify-center" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Audio Bed"
        className="w-[720px] max-w-[94vw] h-[70vh] max-h-[84vh] flex flex-col bg-surface-1 border border-line-2 rounded-lg shadow-e3 animate-modal-in"
        onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="h-11 px-3 flex items-center gap-2 border-b border-line-1 bg-surface-2 shrink-0">
          <Music size={14} className="text-fg-2" />
          <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider">Audio Bed</span>
          <span className="text-micro text-fg-3">global · survives scene changes</span>
          <div className="ml-3 w-40 h-2 rounded bg-surface-3 overflow-hidden" title={`peak ${meter.peak.toFixed(3)}`}>
            <div className="h-full bg-accent transition-[width] duration-75" style={{ width: pct(meter.peak) }} />
          </div>
          <button onClick={addTrack} className="ml-auto inline-flex items-center gap-1 px-2 h-7 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 text-mini"><Plus size={12} /> Track</button>
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
                  <div key={c.id} className="flex items-center gap-2 px-2 h-8 rounded bg-surface-2 border border-line-1">
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
                    <button onClick={() => removeClip(c.id)} title="Remove clip" className="ml-auto text-fg-3 hover:text-danger"><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-3 py-1.5 border-t border-line-1 text-micro text-fg-3 shrink-0">
          Clips play when the transport playhead is over them. Import audio via the Media panel (Music icon).
        </div>
      </div>
    </div>
  );
};
