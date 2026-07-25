// The Audio block of a video clip's inspector — the clip's OWN soundtrack (the audio track inside the
// `.mp4`/`.mov` it already points at), not a linked audio clip. There is no path to pick and no lane to
// place: placement is derived from the video clip itself (services/videoAudio.ts), so everything authored
// here is about how it SOUNDS, never about when.
//
// ⚠ DRAFT LOCALLY, COMMIT ONCE — the project's invariant 7. A commit here is a whole-document write plus a
// re-push to the engine; doing it per `pointermove` on the gain slider is sixty of those a second on a live
// show. The slider therefore renders from local state while dragging and writes exactly once, on release.

import React, { useEffect, useState } from 'react';
import { VideoClip, VideoClipAudio } from '../../types';
import { Tooltip } from '../ui/Tooltip';
import { help } from '../../services/helpBus';

interface Props {
  clip: VideoClip;
  onPatch: (patch: Partial<VideoClipAudio>) => void;
}

const ClipAudioInspectorBase: React.FC<Props> = ({ clip, onPatch }) => {
  const a = clip.audio;
  const enabled = a?.enabled !== false;   // ABSENT ⇒ AUDIBLE — the decided default, in every project
  const [gain, setGain] = useState(a?.gain ?? 1);
  // Re-sync the draft when the SELECTION moves to another clip (or the document changes underneath).
  // Keyed on the clip id AND the authored value: a gesture that has already committed must not be undone
  // by this, and a clip swapped under an open inspector must not inherit the previous clip's draft.
  useEffect(() => { setGain(a?.gain ?? 1); }, [clip.id, a?.gain]);

  return (
    <div className="space-y-1.5 pt-1.5 border-t border-line-1">
      <div className="flex items-center justify-between">
        <span className="text-micro font-bold uppercase tracking-wider text-fg-3">Audio</span>
        <Tooltip id="timeline.audio-clip-enable">
          <label className="flex items-center gap-1 text-micro text-fg-2 cursor-pointer" title="Play this clip's own soundtrack" {...help('timeline.audio-clip-enable')}>
            <input type="checkbox" className="accent-accent" checked={enabled}
              // `undefined` rather than `true` when switching back on: absent already means audible, and
              // writing an explicit `true` would put a redundant field in every project file forever.
              onChange={(e) => onPatch({ enabled: e.target.checked ? undefined : false })} />
            On
          </label>
        </Tooltip>
      </div>

      {enabled && (
        <>
          <div className="flex items-center gap-1.5">
            <span className="text-micro text-fg-2 w-9">Gain</span>
            <Tooltip id="timeline.audio-clip-gain">
              <input type="range" min={0} max={1.5} step={0.01} value={gain}
                onChange={(e) => setGain(parseFloat(e.target.value))}
                onPointerUp={() => onPatch({ gain: gain === 1 ? undefined : gain })}
                onKeyUp={() => onPatch({ gain: gain === 1 ? undefined : gain })}
                {...help('timeline.audio-clip-gain')}
                className="flex-1 min-w-0 h-1 accent-accent" />
            </Tooltip>
            <span className="text-micro num text-fg-3 w-8 text-right">{Math.round(gain * 100)}%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-micro text-fg-2 w-9">Offset</span>
            <Tooltip id="timeline.audio-clip-offset">
              <input type="number" step={5} value={a?.offsetMs ?? 0}
                onChange={(e) => { const v = parseFloat(e.target.value); onPatch({ offsetMs: Number.isFinite(v) && v !== 0 ? v : undefined }); }}
                {...help('timeline.audio-clip-offset')}
                className="w-16 bg-surface-0 border border-line-1 rounded text-micro num text-fg-1 px-1 py-0.5 outline-none focus:border-accent" />
            </Tooltip>
            <span className="text-micro text-fg-3">ms</span>
            <Tooltip id="timeline.audio-clip-mute">
              <button
                onClick={() => onPatch({ mute: a?.mute ? undefined : true })}
                title={a?.mute ? 'Un-mute this clip' : 'Mute this clip'}
                {...help('timeline.audio-clip-mute')}
                className={`ml-auto px-1.5 h-4 rounded-sm text-micro font-bold border ${a?.mute ? 'bg-warn text-black border-transparent' : 'text-fg-3 border-line-2 hover:text-fg-1'}`}
              >M</button>
            </Tooltip>
          </div>
          <div className="text-micro text-fg-3 leading-snug">
            Plays through the audio engine on this clip’s own playhead. A file with no audio track is
            simply silent. Offset is added to the machine’s A/V offset in Preferences ▸ Audio.
          </div>
        </>
      )}
    </div>
  );
};

// Memoized: the timeline re-renders every frame during playback, and this panel holds a live drag draft.
export const ClipAudioInspector = React.memo(ClipAudioInspectorBase);
