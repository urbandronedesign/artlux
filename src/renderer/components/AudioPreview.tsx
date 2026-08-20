import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, AlertTriangle } from 'lucide-react';
import { resolveMediaUrl } from '../services/mediaCache';
import { Tooltip } from './ui/Tooltip';
import { help } from '../services/helpBus';

// Audition an audio asset from the Media library — enough to answer "which file is this?" when the name
// does not, and nothing more. Play/pause, a scrub bar, a clock.
//
// ── IT DOES NOT GO THROUGH THE SHOW'S AUDIO ENGINE, AND THAT IS THE DESIGN ────────────────────────────
// A plain <audio> over `artlux-media://`, so it comes out of the machine's DEFAULT device. Three reasons,
// in order of how much they matter in a venue:
//   · It CANNOT disturb the show. The native engine's master chain is what feeds the rig; an audition on
//     a separate element shares nothing with it — no bus, no voice, no clip id, nothing to collide over.
//     Clicking play here during a live cue does not put a sound in the room.
//   · It works with NO ENGINE. `audioManager` is load-or-null (docs/AUDIO.md's `no audio engine` badge),
//     and identifying a file is authoring work that has no business requiring the native addon.
//   · Chromium decodes wav/flac/ogg/mp3, which is the library's whole audio set bar `.aiff`.
// The trade is real and worth stating: this tells you WHICH file it is, not how it sounds through the rig.
// For that, put it on a lane.
//
// ⚠ ONE ELEMENT, RE-POINTED — never one per asset. The inspector renders for whatever is selected, and a
// library of 300 sounds must not leave 300 media elements (each with a decoder and a connection to the
// media protocol) behind it. `src` changes; the element does not.
export const AudioPreview: React.FC<{ path: string; missing: boolean }> = ({ path, missing }) => {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [failed, setFailed] = useState(false);
  // Drafted while the thumb is down: seeking on every input event is fine for one element, but READING
  // `currentTime` back into the slider mid-drag makes the thumb fight the pointer (the element reports
  // the last position it actually reached, which lags a fast scrub).
  const [scrub, setScrub] = useState<number | null>(null);

  // A new selection must not leave the old file playing under the new one's name. Reset everything the
  // element told us about the OLD source too — a stale duration on a fresh file is a lie the scrub bar
  // would act on.
  useEffect(() => {
    const el = ref.current;
    if (el) { el.pause(); el.currentTime = 0; }
    setPlaying(false); setT(0); setDur(0); setFailed(false); setScrub(null);
  }, [path]);
  // …and neither must unmounting the inspector (switch context, clear the selection, close the panel).
  useEffect(() => () => { ref.current?.pause(); }, []);

  const toggle = () => {
    const el = ref.current; if (!el || failed) return;
    if (el.paused) void el.play().then(() => setPlaying(true)).catch(() => setFailed(true));
    else { el.pause(); setPlaying(false); }
  };
  const seek = (v: number) => { const el = ref.current; if (el) el.currentTime = v; setScrub(v); };

  const clock = (s: number) => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
  const pos = scrub ?? t;

  return (
    <div className="flex items-center gap-2">
      <audio
        ref={ref}
        src={resolveMediaUrl(path)}
        preload="metadata"
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; setDur(Number.isFinite(d) ? d : 0); }}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onEnded={() => { setPlaying(false); setT(0); if (ref.current) ref.current.currentTime = 0; }}
        onError={() => setFailed(true)}
      />
      <Tooltip id="media.audio-preview">
        <button onClick={toggle} disabled={missing || failed} {...help('media.audio-preview')}
          title={failed ? 'This file could not be decoded for preview' : playing ? 'Pause' : 'Preview (plays on the system default device, not the show output)'}
          className="inline-flex items-center justify-center w-6 h-6 rounded border border-line-1 bg-surface-2 hover:bg-surface-3 disabled:opacity-40 text-fg-1 shrink-0">
          {playing ? <Pause size={11} /> : <Play size={11} />}
        </button>
      </Tooltip>
      {failed ? (
        <span className="flex items-center gap-1 text-micro text-warn flex-1 min-w-0">
          <AlertTriangle size={11} className="shrink-0" />
          <span className="truncate">Can’t preview this file — it still plays on a lane if the engine can decode it.</span>
        </span>
      ) : (
        <>
          {/* `dur || 1` — a zero max pins the thumb at the far end and makes the control look broken while
              the metadata is still in flight. `disabled` is what says "not ready", not a degenerate range. */}
          <input type="range" min={0} max={dur || 1} step={0.01} value={Math.min(pos, dur || 1)}
            aria-label="preview position"
            disabled={missing || !dur}
            onChange={(e) => seek(Number(e.target.value))}
            onPointerUp={() => setScrub(null)}
            onBlur={() => setScrub(null)}
            /* The app binds single-key transport shortcuts on the window. Without this, arrowing along
               this slider also drives the SHOW. */
            onKeyDown={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 accent-accent" />
          <span className="text-micro text-fg-3 tabular-nums shrink-0">{clock(pos)} / {clock(dur)}</span>
        </>
      )}
    </div>
  );
};
