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
//   next:     shared SESSION state (selection, active scene, transport) — not persisted, not undoable.
//
// WHY App STILL RE-RENDERS ON EVERY CHANGE. useDocSlice() inside App subscribes App to that slice, so
// for now a fixture edit re-renders App exactly as the useState did. That is the point of W1: move the
// state with zero behaviour change. The re-render WIN arrives in W2, when panels read their slice here
// directly and App stops passing it down.

import { useSyncExternalStore } from 'react';
import { createDocStore, type Updater } from '../../../shared/docStore';
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

/**
 * The one store. A module singleton, like layoutStore — one per window bundle. ⚠ Import it ONLY from
 * this file's path: a second import path to the same module would duplicate the singleton (the
 * plugin-barrel bug in CLAUDE.md), and writers would hit one copy while readers watch the other.
 */
export const docStore = createDocStore<DocSlices>(INITIAL);

/** A setter with React's useState contract. Stable: built once per slice, never per render. */
export type SliceSetter<T> = (next: Updater<T>) => void;

const setterCache = new Map<keyof DocSlices, SliceSetter<never>>();
export function sliceSetter<K extends keyof DocSlices>(key: K): SliceSetter<DocSlices[K]> {
  let s = setterCache.get(key) as SliceSetter<DocSlices[K]> | undefined;
  if (!s) {
    s = (next) => docStore.set(key, next);
    setterCache.set(key, s as SliceSetter<never>);
  }
  return s;
}

// Subscribe functions must also be stable, or useSyncExternalStore resubscribes on every render.
const subscribeCache = new Map<keyof DocSlices, (fn: () => void) => () => void>();
function sliceSubscribe(key: keyof DocSlices): (fn: () => void) => () => void {
  let s = subscribeCache.get(key);
  if (!s) {
    s = (fn) => docStore.subscribeSlice(key, fn);
    subscribeCache.set(key, s);
  }
  return s;
}

/** Read one slice and re-render when (and only when) it changes. */
export function useDocSlice<K extends keyof DocSlices>(key: K): DocSlices[K] {
  return useSyncExternalStore(sliceSubscribe(key), () => docStore.getSlice(key));
}
