// THE EDITOR STORE, AS A PANEL WINDOW SEES IT (E5/W5).
//
// A docked panel reads useEditor()/useEditorPick() and calls useEditorActions(), all supplied by App
// through <EditorStore>. A panel window has no App, so this supplies the same two things from the two
// channels a client has:
//
//   DATA    = this window's Show Host replica (state/hostLink.ts in its read-only 'panel' role: the
//             document and the session, kept current by the host's patches) + the 'editor.extras'
//             live stream (what App holds outside the stores: resolved fixture profiles, settings,
//             displays, …). Everything else EditorData has is DERIVED here exactly as App derives it.
//   ACTIONS = a remote call: every action runs IN THE EDITOR (live/broker.ts → App's own handler) and
//             the result comes back through the host like any edit. The panel cannot tell the
//             difference, and every rule App's handlers keep (repatch, undo, scene capture) still holds.
//             The two render-free drags (the LED master and projector brightness) are live drags
//             instead, so the editor releases them if this window dies mid-drag.
//
// The panel component is the SAME component the editor docks; nothing in it knows it is detached.

import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { docStore, sessionStore } from '../state/docStore';
import { EditorStore, buildSelection, type EditorActions, type EditorData, type SelectedKinds } from '../state/EditorStore';
import { liveClient } from './client';
import { hostReplicaReady, subscribeReplicaReady } from '../state/hostLink';
import type { EditorExtras } from './coreStreams';
import type { ProjectRefs } from '../services/assetLibrary';

/** The 'editor.extras' stream, as a hook. Null until the editor has answered once. */
function useEditorExtras(): EditorExtras | null {
  const [x, setX] = useState<EditorExtras | null>(null);
  useEffect(() => liveClient.subscribe('editor.extras', null, (v) => setX(v as EditorExtras)), []);
  return x;
}

/** The actions, as remote calls. One function per name, created once (EditorStore caches them too). */
function makeRemoteActions(): EditorActions {
  const fail = (name: string) => (e: Error) => console.warn(`[panel] editor action "${name}" failed:`, e.message);
  // Arguments cross a process boundary, so only what structured-clones can go. The common thing that
  // does not is the click itself: `onClick={a.addFixture}` hands the action React's event, which a
  // docked call ignores and a postMessage refuses — and the refusal used to lose the whole call. An
  // argument that cannot be sent is sent as undefined, which is what such an action ignores anyway.
  const sendable = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
    if (v instanceof Event || 'nativeEvent' in (v as object)) return undefined;
    try { return structuredClone(v); } catch { return undefined; }
  };
  const call = (name: string, args: unknown[]) => liveClient.action(name, args.map(sendable));
  const special: Record<string, (...a: unknown[]) => unknown> = {
    // Render-free drags: the editor's own channel, released by the editor if this window dies.
    pushMasterBrightness: (v) => liveClient.drag({ target: 'ledBrightness', value: Number(v) }),
    pushProjectorBrightness: (v) => liveClient.drag({ target: 'projectorBrightness', value: Number(v) }),
    // Fixture faders: one live drag per channel, so the editor releases each if this window dies.
    pushFixtureChannels: (writes) => { for (const w of writes as Array<{ fixtureId: string; key: string; value: number }>) liveClient.drag({ target: 'fixtureChannel', fixtureId: w.fixtureId, key: w.key, value: w.value }); },
    releaseFixtureChannels: (writes) => { for (const w of writes as Array<{ fixtureId: string; key: string }>) liveClient.drag({ target: 'fixtureChannel', fixtureId: w.fixtureId, key: w.key, value: 0, end: true }); },
    // The release: end the drag, then commit — the same order the docked slider's onInput/onChange has.
    setMasterBrightness: (v) => { liveClient.drag({ target: 'ledBrightness', value: Number(v), end: true }); return call('setMasterBrightness', [v]).catch(fail('setMasterBrightness')); },
    setProjectorBrightness: (v) => { liveClient.drag({ target: 'projectorBrightness', value: Number(v), end: true }); return call('setProjectorBrightness', [v]).catch(fail('setProjectorBrightness')); },
  };
  const cache = new Map<string, unknown>();
  return new Proxy({} as EditorActions, {
    get(_t, key) {
      if (typeof key !== 'string') return undefined;
      if (!cache.has(key)) {
        // A remote action returns a PROMISE of its result. The few actions whose result a docked caller
        // reads synchronously (copySelection, pasteClipboard) are therefore not exact here; none of the
        // detachable panels calls them (contexts/detachable.tsx).
        cache.set(key, special[key] ?? ((...args: unknown[]) => { const p = call(key, args); p.catch(fail(key)); return p; }));
      }
      return cache.get(key);
    },
  });
}

const subscribeDoc = (fn: () => void) => docStore.subscribe(fn);
const subscribeSession = (fn: () => void) => sessionStore.subscribe(fn);

export const PanelEditorStore: React.FC<{ children: React.ReactNode; fallback: React.ReactNode }> = ({ children, fallback }) => {
  const doc = useSyncExternalStore(subscribeDoc, docStore.get);
  const session = useSyncExternalStore(subscribeSession, sessionStore.get);
  const extras = useEditorExtras();
  const ready = useSyncExternalStore(subscribeReplicaReady, hostReplicaReady);
  const actions = useMemo(makeRemoteActions, []);

  const data = useMemo<EditorData | null>(() => {
    if (!extras || !ready) return null;
    const activeScene = session.activeSceneId ? doc.scenes.find((s) => s.id === session.activeSceneId) : undefined;
    // As App builds it (App.tsx projectRefs): the live doc, every captured scene, every timeline, the bed.
    const projectRefs: ProjectRefs = {
      surfaces: [doc.surfaces, ...doc.scenes.map((s) => s.surfaces ?? [])].flat(),
      scene3D: [doc.scene3D, ...doc.scenes.map((s) => s.scene3D)],
      timelines: [doc.timeline, ...doc.scenes.map((s) => s.timeline).filter(Boolean)],
      audioClips: doc.audioMix.clips,
    } as ProjectRefs;
    return {
      surfaces: doc.surfaces, fixtures: doc.fixtures, groups: doc.groups, controllers: doc.controllers,
      templates: doc.templates,
      fixtureProfiles: extras.fixtureProfiles as EditorData['fixtureProfiles'],
      selectedSurfaceId: session.selectedSurfaceId, selectedFixtureId: session.selectedFixtureId,
      selectedFixtureIds: session.selectedFixtureIds, selectedModelId: session.selectedModelId,
      selection: buildSelection(session.selectedSurfaceId, session.selectedFixtureId, session.selectedFixtureIds,
        session.selectedModelId, extras.selectedFixtureKinds as SelectedKinds),
      projectorOutputs: doc.projectorOutputs, displays: extras.displays as EditorData['displays'],
      scene3D: doc.scene3D, modelNaturalSizes: extras.modelNaturalSizes, sceneSaved: extras.sceneSaved,
      assets: doc.assets, currentProjectPath: extras.currentProjectPath, projectRefs,
      timeline: activeScene?.timeline ?? doc.timeline, globalTimeline: doc.timeline,
      scenes: doc.scenes, cueBanks: doc.cueBanks, stateMachine: doc.stateMachine, activeSceneId: session.activeSceneId,
      settings: extras.settings as EditorData['settings'], patchPolicy: doc.patchPolicy,
      globalBrightness: doc.globalBrightness, projectorBrightness: doc.projectorBrightness,
      isVideoPlaying: session.isVideoPlaying,
      colorPalette: doc.colorPalette, audioMix: doc.audioMix,
      autoKeyArmed: extras.autoKeyArmed,
    };
  }, [doc, session, extras, ready]);

  if (!data) return <>{fallback}</>;
  return <EditorStore data={data} actions={actions}>{children}</EditorStore>;
};
