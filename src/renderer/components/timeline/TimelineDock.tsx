// THE TIMELINE PANEL, FED FROM THE EDITOR STORE (E5 — the detached timeline).
//
// The timeline used to take two dozen props straight from App: the bound document, its change handler, the
// author strip's handlers, the cue list, the bed, the base automation… A panel window has no App, so this
// builds exactly those props from useEditorPick() and useEditorActions() — the editor's own store in the
// editor, the replica + the editor's actions over the live channel in a panel window (live/panelStore.tsx).
// The SAME adapter in both places, so the two can never disagree about what the timeline is handed.
//
// Every derived prop is memoized: the timeline is React.memo'd (E5/W2), and a fresh object per render would
// reconcile the whole NLE on every unrelated store change.

import React, { useMemo } from 'react';
import { Timeline } from './Timeline';
import { useEditorActions, useEditorPick } from '../../state/EditorStore';
import { GLOBAL_ACCENT } from '../../sceneAccent';
import type { AudioMix, ColorValue } from '../../types';

// An id for a new named colour, made HERE: the timeline points a key at it in the same edit, and a panel
// window cannot wait for the editor to make one (an action's result is a promise there). The same shape
// App's own ids have.
const newId = () => Math.random().toString(36).slice(2, 11);

interface Props {
  /** The editor's full-window timeline (App's own toggle). Absent in a panel window: the window IS the room. */
  maximized?: boolean;
  onToggleMax?: () => void;
}

export const TimelineDock: React.FC<Props> = ({ maximized, onToggleMax }) => {
  const d = useEditorPick('timeline', 'globalTimeline', 'stateMachine', 'isVideoPlaying', 'currentProjectPath', 'scenes', 'cueBanks',
    'groups', 'fixtures', 'fixtureProfiles', 'selectedFixtureIds', 'activeSceneId', 'audioMix', 'colorPalette');
  const a = useEditorActions();

  // The author strip, as App built it (App.tsx timelineAuthor). `holdsAtEnd` mirrors the transport's rule
  // (LOOP WINS — a wrapping clock never reaches an end).
  const author = useMemo(() => {
    const activeScene = d.activeSceneId ? d.scenes.find((s) => s.id === d.activeSceneId) : undefined;
    return {
      activeSceneId: d.activeSceneId,
      activeName: activeScene ? activeScene.name : 'Global',
      activeAccent: activeScene?.accent ?? GLOBAL_ACCENT,
      index: activeScene ? d.scenes.findIndex((s) => s.id === activeScene.id) : -1,
      total: d.scenes.length,
      scenes: d.scenes.map((s) => ({ id: s.id, name: s.name, accent: s.accent, clipCount: s.timeline.clips.length, holdsAtEnd: !!s.timeline.holdAtEnd && !s.timeline.loop })),
      onSelect: (sid: string | null) => a.authorSelect(sid),
      onSave: () => a.saveState(),
      onPrev: () => a.authorStep(-1),
      onNext: () => a.authorStep(1),
      onNew: () => a.createState(),
    };
  }, [d.activeSceneId, d.scenes, a]);
  const cues = useMemo(() => d.cueBanks.flatMap((b) => b.cues.map((c) => ({ id: c.id, name: c.name }))), [d.cueBanks]);
  // (Moved here from App.tsx with the code it explains.)
  // THE BED, handed to the timeline panel — and ONLY while Global is bound.
  //
  // `undefined` while a scene is bound is not a nicety: it is the single line that enforces "never draw
  // the bed against a scene-relative ruler". The bed rides the SHOW clock; while Global is bound the two
  // clocks are the same number (the engine maintains that identity), so the ruler under the bed's lanes is
  // honest. The instant a scene is bound they diverge — the scene restarts, the bed rolls on — and a bed
  // clip drawn at "0:30" on a scene ruler would be a lie about when it is heard. The panel shows the
  // `♪ BED mm:ss` readout instead, and the mixer keeps the (time-independent) faders reachable.
  //
  // ⚠ THE GATE IS `activeSceneId`. DO NOT "FIX" IT into something that asks about the DOCUMENT.
  //
  // The bed rides the SHOW clock and the ruler shows the PLAYHEAD. Recalling any scene goes through
  // swap(scene.id, tl, {transport:'restart'}), which does `mainSeek(timelineStart(t))` — resetting the
  // playhead — while showClock defaults to 'preserve' and the bed rolls serenely on. So the instant a scene
  // is recalled, playhead = 0:00 and showTime = 4:05: DIVERGED, deliberately. That divergence IS the show
  // clock; it is the whole point of the wave.
  //
  // Draw the bed against the ruler there and a clip that is AUDIBLE RIGHT NOW is painted four minutes to the
  // right of the playhead — the precise lie this `undefined` exists to prevent. `activeSceneId == null` (the
  // Global pill) is the only state in which no restart-swap has pulled the two clocks apart. The mixer keeps
  // the (time-independent) faders reachable meanwhile, and the ♪ BED readout says where the bed actually is.
  //
  // (This block used to argue at length against a SECOND predicate, isGlobalDocBound(), which was true under
  // a scene with no timeline of its own. That state was deleted on 2026-07-14 and the predicate collapsed
  // into clocksCoincident(). The conclusion is unchanged; the trap it warned about no longer has a door.)
  //
  // setAudioMix does NOT normalize (host.audio.setMix does); the lane's commits go through the same guard.
  // THE BASE LAYER, FOR THE PANEL TO DRAW. The global timeline's lanes keep driving their parameters
  // underneath every scene (setBaseAutomation, above) — but the panel only ever saw the BOUND document, so
  // the instant a scene was recalled they vanished from the screen while they carried on moving the master.
  // Until now that was masked by a bug: Capture Scene cloned the global lanes INTO the scene, so something
  // was on screen — the wrong lane, on the wrong clock. Stripping that clone (the blocker) fixes the data
  // and empties the panel, so this closes the gap our own fix opened.
  //
  // EMPTY ON THE GLOBAL PILL: there the bound doc IS the base, and drawing it would duplicate every lane.
  // The editor normalizes the mix it is sent (the setAudioMix action).
  const audio = useMemo(
    () => (d.activeSceneId ? undefined : { mix: d.audioMix, onChangeMix: (m: AudioMix) => a.setAudioMix(m) }),
    [d.activeSceneId, d.audioMix, a],
  );
  // THE BASE LAYER under a bound scene (App.tsx baseAutomationProp); empty on the Global pill, where the
  // bound document IS the base.
  const baseAutomation = useMemo(
    () => (d.activeSceneId ? (d.globalTimeline.automation ?? []) : []),
    [d.activeSceneId, d.globalTimeline.automation],
  );
  const onSaveColor = useMemo(() => (value: ColorValue, name: string): string => {
    const id = newId();
    a.saveColor(value, name, id);
    return id;
  }, [a]);

  return (
    <Timeline
      timeline={d.timeline} onChange={a.setTimeline} author={author}
      stateMachine={d.stateMachine} onStateMachineChange={a.setStateMachine}
      playing={d.isVideoPlaying} onTogglePlay={a.togglePlay}
      maximized={maximized} onToggleMax={onToggleMax}
      projectPath={d.currentProjectPath} onRegisterAsset={a.registerAsset}
      scenes={d.scenes} cues={cues} fixtureGroups={d.groups} rigFixtures={d.fixtures} rigProfiles={d.fixtureProfiles}
      selectedFixtureIds={d.selectedFixtureIds} audio={audio} baseAutomation={baseAutomation}
      colorPalette={d.colorPalette} onSaveColor={onSaveColor}
    />
  );
};
