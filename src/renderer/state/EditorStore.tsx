// The editor's shared state, exposed to panels without prop threading.
//
// WHY THIS EXISTS. The workspace-context shell composes the UI out of panels a context names by id
// (see `WorkspaceContext` in @artlux/sdk/renderer). The shell resolves a panel id to a component and
// renders it — it cannot know that *this* panel wants 25 props and *that* one wants 6, so a panel has
// to fetch what it needs itself. `ScenePanel` alone took 25 props from App before this.
//
// App remains the single owner of the state and of every mutation: this is a distribution mechanism,
// not a state rewrite. App builds `data` + `actions` each render and wraps the shell in <EditorStore>.
//
// TWO CONTEXTS ON PURPOSE — this is the whole perf design:
//   • DataCtx changes whenever App re-renders (same cadence as the props it replaces — no regression).
//   • ActionsCtx NEVER changes identity, so a panel that only dispatches (a toolbar, an action bar)
//     re-renders zero times when unrelated state moves.
// App's 73 handlers are re-created every render and only one is useCallback'd, so handing them out
// directly would defeat every React.memo in the tree. The facade below fixes that without asking App
// to memoize 73 functions.
//
// The renderer repaints per frame during playback: panels reading DataCtx must keep the existing
// discipline (React.memo, local-during-drag + commit-on-release sliders, `services/livePreview.ts`
// for the render-free live channel). Reading state here is not a licence to re-render per frame.

import React, { createContext, useContext, useMemo, useRef } from 'react';
import type { SelectionSnapshot } from '@artlux/sdk/renderer';
import type {
  Surface, Fixture, FixtureGroup, Controller, FixtureTemplate, AppSettings, PatchPolicy,
  Scene, CueBank, StateMachine, Timeline, AssetEntry, AssetType,
} from '../types';
import type { Scene3D, SceneModel, DisplayInfo, ProjectorOutput } from '../../../shared/protocol';
import type { ProjectRefs } from '../services/assetLibrary';
import type { ModelTransform } from '../components/Simulator3D/ModelObject';

// ── Data ────────────────────────────────────────────────────────────────────────────────────
// Read-only view of what App holds. Mirrors App's useState fields; no derived values except
// `selection`, which is the one shape the SDK's panel/action contracts speak.
export interface EditorData {
  // rig
  surfaces: Surface[];
  fixtures: Fixture[];
  groups: FixtureGroup[];
  controllers: Controller[];
  templates: FixtureTemplate[];
  // selection
  selectedSurfaceId: string | null;
  selectedFixtureId: string | null;   // primary — drives the inspector + the on-stage gizmo
  selectedFixtureIds: string[];       // the full set (grouping / batch ops)
  selectedModelId: string | null;
  selection: SelectionSnapshot;
  // outputs + 3D
  projectorOutputs: ProjectorOutput[];
  displays: DisplayInfo[];
  scene3D: Scene3D;
  modelNaturalSizes: Record<string, number>;
  sceneSaved: boolean;
  // media
  assets: AssetEntry[];
  currentProjectPath: string | null;
  // Every place a path can be referenced (live + every scene + every timeline + the bed). Built once
  // in App; the media library's usage badge under-reports without all of it.
  projectRefs: ProjectRefs;
  // show
  timeline: Timeline;                 // the BOUND timeline (a scene's own while authoring one)
  globalTimeline: Timeline;           // the project's own doc — the take library lives on this one
  scenes: Scene[];
  cueBanks: CueBank[];
  stateMachine: StateMachine;
  activeSceneId: string | null;
  // globals
  settings: AppSettings;
  patchPolicy: PatchPolicy;
  globalBrightness: number;
  projectorBrightness: number;
  isVideoPlaying: boolean;
}

// ── Actions ─────────────────────────────────────────────────────────────────────────────────
// Every mutation a panel may perform. Names match App's own handlers so the move is mechanical.
export interface EditorActions {
  // surfaces
  selectSurface(id: string | null): void;
  addSurface(): void;
  removeSurface(id: string): void;
  renameSurface(id: string, name: string): void;
  moveSurface(id: string, dir: 'up' | 'down'): void;
  updateSurface(id: string, patch: Partial<Surface>): void;
  setSurfaces(next: Surface[]): void;
  // fixtures
  selectFixture(id: string | null, additive?: boolean): void;
  selectFixtures(ids: string[]): void;
  selectAllFixtures(): void;
  addFixture(): void;
  removeFixture(id: string): void;
  renameFixture(id: string, name: string): void;
  updateFixture(id: string, patch: Partial<Fixture>): void;
  setFixtures(next: Fixture[]): void;
  autoPatch(): void;
  commitFixture3D(id: string, patch: Partial<Fixture>): void;
  // groups
  createGroup(): void;
  addSelectedToGroup(groupId: string): void;
  removeGroup(groupId: string): void;
  selectGroup(group: FixtureGroup): void;
  applyLookToGroup(group: FixtureGroup): void;
  // controllers
  addController(): void;
  updateController(id: string, patch: Partial<Controller>): void;
  removeController(id: string): void;
  // templates
  saveTemplate(): void;
  addFromTemplate(t: FixtureTemplate): void;
  removeTemplate(id: string): void;
  // 3D scene
  selectModel(id: string | null): void;
  addModel(): void;
  addPlane(): void;
  removeModel(id: string): void;
  updateModel(id: string, patch: Partial<SceneModel>): void;
  commitModel(id: string, t: ModelTransform): void;
  modelNaturalSize(id: string, maxDim: number): void;
  sceneConfig(patch: Partial<Scene3D>): void;
  saveScene(): void;
  // media
  importAssets(type: AssetType): void;
  /** Adopt media copied into assets/ by hand → how many entries were added. */
  scanAssets(): Promise<number>;
  removeAsset(asset: AssetEntry): void;
  relinkAsset(asset: AssetEntry): void;
  useAssetOnSurface(asset: AssetEntry): void;
  dropAssetOnSurface(surfaceId: string, asset: AssetEntry): void;
  collectAssets(): void;
  // globals
  setMasterBrightness(v: number): void;
  setProjectorBrightness(v: number): void;
  pushProjectorBrightness(v: number): void;   // render-free live channel (drag)
  setVideoPlaying(v: boolean): void;
  updateSettings(patch: Partial<AppSettings>): void;
  updatePatchPolicy(patch: Partial<PatchPolicy>): void;
  // show machine
  setStateMachine(sm: StateMachine): void;
  /** Bind a scene's own timeline for authoring (what the timeline's scene pill does). */
  enterAuthorScene(sceneId: string): void;
  // app
  recordHistory(): void;
  saveProject(): void;
  // Run a host menu action by id — the bridge that lets a ContextAction reuse the ~30 functions
  // already wired through App's dispatchMenu (open, save-as, routing, preferences, collect-assets…)
  // instead of re-plumbing them.
  menuAction(action: string): void;
}

const DataCtx = createContext<EditorData | null>(null);
const ActionsCtx = createContext<EditorActions | null>(null);

interface Props { data: EditorData; actions: EditorActions; children: React.ReactNode }

export const EditorStore: React.FC<Props> = ({ data, actions, children }) => {
  // The actions facade. `latest` tracks App's freshly-created handlers every render; the facade
  // hands out PERMANENT wrapper functions that forward to `latest.current` at CALL time.
  //
  // Both halves matter. Forwarding at call time means a memoized panel that never re-renders still
  // calls the handler holding today's state (a plain object of App's handlers would leave it holding
  // a stale closure — the classic bug). Caching the wrapper means the identity a panel puts in a
  // useEffect/useMemo dep array never changes, so nothing re-fires.
  const latest = useRef(actions);
  latest.current = actions;
  const stableActions = useMemo<EditorActions>(() => {
    const cache = new Map<string | symbol, unknown>();
    return new Proxy({} as EditorActions, {
      get(_t, key) {
        if (!cache.has(key)) {
          cache.set(key, (...args: unknown[]) => {
            const fn = (latest.current as unknown as Record<string | symbol, unknown>)[key];
            if (typeof fn !== 'function') { console.warn(`[editor] no action "${String(key)}"`); return undefined; }
            return (fn as (...a: unknown[]) => unknown)(...args);
          });
        }
        return cache.get(key);
      },
    });
  }, []);

  return (
    <ActionsCtx.Provider value={stableActions}>
      <DataCtx.Provider value={data}>{children}</DataCtx.Provider>
    </ActionsCtx.Provider>
  );
};

// Panels use these instead of props. Throwing (rather than returning null) is deliberate: a panel
// rendered outside the shell is a wiring bug, and a silent null would surface as an unrelated crash
// three frames later inside the panel's own body.
export function useEditor(): EditorData {
  const v = useContext(DataCtx);
  if (!v) throw new Error('useEditor() outside <EditorStore> — panels must render inside the shell');
  return v;
}

export function useEditorActions(): EditorActions {
  const v = useContext(ActionsCtx);
  if (!v) throw new Error('useEditorActions() outside <EditorStore> — panels must render inside the shell');
  return v;
}

// ── Selection ───────────────────────────────────────────────────────────────────────────────
// Build the SDK snapshot from App's selection ids. `primary` is what the operator last clicked, in
// the priority App itself enforces: selecting a surface clears the fixture set and vice versa
// (handleSelectSurface / handleSelectFixture), so at most one of the three is live in practice —
// but the shape stays plural so the inspector can show sections for several kinds at once once that
// mutual exclusion is relaxed.
export function buildSelection(
  selectedSurfaceId: string | null,
  selectedFixtureId: string | null,
  selectedFixtureIds: string[],
  selectedModelId: string | null,
): SelectionSnapshot {
  const ids: SelectionSnapshot['ids'] = {};
  if (selectedSurfaceId) ids.surface = [selectedSurfaceId];
  if (selectedFixtureIds.length) ids.fixture = selectedFixtureIds;
  else if (selectedFixtureId) ids.fixture = [selectedFixtureId];
  if (selectedModelId) ids.model = [selectedModelId];
  const primary: SelectionSnapshot['primary'] =
      selectedSurfaceId ? { kind: 'surface', id: selectedSurfaceId }
    : selectedFixtureId ? { kind: 'fixture', id: selectedFixtureId }
    : selectedModelId ? { kind: 'model', id: selectedModelId }
    : null;
  return { kinds: Object.keys(ids) as SelectionSnapshot['kinds'], ids, primary };
}
