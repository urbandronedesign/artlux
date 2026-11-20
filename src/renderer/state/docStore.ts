// ─────────────────────────── THE DOCUMENT STORE — renderer binding ───────────────────────────
//
// The core (shared/docStore.ts) is shape-agnostic and React-free so it can move into the Show Host
// process in W3. This file is where the RENDERER says what the document is and how React reads it.
//
// MIGRATION STATE (plans/native-engine.md §9a, W1). Slices move out of App.tsx's `useState` into
// `DocSlices` one at a time. Each move must be invisible: App keeps its local names (`fixtures`,
// `setFixtures`), and the setter keeps useState's contract — a value OR an updater, a stable identity,
// and a no-op when the value is unchanged — so not one call site, effect dependency or undo path
// changes. verify:invariants fails if a migrated slice reappears as a `useState` in App.tsx.
//
//   migrated: the whole undoable DocSnapshot — fixtures, surfaces, groups, scenes, timeline, cueBanks,
//             stateMachine, audioMix, scene3D, globalBrightness — and the non-undoable project
//             slices: patchPolicy, lightingPoses, colorPalette, schedule, templates, controllers,
//             assets, projectorOutputs, outputSpans, bakes.
//   session:  selectedFixtureId, selectedFixtureIds, selectedSurfaceId, selectedModelId, activeSceneId,
//             isVideoPlaying — in the separate sessionStore (see SessionSlices for why separate).
//   W1 is then complete for App's shared state. Still in App, deliberately: per-window UI state (open
//   modals, docs panel, dialogs) and the projector-UI lists (editing/identify/muted output ids).
//
// WHY App STILL RE-RENDERS ON EVERY CHANGE. useDocSlice() inside App subscribes App to that slice, so
// for now a fixture edit re-renders App exactly as the useState did. That is the point of W1: move the
// state with zero behaviour change. The re-render WIN arrives in W2, when panels read their slice here
// directly and App stops passing it down.

import { useSyncExternalStore } from 'react';
import { createDocStore, type DocStore, type Updater } from '../../../shared/docStore';
import {
  SourceType, defaultTimeline, defaultStateMachine, defaultAudioMix,
  type Fixture, type Surface, type FixtureGroup, type Scene, type CueBank, type Timeline,
  type StateMachine, type AudioMix, type PatchPolicy, type NamedPose, type NamedColor, type FixtureTemplate,
  type Controller, type AssetEntry, type BakeEntry,
} from '../types';
import { defaultScene3D, type Scene3D, type ProjectorOutput, type OutputSpan } from '../../../shared/protocol';

export interface DocSlices {
  // ── The undoable document — exactly App's DocSnapshot, so undo/redo snapshot these ten. ──
  fixtures: Fixture[];
  surfaces: Surface[];
  groups: FixtureGroup[];
  scenes: Scene[];
  timeline: Timeline;
  cueBanks: CueBank[];
  stateMachine: StateMachine;
  audioMix: AudioMix;
  scene3D: Scene3D;
  globalBrightness: number;
  // ── The rest of the project file: persisted, NOT undoable (DocSnapshot leaves them out on purpose). ──
  patchPolicy: PatchPolicy;
  lightingPoses: NamedPose[];
  colorPalette: NamedColor[];
  /** In-project wall-clock schedule; show-control owns the entry shape, so it is opaque here. */
  schedule: unknown[];
  templates: FixtureTemplate[];
  controllers: Controller[];
  assets: AssetEntry[];
  projectorOutputs: ProjectorOutput[];
  outputSpans: OutputSpan[];
  bakes: BakeEntry[];
}

// The initial document — what App's useState initialisers held. Moved here verbatim: a fresh editor
// still opens with one arch on surf-1 and selects 'fix-1'.
const INITIAL: DocSlices = {
  fixtures: [
    {
      id: 'fix-1',
      name: 'Main Arch',
      x: 0.15, y: 0.15, width: 0.7, height: 0.1,
      universe: 0, startAddress: 1, ledCount: 60, reverse: false, rotation: 0,
      colorData: [], surfaceId: 'surf-1'
    }
  ],
  surfaces: [
    { id: 'surf-1', name: 'Surface 1', x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 0, content: { type: SourceType.NONE } },
  ],
  groups: [],
  scenes: [],
  timeline: defaultTimeline(),
  cueBanks: [],
  stateMachine: defaultStateMachine(),
  audioMix: defaultAudioMix(),
  scene3D: defaultScene3D(),
  globalBrightness: 1.0,
  patchPolicy: { reserveLockedRanges: false },
  lightingPoses: [],
  colorPalette: [],
  schedule: [],
  templates: [],
  controllers: [],
  assets: [],
  projectorOutputs: [],
  outputSpans: [],
  bakes: [],
};

// ─────────────────────────────── THE SESSION — shared, never saved ───────────────────────────────
// What every window must agree on WHILE the editor runs, and which is neither the document nor undoable:
// the selection, the bound scene, the transport. It is a SEPARATE store, not more DocSlices, on purpose:
//   • undo snapshots DocSlices, and a click that selects a fixture must never be an undo step;
//   • persistence serialises the document, and the selection must never travel in a .artlux;
//   • in W3 the document is replicated with revisions, while session state is cheaper to resync whole.
// The timeline CLIP selection is not here: it already lives render-free in services/selection.ts.
export interface SessionSlices {
  /** The primary selected fixture: drives the inspector and the stage gizmo. */
  selectedFixtureId: string | null;
  /** The full fixture multi-selection, in click order (a lighting take captures them in this order). */
  selectedFixtureIds: string[];
  selectedSurfaceId: string | null;
  /** The selected 3D model. Selecting a fixture must also clear it (CLAUDE.md, 3D picking). */
  selectedModelId: string | null;
  /** The scene the timeline editor is bound to (null = the global timeline). */
  activeSceneId: string | null;
  /** The transport: drives timelineEngine.setPlaying. */
  isVideoPlaying: boolean;
}

// Moved verbatim from App's useState initialisers: a fresh editor selects the default arch, and plays.
const INITIAL_SESSION: SessionSlices = {
  selectedFixtureId: 'fix-1',
  selectedFixtureIds: ['fix-1'],
  selectedSurfaceId: null,
  selectedModelId: null,
  activeSceneId: null,
  isVideoPlaying: true,
};

/**
 * The two stores. Module singletons, like layoutStore — one per window bundle. ⚠ Import them ONLY from
 * this file's path: a second import path to the same module would duplicate the singleton (the
 * plugin-barrel bug in CLAUDE.md), and writers would hit one copy while readers watch the other.
 */
export const docStore = createDocStore<DocSlices>(INITIAL);
export const sessionStore = createDocStore<SessionSlices>(INITIAL_SESSION);

/** A setter with React's useState contract. Stable: built once per slice, never per render. */
export type SliceSetter<T> = (next: Updater<T>) => void;

// One binding implementation for both stores. Setters AND subscribe functions are cached per key:
// a setter's identity must be stable (App lists them in effect deps exactly as it did useState's), and
// an unstable subscribe would make useSyncExternalStore resubscribe on every render.
function bind<D extends object>(store: DocStore<D>) {
  const setters = new Map<keyof D, SliceSetter<never>>();
  const subs = new Map<keyof D, (fn: () => void) => () => void>();
  const setter = <K extends keyof D>(key: K): SliceSetter<D[K]> => {
    let s = setters.get(key) as SliceSetter<D[K]> | undefined;
    if (!s) { s = (next) => store.set(key, next); setters.set(key, s as SliceSetter<never>); }
    return s;
  };
  const subscribe = (key: keyof D): ((fn: () => void) => () => void) => {
    let s = subs.get(key);
    if (!s) { s = (fn) => store.subscribeSlice(key, fn); subs.set(key, s); }
    return s;
  };
  // Read one slice and re-render when (and only when) it changes.
  const useSlice = <K extends keyof D>(key: K): D[K] =>
    useSyncExternalStore(subscribe(key), () => store.getSlice(key));
  return { setter, useSlice };
}

const doc = bind(docStore);
const session = bind(sessionStore);

/** Read one DOCUMENT slice. */
export const useDocSlice = doc.useSlice;
/** The stable setter for one DOCUMENT slice. */
export const sliceSetter = doc.setter;
/** Read one SESSION slice. */
export const useSessionSlice = session.useSlice;
/** The stable setter for one SESSION slice. */
export const sessionSetter = session.setter;
