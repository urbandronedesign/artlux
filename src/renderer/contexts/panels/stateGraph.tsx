import React from 'react';
import { StateGraphEditor } from '../../components/timeline/StateGraphEditor';
import { useEditorPick, useEditorActions } from '../../state/EditorStore';
import { revealEditorBottom } from '../../services/editorShell';

// The Show Machine — in a file of its own because it may open in a panel window (contexts/detachable.tsx),
// and the window's import graph is this file's. What it needs of the editor beyond the document comes
// through seams: the OSC learn and the sender list (services/smOscInbox, fed by live/oscRemote.ts in a
// window) and the editor's timeline drawer (services/editorShell).

// The project-level show machine, as the `machine` context's viewport. Was a centred modal inside the
// timeline; a state graph is an authoring surface that wants the whole window.
//
// `scenes` carries a clip count per scene so the graph can show which states actually have content —
// read straight off each scene's own timeline (every scene owns one; see the Scene type).
export const StateMachineViewport: React.FC = () => {
  const { stateMachine, timeline, scenes, cueBanks } = useEditorPick('stateMachine', 'timeline', 'scenes', 'cueBanks');
  const a = useEditorActions();
  return (
    <StateGraphEditor
      sm={stateMachine}
      markers={timeline.markers ?? []}
      layers={timeline.layers}
      // …plus whether the state ENDS BY HOLDING its last frame, which is what a ⏱ (requireEnd) edge
      // out of it waits for. LOOP WINS in the engine, so a looping timeline never claims to hold.
      scenes={scenes.map((s) => ({ id: s.id, name: s.name, accent: s.accent, clipCount: s.timeline.clips.length, holdsAtEnd: !!s.timeline.holdAtEnd && !s.timeline.loop }))}
      cues={cueBanks.flatMap((b) => b.cues.map((c) => ({ id: c.id, name: c.name })))}
      onChange={a.setStateMachine}
      // Without this, graph edits are invisible to undo AND an unrelated Ctrl+Z silently reverts
      // them (stateMachine is in DocSnapshot). Guarded by verify:invariants.
      onRecordHistory={a.recordHistory}
      // Editing a state's timeline binds that scene and pulls the timeline DRAWER up underneath the
      // graph. It used to switch to the `timeline` context, which took the graph away — the whole
      // point of the drawer is that the state you just wired stays on screen beside its lanes.
      onEditTimeline={(sceneId) => { a.enterAuthorScene(sceneId); revealEditorBottom(); }}
    />
  );
};

