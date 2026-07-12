// One audio lane: an AudioTrack's clips on the same time axis as the video lanes.
//
// TWO CONTAINERS, ONE COMPONENT. `source` says which:
//   'bed'      — ProjectData.audio. Rides the SHOW clock. Drawn ONLY while Global is bound (there, show
//                clock ≡ playhead, so the ruler is honest; inside a scene the two diverge and drawing the
//                bed against a scene-relative ruler would be a LIE). Commits via onChangeMix.
//   'timeline' — this document's own Timeline.audio. Rides the PLAYHEAD, restarts with its timeline.
//                Commits via onChange(timeline) — the EXPENSIVE path (setData → recompile + a
//                structured-clone postMessage of the whole doc to every projector port).
// Every callback carries `source` back to the parent for exactly that reason.
//
// DRAFT LOCALLY, COMMIT ONCE ON POINTERUP. Non-negotiable (see ClipBlock/AutomationLane): a commit per
// pointermove re-enters App → setScenes/setAudioMix → engine.setData → warmMedia + pruneStaleLayers +
// compileAutomation + a postMessage per projector, 60×/s — and setData can emit a `pause` intent, which
// stops the bed. The CLIP DRAG STATE LIVES IN Timeline.tsx (window listeners, snapping, the one commit);
// this component only reports pointerdowns, exactly like ClipBlock. The gutter's own continuous controls
// (the gain fader, the name field) draft here and commit on release/blur — same rule, local scope.
import React from 'react';
import { Trash2, Volume2, VolumeX, Headphones, Music } from 'lucide-react';
import type { AudioClip, AudioTrack } from '../../types';
import { AUDIO_LANE_H, GUTTER, fmtClock } from './geometry';
import { peaksFor, sourceDurationFor, subscribePeaks } from './audioPeaks';

export type AudioDragMode = 'move' | 'l' | 'r' | 'fadeIn' | 'fadeOut';

export interface AudioLaneProps {
  track: AudioTrack;
  clips: AudioClip[];               // already filtered to this track, with the drag draft applied
  source: 'bed' | 'timeline';       // WHICH CONTAINER — decides the commit path and the clock label
  selectedId: string | null;
  tool: 'select' | 'blade';
  pxPerSec: number;
  width: number;
  onPatchTrack: (patch: Partial<AudioTrack>) => void;
  onRemoveTrack: () => void;
  onStartDrag: (e: React.PointerEvent, clip: AudioClip, mode: AudioDragMode, source: 'bed' | 'timeline') => void;
  onBlade: (clip: AudioClip, clientX: number, source: 'bed' | 'timeline') => void;
  onRemoveClip: (clipId: string, source: 'bed' | 'timeline') => void;
  onSelect: (clipId: string, source: 'bed' | 'timeline') => void;
  onSeek: (clientX: number) => void;
  onDropAsset: (e: React.DragEvent, trackId: string, source: 'bed' | 'timeline') => void;
}

const BODY_H = AUDIO_LANE_H - 8;   // the clip block insets 4px top and bottom

// The waveform, as an SVG path over the clip's VISIBLE window [inPoint, inPoint + duration) of the source.
// Trimming a clip must move the wave under it, not rescale it — that is the whole point of a waveform.
//
// ⚠ THE SOURCE LENGTH IS NOT `clip.duration`. Falling back to it (`clip.sourceDuration ?? clip.duration`)
// is what makes the wave LIE: on a clip with no `sourceDuration` — which is every clip on every bed
// authored before this wave — `src` would shrink WITH `duration` on every trim, so `t1` is always 1 and
// the whole file is re-squeezed into the visible window each frame. Ask the decode instead
// (`sourceDurationFor`), and if even that is unknown (still decoding, or undecodable), draw a FLAT BAR
// rather than a false one.
//
// MEMOIZED, because this is on a HOT RENDER PATH. Timeline.tsx re-renders at ~10 Hz while the transport
// runs (its `autoPlayhead` sampler) and at 1 Hz always (`defsTick`), and neither AudioClipBlock nor
// AudioLane can be React.memo'd out of it (the `clips` array and every gutter callback are freshly
// allocated per render upstream). Rebuilding the path meant ~1200 `toFixed(1)` calls plus a join PER
// CLIP, PER RENDER, forever — for a shape that only changes when the clip is trimmed, the zoom moves, or
// a decode lands. `peakTick` is the decode signal (AudioLane's subscribePeaks subscription): the peaks
// and the source duration both live in module maps, so it is the ONLY thing that can change them without
// a prop moving — which makes it a required dep, not a nicety.
const Wave: React.FC<{ clip: AudioClip; widthPx: number; peakTick: number }> = ({ clip, widthPx, peakTick }) => {
  const { path, inPoint, duration, sourceDuration } = clip;
  const d = React.useMemo(() => {
    const buckets = Math.max(2, Math.min(600, Math.floor(widthPx)));
    const src = sourceDuration ?? sourceDurationFor(path);
    const full = peaksFor(path, 2048);
    if (!full || !src || !(src > 0)) return null;   // decoding / undecodable → the caller draws a flat bar
    const t0 = inPoint / src, t1 = Math.min(1, (inPoint + duration) / src);
    const mid = BODY_H / 2;
    const at = (i: number) => {
      const f = t0 + ((t1 - t0) * i) / (buckets - 1);
      return full[Math.min(full.length - 1, Math.max(0, Math.floor(f * full.length)))] ?? 0;
    };
    const pts: string[] = [];
    for (let i = 0; i < buckets; i++) {
      const x = ((i / (buckets - 1)) * widthPx).toFixed(1);
      pts.push(`${x},${(mid - at(i) * mid * 0.92).toFixed(1)}`);
    }
    for (let i = buckets - 1; i >= 0; i--) {
      const x = ((i / (buckets - 1)) * widthPx).toFixed(1);
      pts.push(`${x},${(mid + at(i) * mid * 0.92).toFixed(1)}`);
    }
    return `M${pts.join(' L')}Z`;
    // peakTick: see above — a decode landing changes peaksFor/sourceDurationFor with no prop moving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, inPoint, duration, sourceDuration, widthPx, peakTick]);

  if (d == null) {
    return <div className="absolute inset-x-0 top-1/2 h-px bg-fg-3/40 pointer-events-none" />; // decoding / undecodable
  }
  return (
    <svg width={widthPx} height={BODY_H} className="absolute inset-0 pointer-events-none" preserveAspectRatio="none">
      <path d={d} className="fill-accent/45" />
    </svg>
  );
};

const AudioClipBlock: React.FC<{
  clip: AudioClip; selected: boolean; blade: boolean; pxPerSec: number;
  source: 'bed' | 'timeline';
  peakTick: number;                 // the decode signal — forwarded to Wave's memo (see Wave)
  onStartDrag: AudioLaneProps['onStartDrag'];
  onBlade: AudioLaneProps['onBlade'];
  onRemoveClip: AudioLaneProps['onRemoveClip'];
  onSelect: AudioLaneProps['onSelect'];
}> = ({ clip, selected, blade, pxPerSec, source, peakTick, onStartDrag, onBlade, onRemoveClip, onSelect }) => {
  const widthPx = Math.max(6, clip.duration * pxPerSec);
  const fadeInPx = Math.max(0, Math.min(clip.fadeIn ?? 0, clip.duration)) * pxPerSec;
  const fadeOutPx = Math.max(0, Math.min(clip.fadeOut ?? 0, clip.duration)) * pxPerSec;

  const onDown = (e: React.PointerEvent) => {
    if (blade) { e.stopPropagation(); e.preventDefault(); onBlade(clip, e.clientX, source); return; }
    onSelect(clip.id, source);
    onStartDrag(e, clip, 'move', source);
  };

  return (
    <div
      onPointerDown={onDown}
      className={`absolute top-1 bottom-1 rounded-sm border overflow-hidden ${blade ? 'cursor-col-resize' : 'cursor-grab'} ${selected ? 'border-accent bg-accent/20' : 'border-line-2 bg-surface-3'} ${clip.mute ? 'opacity-40' : ''}`}
      style={{ left: clip.start * pxPerSec, width: widthPx }}
      title={`${clip.name} — ${fmtClock(clip.duration)}`}
    >
      {widthPx > 12 && <Wave clip={clip} widthPx={widthPx} peakTick={peakTick} />}

      {/* THE FADE RAMPS — the visual truth of AudioClip.fadeIn/fadeOut, which the driver honours from
          Task 6 on (D9). Drawn as triangles over the wave, so what you see is the envelope you hear. */}
      {fadeInPx > 1 && (
        <svg width={fadeInPx} height={BODY_H} className="absolute left-0 top-0 pointer-events-none" preserveAspectRatio="none">
          <path d={`M0,0 L${fadeInPx},0 L0,${BODY_H} Z`} className="fill-surface-0/70" />
        </svg>
      )}
      {fadeOutPx > 1 && (
        <svg width={fadeOutPx} height={BODY_H} className="absolute right-0 top-0 pointer-events-none" preserveAspectRatio="none">
          <path d={`M${fadeOutPx},0 L${fadeOutPx},${BODY_H} L0,0 Z`} className="fill-surface-0/70" />
        </svg>
      )}

      <div className="absolute inset-x-0 top-0 h-3.5 bg-gradient-to-b from-black/55 to-transparent pointer-events-none" />
      <div className="relative px-1.5 pt-0.5 text-micro leading-tight truncate text-fg-1 pointer-events-none drop-shadow flex items-center gap-1">
        <Music size={9} className="shrink-0 opacity-70" />{clip.name}
      </div>

      {!blade && <>
        {/* trim handles — same 6px targets as ClipBlock */}
        <div onPointerDown={(e) => { e.stopPropagation(); onSelect(clip.id, source); onStartDrag(e, clip, 'l', source); }}
          title="Trim in — drag" className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-black/40 hover:bg-accent" />
        <div onPointerDown={(e) => { e.stopPropagation(); onSelect(clip.id, source); onStartDrag(e, clip, 'r', source); }}
          title="Trim out — drag" className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-black/40 hover:bg-accent" />
        {/* THE FADE CORNER HANDLES (D9) — the DAW idiom: drag the top corner in to lengthen the fade.
            Offset past the trim handles (left/right 1.5) so the two targets never fight. */}
        <div onPointerDown={(e) => { e.stopPropagation(); onSelect(clip.id, source); onStartDrag(e, clip, 'fadeIn', source); }}
          title="Fade in — drag right" style={{ left: Math.max(6, fadeInPx) - 4 }}
          className="absolute top-0 w-2 h-2 rounded-sm bg-accent/70 hover:bg-accent cursor-ew-resize" />
        <div onPointerDown={(e) => { e.stopPropagation(); onSelect(clip.id, source); onStartDrag(e, clip, 'fadeOut', source); }}
          title="Fade out — drag left" style={{ right: Math.max(6, fadeOutPx) - 4 }}
          className="absolute top-0 w-2 h-2 rounded-sm bg-accent/70 hover:bg-accent cursor-ew-resize" />
      </>}

      {selected && (
        <button onPointerDown={(e) => e.stopPropagation()} onClick={() => onRemoveClip(clip.id, source)}
          title="Remove clip" className="absolute top-0.5 right-2 text-fg-2 hover:text-danger"><Trash2 size={10} /></button>
      )}
    </div>
  );
};

export const AudioLane: React.FC<AudioLaneProps> = ({
  track, clips, source, selectedId, tool, pxPerSec, width,
  onPatchTrack, onRemoveTrack, onStartDrag, onBlade, onRemoveClip, onSelect, onSeek, onDropAsset,
}) => {
  const blade = tool === 'blade';
  const muted = !!track.mute;
  // A waveform decode lands asynchronously and nothing else would repaint this lane (Timeline's ~10 Hz
  // playhead setState bails out when the transport is paused). One re-render per decode, not per frame.
  const [peakTick, setPeakTick] = React.useState(0);
  React.useEffect(() => subscribePeaks(() => setPeakTick(t => t + 1)), []);
  // ⚠ THE GUTTER'S FADER AND NAME FIELD ARE DRAFTED LOCALLY AND COMMITTED ONCE — invariant 7, in the file
  // whose own header states it. React maps `onChange` on a range/text input to the DOM `input` event: every
  // pointermove of the fader, every keystroke of the name. For source === 'timeline' one commit is
  // onChange(timeline) → App.handleTimelineChange → setScenes/setTimeline → engine.setData →
  // clampPlayheadIntoDoc + warmMedia + pruneStaleLayers + compileAutomation + a structured-clone
  // postMessage of the WHOLE doc to EVERY projector port, plus the audio fan-out's syncLoaded/syncClips.
  // And clampPlayheadIntoDoc CAN EMIT A `pause` INTENT — so at 60 Hz, with the scene parked at its end,
  // TYPING A TRACK'S NAME WOULD STOP THE TRANSPORT AND KILL THE BED this whole wave exists to protect.
  // Mute/solo/remove are discrete — one commit each — and stay as plain onClick.
  const [gainDraft, setGainDraft] = React.useState<number | null>(null);
  const [nameDraft, setNameDraft] = React.useState<string | null>(null);
  const commitGain = () => { if (gainDraft != null) onPatchTrack({ gain: gainDraft }); setGainDraft(null); };
  // ⚠ THE NAME DRAFT IS MIRRORED IN A REF, AND commitName READS THE *REF* — NEVER THE CLOSURE.
  //
  // Escape must ABANDON the rename, and it must also blur (leaving a field focused on a draft that was
  // just thrown away is its own trap). But `.blur()` dispatches the native blur event SYNCHRONOUSLY,
  // inside the very keydown call stack that just called setNameDraft(null) — and that setState is
  // BATCHED, so React runs onBlur → commitName from the CURRENT render's closure, where `nameDraft` is
  // still the typed string. Escape would COMMIT the rename it was supposed to discard. On a
  // source === 'timeline' track that is a full onChange(timeline) → engine.setData → clampPlayheadIntoDoc
  // + warmMedia + pruneStaleLayers + compileAutomation + a structured-clone postMessage to every
  // projector port — this file's own header names that path as the thing never to take by accident.
  //
  // A ref is written SYNCHRONOUSLY, so the blur that follows in the same stack reads `null` and commits
  // nothing. It also makes commitName correct for any future path that blurs from inside a handler.
  const nameDraftRef = React.useRef<string | null>(null);
  const setName = (v: string | null) => { nameDraftRef.current = v; setNameDraft(v); };
  const commitName = () => {
    const d = nameDraftRef.current;
    if (d != null && d !== track.name) onPatchTrack({ name: d });
    setName(null);
  };
  return (
    <div className={`flex border-b border-line-1 ${muted ? 'opacity-50' : ''} ${track.solo ? 'bg-accent/5' : ''}`}>
      {/* gutter — the component owns it (the AutomationLane/StateLane idiom, not the video-lane one) */}
      <div className="sticky left-0 z-20 shrink-0 bg-surface-1 border-r border-line-1 flex flex-col justify-center gap-0.5 px-2 py-1"
        style={{ width: GUTTER, height: AUDIO_LANE_H }}>
        <div className="flex items-center gap-1">
          <Music size={10} className="text-fg-3 shrink-0" />
          {/* Draft on keystroke, commit on blur / Enter. ESCAPE ABANDONS — and it really does: `setName`
              clears the REF synchronously, so the blur() below (which fires onBlur → commitName inside
              this same call stack) reads null and commits nothing. See commitName. */}
          <input value={nameDraft ?? track.name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setName(null); (e.target as HTMLInputElement).blur(); } }}
            className="flex-1 min-w-0 bg-transparent outline-none text-micro text-fg-1 truncate" />
          <button onClick={onRemoveTrack} title="Remove track (and its clips)" className="text-fg-3 hover:text-danger"><Trash2 size={11} /></button>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => onPatchTrack({ mute: !track.mute })} title={track.mute ? 'Unmute' : 'Mute'}
            className={track.mute ? 'text-danger' : 'text-fg-3 hover:text-fg-1'}>
            {track.mute ? <VolumeX size={11} /> : <Volume2 size={11} />}
          </button>
          <button onClick={() => onPatchTrack({ solo: !track.solo })} title={track.solo ? 'Un-solo' : 'Solo'}
            className={track.solo ? 'text-accent' : 'text-fg-3 hover:text-fg-1'}><Headphones size={11} /></button>
          {/* draft on drag, commit ONCE on pointerup / keyboard release / blur */}
          <input type="range" min={0} max={1.5} step={0.01} value={gainDraft ?? track.gain ?? 1}
            onChange={(e) => setGainDraft(Number(e.target.value))}
            onPointerUp={commitGain} onKeyUp={commitGain} onBlur={commitGain}
            title={`gain ${(gainDraft ?? track.gain ?? 1).toFixed(2)}`} className="flex-1 min-w-0 accent-accent" />
          {/* Which container this track belongs to — the clock is not a detail the user can guess. */}
          <span className="text-micro text-fg-3 shrink-0" title={source === 'bed'
            ? 'The BED — one per project. Rides the show clock: it does NOT restart when a scene is recalled.'
            : "This timeline's own audio. Rides the playhead: it restarts when this timeline does."}>
            {source === 'bed' ? 'BED' : 'TL'}
          </span>
        </div>
      </div>

      {/* body.
          onDragOver preventDefaults UNCONDITIONALLY (the video Lane idiom), not just for an artlux-asset
          drag: this app installs no global dragover/drop guard, so a surface that does not accept a drop
          lets it fall through to the DOCUMENT default — and an OS file dropped there NAVIGATES THE WINDOW
          TO IT, blanking the app. Swallow every drop here; onDropAsset ignores any payload that is not an
          audio library asset. */}
      <div className="relative" style={{ width, height: AUDIO_LANE_H }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDropAsset(e, track.id, source)}
        onPointerDown={(e) => { if (e.button === 0 && e.target === e.currentTarget) onSeek(e.clientX); }}>
        {clips.map(c => (
          <AudioClipBlock key={c.id} clip={c} selected={selectedId === c.id} blade={blade} pxPerSec={pxPerSec}
            source={source} peakTick={peakTick} onStartDrag={onStartDrag} onBlade={onBlade} onRemoveClip={onRemoveClip} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
};
