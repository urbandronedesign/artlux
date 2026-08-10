import React, { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } from 'react';
import { Fixture, Surface, SurfaceContent, SourceType, AppSettings, FixtureGroup, Scene, Cue, CueBank, defaultCueBank, normalizeCueBanks, FixtureTemplate, Controller, Timeline, defaultTimeline, normalizeTimeline, StateMachine, SmState, defaultStateMachine, normalizeStateMachine, AudioMix, defaultAudioMix, normalizeAudioMix, timelineAudioClips, timelineAudioTracks, sceneAudioEntries, cueEntries, isAddressableEntry, type AudioClip, type CueEntry, type CueTransition, type TimelineAudio, type AssetEntry, type AssetType, type PatchPolicy, readPatchPolicy, type FixtureProfile, type FixtureKind, type OutputProtocol, type NamedPose, normalizeNamedPoses } from './types';
import { defaultScene3D, defaultProjectorOutput, defaultCornerPin, defaultSoftEdge, WINDOWED_DISPLAY } from '../../shared/protocol';
import type { ProjectorCalibration } from '../../shared/protocol';
import { calibCapture as cam, measureGamma, calibWorkspace, resolveProjectedScene } from '@artlux/plugin-calibration/renderer';
import type { AppInfo, UpdateEvent, Scene3D, SceneModel, ProjectorOutput, OutputSpan, DisplayInfo, SoftEdge, SrcRect } from '../../shared/protocol';
import { spanTiles, tileName } from './services/outputSpan';
import type { ProjectorToMain, MainToProjector } from './projector/bridge';
import { makeBezierWarp } from './projector/warp';
import { outputToNvwarp, toBlendMap } from './projector/nvwarpApply';
import { OutputsPanel } from './components/OutputsPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { UpdateNotice } from './components/UpdateNotice';
import { autoPatch } from './services/addressing';
import { isLight } from './services/fixtureKind';
import { derivedFixtureRect, retrackDerivedRect } from './services/fixtureGeometry';
import { mergeFixtureLook } from './services/sceneLook';
import { spawnPosition3D } from './services/led3dDefaults';
import * as placement from './services/fixturePlacement';
import { About } from './components/About';
import { AudioEngineMissing } from './components/AudioEngineMissing';
import { RoutingModal } from './components/RoutingModal';
import { CueBankPanel } from './components/CueBankPanel';
import { Stage } from './components/Stage';
import Simulator3D from './components/Simulator3D/Simulator3D';
import { useModelUrls } from './components/Simulator3D/useModelUrls';
import type { ModelTransform } from './components/Simulator3D/ModelObject';
import { Timeline as TimelinePanel } from './components/timeline/Timeline';
import { MenuBar } from './components/MenuBar';
import { DocsBrowser } from './components/DocsBrowser';
import { StatusBar } from './components/StatusBar';
import { WorkspaceShell, isDockingOn } from './components/shell/WorkspaceShell';
import { EditorStore, buildSelection, type EditorData, type EditorActions, type SelectedKinds } from './state/EditorStore';
import {
  registerCoreWorkspace, VIEWPORT_STAGE_2D, VIEWPORT_SCENE_3D, VIEWPORT_TIMELINE, VIEWPORT_SCENES,
  VIEWPORT_OUTPUTS, VIEWPORT_MACHINE,
} from './contexts';
import { contextLayoutOf, goToContext } from './contexts/nav';
import {
  ensureTree, findGroupOf, addPanel, setActive, toggleCollapsed, groups as dockGroups,
  type DockManifest,
} from './services/dockTree';
import { configureOutput, addStatusListener } from './services/mockSocketService';
import { perfMonitor } from './services/perfMonitor';
import { notePainted, setFaultProject, SAFE_MODE } from './services/faultReporter';
import { uiPerfMonitor } from './services/uiPerfMonitor';
import { telemetry } from './services/telemetry';
import { useStableHandlers } from './hooks/useStableHandlers';
import { frameEngine, EMPTY_PROFILES as ENGINE_EMPTY_PROFILES } from './engine/frameEngine';
import { UiProfiler } from './components/UiProfiler';
import { getDrawable, getDrawableGeneration, resolveSource } from './services/surfaceMedia';
import { timeline as timelineEngine, GLOBAL_POOL, PROGRAM_LAYER_ID } from './services/timeline';
import * as fixtureSignal from './services/fixtureSignal';
import { planStoreKey, poseForGroup, upsertKey } from './services/lightingStoreKey';
import * as lightingCue from './services/lightingCue';
import { usageForPath, normPath, libraryItems, type ProjectRefs } from './services/assetLibrary';
import { setCoreStateView } from './services/automationTargets.core';
import * as profiles from './services/fixtureProfiles';
import * as timelinePreloader from './services/timelinePreloader';
import { reachableNext } from './services/smLookahead';
import * as bootGate from './services/bootGate';
import * as openTrace from './services/openTrace';
import { nextAccent, GLOBAL_ACCENT } from './sceneAccent';
import * as oscController from './services/oscController';
import { useLayout } from './hooks/useLayout';
import { layoutStore, type WorkspaceLayout } from './services/layoutStore';
import { CALIBRATION_ENABLED } from './services/runProfile';
import { keymap } from './shortcuts/keymapStore';
import { openHelp } from './services/helpNav';
import { openShortcuts } from './services/shortcutsNav';
import { activateRendererPlugins } from './host/plugins';
import { setEnabled as mp4SetEnabled } from '@artlux/plugin-mp4';
import type { RendererHostServices, AutomationTargetProvider, AutomationTargetDef } from '@artlux/sdk/renderer';
import { nextNumberedName } from '@artlux/sdk/renderer';
import { projectorChannelRegistry, panelRegistry, automationTargetRegistry, contextRegistry } from './host/registries';
import * as cueBus from './services/cueBus';
import * as selection from './services/selection';
import * as transitions from './services/transitions';
import { collectFadeableTargets, getByPath, setByPath, isFadeablePath, type StateView } from './services/paramPath';
import { trackingPlayback, trackingDrawable, resetPeopleTracking } from '@artlux/plugin-lidar-tracking';
import * as lightingPlayback from './services/lightingPlayback';
import * as takeRecorder from './services/takeRecorder';
import { Columns2, Maximize2, Minimize2 } from 'lucide-react';
import { useHistory } from './hooks/useHistory';
import { useToast, useConfirm } from './components/ui';

const generateId = () => Math.random().toString(36).substr(2, 9);

// Register the host's own workspace contexts + panels at module scope, i.e. before React mounts and
// before plugins activate. Registration order does not actually matter (contextRegistry.extend queues
// against a context that hasn't registered yet), but doing it here means the rail is populated on the
// very first render instead of after an effect.
registerCoreWorkspace();

// The DMX monitor's panel id — View ▸ DMX Monitor targets it by id now that dock tabs are
// panels rather than the core-only DockTab enum.
const MONITOR_PANEL = 'core.dock.monitor';
const PERF_PANEL = 'core.dock.perf';

const ROUTING_PANEL = 'core.dock.routing';

// Open a dock panel by id from outside the shell (a keyboard shortcut, a launch flag). Not every
// context carries every dock panel, so if the active one doesn't, switch to the first context that
// does — otherwise the shortcut would open the dock onto a tab that isn't there.
//
// ⚠ IT HAS TO WRITE THE TREE, NOT JUST `dockPanel` — AND THAT IS THE HALF THAT WAS MISSING.
// `contexts[id].dockPanel` is read by the hand-built shell every render, but under DOCKING (the
// default) it is only a COMPILE-TIME hint: `defaultTreeOf` consults it once, when a context has no
// banked tree yet, and `mergePluginPanels` never looks at it at all. So every reveal — View ▸ OSC
// Monitor, View ▸ DMX Monitor, `?perf=1` — switched to the right workbench and then left the dock on
// whatever tab it was already showing, which reads exactly like "that panel does not exist".
function openDockPanel(panelId: string): void {
  const L = layoutStore.get();
  const active = contextRegistry.get(L.activeContext);
  if (!active?.dock?.includes(panelId)) {
    const owner = contextRegistry.all().find((c) => c.dock?.includes(panelId));
    if (owner) goToContext(owner.id);
  }
  const now = layoutStore.get();
  layoutStore.set({
    dockOpen: true,
    contexts: { ...now.contexts, [now.activeContext]: { ...now.contexts[now.activeContext], dockPanel: panelId } },
  });
  if (!isDockingOn(now)) return;   // the fallback shell renders `dockPanel` directly — nothing more to do
  const ctx = contextRegistry.get(now.activeContext);
  if (!ctx) return;
  const l = layoutStore.get();
  // ensureTree is the single door (never `layout.dockTrees[id]` raw): sanitize what was banked, else
  // compile the shipped arrangement — with this panel as the dock's active tab either way.
  let tree = ensureTree(l.dockTrees?.[ctx.id], ctx as unknown as DockManifest, {
    leftWidth: l.leftWidth, rightWidth: l.rightWidth, dockHeight: l.dockHeight, dockPanel: panelId,
  });
  // The operator may have CLOSED this tab (it then sits in `removed[]`, which merge deliberately
  // respects). Asking for it by name is them asking for it back, so put it in the dock group.
  if (!findGroupOf(tree, panelId)) {
    tree = addPanel(tree, panelId, dockGroups(tree).find((g) => g.region === 'dock')?.id);
  }
  const g = findGroupOf(tree, panelId);
  if (!g) return;
  tree = setActive(tree, g.id, panelId);
  if (g.collapsed) tree = toggleCollapsed(tree, g.id);
  layoutStore.setDockTree(ctx.id, tree);
}

// Broadcast (show) mode: launched hidden via `--broadcast` (see main/index.ts). Renders only
// the Stage engine + the projector outputs from the loaded project — no editor chrome.
const QS = new URLSearchParams(window.location.search);
const BROADCAST = QS.get('broadcast') === '1';
// Headless (`--headless`) now boots this same App entry (see main/index.ts), not the retired
// headless.tsx fork — so the plugin host + show engine + schedule tick + media playback all run.
// It behaves exactly like BROADCAST except it suppresses projector/NDI output (see the reconciler
// gates below): headless = hidden compute + Art-Net only, the historical headless contract.
const HEADLESS = QS.get('headless') === '1';
// True for both hidden run modes — used to share the offscreen-Stage render branch + project loader.
const SHOW_ENGINE = BROADCAST || HEADLESS;

// Who caused a state change. Threaded into the two functions that both an operator AND the show can
// reach (handleRecallScene, applyCues, fireColumn). ONLY an 'operator' edit may push undo history —
// a show event (FSM hop, cue GO, OSC, tablet, scheduler) must never, or an unattended install fills
// the undo stack with changes nobody made. DEFAULT IS 'show' at every such call site: a caller that
// forgets the argument records NOTHING, which is the safe failure. See plans/timeline-undo.md §5.2.
type EditOrigin = 'operator' | 'show';

// A snapshot of the UNDOABLE document — the authored slices Ctrl+Z reverts, whole and untorn. This is
// a renderer-local interface: NEVER persisted, NEVER sent over IPC, so it adds no .artlux schema
// change and no migration. Deliberately NOT ProjectData: controllers, projectorOutputs/outputSpans,
// the managed asset library, the schedule and machine settings are excluded — reverting a projector
// calibration or a controller mapping mid-show is a footgun, not a feature. See plans/timeline-undo.md.
interface DocSnapshot {
  fixtures: Fixture[]; surfaces: Surface[]; groups: FixtureGroup[];
  scenes: Scene[];              // each Scene carries its OWN cloned Timeline
  timeline: Timeline;           // the global doc
  cueBanks: CueBank[]; stateMachine: StateMachine; audioMix: AudioMix;
  scene3D: Scene3D; globalBrightness: number;
}
const QUERY_PROJECT = QS.get('project') || '';
const QUERY_NEW_PROJECT = QS.get('newProject') || '';
// Perf HUD debug flag: `?perf=1` forces it on; otherwise it persists via localStorage (toggle: Ctrl+Alt+P).
const PERF_FLAG = QS.get('perf') === '1';

// The empty bound-timeline audio container, for a document saved before Timeline.audio existed
// (timelineEngine.getBoundAudio() → undefined). A MODULE-SCOPE CONSTANT, deliberately, and it must stay
// one: host.audio.getTimelineAudio() is called by the audio driver EVERY FRAME, and the driver's orphan
// detector gates on the clip array's IDENTITY (plugin.renderer.ts pruneOrphans). Returning a fresh
// `{ tracks: [], clips: [] }` per call would hand it two brand-new arrays 60×/s, so the gate could never
// short-circuit — it would rebuild its live-id Set and re-run the load pass on every frame, forever, on
// exactly the legacy document this fallback exists to serve. Frozen so no consumer can mutate the shared
// instance into a live container.
const EMPTY_TIMELINE_AUDIO: TimelineAudio = Object.freeze({
  tracks: Object.freeze([]) as unknown as TimelineAudio['tracks'],
  clips: Object.freeze([]) as unknown as TimelineAudio['clips'],
});

const DEFAULT_SETTINGS: AppSettings = {
  artNetIp: '127.0.0.1',
  artNetPort: 6454,
  outputEnabled: true,
  broadcast: false,
  gamma: 1.0,
  protocol: 'artnet',
  fps: 44,
  keepAlive: true,
  artNetSync: false,
  oscEnabled: false,
  oscListenPort: 10000,
  oscListenAddress: '',
  oscControlPrefix: '/artlux',
  helpLang: 'en'
};

const App: React.FC = () => {
  // In-app feedback (replaces blocking native window.confirm/alert). See components/ui/feedback.
  const toast = useToast();
  // …and a live mirror, for the []-deps host installs below (takeRecorder speaks its refusals through
  // toasts, and is armed from surfaces that are not in App's React subtree). The provider memoizes its
  // api today, but a service must not depend on another module keeping that promise.
  const toastRef = useRef(toast); toastRef.current = toast;
  const confirm = useConfirm();
  // Fixtures are now a plain state slice (they used to BE the history hook's present). The document
  // history that Ctrl+Z drives is the separate stack below, which snapshots fixtures alongside every
  // other authored slice. recordHistory / undo / redo are defined further down (after every slice it
  // snapshots is in scope) — see the "document history" block.
  const [fixtures, setFixtures] = useState<Fixture[]>([
    {
      id: 'fix-1',
      name: 'Main Arch',
      x: 0.15, y: 0.15, width: 0.7, height: 0.1,
      universe: 0, startAddress: 1, ledCount: 60, reverse: false, rotation: 0,
      colorData: [], surfaceId: 'surf-1'
    }
  ]);
  // The ONE document-history primitive (undo/redo). Holds only past/future snapshots; the live
  // document is assembled from the slices into docRef below.
  const { record: historyRecord, undo: historyUndo, redo: historyRedo, reset: resetHistory } = useHistory<DocSnapshot>();

  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>('fix-1');
  // Full multi-selection set (for grouping/bulk ops); selectedFixtureId is the "primary"
  // member that drives the inspector + on-stage transform gizmo.
  const [selectedFixtureIds, setSelectedFixtureIds] = useState<string[]>(['fix-1']);
  // Live mirror of fixtures for the global keydown handler (avoids stale closure).
  const fixturesRef = useRef<Fixture[]>(fixtures);
  fixturesRef.current = fixtures;
  // …and of the selection, for services/takeRecorder: a lighting take captures exactly these fixtures
  // IN THIS ORDER, and the recorder is armed from a status chip and a keyboard shortcut that are not
  // inside any React subtree of App.
  const selectedFixtureIdsRef = useRef<string[]>(selectedFixtureIds);
  selectedFixtureIdsRef.current = selectedFixtureIds;
  // ── DMX fixture profiles in play ──────────────────────────────────────────────────────────────
  // Resolved from the open project's embedded copies, the operator's own profiles and the bundled
  // library (services/fixtureProfiles owns that precedence). Held as state, not a ref, because a
  // profiled fixture's DMX FOOTPRINT comes from here — so the patch, the collision detector and the
  // packer must all re-derive when it changes.
  const [fixtureProfiles, setFixtureProfiles] = useState<ReadonlyMap<string, FixtureProfile>>(profiles.snapshot());
  useEffect(() => profiles.subscribe(() => setFixtureProfiles(profiles.snapshot())), []);
  // Pull in whatever the current rig references. Cheap and idempotent: already-resolved ids and
  // in-flight manufacturers cost nothing, so running it on every fixture change is fine.
  useEffect(() => {
    const ids = fixtures.filter(isLight).map(f => f.profileId as string);
    if (ids.length) void profiles.ensureLoaded(ids);
  }, [fixtures]);
  const fixtureProfilesRef = useRef(fixtureProfiles);
  fixtureProfilesRef.current = fixtureProfiles;
  const [surfaces, setSurfaces] = useState<Surface[]>([
    { id: 'surf-1', name: 'Surface 1', x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 0, content: { type: SourceType.NONE } },
  ]);
  const [selectedSurfaceId, setSelectedSurfaceId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  // Patch policy — SHOW state (it addresses this project's fixtures), not machine state. It used to live in
  // AppSettings, which no longer travels in the project file.
  const [patchPolicy, setPatchPolicy] = useState<PatchPolicy>({ reserveLockedRanges: false });
  const [isVideoPlaying, setIsVideoPlaying] = useState(true);
  const [globalBrightness, setGlobalBrightness] = useState(1.0);
  const [groups, setGroups] = useState<FixtureGroup[]>([]);
  // THE POSE LIBRARY — project-level, not per-Timeline, because a cue fired from the tablet or a
  // state's entry action belongs to no timeline at all. It also means a look used in five scenes is
  // stored once. Shared by pose CUES and by keyframes that carry a `poseRef`.
  const [lightingPoses, setLightingPoses] = useState<NamedPose[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [cueBanks, setCueBanks] = useState<CueBank[]>([]);
  // In-project wall-clock schedule (show-control plugin owns the entry shape; opaque here). Persisted
  // in ProjectData.schedule and exposed to the plugin read/write via the host `show` service below.
  const [schedule, setSchedule] = useState<unknown[]>([]);
  // Global audio bed (ProjectData.audio → AudioMix): tracks/clips/buses that ride the main transport
  // playhead, played by the native engine (plugins/audio). Survives scene swaps.
  const [audioMix, setAudioMix] = useState<AudioMix>(defaultAudioMix());
  const [templates, setTemplates] = useState<FixtureTemplate[]>([]);
  const [controllers, setControllers] = useState<Controller[]>([]);
  // Editor layout lives in the workspace store (persisted to prefs, hydrated on boot). Destructure with
  // the old local names + setter shims that preserve the useState API (a value OR an updater fn), so
  // every existing call site below is unchanged. Split view is included; the calibration wizard turns it on.
  const L = useLayout();
  const { dockOpen, splitView, splitRatio, timelineMax, showLeft: showLeftPanel, showRight: showRightPanel } = L;
  const setLayoutField = <K extends keyof WorkspaceLayout>(k: K) =>
    (v: WorkspaceLayout[K] | ((p: WorkspaceLayout[K]) => WorkspaceLayout[K])) =>
      layoutStore.set({ [k]: typeof v === 'function' ? (v as (p: WorkspaceLayout[K]) => WorkspaceLayout[K])(layoutStore.get()[k]) : v } as Partial<WorkspaceLayout>);
  const setDockOpen = setLayoutField('dockOpen');
  const setDockHeight = setLayoutField('dockHeight');
  const setSplitView = setLayoutField('splitView');
  const setSplitRatio = setLayoutField('splitRatio');
  // Calibration's session state lives in the PLUGIN (calibWorkspace) since the `calib` context took
  // ownership. App only reads it, to feed the embedded 3D its pick props and to let the projector
  // reconciler know which output the wizard is currently driving.
  const calib = useSyncExternalStore(calibWorkspace.subscribe, calibWorkspace.getState);
  const calibratingOutputId = calib.target;
  // Is the 3D pane on screen right now? (The 3D context, or any split-view context.)
  const scene3dVisible = splitView || contextRegistry.get(L.activeContext)?.viewport === VIEWPORT_SCENE_3D;
  // LAZY, THEN STICKY. Unlike Stage (which must never unmount — it feeds Art-Net), the 3D canvas has no
  // such constraint, and it MUST NOT mount before it is first shown: r3f initializes its raycaster and
  // event layer against the canvas's size at mount, and a canvas born in a 0×0 hidden pane never
  // recovers working hit-testing when the pane later grows — every click misses, so fixtures can't be
  // selected. So we withhold it until the first time it's visible (correct, non-zero init), then keep
  // it mounted (no GLB reload / WebGL-context churn on later switches); `paused` idles it while hidden.
  const scene3dMountedRef = useRef(false);
  if (scene3dVisible) scene3dMountedRef.current = true;
  const scene3dMounted = scene3dMountedRef.current;
  // Maximize / restore the timeline. Restoring MUST also open the drawer: the drawer is where the
  // timeline docks, so F-then-F into a closed drawer would look like the timeline vanished.
  const setTimelineMax = (v: boolean) => layoutStore.set(v ? { timelineMax: true } : { timelineMax: false, bottomOpen: true });
  // Docs Browser panel (local UI state — not persisted in the layout yet).
  const [docsOpen, setDocsOpen] = useState(false);
  const [docsWidth, setDocsWidth] = useState(480);
  const setShowLeftPanel = setLayoutField('showLeft');
  const setShowRightPanel = setLayoutField('showRight');
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [aboutOpen, setAboutOpen] = useState(false);
  // null = not probed yet, or the probe failed. ONLY an explicit false raises the alarm: a false "you have
  // no sound" would be worse than the defect it reports.
  const [audioAvailable, setAudioAvailable] = useState<boolean | null>(null);
  const [audioWarnDismissed, setAudioWarnDismissed] = useState(false);
  const [openModals, setOpenModals] = useState<Set<string>>(new Set()); // plugin modal panels open by id
  const [update, setUpdate] = useState<UpdateEvent | null>(null);
  const [updateUserInitiated, setUpdateUserInitiated] = useState(false);
  const [scene3D, setScene3D] = useState<Scene3D>(defaultScene3D());
  const scene3DRef = useRef(scene3D); scene3DRef.current = scene3D; // live mirror for the []-deps tracking bridge
  const settingsRef = useRef(settings); settingsRef.current = settings; // live mirror for host.settings service
  // Embedded 3D scene (split view): model GLB urls + selection/natural-size.
  const modelUrls = useModelUrls(scene3D.models);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [modelNaturalSizes, setModelNaturalSizes] = useState<Record<string, number>>({});
  const [timeline, setTimeline] = useState<Timeline>(defaultTimeline());
  // Per-scene decoupled timelines: the editor binds to ONE timeline at a time — the scene currently
  // being authored (its own `scene.timeline`) or the shared global `timeline` when none is (null).
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  // Project-level "Show" state machine over scenes (lives outside the timeline; runs on a standalone
  // clock via the engine — see services/timeline.ts setStateMachine).
  const [stateMachine, setStateMachine] = useState<StateMachine>(defaultStateMachine());
  const [assets, setAssets] = useState<AssetEntry[]>([]); // managed media library (video/image/model)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  // The scene currently being authored and the timeline the editor is bound to. `activeTimeline` is
  // the scene's own timeline when authoring, else the shared global one — the single doc the timeline
  // panel shows/edits and the engine plays for the active pool.
  const activeScene = activeSceneId ? scenes.find(s => s.id === activeSceneId) ?? null : null;
  const activeTimeline: Timeline = activeScene?.timeline ?? timeline;
  // Every timeline in the project — the global one plus each scene's own. Asset-usage counting must
  // see ALL of them or deleting an asset used only inside a scene reports "unused".
  const allTimelines = useMemo(
    () => [timeline, ...scenes.map(s => s.timeline).filter((t): t is Timeline => !!t)],
    [timeline, scenes],
  );
  // EVERY place an asset path can live, in one memo — the input to asset-usage counting (the badge in
  // the Media Library, the delete confirmation, and Relink's reference count). It must span the LIVE
  // doc AND every captured scene's snapshot AND the audio bed: `count === 0` is what makes
  // handleRemoveAsset skip its confirm dialog entirely, so a reference this list can't see is an asset
  // deleted with no warning while it is still on air. Ids repeat across scenes (Capture Scene aliases
  // them) — usageIndex dedupes with a Set. Memoized because MediaPanel is an always-mounted sidebar
  // that rebuilds the index on every App state change.
  const projectRefs = useMemo<ProjectRefs>(() => ({
    surfaces: [surfaces, ...scenes.map(s => s.surfaces ?? [])].flat(),
    scene3D: [scene3D, ...scenes.map(s => s.scene3D)],
    timelines: allTimelines,
    audioClips: audioMix.clips,
  }), [surfaces, scenes, scene3D, allTimelines, audioMix]);
  // Live mirrors for []-deps engine subscriptions (FSM look-ahead preload) — see below.
  const scenesRef = useRef(scenes); scenesRef.current = scenes;
  const cueBanksRef = useRef(cueBanks); cueBanksRef.current = cueBanks;
  const scheduleRef = useRef(schedule); scheduleRef.current = schedule;
  const stateMachineRef = useRef(stateMachine); stateMachineRef.current = stateMachine;
  const audioMixRef = useRef(audioMix); audioMixRef.current = audioMix; // live mirror for host.audio (memo has [] deps)
  const activeSceneIdRef = useRef(activeSceneId); activeSceneIdRef.current = activeSceneId;
  // The GLOBAL document. Read by the plugin write path below when a scene that has NO timeline of its own
  // is bound: `activeTimeline` is the global doc there, so that is the doc its first edit materializes from.
  const timelineRef = useRef(timeline); timelineRef.current = timeline;
  // The BOUND document (the active scene's timeline, else the global one) — for services/takeRecorder,
  // which appends a finished take to whichever document the operator was recording into. Safe as a
  // render-assigned ref for that caller and only that caller: see the warning immediately below, and the
  // matching one on TakeHost. `Timeline.tsx` reads the same value the same way, through its own
  // `timelineRef`/`onChangeRef`, so extracting the commit changes nothing about when it is read.
  const activeTimelineRef = useRef(activeTimeline); activeTimelineRef.current = activeTimeline;
  // NB: the transport-intent subscription below deliberately does NOT read the editor binding through
  // a render-assigned ref (activeTimeline / handleTimelineChange). Those refs are refreshed on RENDER,
  // and an FSM `setLoop` entry action runs synchronously inside the very frame whose scene recall only
  // QUEUED setActiveSceneId — so they would still describe the timeline the machine just LEFT. It asks
  // the engine (activePoolKey(), already repointed by swap()) instead. See the 'loop' intent below.
  // Live FSM readback for the host `show` service (the show-control tablet polls getStatus()).
  const currentSmStateRef = useRef<string | null>(null);
  const lastFiredTransitionRef = useRef<string | null>(null);

  // Projector outputs: per-surface fullscreen on a physical display.
  const [projectorOutputs, setProjectorOutputs] = useState<ProjectorOutput[]>([]);
  // How a source surface was cut into overlapping SLICE surfaces (one picture across several
  // projectors). Authoring metadata only — the truth lives on the member surfaces and their outputs;
  // see shared/protocol OutputSpan.
  const [outputSpans, setOutputSpans] = useState<OutputSpan[]>([]);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  // Surfaces whose corners/mesh are being aligned. A SET, not one id: aligning a span means putting
  // the grid up on every projector of the wall AT ONCE, which is the only way to judge where the
  // overlaps actually land. Toggling one output adds/removes it; Esc in a window removes just that one.
  const [editingOutputIds, setEditingOutputIds] = useState<string[]>([]);
  // Outputs currently SHOUTING THEIR NAME at the wall (see projector/bridge.ts 'identify'). A set for
  // the same reason aligning is: the question is "which of these six is which", and answering it one
  // projector at a time means walking back to the desk between each.
  //
  // Deliberately App state and NOT part of ProjectorOutput: identify is a thing you do while rigging,
  // and anything persisted here could be saved on and then come up over a show.
  const [identifyOutputIds, setIdentifyOutputIds] = useState<string[]>([]);
  const [projectorFpsCap, setProjectorFpsCap] = useState(0); // performance mode: 0 = uncapped
  const [projectorBrightness, setProjectorBrightness] = useState(1); // master brightness of projected content (separate from LED brightness)
  const projectorPortsRef = useRef<Map<string, MessagePort>>(new Map()); // surfaceId -> port
  const openProjectorsRef = useRef<Map<string, number>>(new Map());      // surfaceId -> displayId (open windows)
  const ndiSendersRef = useRef<Set<string>>(new Set());                  // surfaceIds with a live NDI sender
  const [nvAvailable, setNvAvailable] = useState(false);                 // NVAPI scanout warp/blend present (Quadro/RTX-pro)
  const nvAppliedRef = useRef<Map<string, number>>(new Map());           // surfaceId -> displayId with a live NVAPI warp/blend
  const surfacesRef = useRef<Surface[]>(surfaces);                        // live mirror for the frame pump
  surfacesRef.current = surfaces;
  // The automation engine samples curves inside the frame loop and lays them over committed state
  // WITHOUT re-rendering React, so its view of the world has to be a live ref, not a captured value.
  const brightnessRef = useRef(globalBrightness); brightnessRef.current = globalBrightness;
  useEffect(() => {
    setCoreStateView(() => ({
      surfaces: surfacesRef.current, fixtures: fixturesRef.current, globalBrightness: brightnessRef.current,
      // The target picker needs these to enumerate a profiled fixture's channels and size their step.
      profiles: fixtureProfilesRef.current,
    }));
  }, []);

  // ─────────────────────────────── DOCUMENT HISTORY (undo / redo) ───────────────────────────────
  // The live snapshot of the undoable document — reassembled every render (cheap: ~10 pointer reads
  // into a fresh object, no clone). record()/undo()/redo() read THIS ref, so they capture the current
  // COMMITTED state without needing a live mirror per slice. Because every writer of these slices
  // updates immutably, the references it holds are never mutated out from under it.
  const docRef = useRef<DocSnapshot>({
    fixtures, surfaces, groups, scenes, timeline, cueBanks, stateMachine, audioMix, scene3D, globalBrightness,
  });
  docRef.current = { fixtures, surfaces, groups, scenes, timeline, cueBanks, stateMachine, audioMix, scene3D, globalBrightness };

  // Restore a snapshot by fanning its slices back out to the owning setters. Every imperative service
  // re-syncs FOR FREE off these setters — surfaceMedia/contentSource/timelineEngine and the GPU LED
  // mapper are all useEffect-keyed on this state (see Stage.tsx and the effects below), and restoring a
  // scene/timeline re-fires the engine + projector fan-out via the [activeTimeline, activeSceneId]
  // effect — so an undo needs no imperative re-init. Setting a slice to an unchanged reference is a
  // no-op (React bails on Object.is), so an undo that touched one slice does not churn the others.
  const applySnapshot = useCallback((d: DocSnapshot) => {
    setFixtures(d.fixtures);
    setSurfaces(d.surfaces);
    setGroups(d.groups);
    setScenes(d.scenes);
    setTimeline(d.timeline);
    setCueBanks(d.cueBanks);
    setStateMachine(d.stateMachine);
    setAudioMix(d.audioMix);
    setScene3D(d.scene3D);
    setGlobalBrightness(d.globalBrightness);
  }, []);

  // The SHOW_ENGINE gate lives here: broadcast/headless has no operator and no editor UI, so the undo
  // stack must not exist there — an FSM hopping states all night would otherwise fill it with changes
  // nobody made (plans/timeline-undo.md §5.2). recordHistory captures the PRE-mutation document (this
  // render's docRef reflects state before a handler's setState); undo/redo swap it for a neighbour.
  const recordHistory = useCallback(() => {
    if (SHOW_ENGINE) return;
    historyRecord(docRef.current);
  }, [historyRecord]);
  const undo = useCallback(() => {
    if (SHOW_ENGINE) return;
    const prev = historyUndo(docRef.current);
    if (prev) applySnapshot(prev);
  }, [historyUndo, applySnapshot]);
  const redo = useCallback(() => {
    if (SHOW_ENGINE) return;
    const next = historyRedo(docRef.current);
    if (next) applySnapshot(next);
  }, [historyRedo, applySnapshot]);
  // ──────────────────────────────────────────────────────────────────────────────────────────────
  // The GLOBAL timeline's lanes run as a BASE under every scene: the audio bed is global and survives
  // scene swaps, so its curves must too. A scene's own lane on the same targetPath shadows the base one.
  useEffect(() => { timelineEngine.setBaseAutomation(timeline.automation ?? []); }, [timeline.automation]);
  // The GLOBAL timeline is the SHOW clock's document: its in/out region and its Length bound the bed and
  // the base automation layer, and its `loop` is what makes the SHOW loop. The engine's `data` is always
  // the BOUND doc, so it has no other way to see this.
  //
  // ⚠ THE DECLARATION SITE IS DELIBERATE: here, beside setBaseAutomation — NOT down in the setData /
  // setPlaying window below, where the declaration order of those two effects is load-bearing and
  // inserting anything between them silently kills setData's clampPlayheadIntoDoc guard.
  useEffect(() => { timelineEngine.setGlobalDoc(timeline); }, [timeline]);
  // A lane is only evaluated while its TARGET exists — and the audio bed is not the timeline, so editing
  // it (adding a clip, deleting an effect) fires none of the engine's compile hooks. Recompile here, or a
  // lane whose target just vanished would keep sampling a dead path, and one whose target just appeared
  // would never wake up.
  useEffect(() => { timelineEngine.recompileAutomation(); }, [audioMix]);

  const [isBridgeConnected, setIsBridgeConnected] = useState(false);
  // renderFps and outputStats are NOT App state — they are 1 Hz telemetry for one corner of the status
  // bar, and holding them here re-rendered the whole editor twice a second while idle. They live in
  // services/telemetry; StatusBar subscribes. See the note in that file before moving them back.
  const frameCount = React.useRef(0);
  const lastTime = React.useRef(performance.now());
  // Renderer frame-time metrics live in the Performance dock tab (editor only). Broadcast has no chrome
  // and uses the console line + Prometheus gauges instead. `?perf=1` opens that tab on launch.
  useEffect(() => { if (PERF_FLAG) openDockPanel(PERF_PANEL); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unsubscribe = addStatusListener((status) => {
        setIsBridgeConnected(status);
    });
    const unsubStats = window.artlux?.onDmxStats?.((s) => telemetry.setOutputStats(s));
    return () => {
        unsubscribe();
        unsubStats?.();
    };
  }, []);

  // Push output settings to the native transport whenever they change.
  useEffect(() => {
    configureOutput(settings);
  }, [settings.outputEnabled, settings.broadcast, settings.artNetIp, settings.artNetPort, settings.fps, settings.keepAlive, settings.artNetSync]);

  // (Live input lifecycle — camera/Spout/DMX-in — is owned by services/surfaceMedia,
  // driven by surface content in the Stage.)

  // ── Feeding the render/output engine ──────────────────────────────────────────────────────────
  // App owns the document, so App tells the engine what the document says. This used to be a dozen
  // ref-mirroring effects inside the Stage, which meant the engine's inputs arrived through a
  // component — and in headless we mounted a hidden 1×1 Stage purely to keep that pipe open.
  //
  // The engine diffs internally, so pushing everything on every change is the intended usage: it works
  // out for itself that moving a fixture rebuilds GPU buffers while changing its intensity does not.
  useEffect(() => {
    frameEngine.setInputs({
      surfaces, fixtures, controllers,
      fixtureProfiles: fixtureProfiles ?? ENGINE_EMPTY_PROFILES,
      gamma: settings.gamma,
      brightness: globalBrightness,
      targetIp: settings.artNetIp,
      broadcast: settings.broadcast,
      protocol: settings.protocol,
      outputEnabled: settings.outputEnabled,
      artNetPort: settings.artNetPort,
      // Engine tick rate — and therefore the decode ask rate. See AppSettings.engineFps.
      engineFps: settings.engineFps ?? 30,
      engineRunning: true,
      videoPlaying: isVideoPlaying,
      // Broadcast/headless have no visible composite, and compositing is dead work there on the
      // WebGPU path (fixtures sample per-surface, not the composite).
      showPreview: !SHOW_ENGINE,
    });
  }, [surfaces, fixtures, controllers, fixtureProfiles, settings, globalBrightness, isVideoPlaying]);

  // The one thing the engine hands back: a surface auto-fitted to its content's aspect ratio.
  useEffect(() => { frameEngine.setHost({ onSurfacesAutoFitted: setSurfaces }); }, []);


  useEffect(() => {
    // No operator in broadcast/headless — the global undo/redo/select keybindings have no place there,
    // and undo()/redo() are no-ops in that mode anyway (see the SHOW_ENGINE gate above).
    if (SHOW_ENGINE) return;
    const handleKeyDown = (e: KeyboardEvent) => {
        // A text field owns Ctrl+Z / Ctrl+Y for its OWN native undo/redo — do not hijack it to revert the
        // whole document while someone is un-typing a character in the Length field or a marker note.
        // Same predicate the selectAll branch and useTimelineKeys use. (Requirement: plans/timeline-undo.md.)
        const el = e.target as HTMLElement | null;
        const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        // Bindings resolve through the keymap (registry defaults + the user's saved overrides). redo is
        // checked before undo because Ctrl+Shift+Z would otherwise satisfy undo's Ctrl+Z on some layouts.
        if (!typing && keymap.matches(e, 'global.redo')) {
            redo();
            e.preventDefault();
        }
        else if (!typing && keymap.matches(e, 'global.undo')) {
            undo();
            e.preventDefault();
        }
        else if (keymap.matches(e, 'global.selectAll')) {
            if (!typing && fixturesRef.current.length) {
                handleSelectFixtures(fixturesRef.current.map(f => f.id));
                e.preventDefault();
            }
        }
        // Open the Performance dock tab (renderer frame-time metrics).
        else if (keymap.matches(e, 'global.perfDock')) {
            openDockPanel(PERF_PANEL);
            e.preventDefault();
        }
        // Pull the timeline drawer up / down in whatever workbench you are in. Not gated on `typing`:
        // it is a modified chord a text field has no claim on, unlike Ctrl+Z.
        else if (keymap.matches(e, 'global.toggleBottom')) {
            layoutStore.set({ bottomOpen: !layoutStore.get().bottomOpen });
            e.preventDefault();
        }
        // Arm / stop the two recorders from anywhere — including Calibration and Preferences, which
        // declare no bottom drawer and so had NO route to a recorder at all. Modified chords, so not
        // gated on `typing`, and deliberately not bare `R`: Ctrl+R is a registered main-process Reload
        // accelerator that would hard-reload the renderer mid-take. Refusals speak through a toast.
        else if (keymap.matches(e, 'global.recordLighting')) {
            takeRecorder.toggleLighting();
            e.preventDefault();
        }
        else if (keymap.matches(e, 'global.recordTracking')) {
            takeRecorder.toggleTracking();
            e.preventDefault();
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  useEffect(() => {
    let animationFrameId: number;
    const loop = (time: number) => {
      frameCount.current++;
      if (time - lastTime.current >= 1000) {
        telemetry.setRenderFps(frameCount.current);
        frameCount.current = 0;
        lastTime.current = time;
        // Renderer frame-time baseline (~1 Hz): push to Prometheus (broadcast/headless have no HUD)
        // and, in broadcast, log a line so the show machine has a visible signal in its console/logs.
        // The UI-cost numbers ride the same message: a late frame and a blocked main thread are the
        // same second of wall clock, and reading them apart is what made "the UI stalled the engine"
        // an argument rather than a measurement.
        // This second of wall clock is also the proof that the renderer PAINTED. It clears the
        // Safe-Mode boot-failure counter (this boot was healthy) and downgrades any later fault from
        // "this project cannot load" to "it ran and then broke" — which is the difference between
        // offering Safe Mode and offering a reload. Idempotent; only the first call does anything.
        notePainted();
        const ps = perfMonitor.stats();
        const us = uiPerfMonitor.stats();
        window.artlux?.reportRenderStats?.({
          ...ps,
          longTasks: us.longTasks, longTaskMs: us.longTaskMs, longTaskMaxMs: us.longTaskMaxMs,
          commits: us.commits, commitMs: us.commitMs,
        });
        // `gpu=` says n/a rather than 0 when the device cannot time itself — a broadcast log is read
        // long after the fact, and "0.0ms" would be remembered as a free GPU.
        const gpu = ps.gpuComputeP99Us === undefined ? 'n/a' : `${(ps.gpuComputeP99Us / 1000).toFixed(2)}ms`;
        if (BROADCAST) console.info(`[perf] fps=${ps.fps.toFixed(0)} frameP99=${ps.frameP99.toFixed(1)}ms workP99=${ps.workP99.toFixed(1)}ms gpuP99=${gpu} long=${ps.longFrames}/${ps.samples} blocked=${us.longTaskMs.toFixed(0)}ms/${us.longTasks}`);
      }
      animationFrameId = requestAnimationFrame(loop);
    };
    loop(performance.now());
    return () => cancelAnimationFrame(animationFrameId);
  }, []);

  // --- Surfaces ---
  const handleSelectSurface = (id: string | null) => { setSelectedSurfaceId(id); if (id) { setSelectedFixtureId(null); setSelectedFixtureIds([]); } };
  // --- embedded 3D model handlers (App is the source of truth for the split-view scene panel) ---
  const handleSelectModel = (id: string | null) => { setSelectedModelId(id); if (id) { setSelectedFixtureId(null); setSelectedFixtureIds([]); setSelectedSurfaceId(null); } };
  const handleCommitModel = (id: string, t: ModelTransform) =>
    setScene3D(s => ({ ...s, models: (s.models ?? []).map(m => m.id === id ? { ...m, ...t } : m) }));
  const handleModelNaturalSize = (id: string, maxDim: number) =>
    setModelNaturalSizes(s => (s[id] === maxDim ? s : { ...s, [id]: maxDim }));
  // Records like handleUpdateSurface: every caller commits discretely (NumRow/Toggle/select — the
  // 3D gizmo drags go through onCommitModel with the Simulator3D moved-latch instead), so this
  // never fires per-frame. One config edit = one undo entry.
  const handleSceneConfig = (patch: Partial<Scene3D>) => { recordHistory(); setScene3D(s => ({ ...s, ...patch })); };
  // --- 3D model CRUD (driven by the in-window scene panel; App owns scene3D) ---
  // Add/remove record here; the COMMIT paths (handleCommitModel / handleCommitFixture3D) must NOT —
  // the gizmos latch history on their first real drag movement (onRecordHistory), and recording in
  // the commit too would push a second, post-mutation snapshot that makes Ctrl+Z a no-op. (An older
  // comment here excluded all of scene3D as "not on the fixtures-only stack"; dead since DocSnapshot
  // widened to the whole authored document.)
  const addSceneModel = (m: SceneModel) => { recordHistory(); setScene3D(s => ({ ...s, models: [...(s.models ?? []), m] })); handleSelectModel(m.id); };
  // Returns the new model's id (null = the picker was cancelled) so a caller that is BLOCKED on having
  // a venue model — the calibration wizard's Setup prerequisite — can react rather than just hoping.
  const handleAddModel = async (): Promise<string | null> => {
    const path = await window.artlux?.pickModel?.();
    if (!path) return null;
    const name = (path.replace(/\\/g, '/').split('/').pop() || path).replace(/\.(glb|gltf)$/i, '');
    const count = (scene3D.models ?? []).length;
    const id = crypto.randomUUID();
    addSceneModel({ id, name, path, position: { x: count * 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1, visible: true });
    return id;
  };
  const addModelRef = useRef(handleAddModel); addModelRef.current = handleAddModel; // live mirror for host.scene3D.addModel
  const handleAddPlane = () => {
    const count = (scene3D.models ?? []).length;
    // The NAME is numbered from what is taken; `count` still places it (the x-cascade so a new plane
    // does not land inside the last one). Per-word matters here too — `models[]` also holds imported
    // glb files, which are named after the FILE, and those must not push the screen counter along.
    addSceneModel({ id: crypto.randomUUID(), name: nextNumberedName('Screen', scene3D.models ?? []), kind: 'plane', path: '', position: { x: count * 2, y: 1.2, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 2, visible: true });
  };
  const handleUpdateModel = (id: string, patch: Partial<SceneModel>) => { setScene3D(s => ({ ...s, models: (s.models ?? []).map(m => m.id === id ? { ...m, ...patch } : m) })); };
  const handleRemoveModel = (id: string) => { recordHistory(); setScene3D(s => ({ ...s, models: (s.models ?? []).filter(m => m.id !== id) })); if (selectedModelId === id) setSelectedModelId(null); };
  const [sceneSaved, setSceneSaved] = useState(false);
  const sceneSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSceneSave = () => { handleSaveProject().then((path) => { if (path) { setSceneSaved(true); if (sceneSavedTimer.current) clearTimeout(sceneSavedTimer.current); sceneSavedTimer.current = setTimeout(() => setSceneSaved(false), 1500); } }); };
  // Maximize the 3D pane: shrink the 2D stage to a sliver so the 3D view + panel nearly fill the
  // area (recovers the old detached-window's near-fullscreen editing). Toggles back to the prior split.
  const MAX_3D_RATIO = 0.12;
  const prevSplitRatio = useRef(0.5);
  const is3DMaximized = splitView && splitRatio <= MAX_3D_RATIO + 0.001;
  const handleToggle3DMax = () => {
    if (is3DMaximized) { setSplitRatio(prevSplitRatio.current > 0.2 ? prevSplitRatio.current : 0.5); }
    else { prevSplitRatio.current = splitRatio; if (!splitView) setSplitView(true); setSplitRatio(MAX_3D_RATIO); }
  };

  // Single-target selection with optional additive (ctrl/cmd) toggle. Clicking an
  // already-selected member without a modifier keeps the multi-selection (so it stays
  // draggable) and just moves the primary; clicking elsewhere selects only that fixture.
  const handleSelectFixture = (id: string | null, additive = false) => {
    if (!id) { setSelectedFixtureId(null); setSelectedFixtureIds([]); return; }
    setSelectedSurfaceId(null);
    // Clearing the MODEL is not optional, and its absence read as "fixtures cannot be selected in 3D":
    // Simulator3D computes `selectedFixture = !selectedModelId && …`, so while a model stayed selected
    // the fixture gizmo never appeared and the inspector kept showing Model — the click DID land, it
    // just had no visible effect. handleSelectModel has always cleared the fixture; this is the other
    // half of that pair. Venue screens are big and easy to select by accident, so this was the common
    // case, not the corner one.
    setSelectedModelId(null);
    if (additive) {
      const has = selectedFixtureIds.includes(id);
      const next = has ? selectedFixtureIds.filter(x => x !== id) : [...selectedFixtureIds, id];
      setSelectedFixtureIds(next);
      setSelectedFixtureId(has ? (next[next.length - 1] ?? null) : id);
    } else if (selectedFixtureIds.includes(id) && selectedFixtureIds.length > 1) {
      setSelectedFixtureId(id);
    } else {
      setSelectedFixtureIds([id]);
      setSelectedFixtureId(id);
    }
  };
  // Replace the whole selection (range-select, select-all, group recall).
  const handleSelectFixtures = (ids: string[]) => {
    setSelectedFixtureIds(ids);
    setSelectedFixtureId(ids.length ? ids[ids.length - 1] : null);
    if (ids.length) { setSelectedSurfaceId(null); setSelectedModelId(null); }
  };
  const handleSelectAllFixtures = () => handleSelectFixtures(fixtures.map(f => f.id));
  const handleAddSurface = () => {
    recordHistory();
    const id = generateId();
    const z = surfaces.reduce((m, s) => Math.max(m, s.zIndex), -1) + 1;
    setSurfaces([...surfaces, {
      // `nextNumberedName`, not `surfaces.length + 1` — the count re-issues a name a deletion left
      // behind (delete `Surface 1` of two and the next add is a second `Surface 2`). Same everywhere
      // below; the SDK helper carries the why.
      id, name: nextNumberedName('Surface', surfaces),
      x: 0.25, y: 0.25, width: 0.5, height: 0.5, rotation: 0, zIndex: z,
      content: { type: SourceType.NONE },
    }]);
    handleSelectSurface(id);
  };
  // Move a surface in the stage z-order (renumbers zIndex by back→front position so ordering stays
  // clean). 'up' = toward the front (drawn later / on top), 'down' = toward the back.
  const handleMoveSurface = (id: string, dir: 'up' | 'down') => {
    recordHistory();
    const ordered = [...surfaces].sort((a, b) => (a.zIndex - b.zIndex) || (surfaces.indexOf(a) - surfaces.indexOf(b)));
    const i = ordered.findIndex(s => s.id === id);
    const j = dir === 'up' ? i + 1 : i - 1;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    const z = new Map(ordered.map((s, idx) => [s.id, idx]));
    setSurfaces(surfaces.map(s => ({ ...s, zIndex: z.get(s.id)! })));
  };
  const handleRemoveSurface = async (id: string) => {
    // Deleting a surface also removes its projector output (the reconciler then closes that window) —
    // a mapped projector goes dark. Confirm, and say so when an output is attached. The SURFACE is
    // undoable (it's in DocSnapshot); the output binding is NOT (projectorOutputs is deliberately
    // excluded — undoing output config mid-show is a footgun), so the message says exactly that.
    const surf = surfaces.find(s => s.id === id);
    const hasOutput = projectorOutputs.some(o => o.surfaceId === id);
    if (!await confirm({
      title: `Delete surface "${surf?.name ?? id}"?`,
      message: hasOutput
        ? 'Its projector output is removed too — that display goes dark. Ctrl+Z brings the surface back, but not the output assignment.'
        : 'Ctrl+Z can bring it back.',
      confirmLabel: 'Delete', danger: true,
    })) return;
    recordHistory();
    setSurfaces(surfaces.filter(s => s.id !== id));
    setProjectorOutputs(prev => prev.filter(o => o.surfaceId !== id)); // reconciler closes its window
    if (selectedSurfaceId === id) setSelectedSurfaceId(null);
  };

  // --- Projector outputs (per-surface fullscreen on a physical display) ---
  const upsertOutput = (surfaceId: string, patch: Partial<ProjectorOutput>) => {
    setProjectorOutputs(prev => prev.some(o => o.surfaceId === surfaceId)
      ? prev.map(o => o.surfaceId === surfaceId ? { ...o, ...patch } : o)
      : [...prev, { ...defaultProjectorOutput(surfaceId), ...patch }]);
  };
  const projectorOutputsRef = useRef(projectorOutputs); projectorOutputsRef.current = projectorOutputs; // live mirror for plugin host services
  const currentProjectPathRef = useRef(currentProjectPath); currentProjectPathRef.current = currentProjectPath; // ditto — host.project.path()
  // Name the loaded document on every crash report. Written during render, not in an effect, because
  // the throws that matter most happen ON the load path — an effect would not have run yet, and the
  // fault would say '' exactly when "which file did this?" is the only question worth answering. It
  // is also what keys the boot-failure counter, so opening a DIFFERENT project starts a fresh count.
  setFaultProject(currentProjectPath);

  // --- Spanning one surface across several projectors (grid math: services/outputSpan.ts) ---
  //
  // The ONLY writer of a span's members. The wizard, the overlap slider and Regenerate all land here,
  // so there is exactly one place where "what the grid means" becomes surfaces + outputs — and a span
  // is never consulted at runtime, which is what keeps a hand-tuned or half-deleted span harmless.
  const applySpan = (span: OutputSpan) => {
    const src = surfaces.find(s => s.id === span.sourceSurfaceId);
    if (!src) return;
    const tiles = spanTiles(span);
    const ids = tiles.map((_, i) => span.sliceIds[i] ?? generateId());
    const dropped = span.sliceIds.filter(id => !ids.includes(id)); // members a shrinking grid no longer has

    setSurfaces(prev => {
      let z = prev.reduce((m, s) => Math.max(m, s.zIndex), -1);
      const next = prev.filter(s => !dropped.includes(s.id));
      tiles.forEach((t, i) => {
        const id = ids[i];
        const k = next.findIndex(s => s.id === id);
        const content: SurfaceContent = { ...(k >= 0 ? next[k].content : {}), type: SourceType.SLICE, sliceOf: src.id, sliceRect: t.rect };
        // Lay each piece out INSIDE the source's own stage rect, so the Stage shows the split the
        // same way the projectors will — the editor preview reads as the wall, not as a pile of rects.
        const geom = {
          x: src.x + t.rect.x * src.width, y: src.y + t.rect.y * src.height,
          width: src.width * t.rect.w, height: src.height * t.rect.h,
        };
        if (k >= 0) next[k] = { ...next[k], ...geom, content };
        else next.push({ id, name: tileName(src.name, t, span.cols, span.rows), rotation: src.rotation, zIndex: ++z, ...geom, content });
      });
      return next;
    });

    setProjectorOutputs(prev => {
      let next = prev.filter(o => !dropped.includes(o.surfaceId));
      // Never hand one display to two outputs: anything already claimed is off the table, and a member
      // that already has a display keeps it (re-tuning an overlap must not re-shuffle the wall).
      //
      // The operator's OWN screen is never auto-claimed — primary and built-in panels are skipped, so
      // creating a span can't slam a fullscreen output over the editor you are creating it in. In a
      // real rig the projectors are the secondary displays, which is exactly what's left. Rows that
      // get nothing stay unassigned; pick a display (or Windowed) per row.
      const taken = new Set(next.filter(o => o.displayId != null).map(o => o.displayId!));
      const free = displays.filter(d => !taken.has(d.id) && !d.primary && !d.internal).map(d => d.id);
      let f = 0;
      tiles.forEach((t, i) => {
        const id = ids[i];
        const cur = next.find(o => o.surfaceId === id);
        const patch: Partial<ProjectorOutput> = {
          enabled: true,
          displayId: cur?.displayId ?? (f < free.length ? free[f++] : null),
          // Feather comes from the grid; the blend gamma is the PROJECTOR's and is kept (it is measured
          // per machine, not derived from the layout — see SoftEdge in shared/protocol).
          softEdge: { ...t.soft, gamma: cur?.softEdge?.gamma ?? defaultSoftEdge().gamma },
        };
        next = cur ? next.map(o => o.surfaceId === id ? { ...o, ...patch } : o)
                   : [...next, { ...defaultProjectorOutput(id), ...patch }];
      });
      return next;
    });

    const stored: OutputSpan = { ...span, sliceIds: ids };
    setOutputSpans(prev => prev.some(x => x.id === span.id) ? prev.map(x => x.id === span.id ? stored : x) : [...prev, stored]);
  };

  // Metadata-only edit (name, linked) — never touches the members.
  const updateSpan = (span: OutputSpan) =>
    setOutputSpans(prev => prev.map(x => x.id === span.id ? span : x));

  // Deleting a span deletes the pieces it made. They exist only because it cut them; leaving orphan
  // slices behind (still routed to projectors) would be the surprising half of the two options.
  const removeSpan = (id: string) => {
    const span = outputSpans.find(x => x.id === id);
    if (!span) return;
    setSurfaces(prev => prev.filter(s => !span.sliceIds.includes(s.id)));
    setProjectorOutputs(prev => prev.filter(o => !span.sliceIds.includes(o.surfaceId))); // reconciler closes the windows
    setOutputSpans(prev => prev.filter(x => x.id !== id));
  };

  // Hand-drag of one piece's crop in the span map. It stops describing a regular grid the moment this
  // happens, so the span unlinks itself rather than silently reverting the drag on the next edit.
  const setSliceRect = (surfaceId: string, rect: SrcRect) => {
    setSurfaces(prev => prev.map(s => s.id === surfaceId ? { ...s, content: { ...s.content, sliceRect: rect } } : s));
    setOutputSpans(prev => prev.map(x => x.sliceIds.includes(surfaceId) && x.linked ? { ...x, linked: false } : x));
  };
  const handleSetOutputEnabled = (surfaceId: string, enabled: boolean) => {
    upsertOutput(surfaceId, { enabled });
    // An output switched off stops identifying. Otherwise the id sits in the set with no window to
    // receive it, and switching the output back on hours later brings up a name card over the show.
    if (!enabled) setIdentifyOutputIds(prev => prev.filter(x => x !== surfaceId));
  };
  const handleToggleIdentify = (surfaceId: string) =>
    setIdentifyOutputIds(prev => prev.includes(surfaceId) ? prev.filter(x => x !== surfaceId) : [...prev, surfaceId]);
  // All at once, or all off — the whole point is comparing a wall of them, and "off" has to be one
  // press because that is the state you need before the doors open.
  const handleIdentifyMany = (ids: string[]) =>
    setIdentifyOutputIds(prev => (prev.length > 0 ? [] : ids));
  const handleSetOutputDisplay = (surfaceId: string, displayId: number | null) =>
    upsertOutput(surfaceId, {
      displayId,
      displayLabel: displayId != null ? displays.find(d => d.id === displayId)?.label : undefined,
      enabled: displayId != null,
    });
  const handleToggleEditOutput = (surfaceId: string) =>
    setEditingOutputIds(prev => prev.includes(surfaceId) ? prev.filter(x => x !== surfaceId) : [...prev, surfaceId]);
  // Align a whole span: all of it, or none of it. Judging a soft edge means seeing both grids meet.
  const handleToggleEditMany = (ids: string[]) =>
    setEditingOutputIds(prev => ids.every(id => prev.includes(id))
      ? prev.filter(x => !ids.includes(x))
      : [...prev.filter(x => !ids.includes(x)), ...ids]);
  // --- projector calibration (structured-light intrinsics + solvePnP pose) ---
  // Portal target in the left split pane: during calibration the big RGB camera viewport lives here
  // (replacing the 2D Stage) so it sits side-by-side with the 3D scene. Callback ref → re-renders the
  // wizard once the host element exists, so its createPortal target is reliable.
  const [measuringGammaId, setMeasuringGammaId] = useState<string | null>(null); // output whose gamma is being camera-measured
  const [gammaMsg, setGammaMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const sendToProjector = (surfaceId: string, msg: MainToProjector) =>
    projectorPortsRef.current.get(surfaceId)?.postMessage(msg);
  // Pose-pairing orchestration (crosshair↔model-pick → solvePnP), the pose refs, and the markerless
  // pick/select registration all live in the calibration plugin now (calibWorkspace); App only tells it
  // which output is the board-pose target and forwards embedded-3D picks to it (see the Simulator3D
  // wiring + the setTarget effect below).
  const handleResetCorners = (surfaceId: string) => {
    const o = projectorOutputs.find(x => x.surfaceId === surfaceId);
    if (o?.warp) upsertOutput(surfaceId, { warp: makeBezierWarp(o.cornerPin) });
    else upsertOutput(surfaceId, { cornerPin: defaultCornerPin() });
  };
  const handleToggleWarp = (surfaceId: string, on: boolean) => {
    const o = projectorOutputs.find(x => x.surfaceId === surfaceId);
    const pin = o?.cornerPin ?? defaultCornerPin();
    upsertOutput(surfaceId, { warp: on ? makeBezierWarp(pin) : null });
  };
  const handleSetSoftEdge = (surfaceId: string, patch: Partial<SoftEdge>) => {
    const o = projectorOutputs.find(x => x.surfaceId === surfaceId);
    upsertOutput(surfaceId, { softEdge: { ...(o?.softEdge ?? defaultSoftEdge()), ...patch } });
  };
  const handleSetOutputGamma = (surfaceId: string, gamma: number) => upsertOutput(surfaceId, { gamma });

  // Camera-based gamma + colour measurement: project a level ramp on this output, sample the camera's
  // RGB in the lit footprint, fit the response → write the output's gamma + colorGain. Reuses a running
  // calibration camera if there is one; otherwise opens the default browser camera for the measurement.
  const handleMeasureGamma = async (surfaceId: string) => {
    if (measuringGammaId) return;
    const co = projectorOutputs.find(o => o.surfaceId === surfaceId);
    const live = !!co?.enabled && co.displayId != null && (co.displayId === WINDOWED_DISPLAY || displays.some(d => d.id === co.displayId));
    if (!live) { setGammaMsg({ id: surfaceId, text: 'Enable this output on a display first.', ok: false }); return; }
    setMeasuringGammaId(surfaceId); setGammaMsg(null);
    const startedCam = !cam.dims().w;
    try {
      if (startedCam) {
        try { await cam.start({ source: 'browser' }); }
        catch { setGammaMsg({ id: surfaceId, text: 'No camera — start one in the calibration wizard, then retry.', ok: false }); return; }
      }
      // Freeze the camera response so it doesn't adapt per ramp level (best-effort; driver may ignore).
      await cam.setProp('autoexposure', 0.25); await cam.setProp('auto_wb', 0); await cam.setProp('autofocus', 0);
      const res = await measureGamma(surfaceId, (m) => sendToProjector(surfaceId, m));
      if ('error' in res) { setGammaMsg({ id: surfaceId, text: res.error, ok: false }); return; }
      handleSetOutputGamma(surfaceId, +res.gamma.toFixed(3));
      // The measured gamma is ALSO the blend gamma. SoftEdge.gamma is what makes two feathered halves
      // sum to one unit of light (protocol.ts tells the operator to measure it with exactly this
      // tool) — and until now nothing wrote it, so they had to read the number off this toast and
      // retype it into the Blend γ field. Same measurement, two fields, one of them silently stale.
      const cur = projectorOutputsRef.current.find(o => o.surfaceId === surfaceId);
      upsertOutput(surfaceId, {
        colorGain: res.colorGain,
        softEdge: { ...(cur?.softEdge ?? defaultSoftEdge()), gamma: +res.gamma.toFixed(3) },
      });
      setGammaMsg({ id: surfaceId, ok: true, text: `γ ${res.gamma.toFixed(2)} (R ${res.gammaRGB[0].toFixed(2)} · G ${res.gammaRGB[1].toFixed(2)} · B ${res.gammaRGB[2].toFixed(2)}) · gain ${res.colorGain.map(x => x.toFixed(2)).join('/')} · ${res.footprintPx}px — blend γ updated too` });
    } catch (e) {
      setGammaMsg({ id: surfaceId, text: (e as Error)?.message ?? 'measurement failed', ok: false });
    } finally {
      if (startedCam) cam.stop();
      setMeasuringGammaId(null);
    }
  };
  const handleToggleNdiSend = (surfaceId: string, on: boolean) => upsertOutput(surfaceId, { ndiSend: on });
  const refreshDisplays = () => { window.artlux?.listDisplays?.().then(d => setDisplays(d ?? [])); };
  // ── THE TAKEOVER, ON THE CORE SIDE ─────────────────────────────────────────────────────────────
  // A MANUAL MOVE TAKES THE PARAM BACK from whatever scene or cue is fading it — and COMMITTING IT INTO
  // REACT STATE IS NOT ENOUGH. transitions.apply() lays the interpolation back OVER the committed state on
  // EVERY FRAME (Stage rebuilds `base` from surfacesRef/fixturesRef and hands it to the fade), and a leg on
  // a path with no automation lane glides to its own FROZEN endpoint, not to the live document.
  //
  // So: pull a surface's content.opacity to 0 two seconds into a 10 s crossfade, because you can see the
  // projection is wrong. The slider reads 0. The document holds 0. AND THE PROJECTOR KEEPS SHOWING THE
  // IMAGE FOR EIGHT MORE SECONDS, then snaps to 0 the instant the leg lands. The control appeared to work.
  // The audience saw the wrong picture for the whole fade. The audio side went to considerable trouble to
  // close exactly this hole (releaseFade + dropFadeLeg); this is core's, through the same head-agnostic
  // transitions.dropLeg().
  //
  // Only the paths that ACTUALLY MOVED are released — collectFadeableTargets IS that diff — so nudging a
  // fixture's position never silently kills a running crossfade on its intensity. An automation LANE still
  // owns its path (dropLeg touches the fade, never the overlay), exactly as it does on the audio side.
  const dropTakenOverLegs = (from: StateView, to: StateView) => {
    if (!transitions.isActive()) return;   // free on the overwhelmingly common path — no fade is running
    for (const t of collectFadeableTargets(from, to)) transitions.dropLeg(t.path);
  };
  // The master brightness slider is the FIRST thing an operator grabs when a fade is going wrong on the
  // wall — so it is the last one that may keep sliding under their hand. (Its own path, directly: the
  // slider writes a bare number, not a StateView.)
  const handleMasterBrightness = (val: number) => {
    transitions.dropLeg('globalBrightness');
    setGlobalBrightness(val);
  };

  const handleUpdateSurface = (id: string, patch: Partial<Surface>) => {
    // Records like handleUpdateFixture does (the inspector's NumberInputs commit discretely, and the
    // on-stage drag bypasses this via raw setSurfaces + the Stage moved-latch, so this never fires
    // per-frame). One inspector edit = one undo entry.
    recordHistory();
    const next = surfaces.map(s => s.id === id ? { ...s, ...patch } : s);
    dropTakenOverLegs({ surfaces, fixtures, globalBrightness }, { surfaces: next, fixtures, globalBrightness });
    setSurfaces(next);
  };
  const handleRenameSurface = (id: string, name: string) => handleUpdateSurface(id, { name });

  const handleAddFixture = () => {
    recordHistory();
    const newId = generateId();
    // The created rect is the strip's own shape (4px cells, one cell tall — fixtureGeometry.ts),
    // centered so a near-document-wide bar can't spawn hanging outside the document.
    const ledCount = 30;
    const size = derivedFixtureRect({ ledCount });
    const fx: Fixture = {
      id: newId,
      name: nextNumberedName('Fixture', fixtures),
      x: 0.5 - size.width / 2, y: 0.5 - size.height / 2, width: size.width, height: size.height,
      universe: 0, startAddress: 1, ledCount, reverse: false, rotation: 0,
      colorData: [],
      surfaceId: selectedSurfaceId ?? surfaces[0]?.id,
    };
    setFixtures(autoPatch([...fixtures, fx], controllers, patchPolicy, undefined, fixtureProfiles));
    handleSelectFixture(newId);
  };

  // ── DMX-profile fixtures (moving heads, washes, beams) ────────────────────────────────────────
  // Assigning a profile changes the fixture's DMX FOOTPRINT, so both of these repatch: a 14-channel
  // head where a 120-channel strip used to be would otherwise leave a hole, and the reverse would
  // silently overlap its neighbour.
  //
  // `dmx` is seeded from the profile's own defaults rather than left empty, for two reasons: the
  // fixture then holds the state the manufacturer says it powers up in (a centred head, not pan 0),
  // and — the load-bearing one — setByPath refuses to fabricate a missing nested container, so a
  // fixture with no `dmx` object silently ignores every cue, lane and scene aimed at its channels.
  const applyProfile = (f: Fixture, profile: FixtureProfile, modeKey?: string): Fixture => ({
    ...f,
    profileId: profile.id,
    profileMode: modeKey ?? profile.modes[0]?.key,
    // A profiled fixture is ONE emitter, not a pixel run. Leaving ledCount at 30 would draw thirty
    // LED spheres inside one housing in the 3D scene and consume thirty pixels of the sample buffer.
    ledCount: 1,
    // A LIGHT SAMPLES NOTHING. frameEngine returns before any sampling for it, so this link was
    // already inert — but not harmless: the WebGPU mapper has no kind branch, so it kept computing
    // UVs and sampling a surface for every light, every frame, and threw the result away. It also
    // made the fixture LOOK bound to a surface it is not driven by. Dropping it is a one-way loss
    // (converting back leaves it unlinked), which is the same trade the reverse conversion already
    // makes with profileId/profileMode/dmx: a stale field is worse than an absent one.
    surfaceId: undefined,
    // ITS PLACE IN THE ROOM IS ITS OWN, from here on. `effectivePosObj` derives a 3D position from
    // the 2D rect when this is absent — and both creation paths hardcode x:0.4/y:0.4, which maps to
    // the world ORIGIN, so every head added piled up in one spot. The fallback is deliberately kept
    // for EXISTING projects (where the 2D rect is a true record of where the operator put it); only
    // new lights get an explicit position, and they get spread instead of stacked.
    position3D: f.position3D ?? spawnPosition3D(fixtures.filter(isLight).length),
    dmx: { ...profiles.seedValues(profile), ...(f.dmx ?? {}) },
  });

  const handleSetFixtureProfile = async (id: string, profileId: string | null, modeKey?: string) => {
    if (!profileId) {
      recordHistory();
      // Back to a pixel fixture. profileId/profileMode/dmx are dropped rather than kept "in case" —
      // a stale profile id is exactly what would resolve to footprint 0 later and shift the patch.
      setFixtures(autoPatch(
        fixtures.map(f => {
          if (f.id !== id) return f;
          const { profileId: _p, profileMode: _m, dmx: _d, ...rest } = f;
          return { ...rest, ledCount: Math.max(1, f.ledCount) };
        }),
        controllers, patchPolicy, undefined, fixtureProfiles,
      ));
      return;
    }
    // The profile may not be resolved yet (its manufacturer chunk is fetched lazily), so make sure
    // it is before patching — the footprint depends on it.
    await profiles.ensureLoaded([profileId]);
    const profile = profiles.get(profileId);
    if (!profile) { toast.error('Fixture profile unavailable', profileId); return; }
    recordHistory();
    setFixtures(autoPatch(
      fixtures.map(f => (f.id === id ? applyProfile(f, profile, modeKey) : f)),
      controllers, patchPolicy, undefined, fixtureProfiles,
    ));
  };

  const handleAddFixtureFromProfile = async (profileId: string, modeKey?: string) => {
    await profiles.ensureLoaded([profileId]);
    const profile = profiles.get(profileId);
    if (!profile) { toast.error('Fixture profile unavailable', profileId); return; }
    recordHistory();
    const newId = generateId();
    const base: Fixture = {
      id: newId,
      name: nextNumberedName(profile.model, fixtures),
      x: 0.4, y: 0.4, width: 0.2, height: 0.2,
      universe: 0, startAddress: 1, ledCount: 1, reverse: false, rotation: 0,
      colorData: [],
      surfaceId: selectedSurfaceId ?? surfaces[0]?.id,
    };
    setFixtures(autoPatch([...fixtures, applyProfile(base, profile, modeKey)], controllers, patchPolicy, undefined, fixtureProfiles));
    handleSelectFixture(newId);
    // A LIGHT LIVES IN THE ROOM, so offer to put it there. The fixture already exists, is patched and
    // is selected — this only arms a click to MOVE it, so never clicking costs nothing (it stays on
    // the spread row spawnPosition3D gave it). Going to the 3D workbench is part of the offer: an
    // armed placement with no scene on screen would be a mode with nowhere to click.
    placement.arm({ fixtureId: newId, label: profile.model });
    goToContext('3d');
  };

  const handleRemoveFixture = (id: string) => {
    recordHistory();
    // An armed placement must not outlive its target: the hint would name a fixture that no longer
    // exists, and the next click would silently do nothing.
    if (placement.get()?.fixtureId === id) placement.disarm();
    setFixtures(autoPatch(fixtures.filter(f => f.id !== id), controllers, patchPolicy, undefined, fixtureProfiles));
    setSelectedFixtureIds(prev => prev.filter(x => x !== id));
    if (selectedFixtureId === id) setSelectedFixtureId(null);
  };

  // ── A LIGHT FIXTURE IS ONE EMITTER — ledCount IS PINNED TO 1 ────────────────────────────────
  //
  // types.ts has said so since profiles landed, but nothing ENFORCED it, and the Mapping inspector
  // and the Routing grid both exposed an editable "LED Count" for every fixture including a moving
  // head. Raising it was silent corruption of a peculiarly evil kind: the head's own DMX is
  // unaffected (its footprint comes from the mode), so nothing looks wrong at the fixture — but
  // frameEngine walks the canonical pixel buffer with `offset += f.ledCount`, so EVERY fixture
  // patched after it shifts in that buffer. The DMX monitor's pixel strip and the 3D LED colours
  // misalign for the whole rest of the rig while correct Art-Net keeps flowing.
  //
  // Hiding the controls is ergonomics; THIS is the cure. It sits on the one funnel every fixture
  // mutation passes through, so a future panel, a plugin, an OSC path or a paste cannot reopen it.
  const pinLedCount = (f: Fixture): Fixture =>
    isLight(f) && f.ledCount !== 1 ? { ...f, ledCount: 1 } : f;

  // Auto re-patch when something that affects addressing changes.
  const REPATCH_KEYS = ['ledCount', 'channelsPerPixel', 'controllerId', 'patchLocked'] as const;
  const handleUpdateFixture = (id: string, updates: Partial<Fixture>) => {
    recordHistory();
    // retrackDerivedRect: a ledCount/shape/matrix edit re-derives the rect, but only while the
    // rect is still exactly what creation derived — plain Add creates at the default count of 30
    // and the real count arrives here afterwards, so creation-time sizing alone would leave most
    // fixtures shaped for the wrong strip. Hand-resized geometry is never touched.
    const mapped = fixtures.map(f => f.id === id ? retrackDerivedRect(f, pinLedCount({ ...f, ...updates })) : f);
    const repatch = REPATCH_KEYS.some(k => k in updates);
    const next = repatch ? autoPatch(mapped, controllers, patchPolicy, undefined, fixtureProfiles) : mapped;
    dropTakenOverLegs({ surfaces, fixtures, globalBrightness }, { surfaces, fixtures: next, globalBrightness });
    setFixtures(next);
  };

  const handleAutoPatch = () => setFixtures(autoPatch(fixtures, controllers, patchPolicy, undefined, fixtureProfiles));

  // --- Controllers (output devices) ---
  // WHAT A NEW CONTROLLER DRIVES, by its protocol — a USB-DMX widget is a lighting interface, a
  // network node feeds LED tape. Only a DEFAULT: the operator can say otherwise, and an existing
  // controller has no `drives` at all (which patches exactly as it always did).
  const drivesFor = (protocol: OutputProtocol): FixtureKind => (protocol === 'enttec' ? 'light' : 'pixel');

  const handleAddController = () => {
    setControllers([...controllers, {
      id: generateId(), name: nextNumberedName('Controller', controllers),
      protocol: settings.protocol, ip: settings.artNetIp, broadcast: settings.broadcast,
      drives: drivesFor(settings.protocol),
    }]);
  };
  const handleUpdateController = (id: string, patch: Partial<Controller>) => {
    const next = controllers.map(c => {
      if (c.id !== id) return c;
      const merged = { ...c, ...patch };
      // SWITCHING THE PROTOCOL RE-DEFAULTS WHAT IT DRIVES — but only if the operator never said.
      // Routing lets an existing controller flip Art-Net ↔ USB DMX, and a widget still advertising
      // `drives: 'pixel'` would send every light past it to the next candidate: the same
      // silent-wrong-bucket failure this wave exists to remove, reintroduced through the one field
      // an operator is most likely to edit. A hand-set value is left alone.
      if ('protocol' in patch && !('drives' in patch) && c.drives === drivesFor(c.protocol)) {
        merged.drives = drivesFor(merged.protocol);
      }
      return merged;
    });
    setControllers(next);
    // `drives` changes which controller an unassigned fixture falls to, so it re-patches for the
    // same reason startUniverse does. This is the one place in the wave that can MOVE addresses,
    // and it only fires when the operator deliberately changed what a box drives.
    if ('startUniverse' in patch || 'drives' in patch || 'protocol' in patch) {
      setFixtures(autoPatch(fixtures, next, patchPolicy, undefined, fixtureProfiles));
    }
  };
  const handleRemoveController = async (id: string) => {
    const ctrl = controllers.find(c => c.id === id);
    const patched = fixtures.filter(f => f.controllerId === id).length;
    if (!await confirm({
      title: `Remove output "${ctrl?.name ?? id}"?`,
      message: patched > 0
        ? `${patched} fixture${patched === 1 ? '' : 's'} patched to it will be unassigned and re-patched to the default target.`
        : 'This output device will be removed.',
      confirmLabel: 'Remove', danger: true,
    })) return;
    const next = controllers.filter(c => c.id !== id);
    setControllers(next);
    setFixtures(autoPatch(fixtures.map(f => f.controllerId === id ? { ...f, controllerId: undefined } : f), next, patchPolicy, undefined, fixtureProfiles));
  };

  const handleRenameFixture = (id: string, newName: string) => {
    handleUpdateFixture(id, { name: newName });
  };

  // 3D gizmo commit: history already recorded at drag-start, so don't re-record.
  // ONE state change per gesture, however many fixtures the gizmo moved — so dragging ten heads is
  // one undo step, not ten, and the fade engine sees a single coherent before/after.
  const handleCommitFixture3D = (updates: Array<{ id: string } & Partial<Fixture>>) => {
    if (!updates.length) return;
    const byId = new Map(updates.map(u => [u.id, u]));
    const next = fixtures.map(f => { const u = byId.get(f.id); return u ? { ...f, ...u } : f; });
    dropTakenOverLegs({ surfaces, fixtures, globalBrightness }, { surfaces, fixtures: next, globalBrightness });
    setFixtures(next);
  };

  // --- Groups ---
  const handleCreateGroup = () => {
    const ids = [...selectedFixtureIds];
    setGroups([...groups, { id: generateId(), name: nextNumberedName('Group', groups), fixtureIds: ids }]);
  };
  const handleAddSelectedToGroup = (groupId: string) => {
    if (!selectedFixtureIds.length) return;
    setGroups(groups.map(g => g.id === groupId
      ? { ...g, fixtureIds: Array.from(new Set([...g.fixtureIds, ...selectedFixtureIds])) } : g));
  };
  const handleRemoveGroup = (groupId: string) => setGroups(groups.filter(g => g.id !== groupId));
  const handleSelectGroup = (group: FixtureGroup) => {
    if (group.fixtureIds.length) handleSelectFixtures(group.fixtureIds);
  };
  // Copy the selected fixture's "look" (effect/segments/palette) to all group members.
  const handleApplyLookToGroup = (group: FixtureGroup) => {
    const src = fixtures.find(f => f.id === selectedFixtureId);
    if (!src) return;
    const look: Partial<Fixture> = {
      source: src.source, effectId: src.effectId, paletteId: src.paletteId,
      speed: src.speed, intensity: src.intensity, segments: src.segments,
    };
    recordHistory();
    const next = fixtures.map(f => group.fixtureIds.includes(f.id) ? { ...f, ...look } : f);
    dropTakenOverLegs({ surfaces, fixtures, globalBrightness }, { surfaces, fixtures: next, globalBrightness });
    setFixtures(next);
  };

  // --- Plugin-namespaced cue/scene entries (today: audio.*) ---
  //
  // A core entry rides the StateView (surfaces / fixtures / globalBrightness): applyCues commits it with
  // setByPath and the fade engine interpolates it there. A PLUGIN entry has no StateView to ride —
  // setByPath silently returns the view untouched for any other head (paramPath's `return view`) — so it
  // goes to its namespace's AutomationTargetProvider instead, landing in that provider's FADE LAYER, one
  // level UNDER any automation lane that owns the same path (a lane always wins, structurally).
  //
  // ⚠ SHAPE FIRST — THIS IS A *GO*, AND IT IS REACHED BEFORE applyAudioEntries' OWN GUARD. `Cue.entries` is
  // document data with no normalizer in front of it (applyProjectData spreads the banks in), and a bare
  // `e.path.split('.')` on a hand-edited `[null]` / `[{value:1}]` throws inside applyCues — the second lock
  // downstream never gets the chance to run. A malformed entry is not a plugin entry and not a core one: it
  // is unaddressable, so it is neither, and both loops skip it. (Callers filtering with cueEntries() have
  // already dropped it; this keeps the predicate honest on its own, for whoever calls it next.)
  const isPluginHeadEntry = (e: CueEntry): boolean => {
    if (!isAddressableEntry(e)) return false;
    const h = e.path.split('.')[0];
    return h !== 'surfaces' && h !== 'fixtures' && e.path !== 'globalBrightness';
  };
  // Turn a cue's/scene's plugin entries into fade legs. `fadeSec`/`transition` are the OWNER's defaults;
  // each entry may override either (exactly as the core loop in applyCues already does).
  //
  // ⚠ A SNAP IS A ZERO-LENGTH *LEG*, NOT A DIRECT writeFade() — AND THAT ORDERING IS LOAD-BEARING.
  // An in-flight fade on the same path KEEPS RUNNING until an incoming batch names that path: start()
  // RE-TARGETS it (the old leg is dropped from its batch) and only then writes the snap. A snap written
  // directly HERE would happen BEFORE that hand-off, so the still-live leg would overwrite the value we
  // just recalled on its very next apply() frame — the previous scene's audio, sliding back over ours, on
  // a GO. Handing the snap to start() as a durMs-0 leg is what puts it on the right side of the re-target.
  // One writer per path, correct order.
  const applyAudioEntries = (entries: CueEntry[], fadeSec: number, transition?: CueTransition): transitions.FadeLeg[] => {
    const legs: transitions.FadeLeg[] = [];
    // enumerate() rebuilds the whole catalog (it walks the live mix) — do it ONCE per provider per recall,
    // not once per entry. A provider in a bad state must not blow up a GO: an empty catalog just means
    // "linear and unclamped", which is the safe reading of a param we know nothing about.
    const defsByHead = new Map<string, Map<string, AutomationTargetDef>>();
    const defFor = (head: string, provider: AutomationTargetProvider, path: string): AutomationTargetDef | undefined => {
      let m = defsByHead.get(head);
      if (!m) {
        m = new Map();
        try { for (const d of provider.enumerate()) m.set(d.path, d); } catch { /* keep going */ }
        defsByHead.set(head, m);
      }
      return m.get(path);
    };
    for (const e of entries) {
      // ⚠ THE SHAPE CHECK COMES FIRST, AND `path` BEFORE `value`. These entries are DOCUMENT data — a
      // hand-edited or tool-generated .artlux reaches here verbatim (Scene.audio has no normalizer) — and
      // isFadeablePath does `path.split('.')`, which throws on a missing or non-string path. This runs
      // INSIDE A GO — outside render, where no boundary reaches: one bad entry kills the GO mid-show.
      // sceneAudioEntries already drops the unaddressable ones at the door; this is the second lock, and
      // the one that also covers Cue.entries.
      if (!e || typeof e.path !== 'string' || typeof e.value !== 'number' || !isFadeablePath(e.path)) continue;
      const head = e.path.split('.')[0];
      const provider = automationTargetRegistry.get(head);
      if (!provider) continue;                       // the plugin is disabled — the entry persists, inert
      const def = defFor(head, provider, e.path);
      // THE FADE'S `from` IS THE *EFFECTIVE* VALUE, NOT THE AUTHORED ONE. provider.get() returns the
      // authored value — what the slider last wrote — and a fade NEVER touches the authored mix. So on the
      // SECOND recall of a path an authored `from` starts the leg where the operator's fader is, not where
      // the sound actually is: scene A fades master 1.0 → 0.2, scene B fades it → 0.5, and frame one of B
      // slams the master to FULL LEVEL before gliding down. getLive() = laneOvr ?? fade ?? authored.
      const from = provider.getLive?.(e.path) ?? provider.get(e.path);
      // ⚠ CLAMP THE DESTINATION TO THE TARGET'S OWN RANGE. This is the ONE door into the audio engine that a
      // number can be TYPED through: the ♪ inspector's value box is a free-text <input type=number> and an
      // OSC-fired or hand-edited entry has no UI in front of it at all. Every mixer fader is bounded
      // (master: min 0 max 1.5) — an entry was not. `2` typed where `0.2` was meant on audio.master.gain
      // rode writeFade → syncMaster → setMasterGain unchecked all the way to the native bus (which jlimits
      // at 4.0, i.e. +12 dB): a level event, in a venue, with nobody in the room. Same door for a filter
      // cutoff typed past Nyquist. enumerate() is the catalog and it carries min/max for every target — the
      // map is already built above for `log`. No def (a dangling path, or a provider that threw) ⇒ no range
      // to clamp against, so the value passes: we do not invent a bound we do not know.
      const to = def ? Math.min(def.max, Math.max(def.min, e.value)) : e.value;
      if (typeof from !== 'number') {
        // Nothing to glide FROM (a dangling path — the clip it addressed was deleted). Snap it: durMs 0,
        // so start() writes `to` straight into the fade layer and the entry is applied rather than dropped.
        legs.push({ path: e.path, from: to, to, transition: 'none', fadeSec: 0 });
        continue;
      }
      // A per-entry override REPLACES the owner's default, it does not AND with it (transitions.start:
      // `t.transition ?? opts.transition`, `t.fadeSec ?? opts.fadeSec`). An entry that explicitly asks for
      // 'smooth' inside a cue whose default is 'none' must FADE. Resolving here (rather than leaving the
      // leg's fields undefined) is also what makes the PER-CUE timing in applyCues real: the batch opts
      // handed to start() are cues[0]'s, and a leg with no fadeSec of its own would silently inherit them.
      // LOG-CURVE TARGETS FADE IN LOG SPACE — a filter cutoff (20 Hz–20 kHz), a delay time, an attack —
      // because the AUTOMATION engine does, and the operator compares the two in the room.
      legs.push({
        path: e.path, from, to,
        transition: e.transition ?? transition ?? 'smooth',
        fadeSec: e.fadeSec ?? fadeSec,
        log: def?.log ?? false,
      });
    }
    return legs;
  };

  // --- Scenes (look snapshots) ---
  // Capture the visible state — surfaces, fixtures, brightness, groups, 3D scene, projector
  // outputs — but not the timeline/assets (playing transport + media library) or rig wiring.
  //
  // ⚠ `timeline` IS OMITTED FROM THE TYPE, AND THAT IS LOAD-BEARING. This used to say
  // `Omit<Scene, 'id' | 'name' | 'fadeSec'>`, which claimed the snapshot DOES carry a timeline — a lie the
  // comment above already contradicted, and one that only compiled because Scene.timeline was optional.
  // Making the field required exposed it. It must stay omitted: handleUpdateScene does
  // `{ ...s, ...buildSceneSnapshot() }`, so a snapshot carrying a timeline would make "Update Scene"
  // CLOBBER the scene's own timeline with whatever is currently bound.
  const buildSceneSnapshot = (): Omit<Scene, 'id' | 'name' | 'fadeSec' | 'timeline'> => ({
    surfaces,
    fixtures: fixtures.map(f => ({ ...f, colorData: [] })),
    globalBrightness,
    // `groups` IS STRIPPED, for the reason the whole block below gives about trackingZones: a group is
    // {id, name, fixtureIds} — rig structure with no look in it. It rode this snapshot and a recall
    // assigned it, so a group created after a scene was stored was DELETED by the next GO onto that
    // scene, and every lighting clip aimed at it went silent while still reading as correct.
    // handleRecallScene ignores the field, so an old file that carries one is harmless.
    groups: undefined,
    // ⚠ `trackingZones` IS STRIPPED, AND FOR THE SAME CLASS OF REASON `timeline` IS OMITTED ABOVE.
    //
    // A TRIGGER ZONE IS THE ROOM, NOT THE LOOK. It is a rectangle taped to a real floor: it does not
    // change shape because the lighting changed. But it lived on Scene3D, Scene3D rides in this
    // snapshot, and recall assigns the whole object — so every scene silently carried a COPY of the
    // zones as they were when it was captured, and the first GO onto a scene captured BEFORE the zones
    // were drawn replaced the live list with nothing. Every zone vanished from the panel and the 3D
    // scene, and every zone-driven transition went inert — a show that simply stops reacting to people,
    // with nothing logged and nothing on screen to explain it.
    //
    // So the GEOMETRY stays at project scope (the live scene3D, saved once in ProjectData.scene3D) and
    // never travels; what DOES travel is `activeZoneIds` — which of the room's zones this look listens
    // to — because that genuinely is part of the look. See handleRecallScene, which preserves the live
    // list on the way back in, and docs/TRACKING_SYNC.md.
    // `viewFrom` is stripped for the same reason as trackingZones: it is where the OPERATOR is
    // looking in the editor, not part of the look. Captured, it would ride every scene and a GO
    // would yank the 3D viewport to whichever projector was selected when that scene was stored.
    scene3D: { ...scene3D, trackingZones: undefined, viewFrom: undefined },
    projectorOutputs,
  });
  const handleCaptureScene = () => {
    const id = generateId();
    // A fresh capture takes the currently-bound timeline as its own (deep-cloned so later edits to
    // other timelines don't mutate it); the snapshot itself is look-only so Update never clobbers it.
    //
    // ⚠ AUTOMATION IS DELIBERATELY NOT CLONED — this is a merge blocker, and the reachable one.
    //
    // On the Global pill `activeTimeline` IS the global doc, so a naive structuredClone handed the new scene
    // a COPY of every BASE lane. compileAutomation decides a lane's clock by which document holds it, so the
    // copy was retagged from the SHOW clock to the SCENE clock — AND it shadowed the real base lane by
    // targetPath (timeline.ts:519), deleting the genuine show-clock lane from the compile entirely. A house
    // fade on audio.master.gain therefore SNAPPED BACK TO ITS t=0 VALUE on every recall of that scene:
    // measured at +9.6 dB in a single frame, in front of an audience. And the clone was persisted, so it
    // recurred on every GO, in that project, forever.
    //
    // NOTHING IS LOST BY STRIPPING. With `automation: []` no scene lane shadows anything, so timeline.ts:519
    // hands back EVERY global lane tagged 'show'. The house fade keeps riding the show clock exactly as it
    // did — as the BASE LAYER, which is what baseAutomation is for. We remove the impostor, not the curve.
    // (A lane the operator actually draws ON this scene still rides the playhead and still shadows a global
    // lane on the same target — see scratch/laneclock-sim.mjs, which pins both.)
    const timeline: Timeline = { ...structuredClone(activeTimeline), automation: [] };
    // ⚠ `nextNumberedName` counts PER WORD, and that matters more here than anywhere else: `scenes[]`
    // holds BOTH `Scene N` (this door) and `State N` (handleCreateState — a state IS a scene plus a
    // graph node). On a shared counter, a show with three scenes and no state at all mints its first
    // state as `State 4`, and the operator reads that as three states they cannot find.
    setScenes([...scenes, { id, name: nextNumberedName('Scene', scenes), fadeSec: 0, ...buildSceneSnapshot(), timeline, accent: nextAccent(scenes.map(s => s.accent), id) }]);
  };
  // Re-capture current LOOK into an existing scene (keeps id/name/fadeSec/timeline) — MadMapper
  // "Update Scene". buildSceneSnapshot is look-only, so a scene's own timeline is never clobbered.
  const handleUpdateScene = (id: string) => {
    setScenes(scenes.map(s => s.id === id ? { ...s, ...buildSceneSnapshot() } : s));
  };
  const handleRenameScene = (id: string, name: string) => setScenes(scenes.map(s => s.id === id ? { ...s, name } : s));
  const handleUpdateSceneFade = (id: string, fadeSec: number) => setScenes(scenes.map(s => s.id === id ? { ...s, fadeSec } : s));
  // The ONLY writer of `scene.audio`. Deliberately NOT part of buildSceneSnapshot: "Update Scene" spreads
  // that snapshot over the scene, so a look-only snapshot is what keeps a carefully bound audio list alive
  // when the operator tweaks a light and presses Update.
  const handleUpdateSceneAudio = (id: string, entries: CueEntry[]) =>
    setScenes(prev => prev.map(s => s.id === id ? { ...s, audio: entries } : s));
  // Recall commits the target state immediately (discrete params snap), then — when fadeSec > 0 —
  // starts a render-free transition that animates the fadeable numerics from their old values to the
  // new ones (Stage pump overrides them per-frame, no React re-render). Every field beyond
  // fixtures/globalBrightness is presence-guarded so older minimal scenes still load.
  const handleRecallScene = (scene: Scene, origin: EditOrigin = 'show') => {
    // Only a human clicking GO records history. A recall reached through the show (FSM/OSC/cue/tablet/
    // scheduler) passes no origin → 'show' → no record. See plans/timeline-undo.md §5.2.
    if (origin === 'operator') recordHistory();
    // Capture the pre-recall view for the fade's "from" before committing the target.
    const fromView = { surfaces, fixtures, globalBrightness };
    // THE RIG SURVIVES THE RECALL — only the LOOK part of each fixture travels. `scene.fixtures` is a
    // whole-array snapshot, so assigning it replaced the live rig with the rig as it stood when the
    // scene was stored: a fixture patched since simply vanished, and every surviving one reverted to
    // the snapshot's universe/address/controller/profile/3D position. Since the FSM recalls on
    // entering EVERY state (including its initial one, on load), that made "add a head" or "re-patch"
    // undo itself the moment the show started. Reproduced in the running app; see sceneLook.ts, which
    // owns the look/rig split, and the trackingZones note in buildSceneSnapshot for the same lesson.
    const nextFixtures = mergeFixtureLook(fixtures, scene.fixtures);
    const toView = { surfaces: scene.surfaces ?? surfaces, fixtures: nextFixtures, globalBrightness: scene.globalBrightness };
    if (scene.surfaces) setSurfaces(scene.surfaces);
    setFixtures(nextFixtures);
    setGlobalBrightness(scene.globalBrightness);
    // GROUPS DO NOT TRAVEL AT ALL. A FixtureGroup is {id, name, fixtureIds} — pure rig structure with
    // no look content whatsoever, so a scene has nothing to say about it. Restoring the list deleted
    // any group made since the capture, and a lighting clip targets its group BY ID: the clip stays
    // on the timeline, configured correctly, driving nothing. Old files still carry `groups`; it is
    // ignored here (and no longer captured) exactly as trackingZones is.
    // THE ROOM SURVIVES THE RECALL. `trackingZones` is project-scope geometry and is stripped from the
    // snapshot (see buildSceneSnapshot) — but an OLD scene, captured before that rule existed, still
    // carries its own copy in the file, so this must not simply assign `scene.scene3D`. Keeping the live
    // list is both the migration and the invariant: a GO can change WHICH zones a look listens to
    // (activeZoneIds, which does travel), never which zones exist.
    if (scene.scene3D) setScene3D(prev => ({ ...scene.scene3D!, trackingZones: prev.trackingZones, viewFrom: prev.viewFrom }));
    if (scene.projectorOutputs) setProjectorOutputs(scene.projectorOutputs);
    setSelectedFixtureId(null);
    setSelectedFixtureIds([]);
    setSelectedSurfaceId(null);
    // ── AUDIO ── The scene's bound audio params. They do NOT ride the StateView diff above (audio is not on
    // the StateView and never will be) — they are an explicit {path, value} list, faded through the SAME
    // engine and the SAME batch as the look, so picture and sound move together, and landing in the
    // provider's fade layer UNDER any automation lane that owns the same path. Absent `scene.audio` ⇒ this
    // scene changes no audio, which is every project authored before this shipped.
    //
    // ⚠ A ZERO-FADE RECALL IS THE COMMON CASE (`fadeSec` defaults to 0) AND IT MUST STILL APPLY ITS AUDIO.
    // It does, because a zero-fade entry is a durMs-0 LEG, not a skipped one: `audioLegs` is non-empty, we
    // take the start() arm, and start()'s own !willAnimate branch writes those legs into the fade layer.
    // (Routing the snap through start() rather than writing it here is what puts it on the far side of the
    // re-target, so a still-live leg on the same path cannot slide back over it — see applyAudioEntries.)
    //
    // ⚠ PLUGIN HEADS ONLY — the same filter applyCues puts in front of this call. `Scene.audio` is written
    // by the ♪ picker, which only ever offers PLUGIN params, so this drops nothing an operator can author.
    // But the field has no normalizer, and a hand-edited scene carrying a CORE path (globalBrightness,
    // surfaces.<id>.x) would sail through: isFadeablePath passes it, the registry resolves the head to the
    // CORE provider, and transitions routes the leg down its setByPath arm — FADING a param the recall above
    // has already committed, then snapping it back when the leg lands. The contract is now structural rather
    // than conventional.
    const audioLegs = applyAudioEntries(sceneAudioEntries(scene).filter(isPluginHeadEntry), scene.fadeSec ?? 0, 'smooth');
    const lookLegs = (scene.fadeSec && scene.fadeSec > 0) ? collectFadeableTargets(fromView, toView) : [];
    // ⚠ THE LOOK IS REPLACED WHOLESALE ABOVE, SO EVERY IN-FLIGHT *CORE* LEG IS NOW STALE — it is gliding
    // toward a value this document no longer holds, and it would paint the OUTGOING scene's crossfade
    // straight over the look we just committed for the rest of its duration (a 0-fade recall, which has no
    // lookLegs of its own to re-target them, would be overpainted for seconds). Say so explicitly.
    //
    // It is NOT cancel(). cancel() also FINALIZES the plugin legs — it writes `leg.to` into the audio fade
    // layer — so recalling a look-only scene three seconds into a 20 s music duck used to snap the house
    // from ~0.95 to 0.3 in ONE FRAME, mid-sentence, and the FSM does exactly that on schedule every night.
    // A scene that binds no audio expresses NO OPINION about the sound: the duck runs to the same endpoint,
    // on its own clock, the way it was authored. (cancel() is still right for project open/new/reset —
    // "this show is over" — and that is now all it is used for.)
    transitions.dropCoreLegs();
    if (lookLegs.length || audioLegs.length) {
      transitions.start([...lookLegs, ...audioLegs], { fadeSec: scene.fadeSec ?? 0, transition: 'smooth' });
    }
    // Per-scene decoupled timelines: warm-swap the engine to this scene's own timeline (or global
    // content) and make this the CURRENT edit target — so "just editing" the timeline attaches here
    // and the editor binding never diverges from the engine's active pool. Manual GO, cueBus and the
    // FSM all reach here, so they inherit both for free.
    swapTimelineForScene(scene);
    setActiveSceneId(scene.id);
  };
  // Scenes already reported as recalled-cold. Once per scene, not once per recall: an FSM cycling a
  // show for a week must not fill a venue's console with the same line a million times.
  const coldEntryLogged = useRef(new Set<string>());
  // Warm-swap the playback engine to a scene's timeline, preloading its media first (hitless), and
  // bridge the new timeline to the projector windows. Keyed by scene.id (a per-scene pool), so
  // activePoolKey stays == activeSceneId.
  const swapTimelineForScene = (scene: Scene) => {
    // Every scene owns a timeline (types.ts). This used to fall back to the GLOBAL doc when a scene had
    // none — which is what made `data === globalDoc` true under a scene's pool key, and is the entire
    // reason isGlobalDocBound() had to exist as a question distinct from clocksCoincident().
    const tl = normalizeTimeline(scene.timeline);
    timelinePreloader.warm(scene.id, tl);
    // WAS THIS CUT HITLESS? docs/SCENE-TIMELINES.md has claimed a "60 fps warm-swap (still to be
    // measured)" since the tier was written. Ask before promoting — poolReady answers exactly "would
    // this put a picture on stage, or black" — and say so ONCE per scene, so an operator who sees a
    // flash has a line naming it and the residency budget has real evidence rather than a design
    // intention. After the swap it would always read ready (the pool is live by then), which is why
    // this sits here and not below.
    if (!coldEntryLogged.current.has(scene.id) && !timelineEngine.poolReady(scene.id, tl).ready) {
      coldEntryLogged.current.add(scene.id);
      console.warn(`[scene] "${scene.name}" was recalled before its content was ready — the cut may show a partial first frame`);
    }
    timelineEngine.swap(scene.id, tl, { transport: 'restart', holdMs: (scene.fadeSec ?? 0) * 1000 });
    for (const port of projectorPortsRef.current.values()) port.postMessage({ t: 'timeline', timeline: tl });
  };
  const handleRemoveScene = async (id: string) => {
    const sc = scenes.find(s => s.id === id);
    if (!await confirm({
      title: `Delete scene "${sc?.name ?? id}"?`,
      message: 'Its look, timeline and cues are removed. Ctrl+Z can bring it back.',
      confirmLabel: 'Delete', danger: true,
    })) return;
    // Scene + its embedded timeline + the cue cells are ALL in DocSnapshot, so this undoes clean —
    // and a state left ⚠ scene-missing by this delete heals when the undo restores the scene.
    recordHistory();
    setScenes(scenes.filter(s => s.id !== id));
    // If it was the current scene, fall back to global first (releasePool won't drop the active pool).
    if (activeSceneId === id) {
      setActiveSceneId(null);
      timelineEngine.swap(GLOBAL_POOL, timeline, { transport: 'reconverge' });
    }
    timelineEngine.releasePool(id); // free its warm pool if any
  };

  // --- Per-state authoring loop (trigger → build → save → continue) ---
  // Enter author mode for a scene: bind the editor to its own timeline and recall its look live so you
  // build against real output. The state-machine control layer is left as-is (author with it off).
  const enterAuthor = (sceneId: string) => {
    const scene = scenes.find(s => s.id === sceneId);
    if (!scene) return;
    // Recall already makes this the current edit target + swaps its pool; the scene's own timeline is
    // materialized lazily on first edit (handleTimelineChange), seeded from what was shown.
    handleRecallScene(scene);
  };
  // Leave author mode → edit the shared global timeline again (no look recall; just rebind + swap).
  const exitToGlobal = () => {
    setActiveSceneId(null);
    // RECONVERGE: the playhead snaps to the show clock, so the picture rejoins the bed that never
    // stopped. (This was 'preserve', which ran clampPlayheadIntoDoc → a `pause` intent → the audio
    // driver's stopAllSounding(): clicking the pill back to Global could kill the bed.)
    timelineEngine.swap(GLOBAL_POOL, timeline, { transport: 'reconverge' });
    for (const port of projectorPortsRef.current.values()) port.postMessage({ t: 'timeline', timeline });
  };
  // Create a new state: a Scene (current look + EMPTY timeline + stable accent) + a bound SmState node,
  // then drop straight into author mode on its empty timeline — the "new state → empty timeline" flow.
  const handleCreateState = () => {
    // Record first: this adds a Scene AND an SmState node, and both slices are in DocSnapshot.
    // (An older comment excluded this as "not a fixtures change" — a leftover from the
    // fixtures-only stack, dead since DocSnapshot widened to the whole authored document.)
    recordHistory();
    const id = generateId();
    const accent = nextAccent(scenes.map(s => s.accent), id);
    // `State N` counted among the STATES, not among all scenes — see handleCreateScene's note.
    const scene: Scene = { id, name: nextNumberedName('State', scenes), fadeSec: 0, ...buildSceneSnapshot(), timeline: defaultTimeline(), accent };
    setScenes(prev => [...prev, scene]);
    setStateMachine(prev => {
      const n = prev.states.length;
      const st: SmState = { id: generateId(), name: scene.name, x: 140 + (n % 5) * 150, y: 110 + Math.floor(n / 5) * 130, entry: [], sceneId: id };
      return { ...prev, states: [...prev.states, st], initialStateId: prev.initialStateId ?? st.id };
    });
    setActiveSceneId(id);
    timelinePreloader.warm(id, scene.timeline!);
    timelineEngine.swap(id, scene.timeline!, { transport: 'restart' });
    for (const port of projectorPortsRef.current.values()) port.postMessage({ t: 'timeline', timeline: scene.timeline });
  };
  // Save the state: re-capture look tweaks (the timeline already lives in the scene via onChange).
  const handleSaveState = () => { if (activeSceneId) handleUpdateScene(activeSceneId); };
  // Step to the adjacent state (scene order), recalling + rebinding — the "continue" step.
  const authorStep = (dir: 1 | -1) => {
    if (!scenes.length) return;
    const idx = activeSceneId ? scenes.findIndex(s => s.id === activeSceneId) : -1;
    const next = scenes[(idx + dir + scenes.length) % scenes.length];
    if (next) enterAuthor(next.id);
  };
  // Timeline edits write back to the OWNER: the active scene's own timeline, else the shared global one.
  // handleTimelineChange IS THE OPERATOR SEAM. It is what record() means for a timeline edit. It has
  // exactly TWO sanctioned callers, both human gestures: the timeline panel (the dock + fullscreen
  // TimelinePanel), and `services/takeRecorder` — which commits a finished lighting or tracking take
  // from whichever surface armed it (a dock panel, the action bar, the status chip, a shortcut). Every
  // writer of a bound timeline document that is NOT a human gesture (an FSM entry action, an OSC
  // message, a cue GO, the scheduler, an asset relink) calls setScenes/setTimeline DIRECTLY and must
  // keep doing so — routing a show event through here would fill an unattended install's undo stack with
  // changes nobody made. That constraint is INHERITED by takeRecorder: nothing may call it from
  // oscController, cueBus or the FSM action table. Each timeline commit fires this exactly once per
  // gesture (drafts commit on pointerup — see Timeline.tsx), so one record() here is one undo entry per
  // gesture, no latch needed. See plans/timeline-undo.md §5.1-5.2.
  const handleTimelineChange = (next: Timeline) => {
    recordHistory();
    if (activeSceneId) setScenes(prev => prev.map(s => s.id === activeSceneId ? { ...s, timeline: next } : s));
    else setTimeline(next);
  };
  const handleTimelineChangeRef = useRef(handleTimelineChange); handleTimelineChangeRef.current = handleTimelineChange;
  // Hand the take recorder its view of the bound document. Installed ONCE (`[]` deps) and reading refs,
  // in the same idiom as frameEngine.setHost / setCoreStateView above — because the surfaces that arm a
  // recorder are deliberately NOT inside App's React subtree: the StatusBar chip renders outside
  // <EditorStore>, and the shortcut fires from a window keydown listener. Neither can call a hook.
  useEffect(() => {
    takeRecorder.setHost({
      timeline: () => activeTimelineRef.current,
      // The same string handleTimelineChange routes on, so the async tracking commit's guard is keyed on
      // where the write will actually LAND. Identity, not value — see Timeline.tsx's docKey note.
      docKey: () => activeSceneIdRef.current ?? '__global__',
      commit: (next) => handleTimelineChangeRef.current(next),
      // The PROJECT's own document. `setTimeline` directly, NOT handleTimelineChange: that routes to
      // the bound scene (which is the bug this fixes) and records an undo entry. Recording a take is an
      // import — it takes the same door handleRemoveAsset already uses to delete one.
      globalTimeline: () => timelineRef.current,
      commitGlobal: (next) => setTimeline(next),
      projectPath: () => currentProjectPathRef.current,
      // THE LIGHTS IN THE SELECTION, IN SELECTION ORDER — not the raw selection.
      //
      // A take is built from the resolved fixture SIGNAL (pan/tilt in degrees, everything else 0..1),
      // which only a light fixture has; an LED strip contributes an EMPTY part. That is not merely
      // wasteful — parts are positional, so part N drives fixture N of the target group, and a take
      // carrying empty parts shifts every real one along and misaligns the phase spread. Filtering
      // here rather than at each door is what keeps the keyboard shortcut honest: it cannot arm a
      // capture the action bar and the panel both refuse. `isLight` is the one sanctioned answer to
      // "what kind is this" (services/fixtureKind) — never an open-coded `f.profileId ?`.
      selectedFixtureIds: () => selectedFixtureIdsRef.current
        .filter((id) => { const f = fixturesRef.current.find((x) => x.id === id); return !!f && isLight(f); }),
      notify: (kind, title, detail) => toastRef.current[kind](title, detail),
      // Resolved out of `scenes`, NOT off a pre-collapsed name — the exact rule audioOwnerName documents
      // in Timeline.tsx: an activeSceneId with no scene behind it must degrade to 'Scene', never to the
      // literal 'Global', or the chip tells you a take is going somewhere it is not.
      destinationName: () => (activeSceneIdRef.current
        ? (scenesRef.current.find(s => s.id === activeSceneIdRef.current)?.name || 'Scene')
        : 'Global'),
    });
  }, []);
  // ── STORE KEY — the last step of the light-fixture authoring loop ────────────────────────────
  //
  // Select a light, place it in 3D, position it, set its channels, then put THAT look on the
  // timeline at the playhead. planStoreKey() decides (it is pure and covers the three cases plus the
  // one refusal); everything here is the mutation, as ONE state change so it is one undo step.
  const handleStoreLightingKey = () => {
    const plan = planStoreKey({
      playhead: timelineEngine.getPlayhead(),
      clips: activeTimeline.clips,
      layers: activeTimeline.layers,
      groups, fixtures,
      states: fixtureSignal.snapshot(),
      selectedFixtureIds: selectedFixtureIds.length ? selectedFixtureIds : selectedFixtureId ? [selectedFixtureId] : [],
    });

    if (plan.kind === 'refused') { toast.error(plan.reason, plan.detail); return; }
    if (plan.warning) toast.info('Key stored', plan.warning);

    recordHistory();
    if (plan.kind === 'write') {
      handleTimelineChange({
        ...activeTimeline,
        lightingSequences: (activeTimeline.lightingSequences ?? []).map(
          (s) => (s.id === plan.sequenceId ? upsertKey(s, plan.key) : s)),
      });
      return;
    }

    // 'create': a new group and/or lane and/or clip, plus the sequence — committed together.
    if (plan.newGroup) setGroups([...groups, plan.newGroup]);
    const layerId = plan.layerId ?? generateId();
    const layers = plan.layerId
      ? activeTimeline.layers
      : [...activeTimeline.layers, { id: layerId, name: 'Lighting', kind: 'lighting' as const, enabled: true }];
    handleTimelineChange({
      ...activeTimeline,
      layers,
      lightingSequences: [...(activeTimeline.lightingSequences ?? []), plan.sequence],
      clips: [...activeTimeline.clips, {
        id: generateId(), layerId, name: plan.sequence.name, path: '', kind: 'lighting' as const,
        start: plan.clipStart, duration: Math.max(4, plan.sequence.duration), inPoint: 0,
        lighting: { groupId: plan.groupId, sequenceId: plan.sequence.id },
      }],
    });
  };

  // SAVE POSE TO LIBRARY — the companion to Store Key, and what fills the library that pose CUES
  // fire from. Same capture (the resolved fixture signal for the selected group), stored under a
  // name instead of at a time: keyframes are the storage of a show, cues are the invocation, and a
  // pose is the one atom they share.
  const handleSavePose = () => {
    const ids = selectedFixtureIds.length ? selectedFixtureIds : selectedFixtureId ? [selectedFixtureId] : [];
    const members = ids.map((id) => fixtures.find((f) => f.id === id)).filter((f): f is Fixture => !!f && isLight(f));
    if (!members.length) {
      toast.error('Select the lights first', 'A pose is what a group of light fixtures is doing — select some, then save.');
      return;
    }
    const slots = poseForGroup(members, fixtureSignal.snapshot());
    if (!slots.some((p) => Object.keys(p).length)) {
      toast.error('Those lights are not reporting anything yet', 'Give them a profile and set some channels first.');
      return;
    }
    recordHistory();
    setLightingPoses([...lightingPoses, {
      id: generateId(), name: nextNumberedName('Pose', lightingPoses), slots,
    }]);
  };

  // ── THE PLUGIN WRITE PATH INTO `Timeline.audio` (host.audio.patchTimelineClip) ────────────────────
  //
  // The mixer is a PLUGIN, and it has to be able to shape a clip that lives in a SCENE — its gain, mute,
  // spatial position and insert FX. Every other timeline edit reaches core through the `onChange(timeline)`
  // prop above, which no plugin can see; this is the host-service door onto THE SAME ROUTER, and it is the
  // only one. Deliberately NOT `setTimelineAudio(container)` — see AudioService.patchTimelineClip in the SDK
  // for why the symmetric-with-setMix shape is a trap. Three rules, each of them load-bearing:
  //
  //  1. IT ROUTES OFF THE SAME BINDING handleTimelineChange DOES. Active scene → that scene's own timeline;
  //     none → the global one. Anything that just called setTimeline would edit the GLOBAL document while a
  //     scene is on screen, and the operator's reverb would then be heard under EVERY scene.
  //  2. (RETIRED 2026-07-14.) This rule used to read: "A SCENE WITH NO TIMELINE OF ITS OWN MATERIALIZES ONE
  //     — from the document it is actually bound to (`activeTimeline` = scene.timeline ?? the global doc)."
  //     It was the THIRD writer of the lane-clock blocker: a mixer FX tweak from the audio plugin
  //     materialised a scene timeline out of the GLOBAL doc — automation lanes and all — with no core
  //     timeline edit anywhere. Every scene now owns a timeline (types.ts), so there is nothing to
  //     materialise from and the rule has no subject.
  //  3. THE ID RESOLVES IN THE BOUND DOCUMENT ONLY, AND A MISS IS A DROP — never a search across scenes.
  //     handleCaptureScene deep-clones the bound timeline (structuredClone, :773 — ids and all), so two
  //     scenes hold BYTE-IDENTICAL clip ids: `scenes.flatMap(s => s.timeline?.audio?.clips)` would match in
  //     the WRONG scene on the very first duplicate, silently, in a venue. A recall landing between the
  //     operator's gesture and its commit therefore LOSES the edit — which is the correct outcome, because
  //     they are no longer looking at that clip. (Core defends the same hazard with Timeline.tsx's docKey.)
  //
  // Held in a ref because the plugin-host memo below has [] deps and must not close over a render value
  // (see :234-238). This body reads ONLY refs and functional setState, so calling it from there is sound.
  const patchBoundTimelineClipRef = useRef<(clipId: string, patch: Partial<AudioClip>) => void>(() => {});
  patchBoundTimelineClipRef.current = (clipId, patch) => {
    // Rule 3 in one place: patch the clip if THIS document holds it, else `null` ⇒ hand the document back
    // untouched. (Both readers are the guarded ones — `audio` may be absent on a project older than Wave B.)
    const applied = (t: Timeline): Timeline | null => {
      const clips = timelineAudioClips(t);
      if (!clips.some(c => c.id === clipId)) return null;
      return { ...t, audio: { tracks: timelineAudioTracks(t), clips: clips.map(c => (c.id === clipId ? { ...c, ...patch } : c)) } };
    };
    const sceneId = activeSceneIdRef.current;
    if (!sceneId) { setTimeline(prev => applied(prev) ?? prev); return; }   // `?? prev` — a drop must not re-render
    setScenes(prev => {
      const i = prev.findIndex(s => s.id === sceneId);
      if (i < 0) return prev;
      const next = applied(prev[i].timeline);                              // the scene OWNS its timeline (rule 2, retired)
      if (!next) return prev;                                              // rule 3 — not this document's clip
      const out = prev.slice();
      out[i] = { ...prev[i], timeline: next };
      return out;
    });
  };
  // The author-context bundle handed to the timeline panel (scene pill + author strip). One object so
  // the panel's Props stay tidy; both panel mounts (dock + fullscreen) share it.
  const timelineAuthor = {
    activeSceneId,
    activeName: activeScene ? activeScene.name : 'Global',
    activeAccent: activeScene?.accent ?? GLOBAL_ACCENT,
    index: activeScene ? scenes.findIndex(s => s.id === activeScene.id) : -1,
    total: scenes.length,
    // `holdsAtEnd` mirrors the engine's own rule (LOOP WINS — a wrapping clock never reaches an end),
    // so the graph never advertises a hold the transport will not perform.
    scenes: scenes.map(s => ({ id: s.id, name: s.name, accent: s.accent, clipCount: s.timeline.clips.length, holdsAtEnd: !!s.timeline.holdAtEnd && !s.timeline.loop })),
    onSelect: (sid: string | null) => { if (sid) enterAuthor(sid); else exitToGlobal(); },
    onSave: handleSaveState,
    onPrev: () => authorStep(-1),
    onNext: () => authorStep(1),
    onNew: handleCreateState,
  };
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
  const baseAutomationProp = useMemo(
    () => (activeSceneId ? (timeline.automation ?? []) : []),
    [activeSceneId, timeline.automation],
  );
  const timelineBedProp = useMemo(
    () => (activeSceneId ? undefined : { mix: audioMix, onChangeMix: (m: AudioMix) => setAudioMix(normalizeAudioMix(m)) }),
    [activeSceneId, audioMix],
  );
  // Resolve a cueBus recall request (id then name) against current scenes. Held in a ref so the
  // once-subscribed cueBus listener always sees the latest scenes/handler closure.
  const recallByRefRef = useRef<(ref: string, fadeSec?: number) => void>(() => {});
  recallByRefRef.current = (ref: string, fadeSec?: number) => {
    const scene = scenes.find(s => s.id === ref) ?? scenes.find(s => s.name === ref);
    // A state-machine transition can override the scene's stored fade with its own transition time.
    if (scene) handleRecallScene(fadeSec != null ? { ...scene, fadeSec } : scene);
  };

  // --- Granular cues (apply a subset of params; compose; fade per entry) ---
  // Commit the new state (discrete params + final numerics snap immediately) then animate the
  // fadeable numerics from their old values to the new ones via the render-free transition engine.
  // Accepts several cues so a column-fire fades them as one batch.
  const applyCues = (cues: Cue[], origin: EditOrigin = 'show') => {
    if (!cues.length) return;
    // Operator GO records; a cue fired by the show (default 'show') does not. See §5.2.
    if (origin === 'operator') recordHistory();
    // POSE CUES — the lighting arm, fired before the dot-path entries because it touches neither
    // `next` nor the fade legs: it writes role values into its own overlay layer (between the
    // lighting clip and the automation lane), which the packer samples per frame. That separation is
    // why a look can be fired from the cue grid, the tablet, OSC or a state's entry action with no
    // per-surface wiring at all — they all end up here.
    const lightingEntries = cues.flatMap((c) => (Array.isArray(c.lighting) ? c.lighting : []));
    if (lightingEntries.length) {
      lightingCue.fire(lightingEntries, lightingPoses, groups, fixtures, performance.now());
    }

    const fromView: StateView = { surfaces, fixtures, globalBrightness };
    let next: StateView = { surfaces, fixtures, globalBrightness };
    const legs: transitions.FadeLeg[] = [];
    // cueEntries(): the container AND the elements. `Cue.entries` has no normalizer, so a `for…of` over a
    // non-array throws and a bad element throws on the very next line — inside a GO, outside render, where
    // no boundary reaches. Coerce, do not drop the show.
    for (const cue of cues) for (const e of cueEntries(cue.entries)) {
      if (isPluginHeadEntry(e)) continue;            // audio.* — handled below; `next` would DROP it anyway
      if (isFadeablePath(e.path) && typeof e.value === 'number') {
        const from = getByPath(fromView, e.path);
        if (typeof from === 'number') legs.push({ path: e.path, from, to: e.value, transition: e.transition ?? cue.transition, fadeSec: e.fadeSec ?? cue.fadeSec });
      }
      next = setByPath(next, e.path, e.value);
    }
    setSurfaces(next.surfaces);
    setFixtures(next.fixtures);
    setGlobalBrightness(next.globalBrightness);
    // Plugin-namespaced entries (audio.*). They never touch the StateView — setByPath silently returns it
    // unchanged for a non-core head, so committing them into `next` above would have DROPPED THEM ON THE
    // FLOOR. They go to their provider's fade layer, through the same fade engine, in the same batch.
    //
    // ⚠ PER CUE, NOT FLATTENED. Every cue carries its OWN fadeSec/transition and the core loop right above
    // honours that (`e.fadeSec ?? cue.fadeSec`). Flatten the entries and hand them cues[0]'s timing and a
    // column would fade its music in 0.5 s because the FIRST cue is a 0.5 s look cue — or SNAP it, if
    // cues[0].transition is 'none'. And fireColumn sorts bottom-to-top, so cues[0] is not even the one the
    // operator thinks of as "first". Iterate.
    for (const cue of cues) {
      legs.push(...applyAudioEntries(cueEntries(cue.entries).filter(isPluginHeadEntry), cue.fadeSec, cue.transition));
    }
    // The opts below are only the BATCH DEFAULTS; every leg above already carries its own fadeSec and
    // transition, so no leg ever actually reads them. (That is already true of the core legs.)
    //
    // ⚠ NO `else cancel()`. A CUE PATCHES THE PATHS IT NAMES AND NOTHING ELSE — it does not replace the
    // look, so it has no business ending a fade it never touched. cancel() FINALIZES every in-flight leg
    // straight to its endpoint, and a discrete-only cue produces NO legs at all: "swap the effect" is a
    // perfectly ordinary cue (CueBankPanel captures content.effectId / content.paletteId, neither of them
    // fadeable, neither of them a number), and firing one three seconds into a 20-second music duck snapped
    // the house from ~0.95 to 0.3 IN ONE FRAME, mid-sentence, while the running look crossfade jumped to
    // its endpoint too. In an unattended install the FSM and the scheduler fire these on schedule — so it
    // happened every night, on cue, with nobody there to hear it.
    //
    // There is nothing to fight, either: legs only ever exist on FADEABLE NUMERIC paths, and the paths a
    // discrete cue commits are not leg paths. A cue that DOES name a faded path re-targets it in start().
    if (legs.length) transitions.start(legs, { fadeSec: cues[0].fadeSec, transition: cues[0].transition });
  };
  const fireCueByRef = (ref: string) => {
    for (const b of cueBanks) {
      const cue = b.cues.find(c => c.id === ref) ?? b.cues.find(c => c.name === ref);
      if (cue) { applyCues([cue]); return; }
    }
  };
  // Fire a column: its row-0 scene if present, else every cue in the column (bottom-to-top).
  const fireColumn = (bankRef: string, col: number, origin: EditOrigin = 'show') => {
    const bank = cueBanks.find(b => b.id === bankRef) ?? cueBanks.find(b => b.name === bankRef);
    if (!bank) return;
    const cell = bank.sceneCells.find(sc => sc.col === col);
    const scene = cell ? scenes.find(s => s.id === cell.sceneId) : undefined;
    if (scene) { handleRecallScene(scene, origin); return; }
    applyCues(bank.cues.filter(c => c.col === col).sort((a, b) => b.row - a.row), origin);
  };
  // Held in refs so the once-subscribed cueBus listeners always see the latest closures.
  const fireCueRef = useRef<(ref: string) => void>(() => {});
  fireCueRef.current = fireCueByRef;
  const fireColumnRef = useRef<(bankRef: string, col: number) => void>(() => {});
  fireColumnRef.current = fireColumn;

  // --- Fixture library (templates persisted in userData) ---
  const persistTemplates = (next: FixtureTemplate[]) => {
    setTemplates(next);
    window.artlux?.setPrefs?.({ fixtureTemplates: next });
  };
  // A TEMPLATE IS AN LED-FIXTURE SHAPE. Every field it carries — ledCount, matrix, serpentine,
  // colour order, channels/pixel — describes a pixel run, so saving one from a moving head produced
  // a template that said nothing about the head and rebuilt it as a 1-LED strip. A light's reusable
  // form already exists and is better: its PROFILE plus a mode. (If "my house PAR, pre-aimed" is
  // ever wanted, that is a preset of `dmx` values — a different, small feature that should be named
  // as one rather than smuggled in here.)
  const handleSaveTemplate = () => {
    if (!selectedFixture) return;
    const f = selectedFixture;
    if (isLight(f)) {
      toast.error('Templates are for LED fixtures', 'A light fixture is reused through its DMX profile and mode, which already carry everything a template would.');
      return;
    }
    const t: FixtureTemplate = {
      id: generateId(), name: f.name || nextNumberedName('Template', templates),
      ledCount: f.ledCount, shape: f.shape, matrixWidth: f.matrixWidth, matrixHeight: f.matrixHeight,
      serpentine: f.serpentine, colorOrder: f.colorOrder, rgbwMode: f.rgbwMode, channelsPerPixel: f.channelsPerPixel,
    };
    persistTemplates([...templates, t]);
  };
  const handleAddFromTemplate = (t: FixtureTemplate) => {
    recordHistory();
    const id = generateId();
    // Templates carry the full pixel description, so a "Pixel Bar 150" or an 8×8 matrix lands at
    // its true proportions immediately (same derivation + centering as handleAddFixture).
    const size = derivedFixtureRect(t);
    setFixtures([...fixtures, {
      // The word here is the TEMPLATE's name, so the count is now per-template: three `Pixel Bar`
      // adds read `Pixel Bar 1..3` instead of borrowing the rig's total fixture count and starting at
      // `Pixel Bar 12`. (The helper escapes the word — a template called `Bar (2m)` is a valid name
      // and would otherwise be a regex that matches nothing.)
      id, name: nextNumberedName(t.name, fixtures),
      x: 0.5 - size.width / 2, y: 0.5 - size.height / 2, width: size.width, height: size.height,
      universe: 0, startAddress: 1, reverse: false, rotation: 0, colorData: [],
      ledCount: t.ledCount, shape: t.shape, matrixWidth: t.matrixWidth, matrixHeight: t.matrixHeight,
      serpentine: t.serpentine, colorOrder: t.colorOrder, rgbwMode: t.rgbwMode, channelsPerPixel: t.channelsPerPixel,
      surfaceId: selectedSurfaceId ?? surfaces[0]?.id,
    }]);
    handleSelectFixture(id);
  };
  const handleRemoveTemplate = (id: string) => persistTemplates(templates.filter(t => t.id !== id));

  const defaultSurfaces = (): Surface[] => ([
    { id: generateId(), name: 'Surface 1', x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 0, content: { type: SourceType.NONE } },
  ]);

  const buildProjectData = () => ({
      // 1.1: asset paths stored relative to the project folder when collected.
      // 1.2: every Timeline carries `boundedDuration` — the Wave A marker that says its Length was
      //      authored against a clock that Length actually bounds, so the load-time "raise Length to
      //      the content end" migration must not run on it again (see types.ts). Informational only:
      //      nothing has ever READ this field (the migration is gated on the per-timeline marker, not
      //      on this), so an older build opening a 1.2 file behaves exactly as it always did.
      version: '1.2',
      timestamp: new Date().toISOString(),
      surfaces,
      fixtures,
      controllers,
      // The DMX profiles this rig references, carried WITH the show. A project is portable: on a
      // venue PC whose library is older, or which never had a hand-authored profile, an unembedded
      // profile is simply absent — and a fixture with no resolvable profile has no known footprint,
      // so the patch silently shifts for everything after it on the same controller. Only the
      // profiles actually in use are written.
      fixtureProfiles: profiles.usedBy(fixtures),
      reserveLockedRanges: patchPolicy.reserveLockedRanges,
      globalBrightness,
      groups,
      lightingPoses,
      scenes,
      cueBanks,
      scene3D,
      timeline,
      stateMachine,
      schedule, // in-project wall-clock schedule (show-control plugin owns the shape)
      audio: audioMix, // global audio bed (plugins/audio); AudioMix — normalizeAudioMix() on load
      assets,
      projectorOutputs,
      outputSpans,
      projectorFpsCap,
      projectorBrightness,
  });

  // Apply a loaded project (or rig-free project) to app state. Strips live colorData.
  const applyProjectData = (data: any) => {
      // Cold-open trace: a fresh table per open (see services/openTrace.ts). The main-side half —
      // read/parse/resolve — logs its own `[open]` line; this covers the renderer half through to
      // bootGate's 'gate-armed'. It is how "a heavy project opens slowly" becomes "WHICH phase grew".
      openTrace.begin();
      openTrace.mark('apply-start');
      // Opening a project CLEARS the undo stack — this document has no shared history with the outgoing
      // one. Without this, one Ctrl+Z after File→Open would restore the PREVIOUS project's whole document
      // over the just-opened one (plans/timeline-undo.md §5.3). reset() replaces the old record()-here.
      resetHistory();
      // …and so does an armed click-to-place: its target belongs to the outgoing document.
      placement.disarm();
      // Surfaces: use the saved ones, or fall back to a default full-stage surface
      // (back-compat with pre-surfaces projects).
      const surf = Array.isArray(data?.surfaces) && data.surfaces.length ? data.surfaces as Surface[] : defaultSurfaces();
      setSurfaces(surf);
      // The profiles this show carries, adopted BEFORE the fixtures that reference them, so the very
      // first patch/footprint pass already resolves. Per-document, not accumulated: a profile from a
      // closed show must stop shadowing the library.
      profiles.setEmbedded(Array.isArray(data?.fixtureProfiles) ? data.fixtureProfiles : []);
      if (data?.fixtures && Array.isArray(data.fixtures)) {
          // Default-link any unlinked fixture to the first surface (strict per-surface). Repair legacy
          // corruption: a non-array `segments` (e.g. `{"0":…}` from a pre-fix cue write) is always
          // garbage — coerce it back to undefined so Stage's `segments.map` can't throw on load.
          //
          // A PROFILED FIXTURE ALWAYS GETS A `dmx` OBJECT. setByPath refuses to fabricate a missing
          // nested container (the guard that stopped a cue corrupting `segments`), so a profiled
          // fixture loaded without one would silently swallow every cue, lane and scene aimed at its
          // channels — no error, no output, nothing to debug. An empty object is enough: every
          // channel falls back to the profile's own default when its key is absent.
          setFixtures(data.fixtures.map((f: any) => ({
            ...f,
            colorData: [],
            surfaceId: f.surfaceId ?? surf[0]?.id,
            segments: Array.isArray(f.segments) ? f.segments : undefined,
            ...(isLight(f) && (!f.dmx || typeof f.dmx !== 'object') ? { dmx: {} } : {}),
          })));
      }
      // ── A PROJECT DOES NOT RECONFIGURE THE BUILDING ────────────────────────────────────────────────
      // `settings` is NOT read from the file, and `buildProjectData` no longer writes it. AppSettings is
      // the MACHINE — the sound card, the Art-Net target, the OSC port — and `Prefs.appSettings` already
      // persists it per-machine. Carrying a second copy in the .artlux meant OPENING A SHOW REPATCHED THE
      // VENUE: a project authored in binaural/2ch flipped an octagon/8ch rig to a headphone mix, and
      // :2411 wrote that back to prefs so it stuck.
      //
      // Legacy files still HAVE a `settings` key. It is deliberately ignored — that is the fix, not an
      // oversight. The one show-scoped field it used to hold is rescued by readPatchPolicy() below.
      setPatchPolicy(readPatchPolicy(data));
      if (typeof data?.globalBrightness === 'number') setGlobalBrightness(data.globalBrightness);
      setControllers(Array.isArray(data?.controllers) ? data.controllers : []);
      setGroups(Array.isArray(data?.groups) ? data.groups : []);
      // The pose library, and the cue layer that fires from it. RELEASED on load for the same reason
      // the undo stack is reset: a held cue belongs to the outgoing document, and leaving it latched
      // would drive the incoming rig from a look it never had.
      setLightingPoses(normalizeNamedPoses(data?.lightingPoses));
      lightingCue.clear();
      // Scenes: normalize any per-scene timeline and assign a stable accent to scenes missing one
      // (older projects / scenes captured before accents). The current edit target is bound below.
      const rawScenes: Scene[] = Array.isArray(data?.scenes) ? data.scenes : [];
      const usedAccents: (string | undefined)[] = [];
      const loadedScenes: Scene[] = rawScenes.map(s => {
        const accent = s.accent ?? nextAccent(usedAccents, s.id);
        usedAccents.push(accent);
        // EVERY SCENE OWNS A TIMELINE — and this is the door where that becomes true. The loader used to
        // PRESERVE an absent timeline (`: undefined`), which is how a legacy/imported file kept the
        // timeline-less shape alive. normalizeTimeline already takes `undefined` and returns a complete
        // Timeline, so an old scene simply gets an empty one here. Without this line the required field on
        // Scene would be a lie at runtime: tsc would believe it, and the app would hold undefined.
        return { ...s, accent, timeline: normalizeTimeline(s.timeline) };
      });
      // MIGRATION: HOIST STRANDED TRACKING TAKES INTO THE PROJECT LIBRARY.
      //
      // A LiDAR take is captured reality and belongs to the project, so its ref lives on the GLOBAL
      // document — that is the list the Media panel renders and the one any scene can draw from. But
      // until 2026-08-06 the recorder committed through the bound document, so every take recorded
      // while a scene was on air was written into THAT SCENE. Those takes are invisible to the media
      // library (which reads the global doc) and cannot be placed anywhere else. Hoist them once, on
      // open, deduped by id; the `.lblob` files are untouched, only the refs move. Idempotent, so a
      // project saved after this simply has nothing left to hoist.
      const strandedTakes = loadedScenes.flatMap(s => s.timeline?.trackingTakes ?? []);
      if (strandedTakes.length) {
        for (const s of loadedScenes) if (s.timeline) s.timeline = { ...s.timeline, trackingTakes: [] };
        console.info(`[takes] hoisted ${strandedTakes.length} scene-local tracking take(s) into the project library`);
      }
      setScenes(loadedScenes);
      // This mark is metric B's needle: the per-scene normalize above is the one open cost that grows
      // with scene count (plans/preload-optimization.md §4). If its delta is flat, phase 6 is done.
      openTrace.mark('scenes-normalized');
      // Cue banks: use saved banks, else synthesize Bank 1 and place existing scenes in row 0 so
      // older (pre-cues) projects open with their scenes already on the grid.
      //
      // ⚠ normalizeCueBanks, NOT a cast. `Array.isArray(data.cueBanks)` guards the OUTER array only, and the
      // cast that used to stand in for validation guards NOTHING: a bank whose `cues` is `{"0":…}` reaches
      // App's own render (`cueBanks.flatMap(b => b.cues.map(...))`, the TimelinePanel `cues` prop — no dock
      // tab required) and white-screens the app on load, and reaches fireColumn's `bank.cues.filter(...)`,
      // where the throw is NOT a white screen but something quieter: the GO silently never fires. Container
      // AND elements, like every other document container. (`Cue.entries` stays raw — cueEntries() owns it.)
      const banksLoaded = normalizeCueBanks(data?.cueBanks);
      if (banksLoaded.length) {
        setCueBanks(banksLoaded);
      } else {
        const bank = defaultCueBank(generateId());
        bank.sceneCells = loadedScenes.map((s, i) => ({ col: i, sceneId: s.id }));
        setCueBanks([bank]);
      }
      const tlRaw = normalizeTimeline(data?.timeline);
      // …and land them here, after the global doc is normalized. Deduped by id, global's own first, so
      // re-opening a half-migrated project cannot double a take.
      let tl = tlRaw;
      if (strandedTakes.length) {
        const merged = [...(tlRaw.trackingTakes ?? [])];
        const seen = new Set(merged.map(t => t.id));
        for (const t of strandedTakes) if (!seen.has(t.id)) { seen.add(t.id); merged.push(t); }
        tl = { ...tlRaw, trackingTakes: merged };
      }
      setTimeline(tl);
      // State machine: project-level field, else migrate a legacy machine nested in the timeline.
      const legacySm = (data?.timeline as any)?.stateMachine;
      const smLoaded = normalizeStateMachine(data?.stateMachine ?? legacySm);
      setStateMachine(smLoaded);
      // In-project wall-clock schedule (show-control plugin). Opaque array at App scope; the plugin
      // owns/normalizes the entry shape. Flows through buildProjectData → the .artlux file.
      setSchedule(Array.isArray(data?.schedule) ? data.schedule : []);
      // Global audio bed. normalizeAudioMix defaults a missing/old field → empty bed (back-compat).
      setAudioMix(normalizeAudioMix(data?.audio));
      // Bind the editor to the CURRENT scene on open (the initial-state scene, else the first) and swap
      // the engine to its pool — so "just editing" the timeline attaches to a real scene, not the shared
      // global one. The loaded project surfaces are already the startup look, so we don't re-recall it
      // here (interactive GO/select does). Local loaded vars avoid stale-state closures. No scenes →
      // stay on the global timeline.
      const initialSceneId = smLoaded.initialStateId
        ? smLoaded.states.find(s => s.id === smLoaded.initialStateId)?.sceneId
        : undefined;
      const currentScene = loadedScenes.find(s => s.id === initialSceneId) ?? loadedScenes[0] ?? null;
      setActiveSceneId(currentScene?.id ?? null);
      const curKey = currentScene ? currentScene.id : GLOBAL_POOL;
      const curTl = currentScene ? normalizeTimeline(currentScene.timeline) : tl;
      timelineEngine.setGlobalDoc(tl);   // BEFORE the swap — swap's showClock:'reset' reads globalDoc
                                         // synchronously, and the [timeline] effect above is passive.
      // A SCENE/CUE FADE LAYER IS SHOW STATE, NOT DOCUMENT STATE — drop it, or the OUTGOING project's fades
      // keep shadowing the INCOMING project's authored values, silently and forever (a plugin's override
      // layer is module-level and the plugin is never deactivated). The audio driver reads
      // `laneOverride ?? sceneFade ?? authored`, so a stale master fade would clamp the new show's output
      // with the fader sitting at 1.0 and reading as perfectly healthy.
      //
      // ORDER IS LOAD-BEARING, AND IT IS THE COUNTER-INTUITIVE WAY ROUND. cancel() must come FIRST, and
      // NOT because it tidies core (core's fades live on the StateView, which we replace wholesale) —
      // because of the two things it does to the PLUGIN layer, both of which defeat releaseAllFades if they
      // happen after it:
      //   · An in-flight fade left running would be REFILLED by the very next transitions.apply() frame,
      //     with the OUTGOING project's legs, straight over the freshly-loaded mix.
      //   · cancel() FINALIZES abandoned plugin legs — it WRITES `leg.to` into the fade layer. Run it
      //     second and it resurrects the outgoing show's fades into the new project by hand.
      // cancel() → releaseAllFades() writes the endpoints and then clears them: net empty, which is right.
      transitions.cancel();
      for (const p of automationTargetRegistry.all()) p.releaseAllFades?.();
      timelinePreloader.warm(curKey, curTl);
      openTrace.mark('warm-issued'); // fire-and-forget issuance — the DECODE cost lands in the gate span
      // Opening a project RESETS the show clock (the bed's time restarts with the show); a scene recall
      // never does. Both reach swap() with transport:'restart' and cannot be told apart in there.
      timelineEngine.swap(curKey, curTl, { transport: 'restart', showClock: 'reset' });
      openTrace.mark('swap-done');
      // ── WAIT FOR THE CONTENT, THEN PLAY ────────────────────────────────────────────────────────
      // HOLD the state machine until the look above is actually decoded. warm()/swap() are
      // fire-and-forget: without this the FSM would initialize on the very next frame, enter its
      // initial state and run its `play` entry action over empty decoders — the show's opening
      // seconds out BLACK on the projectors and on Art-Net, with an 'afterDelay' dwell already
      // burning. bootGate arms it when the first frame of every layer + the surfaces' own media are
      // resident, or after the venue's timeout (it always fails open). See services/bootGate.ts.
      //
      // EVERY cold start funnels through applyProjectData — editor open, --project=, the watchdog's
      // relaunch, the show-control playlist's next show — so this one call covers all of them.
      bootGate.hold({ poolKey: curKey, timeline: curTl, surfaces: surf });
      // Asset library: use saved assets; migrate a legacy take-only project (trackingTakes but no
      // assets) so recorded takes still appear in the library. Takes stay owned by the timeline.
      setAssets(Array.isArray(data?.assets) ? data.assets as AssetEntry[] : []);
      setProjectorOutputs(Array.isArray(data?.projectorOutputs) ? data.projectorOutputs as ProjectorOutput[] : []);
      setOutputSpans(Array.isArray(data?.outputSpans) ? data.outputSpans as OutputSpan[] : []);
      setProjectorFpsCap(typeof data?.projectorFpsCap === 'number' ? data.projectorFpsCap : 0);
      setProjectorBrightness(typeof data?.projectorBrightness === 'number' ? data.projectorBrightness : 1);
      setScene3D(() => {
          const s = data?.scene3D ? { ...defaultScene3D(), ...data.scene3D } : defaultScene3D();
          if (!Array.isArray(s.models)) s.models = [];
          // MIGRATE ZONE DWELL to the venue-wide model. The first zones shipped with enterSec/exitSec
          // BAKED at 0.2 / 0.5; those are now the DEFAULT every zone follows, tuned once in the tracking
          // parameters. A zone that still carries exactly the shipped defaults was never deliberately
          // overridden — strip them so the on-site knob moves it. A zone with any OTHER value is a real
          // override and is left alone. Harmless if it re-runs: a value that already equals the default
          // simply gets dropped again, and the effective dwell never changes (venue default is 0.2/0.5).
          if (Array.isArray(s.trackingZones)) {
              s.trackingZones = (s.trackingZones as { enterSec?: number; exitSec?: number }[]).map((z) => {
                  const out = { ...z };
                  if (out.enterSec === 0.2) delete out.enterSec;
                  if (out.exitSec === 0.5) delete out.exitSec;
                  return out;
              }) as typeof s.trackingZones;
          }
          // Migrate a legacy single venue model into the models array.
          if (s.modelPath && s.models.length === 0) {
              s.models = [{
                  id: generateId(), name: 'Venue', path: s.modelPath,
                  position: s.modelPosition ?? { x: 0, y: 0, z: 0 },
                  rotation: s.modelRotation ?? { x: 0, y: 0, z: 0 },
                  scale: s.modelScale ?? 1, visible: true,
              }];
          }
          return s;
      });
      setSelectedFixtureId(null);
      setSelectedFixtureIds([]);
      setSelectedSurfaceId(null);
      openTrace.mark('apply-end');
  };

  const refreshRecents = async () => {
      const prefs = await window.artlux?.getPrefs?.();
      if (prefs) setRecentFiles(prefs.recentFiles ?? []);
  };

  // buildProjectData is redefined every render, so the memoized plugin host reaches it through a ref
  // — otherwise host.project.save() would serialize whatever the document was at activation.
  const buildProjectDataRef = useRef(buildProjectData); buildProjectDataRef.current = buildProjectData;

  // Save to the current file (Save) or prompt for a location (Save As / first save).
  const handleSaveProject = async () => {
      try {
          const path = await window.artlux?.saveProject?.(buildProjectData(), currentProjectPath ?? undefined);
          if (path) { setCurrentProjectPath(path); refreshRecents(); toast.success('Project saved'); }
          return path ?? null; // null = the user cancelled the Save dialog (not an error)
      } catch (err) {
          toast.error('Save failed', String((err as Error)?.message ?? err));
          return null;
      }
  };
  const handleSaveAs = async () => {
      try {
          const path = await window.artlux?.saveProject?.(buildProjectData(), undefined);
          if (path) { setCurrentProjectPath(path); refreshRecents(); toast.success('Project saved'); }
      } catch (err) {
          toast.error('Save failed', String((err as Error)?.message ?? err));
      }
  };
  const handleOpenProject = async () => {
      try {
          const res = await window.artlux?.openProject?.();
          if (res) { applyProjectData(res.data); setCurrentProjectPath(res.path); refreshRecents(); }
      } catch (err) {
          toast.error('Could not open project', String((err as Error)?.message ?? err));
      }
  };
  const handleOpenRecent = async (path: string) => {
      try {
          const data = await window.artlux?.loadProjectPath?.(path);
          if (data) { applyProjectData(data); setCurrentProjectPath(path); refreshRecents(); }
          else toast.error('Could not open project', 'The file could not be read.');
      } catch (err) {
          toast.error('Could not open project', String((err as Error)?.message ?? err));
      }
  };

  // Rig = patch/wiring/routing/geometry only (no effects/segments/scenes/media).
  const handleExportRig = async () => {
      const rigFixtures = fixtures.map((f: any) => {
          const { source, effectId, paletteId, speed, intensity, segments, colorData, ...rig } = f;
          return rig;
      });
      await window.artlux?.exportRig?.({ version: '1.0', kind: 'rig', fixtures: rigFixtures });
  };
  const handleImportRig = async () => {
      const rig = await window.artlux?.importRig?.();
      if (rig?.fixtures?.length) {
          recordHistory();
          const imported = rig.fixtures.map((f: any) => ({ ...f, id: generateId(), colorData: [] }));
          setFixtures([...fixtures, ...imported]);
      }
  };

  // The fresh surfaces/fixtures/cue banks of a clean single-fixture project (no setState — see callers).
  //
  // The banks are MINTED HERE, not in resetToNewProject, for the same reason surfaces/fixtures are: the
  // caller writes the SAME value into state AND into the file it saves (setState hasn't applied to that
  // closure yet), and defaultCueBank mints an id — so building it twice would put a different Bank 1 id in
  // memory than on disk. One empty Bank 1 is exactly what applyProjectData synthesizes when it opens a
  // project with no banks, and a clean project has no scenes, so sceneCells is empty there too: the grid you
  // see after New Project is the grid you get when you reopen the file New Project just wrote.
  const makeNewProjectState = () => {
      const surf = defaultSurfaces();
      const fix = [{
          id: generateId(), name: 'Fixture 1',
          x: 0.15, y: 0.15, width: 0.7, height: 0.1,
          universe: 0, startAddress: 1, ledCount: 60, reverse: false, rotation: 0, colorData: [],
          surfaceId: surf[0].id,
      }];
      return { surfaces: surf, fixtures: fix, cueBanks: [defaultCueBank(generateId())] };
  };
  // Reset app state to a clean project — and HAND BACK the document that describes it.
  //
  // ── THE CONTRACT, AND IT IS ALREADY WRITTEN DOWN IN THIS FILE ────────────────────────────────────────
  // `applyProjectData` IS THE DEFINITION OF DOCUMENT STATE: whatever OPEN restores from a file is, by
  // construction, part of the show. So NEW must reset every one of those fields, and must write every one of
  // them clean. The two functions are two halves of one contract — and they had drifted badly.
  //
  // The old comment here said *"Keeps settings/scene3D/timeline (matches prior New behavior)."* It names
  // three fields. **Only `settings` is right** — and at the time this comment was written it earned its
  // exemption honestly: OPEN *merged* it (`{...prev, ...data.settings}`) rather than replacing it, because
  // it is the audio device and the OSC port, i.e. the machine, not the show. `scene3D` and `timeline` are
  // the show, and keeping them meant a brand-new project opened holding the last one.
  //
  // P6 (Task 2) removed that merge outright: `settings` is now the ONE field that never round-trips
  // through this contract at all — `buildProjectData` doesn't write it and `applyProjectData` doesn't read
  // it, so there is nothing here for `resetToNewProject` to reset or return. See AppSettings' header in
  // types.ts and `ProjectData.settings`'s tombstone in shared/protocol.ts.
  //
  // ⚠ IT RETURNS THE OVERRIDES, AND THAT IS THE POINT. `buildProjectData()` reads REACT STATE, and the
  // caller runs it in the SAME SYNCHRONOUS HANDLER as this function — so none of the setStates below have
  // applied to that closure yet, and every field the caller does not explicitly override is written into the
  // brand-new file WITH THE OUTGOING SHOW'S VALUE. That override list used to live in `handleNewProject`,
  // separately, and it HAS NOW FAILED THREE TIMES: the cue grid and the state machine were each patched in
  // after the fact, and when the user ran acceptance test 2.8c on 2026-07-14 the **bed, the schedule, the
  // timeline and the 3D scene were all still leaking into the new project file** — including the bed's clip
  // paths, still pointing into the OLD project's folder, beside an empty asset library. A list you have to
  // *remember* to extend is a list that will drift again. It is returned from the function that does the
  // resetting, so it cannot.
  const resetToNewProject = (st: ReturnType<typeof makeNewProjectState>) => {
      // File→New clears the undo stack — the fresh document shares no history with the outgoing one
      // (plans/timeline-undo.md §5.3). reset() replaces the old record()-here.
      resetHistory();
      setSurfaces(st.surfaces);
      setFixtures(st.fixtures);
      setControllers([]);
      setGroups([]);
      setScenes([]);
      // …and the CUE GRID goes with them. Same defect as the state machine below, one field over: the banks
      // are the OTHER container whose contents are nothing but sceneIds — every sceneCells entry names a
      // scene `setScenes([])` just deleted, and every Cue's entries were authored against that show's rig.
      // Left standing, resetToNewProject kept them AND buildProjectData() wrote them into the brand-new
      // project file, which then opens (banksLoaded.length ⇒ the saved banks are used verbatim) with the
      // outgoing show's grid, fully populated and completely dead: fireColumn resolves each cell's sceneId
      // against `scenes: []`, finds nothing, and no-ops. Not a crash — a grid that lights up and does
      // nothing, shipped into a project that never had those scenes.
      setCueBanks(st.cueBanks);
      setProjectorOutputs([]);
      setOutputSpans([]); // spans point at the outgoing show's surface ids — worthless here
      setAssets([]);
      // ⚠ AND THE BED. This function reasons carefully about what is SHOW state and what is DOCUMENT state
      // — it drops the fade layer below on exactly that grounds — and still left behind the most audible
      // show state there is. `setAudioMix` appeared NOWHERE in it, so audioMixRef kept the outgoing show's
      // bed, with two teeth:
      //   · AUDIBLE — the swap below parks showTime at 0 with showClock:'reset'. That is a large BACKWARD
      //     jump, which the driver reads as a seek, so every bed clip whose window contains 0 RESTARTS.
      //     Show A's music played out of the speakers underneath a brand-new empty project.
      //   · CORRUPTING — buildProjectData() reads audioMix, so the old show's bed was written verbatim into
      //     the fresh .artlux, its clip paths pointing into the OLD project's folder, beside an empty asset
      //     library. The same defect as the cue grid above, one field over.
      // Found by three independent finders in the merge review.
      //
      // ⚠⚠ AND `setAudioMix` ALONE WAS NOT ENOUGH — IT LEFT THE CLICK. This is what acceptance test 2.8c
      // heard on 2026-07-14. The two host reads are ASYMMETRIC, and that asymmetry IS the bug:
      //     getTimelineAudio: () => timelineEngine.getBoundAudio()   ← the ENGINE. Synchronously fresh.
      //     getMix:           () => audioMixRef.current              ← a ref written IN RENDER. A frame behind.
      // This function mutates the ENGINE synchronously (the swap below parks showTime at 0 — a huge BACKWARD
      // jump) but the BED asynchronously (setAudioMix is a setState). So on the very next driver tick the
      // driver sees THE NEW CLOCK AND THE OLD BED: its seek detector fires, and it RESTARTS every outgoing
      // clip whose window contains 0. A frame or two later React commits the empty mix and it all hard-stops.
      // That burst — the departed show's music, from its top, for ~16 ms — is the click.
      //
      // The comment above already described this exact mechanism. The first fix reset the STATE and did not
      // reset the REF, so it closed the *permanent* half and left a one-frame hole. The ref is written HERE,
      // SYNCHRONOUSLY, and BEFORE the swap — the same idiom AudioBedPanel's `mixRef` already uses and
      // documents ("EVERY write path patches from this ref, never from the React `mix`, which is a render
      // behind"). The seek then lands on an empty bed and there is nothing left to restart.
      const emptyMix = defaultAudioMix();
      audioMixRef.current = emptyMix;   // ⚠ SYNCHRONOUS. The driver reads THIS, not the state. Do not remove.
      setAudioMix(emptyMix);
      // The wall-clock scheduler belongs to the show that is ending, too — it was living on in memory AND
      // being written into the new file, for a show whose scenes no longer exist.
      setSchedule([]);
      // ⚠ THE GLOBAL TIMELINE — THE BIGGEST SURVIVOR OF ALL, AND THE ONE THE USER ACTUALLY SAW.
      //
      // `setTimeline` appeared NOWHERE in this function. The outgoing show's ENTIRE global document — every
      // layer, every clip (pointing at an asset library `setAssets([])` has just emptied), its `Timeline.audio`,
      // and its AUTOMATION LANES — survived New Project intact, and `buildProjectData()` wrote all of it into
      // the brand-new file. The user's report, verbatim: *"we still have the master fader automation, in the
      // global timeline."*
      //
      // It is also HALF THE CLICK'S VOLUME. A surviving `audio.master.gain` lane rides the SHOW clock, and the
      // swap below resets that clock to 0 — so the lane re-samples at the TOP of its ramp and the master SNAPS
      // UP, in one frame, underneath the restarting bed. How loud depends on how far down the ramp the operator
      // had got: +3.5 dB at 0:20, **+21.6 dB at 0:55**. It is the same failure mode as the +9.6 dB merge blocker,
      // arriving through a different door — there, Capture Scene CLONED a lane; here, New Project failed to
      // DELETE one.
      const emptyTl = defaultTimeline();
      setTimeline(emptyTl);
      setSelectedFixtureId(null);
      setSelectedFixtureIds([]);
      setSelectedSurfaceId(null);
      // ⚠ THE SCENES ARE GONE, SO THE BINDING MUST GO WITH THEM — AND SO MUST THE ENGINE'S POOL.
      //
      // This used to be a bare `showSeek(getGlobalStart())`: it moved the SHOW clock and left everything
      // else pointing at the show that no longer exists. `activeSceneId` stayed on a scene that is not in
      // `scenes` any more, and the engine stayed bound to that scene's pool. Nothing heals it — `activeScene`
      // is a bare `scenes.find(...) ?? null` derivation, and the only other writers of `activeSceneId` are
      // recall / removeScene / exitToGlobal / createState / applyProjectData, none of which run here. Open a
      // project with states, then New Project, and:
      //   · `activeScene` → null ⇒ `activeTimeline` = the GLOBAL doc, and the setData effect's pool guard
      //     passes on the STALE key ⇒ the engine believes the global doc is bound (clocksCoincident()) and
      //     tags every global lane `'show'` — while the PLAYHEAD is still parked wherever the departed
      //     scene left it and only `showTime` was reset. Clips, curves and the bed run at three times.
      //   · handleTimelineChange sees `activeSceneId` truthy and maps over an EMPTY scenes array ⇒ every
      //     timeline edit is silently discarded, while the pill reads "Global".
      //   · getStatus().activeSceneId reports the phantom ⇒ the mixer locks seeking and never draws the
      //     bed's lanes, in a project with no scenes.
      // So do what the two sibling "leave the scene" sites do (handleRemoveScene, exitToGlobal): clear the
      // binding and put the engine back on the global pool.
      const departed = activeSceneIdRef.current;
      setActiveSceneId(null);
      // …and the state machine, whose nodes all point at now-deleted sceneIds. resetToNewProject never
      // touched it and handleNewProject's payload does not override it, so buildProjectData() wrote the
      // OUTGOING show's graph straight into the brand-new project file.
      setStateMachine(defaultStateMachine());
      // NEW PROJECT resets the show clock, like OPEN does (reset table row 20). Without this the bed's clock
      // keeps running into a project that no longer exists. It is done through the SWAP — not a bare
      // showSeek — because both clocks have to move: 'restart' mainSeeks the PLAYHEAD to the global doc's
      // start (re-anchoring originMs AND re-baselining prevPlayhead, so no phantom crossing window opens and
      // hitEnd is never pulsed), and showClock:'reset' showSeeks the SHOW clock to the same place. One call,
      // both clocks, and the identity the bare showSeek quietly broke is real again.
      //
      // ⚠ setGlobalDoc FIRST, AND WITH THE **FRESH** DOC — exactly as applyProjectData does, and for exactly
      // the reason it states there: `showClock: 'reset'` reads `globalDoc` SYNCHRONOUSLY to find the in-point
      // to park at, while the `[timeline]` effect that would otherwise publish it is passive (post-commit).
      // Without this line the swap would reset the show clock to the DEPARTED show's in-point.
      timelineEngine.setGlobalDoc(emptyTl);
      timelineEngine.swap(GLOBAL_POOL, emptyTl, { transport: 'restart', showClock: 'reset' });
      if (departed) timelineEngine.releasePool(departed); // free the departed scene's decoders (it is no longer active)
      for (const port of projectorPortsRef.current.values()) port.postMessage({ t: 'timeline', timeline: emptyTl });
      // …and it drops the SCENE/CUE FADE LAYER, for the same reason OPEN does (see applyProjectData). It is
      // SHOW state, not document state, and a plugin's layer is module-level — so without this a master or
      // track fade from the OUTGOING show survives into the new one and keeps shadowing its authored mix,
      // with every fader sitting where the operator put it and reading as perfectly healthy.
      // cancel() FIRST, and for the same two reasons it goes first in applyProjectData: an in-flight fade
      // would otherwise refill the layer on the next frame, and cancel() itself WRITES the layer (it
      // finalizes abandoned plugin legs), so running it second would hand-copy the outgoing show's fades
      // into the new project. Read that comment; this is the same trap.
      transitions.cancel();
      for (const p of automationTargetRegistry.all()) p.releaseAllFades?.();
      // ── THE LAST FOUR SURVIVORS ──────────────────────────────────────────────────────────────────────
      // Nobody had noticed these; they are the same bug as the timeline, a few fields over, and the test is
      // mechanical: applyProjectData RESTORES all four from the file (:1216, :1299-:1301), which is what makes
      // them document state. A New Project therefore opened with the last show's 3D models (their .glb paths
      // pointing into a folder this project has no assets from), its house brightness, and its projector
      // tuning — and wrote every one of them into the fresh file.
      setScene3D(defaultScene3D());
      setGlobalBrightness(1);
      setProjectorFpsCap(0);
      setProjectorBrightness(1);
      // The patch policy is show state too (see the PatchPolicy header in types.ts) — reset it with the
      // rest, or a brand-new project would inherit the outgoing show's "reserve locked ranges" flag.
      setPatchPolicy({ reserveLockedRanges: false });
      // ── AND THE DOCUMENT THAT DESCRIBES ALL OF IT (see the header) ───────────────────────────────────
      // Every field buildProjectData() writes, except `version`/`timestamp` (minted fresh on each save).
      // buildProjectData() no longer writes `settings` at all (the machine, not the show — see AppSettings'
      // header) so there is nothing left to except for it. If you add a field to buildProjectData, add it
      // here too — tsc will NOT catch its absence, because this is a widening spread into an `any`-shaped
      // payload. This list has already drifted from buildProjectData three times; don't make it four.
      return {
          surfaces: st.surfaces, fixtures: st.fixtures, controllers: [], groups: [], scenes: [],
          cueBanks: st.cueBanks, stateMachine: defaultStateMachine(), projectorOutputs: [], outputSpans: [], assets: [],
          timeline: emptyTl, audio: emptyMix, schedule: [], scene3D: defaultScene3D(),
          globalBrightness: 1, projectorFpsCap: 0, projectorBrightness: 1, reserveLockedRanges: false,
      };
  };

  // Write a clean document into an ALREADY-PREPARED folder. Shared by the menu (which picks the
  // folder with a dialog) and by `--new-project=` (where the launcher picked it), so the definition
  // of "a new project" exists once. Splitting the dialog from the save is the whole point: the
  // launcher gets to choose WHERE, and never what a project IS.
  const writeNewProjectTo = async (projectFile: string) => {
      const st = makeNewProjectState();
      // Save from the fresh values directly — setState above hasn't applied to THIS closure yet, so
      // buildProjectData() still reads the OUTGOING show out of it, field by field.
      //
      // ⚠ THE OVERRIDE LIST IS NO LONGER MAINTAINED HERE, AND THAT IS THE FIX. It used to be written out
      // by hand at this call site, and it drifted from the function it was supposed to mirror THREE TIMES —
      // the cue grid and the state machine were each patched in after the fact, and the bed, the schedule,
      // the timeline and the 3D scene were STILL leaking into the new file when the user ran acceptance test
      // 2.8c. resetToNewProject now returns the clean document itself: the code that resets a field and the
      // code that writes it out are the same code, so they cannot disagree again.
      const clean = resetToNewProject(st);
      const data = { ...buildProjectData(), ...clean };
      const path = await window.artlux?.saveProject?.(data, projectFile);
      if (path) { setCurrentProjectPath(path); refreshRecents(); }
      return path;
  };

  // New Project always creates a *folder* (project.artlux + assets/ tree) and prompts where to put
  // it, then saves immediately — so there's always a destination for imported/collected media.
  const handleNewProject = async () => {
      const res = await window.artlux?.newProjectFolder?.();
      if (!res) return; // user cancelled the folder dialog → keep the current project
      await writeNewProjectTo(res.projectFile);
  };

  const handleOpenProjectFolder = async () => {
      const res = await window.artlux?.openProjectFolder?.();
      if (res) { applyProjectData(res.data); setCurrentProjectPath(res.path); refreshRecents(); }
  };

  // Copy every referenced external asset into the project folder's assets/ tree, rewrite the
  // references to point there, then save (which stores them as folder-relative paths).
  const handleCollectAssets = async () => {
      if (!currentProjectPath) {
          toast.warn('No project folder yet', 'Create one with File → New Project, then collect assets.');
          return;
      }
      const folder = currentProjectPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      if (!await confirm({
          title: 'Collect assets into the project folder?',
          message: `Copies every external file into\n  ${folder}/assets/\nand overwrites\n  ${currentProjectPath}\n\nThis modifies your project in place and can't be undone.`,
          confirmLabel: 'Collect', danger: true,
      })) return;
      try {
          const res = await window.artlux?.collectAssets?.(currentProjectPath, buildProjectData());
          if (!res) return;
          applyProjectData(res.data);
          await window.artlux?.saveProject?.(res.data, currentProjectPath);
          refreshRecents();
          const detail: string[] = [];
          if (res.skipped) detail.push(`${res.skipped} already collected or not collectable.`);
          if (res.missing.length) detail.push(`Missing (not found on disk): ${res.missing.length}`);
          toast.success(`Collected ${res.copied} asset${res.copied === 1 ? '' : 's'}`, detail.join(' '));
      } catch (err) {
          toast.error('Collect failed', String((err as Error)?.message ?? err));
      }
  };

  // Non-destructive: collect a self-contained copy into a fresh folder, leaving the current file and
  // working directory untouched (pick target → collect → save the copy; no applyProjectData). Offers
  // to open the copy afterwards.
  const handleCollectCopyToFolder = async () => {
      try {
          const res = await window.artlux?.collectAssetsTo?.(buildProjectData());
          if (!res) return;
          await window.artlux?.saveProject?.(res.data, res.projectFile);
          refreshRecents();
          const extra: string[] = [];
          if (res.skipped) extra.push(`${res.skipped} already collected.`);
          if (res.missing.length) extra.push(`${res.missing.length} missing.`);
          toast.success(`Copied ${res.copied} asset${res.copied === 1 ? '' : 's'} to a new folder`, extra.join(' '));
          if (await confirm({
              title: 'Open the collected copy?',
              message: `Saved to\n  ${res.projectFile}\n\nYour current project was not modified.`,
              confirmLabel: 'Open copy',
          })) handleOpenRecent(res.projectFile);
      } catch (err) {
          toast.error('Collect copy failed', String((err as Error)?.message ?? err));
      }
  };

  // ---- Asset library ----
  // Import media of a type: copy into the project's assets/<cat>/ and add library entries.
  // Returns a Promise so the caller (MediaPanel) can show a busy state during the multi-second copy.
  const handleImportAssets = async (type: AssetType) => {
      if (!currentProjectPath) { toast.warn('No project folder yet', 'Create one with File → New Project to import media.'); return; }
      try {
          const entries = await window.artlux?.importAssets?.(currentProjectPath, type);
          if (entries && entries.length) { setAssets(prev => [...prev, ...entries]); toast.success(`Imported ${entries.length} file${entries.length === 1 ? '' : 's'}`); }
      } catch (err) {
          toast.error('Import failed', String((err as Error)?.message ?? err));
      }
  };
  // Scan the project's assets/ folder for media that was copied in by hand (Explorer/Finder, a USB
  // drive, a sync tool) and adopt it into the library. Nothing on disk is touched — main only reports
  // files it found that we don't already list, so this is idempotent. Returns how many were added, for
  // the panel's status line.
  //
  // The "known" list is the LIBRARY's own view (imported assets + the recorded takes the global
  // timeline owns), not just `assets`: main skips .lblob files anyway, but the dedupe must be stated
  // against what the user actually sees, or the day a take category becomes scannable it silently
  // doubles every take. Appending is still guarded here by path — the async round-trip means an import
  // could have landed in between.
  const handleScanAssets = async (): Promise<number> => {
      if (!currentProjectPath) { toast.warn('No project folder yet', 'Create one with File → New Project to scan for media.'); return 0; }
      const known = libraryItems(assets, timeline).map(a => a.path);
      const found = await window.artlux?.scanAssets?.(currentProjectPath, known);
      if (!found || !found.length) return 0;
      // Re-filter inside the updater against the CURRENT list (not the snapshot `known` was built
      // from) — an import can have completed during the await. The count reported is the updater's own
      // work, captured before the state write, so the status line can never claim rows it didn't add.
      const have = new Set(assets.map(a => normPath(a.path)));
      const fresh = found.filter(a => !have.has(normPath(a.path)));
      if (fresh.length) setAssets(prev => {
          const seen = new Set(prev.map(a => normPath(a.path)));
          return [...prev, ...fresh.filter(a => !seen.has(normPath(a.path)))];
      });
      return fresh.length;
  };
  // A media file dropped straight onto the timeline is copied into the project by the Timeline, then
  // registered here so it appears in the Media library — same as an explicit import. Dedupe by path.
  const handleRegisterAsset = (entry: AssetEntry) => {
      const key = entry.path.replace(/\\/g, '/').toLowerCase();
      setAssets(prev => prev.some(a => a.path.replace(/\\/g, '/').toLowerCase() === key) ? prev : [...prev, entry]);
  };
  // Remove a library entry. An imported asset's references are left as-is (they read as missing, and
  // relink brings them back). A recorded TAKE is different — its library entry IS the recording, not a
  // reference to one — so removing it drops the ref AND every clip playing it, across the global
  // timeline and every scene.
  const handleRemoveAsset = async (asset: AssetEntry) => {
      const usedTake = asset.type === 'take';
      // Count references the SAME way the library badges do — across every surface list (live + each
      // scene's look snapshot), every scene3D, every timeline and the audio bed. `refs === 0` short-
      // circuits the confirm below, so anything this count can't see is deleted with no warning at all.
      const refs = usageForPath(asset.path, projectRefs).count;
      // TWO DIFFERENT PROMISES, because the two branches below do genuinely different things. Removing
      // an imported asset leaves its placements alone — they read as missing, and relinking brings them
      // back. Removing a TAKE deletes the recording itself, so every clip playing it is deleted too, on
      // every timeline. Offering one "…(recoverable)" message for both would be a lie in the direction
      // that costs an operator their work.
      if (refs > 0 && !await confirm({
          title: `Remove "${asset.name}"?`,
          message: usedTake
              ? `This deletes the recording. Its ${refs} placement${refs === 1 ? '' : 's'} will be removed from every timeline and scene. This cannot be undone.`
              : `It is used in ${refs} place${refs === 1 ? '' : 's'}. Removing it from the library leaves those references reading as missing (recoverable).`,
          confirmLabel: 'Remove', danger: true,
      })) return;
      // NB: removing a library entry never removes the CLIPS that reference it — video, audio (bed or
      // Timeline.audio) or content. The reference survives and reads as missing, which is recoverable;
      // deleting the user's placement is not. (A take is the one exception below, because a take's
      // library entry IS its trackingTakes row — the recording itself, not a reference to one.) The
      // confirm above is the guard, and it is only as good as usageIndex's coverage of every field a
      // path can live in — see services/assetLibrary.usageIndex.
      if (usedTake) {
          // SWEEP EVERY DOCUMENT, not just the global one. A take lives in the project library and can
          // be dropped on ANY timeline's tracking lane, so its placements are spread across the global
          // doc and every scene. Deleting only the global ones left scene clips pointing at a recording
          // that no longer exists — a clip that cannot play and cannot be relinked, because there is
          // nothing left to relink to. (Same reach as the relink path below, and for the same reason.)
          const dropTake = (t: Timeline): Timeline => ({
              ...t,
              trackingTakes: (t.trackingTakes ?? []).filter(r => r.id !== asset.id),
              clips: t.clips.filter(c => c.takeId !== asset.id),
          });
          setTimeline(dropTake);
          setScenes(prev => prev.map(s => (s.timeline ? { ...s, timeline: dropTake(s.timeline) } : s)));
      } else {
          setAssets(prev => prev.filter(a => a.id !== asset.id));
      }
  };
  // Relink: pick a replacement file (copied into assets/) and rewrite EVERY reference at the old path
  // to point at the new one.
  //
  // "Every" is the whole job, and it used to mean only the live surfaces, the live scene3D and the
  // GLOBAL timeline — there was no setScenes() anywhere in here. Scene timelines, scene LOOK snapshots
  // (`scene.surfaces`) and scene 3D models kept the dead path, and handleRecallScene writes
  // `scene.surfaces` straight back over the live ones — so the relink SILENTLY REVERTED itself on the
  // next scene recall (under an FSM, within seconds), then persisted the dead path on the next save,
  // and the clip played black. The reference count in both dialogs was computed the same partial way,
  // so it under-reported too. Both now go through the same reference model the library badges use.
  const handleRelinkAsset = async (asset: AssetEntry) => {
      if (!currentProjectPath) return;
      const picked = await window.artlux?.importAssets?.(currentProjectPath, asset.type);
      const next = picked && picked[0];
      if (!next) return;
      const oldPath = asset.path, newPath = next.path;
      const fileName = (p: string) => p.replace(/\\/g, '/').split('/').pop();
      // The TRUE count — deduped exactly like the badge (Capture Scene aliases ids across scenes, so a
      // raw tally would multiply one authored reference by the number of scenes it was cloned into).
      const refCount = usageForPath(oldPath, projectRefs).count;
      if (!await confirm({
          title: `Relink "${asset.name}"?`,
          message: `from:  ${fileName(oldPath)}\nto:    ${fileName(newPath)}\n\nThis updates ${refCount} reference${refCount === 1 ? '' : 's'} and can't be undone.`,
          confirmLabel: 'Relink', danger: true,
      })) return;
      // Path equality is normalised (Windows backslashes + case), the same rule the usage count above
      // matched with — or the count and the rewrite could disagree about what "the old path" is.
      const isOld = (p: string | undefined | null): boolean => !!p && normPath(p) === normPath(oldPath);
      const relinkSurfaces = (ss: Surface[]): Surface[] =>
          ss.map(s => (isOld((s.content as { url?: string })?.url) ? { ...s, content: { ...s.content, url: newPath } } : s));
      const relinkScene3D = (s: Scene3D): Scene3D =>
          ({ ...s, models: (s.models ?? []).map(m => isOld(m.path) ? { ...m, path: newPath } : m) });
      const relinkTimeline = (t: Timeline): Timeline => ({
          ...t,
          clips: t.clips.map(c => {
              const n = isOld(c.path) ? { ...c, path: newPath } : c;
              // A generalized content clip carries its file on `content.url`. mapAssetPaths maps it and
              // (as of Wave B) usageIndex counts it — so the confirm dialog above already promises to
              // rewrite it. Leaving it here would make the count and the rewrite disagree and leave a
              // DEAD PATH on air, which is precisely the class of bug this function's header describes.
              const cu = (n.content as { url?: string } | undefined)?.url;
              return isOld(cu) ? { ...n, content: { ...n.content!, url: newPath } } : n;
          }),
          // Takes are matched by id as well: a take's library entry IS its trackingTakes row.
          trackingTakes: (t.trackingTakes ?? []).map(r => (r.id === asset.id || isOld(r.path)) ? { ...r, path: newPath } : r),
          // This timeline's OWN audio (Wave B). The BED is relinked separately at the setAudioMix below.
          // `t.audio` is left absent if it was absent — a relink must not mint containers.
          audio: t.audio ? { ...t.audio, clips: timelineAudioClips(t).map(c => isOld(c.path) ? { ...c, path: newPath } : c) } : t.audio,
      });
      setAssets(prev => prev.some(a => a.id === asset.id) ? prev.map(a => a.id === asset.id ? { ...a, path: newPath, size: next.size } : a) : prev);
      setSurfaces(prev => relinkSurfaces(prev));
      setScene3D(s => relinkScene3D(s));
      setTimeline(t => relinkTimeline(t));                                  // the GLOBAL timeline
      setScenes(prev => prev.map(s => ({                                    // every scene: look + own timeline
          ...s,
          surfaces: s.surfaces ? relinkSurfaces(s.surfaces) : s.surfaces,
          scene3D: s.scene3D ? relinkScene3D(s.scene3D) : s.scene3D,
          timeline: relinkTimeline(s.timeline),
      })));
      setAudioMix(m => ({ ...m, clips: m.clips.map(c => isOld(c.path) ? { ...c, path: newPath } : c) })); // the audio bed
      toast.success(`Relinked "${asset.name}"`, `${refCount} reference${refCount === 1 ? '' : 's'} updated.`);
  };
  // Set the selected surface's content to a video/image asset.
  const handleUseAssetOnSurface = (asset: AssetEntry) => {
      if (!selectedSurfaceId) return;
      const type = asset.type === 'video' ? SourceType.VIDEO : asset.type === 'image' ? SourceType.IMAGE : null;
      if (!type) return;
      handleUpdateSurface(selectedSurfaceId, { content: { type, url: asset.path } });
  };
  // Drag an asset from the library onto a Stage surface (hit-tested in Stage).
  const handleDropAssetOnSurface = (surfaceId: string, asset: AssetEntry) => {
      const type = asset.type === 'video' ? SourceType.VIDEO : asset.type === 'image' ? SourceType.IMAGE : null;
      if (!type) return;
      handleUpdateSurface(surfaceId, { content: { type, url: asset.path } });
  };

  // Save the current project, then relaunch into broadcast (show) mode with it.
  const handleLaunchBroadcast = async () => {
      const path = await handleSaveProject();
      if (path) window.artlux?.relaunchBroadcast?.(path);
      else toast.warn('Save first', 'Save the project to a file, then launch broadcast mode.');
  };

  // Enter or leave the calibration workbench. A RELAUNCH, not a toggle: the calibration plugin is
  // activated once per window at load, in this window and in every projector window it spawns, and a
  // half-switched pair is the shape of bug that ends with a black output at a venue. Dropping it is
  // what keeps an open output cheap — 60 fps against 17.6 with a calibrated one on this machine.
  const handleToggleCalibration = async () => {
      const path = await handleSaveProject();
      if (!path) { toast.warn('Save first', 'Save the project to a file, then switch to calibration.'); return; }
      window.artlux?.relaunchWithCalibration?.(!CALIBRATION_ENABLED, path);
  };

  // App info for the About modal.
  useEffect(() => { window.artlux?.getAppInfo?.().then((i) => setAppInfo(i ?? null)); }, []);

  // Native-menu commands → existing handlers. A ref keeps the latest closures so
  // the listener can be registered exactly once.
  const dispatchMenu = (action: string) => {
      if (action.startsWith('open-recent:')) { handleOpenRecent(action.slice('open-recent:'.length)); return; }
      // Workspace-context switches from either menu (see CONTEXT_MENU_ITEMS in shared/protocol).
      if (action.startsWith('context:')) { goToContext(action.slice('context:'.length)); return; }
      switch (action) {
          case 'new': handleNewProject(); break;
          case 'new-project-folder': handleNewProject(); break; // legacy menu id → folder flow
          case 'open': handleOpenProject(); break;
          case 'open-project-folder': handleOpenProjectFolder(); break;
          case 'save': handleSaveProject(); break;
          case 'save-as': handleSaveAs(); break;
          case 'collect-assets': handleCollectAssets(); break;
          case 'collect-copy': handleCollectCopyToFolder(); break;
          case 'broadcast': handleLaunchBroadcast(); break;
          case 'calibration-profile': handleToggleCalibration(); break;
          case 'export-rig': handleExportRig(); break;
          case 'import-rig': handleImportRig(); break;
          case 'preferences': goToContext('settings'); break;
          case 'routing': openDockPanel(ROUTING_PANEL); break;
          // The DMX Monitor dock tab, from either View menu. A toggle (close if it is the front
          // tab) built on openDockPanel, which hops to a context that carries the tab when the
          // active one doesn't — only 4 of the 9 list it, so from Scenes or Audio a plain slice
          // write would open the dock onto a tab that isn't there.
          case 'dmx-monitor': {
            const now = layoutStore.get();
            if (now.dockOpen && now.contexts[now.activeContext]?.dockPanel === MONITOR_PANEL) setDockOpen(false);
            else openDockPanel(MONITOR_PANEL);
            break;
          }
          // The timeline drawer, from either menu. Same target as Ctrl+T (global.toggleBottom).
          case 'toggle-timeline': layoutStore.set({ bottomOpen: !layoutStore.get().bottomOpen }); break;
          case 'record-lighting-take': takeRecorder.toggleLighting(); break;
          case 'record-tracking-take': takeRecorder.toggleTracking(); break;
          case 'store-lighting-key': handleStoreLightingKey(); break;
          case 'save-lighting-pose': handleSavePose(); break;
          // Context action-bar targets. These functions already existed as panel buttons; routing them
          // through the same dispatcher is what lets a WorkspaceContext name them by id (see
          // contexts/index.tsx) instead of every action needing a callback threaded to the shell.
          case 'outputs': refreshDisplays(); goToContext('project'); break;
          case 'add-surface': handleAddSurface(); break;
          case 'add-model': void handleAddModel(); break;
          case 'add-fixture': handleAddFixture(); break;
          case 'auto-patch': handleAutoPatch(); break;
          case 'create-group': handleCreateGroup(); break;
          case 'save-template': handleSaveTemplate(); break;
          case 'remove-fixture': if (selectedFixtureId) handleRemoveFixture(selectedFixtureId); break;
          case 'about': setAboutOpen(true); break;
          case 'command-palette': window.dispatchEvent(new Event('artlux:toggle-command-palette')); break;
          // ONE help surface. The menu path is open-only (you can't click a menu under the
          // focus-trapped overlay); F1's toggle lives in HelpBrowser's own keydown, renderer-owned
          // like Ctrl+K — see the header comment there for why two owners is the bug.
          case 'help': openHelp(); break;
          case 'shortcuts': openShortcuts(); break;
          case 'docs-browser': setDocsOpen((v) => !v); break;
          case 'check-updates': setUpdateUserInitiated(true); window.artlux?.checkForUpdates?.(); break;
          case 'undo': undo(); break;
          case 'redo': redo(); break;
          default: {
            // A menu action reaches whichever PANEL declares it — core or plugin, wherever it is mounted.
            // 'modal' panels toggle open/closed (host owns open state, the panel owns its chrome);
            // 'dock' panels are revealed by switching to the context that carries them and selecting the
            // tab (openDockPanel). That is what lets a plugin move its panel from a dialog to a dock tab
            // without the menu, the native menu, or this dispatcher knowing anything changed.
            const panel = panelRegistry.all().find((p) => p.menuAction === action);
            if (!panel) break;
            if (panel.mount === 'modal') setOpenModals((s) => { const n = new Set(s); n.has(panel.id) ? n.delete(panel.id) : n.add(panel.id); return n; });
            else if (panel.mount === 'dock') openDockPanel(panel.id);
            // A viewport panel IS a context's main work area, so "open it" means going to that context.
            else if (panel.mount === 'viewport') {
              const owner = contextRegistry.all().find((c) => c.viewport === panel.id);
              if (owner) goToContext(owner.id);
            }
          }
      }
  };
  const dispatchMenuRef = useRef(dispatchMenu);
  dispatchMenuRef.current = dispatchMenu;
  useEffect(() => {
      const unsub = window.artlux?.onMenuAction?.((action) => dispatchMenuRef.current(action));
      return () => unsub?.();
  }, []);

  // Auto-update events from main. A background check runs ~4s after launch (main);
  // we only surface a prompt when there's something actionable (or the user asked).
  useEffect(() => {
      const unsub = window.artlux?.onUpdate?.((e) => {
          setUpdate(e);
          if (e.status === 'not-available') setTimeout(() => setUpdate(null), 2500);
      });
      return () => unsub?.();
  }, []);

  // --- Timeline: feed the playback engine + bridge transport/data to the projector windows ---
  //
  // ⚠ DECLARATION ORDER IS LOAD-BEARING: THIS EFFECT MUST STAY *BEFORE* THE `setPlaying` EFFECT BELOW.
  // React flushes effects in declaration order within a commit. The engine's setData() guard
  // (clampPlayheadIntoDoc — "a document edit must never synthesise a transport event") is gated on the
  // engine's own `playing` still being TRUE, and it only still is because setData runs BEFORE
  // setPlaying(false) in the same flush. Move this effect below the setPlaying one and the guard stops
  // firing — SILENTLY, with no type error and no test to catch it: the raw end-stop takes over again,
  // the playhead jumps live on the projectors and an 'onTimelineEnd' edge fires from a text edit.
  // Do not reorder. (Mirrored note on the setPlaying effect.)
  useEffect(() => {
      // Feed the editor-bound timeline to the engine ONLY when it is the pool currently playing live —
      // i.e. the editor binding matches the engine's active pool. A live GO can make a scene's pool
      // active while the editor is still bound elsewhere; in that case pushing here would clobber the
      // live pool with the wrong doc. The swap() at recall already fed + bridged the live timeline;
      // edits to a non-live pool are applied on its next swap (warmPool/normalizeTimeline).
      if (timelineEngine.activePoolKey() !== (activeSceneId ?? GLOBAL_POOL)) return;
      timelineEngine.setData(activeTimeline);
      trackingPlayback.setData(activeTimeline); // replay recorded blob takes when the playhead crosses them
      lightingPlayback.setData(activeTimeline);  // …and lighting clips, which drive fixtures by role
      for (const port of projectorPortsRef.current.values()) port.postMessage({ t: 'timeline', timeline: activeTimeline });
  }, [activeTimeline, activeSceneId]);
  // FSM look-ahead preloading: when the machine enters a state, warm the timelines it can reach
  // SOONEST, so a transition into a likely-next state is hitless. The warm window follows the show's
  // path (§tiers).
  //
  // RANKED AND TRIMMED TO THE BUDGET — reachableNext orders candidates by how soon their edge can
  // fire and includes `fromAny` global rules (which the old `t.from === stateId` filter could never
  // match, so the edge most likely to fire in an interactive show was the one never preloaded). The
  // slice is what keeps the protect set inside MAX_WARM: handing evictExcess more keys than the
  // budget allows is not something it can resolve — it can only refuse to evict them.
  useEffect(() => timelineEngine.subscribeSmState((stateId) => {
      if (!stateId) return;
      const entries = reachableNext(stateMachineRef.current, stateId)
        .slice(0, timelinePreloader.MAX_WARM)
        .map(e => ({ key: e.sceneId, tl: scenesRef.current.find(s => s.id === e.sceneId)?.timeline }))
        .filter(e => !!e.tl);
      if (entries.length) timelinePreloader.predict(entries);
  }), []);
  // Start the tracking-take replay loop once (main window only).
  useEffect(() => { trackingPlayback.start(); }, []);
  useEffect(() => { lightingPlayback.start(); }, []);
  // The rig a lighting clip resolves its group against. Kept fresh rather than captured, because a
  // clip names a GROUP and the group's membership (and order) is edited while the show is running.
  useEffect(() => { lightingPlayback.setRig(fixtures, groups, lightingPoses); }, [fixtures, groups, lightingPoses]);
  // ⚠ DECLARATION ORDER IS LOAD-BEARING: THIS EFFECT MUST STAY *AFTER* THE `setData` EFFECT ABOVE.
  // Effects flush in declaration order. The engine's setData guard needs the engine's `playing` to be
  // still true when the new document lands, so setData has to run first in the flush. Hoisting this one
  // above it kills that guard silently. See the full note on the setData effect.
  useEffect(() => {
      timelineEngine.setPlaying(isVideoPlaying);
      // A TRANSPORT THAT STARTS DURING A PRELOAD ENDS IT. The boot gate holds only the state machine,
      // so nothing but a human (Play/space, the tablet remote) or an external controller (OSC) can get
      // here while it is holding — and an explicit "start the show NOW" outranks waiting for a decode.
      // This one seam covers every path because App is the single writer of `playing`. No-op when the
      // gate isn't holding.
      if (isVideoPlaying) bootGate.armNow('the transport was started');
  }, [isVideoPlaying]);
  // The FSM control layer drives transport by emitting intents; App turns them into React state so
  // App stays the single writer of `playing` (the setPlaying effect above then drives the engine).
  useEffect(() => timelineEngine.subscribeIntent((i) => {
      if (i.kind === 'play') {
        // Re-arm the clock IMPERATIVELY when it is parked at the end, BEFORE asking React to play.
        // An FSM `play` entry action can be reached on the very frame the end-stop parked — an
        // 'onTimelineEnd' hop into a state that carries `play` but has no bound scene to re-seek us.
        // `playing` is still true then, so setIsVideoPlaying(true) is a NO-OP: no re-render, no
        // [isVideoPlaying] effect, no engine.setPlaying() — and therefore nothing ever clears the
        // engine's end latch. The clock re-parks every frame while the Play button stays lit and
        // show.getStatus().playing keeps reporting true: a frozen still frame that a watchdog reads
        // as a healthy show. seek() is mainSeek(): it re-anchors originMs, clears the latch and
        // re-baselines prevPlayhead, so no React batching can swallow the restart. App still owns
        // `playing` — this only moves the playhead.
        if (timelineEngine.isAtEndBound()) timelineEngine.seek(timelineEngine.getStart());
        // …AND THE SAME RE-ARM FOR THE SHOW CLOCK, WHICH HAS THE SAME HOLE. Reset-table row 12 names TWO
        // sites for "play from the parked end" — setPlaying(true) and this handler — and the engine's
        // show-clock restart lives only in the first. That is the very React no-op described above: a
        // `play` action arriving while `playing` is already true never reaches setPlaying(), so the
        // engine's `if (showAtEndBound()) showSeekInternal(...)` never runs.
        //
        // Why it matters MORE for the show clock than for the playhead: the show clock is SILENT (no
        // intent, no hitEnd), so a parked one has no symptom. An unattended FSM hopping between LOOPING
        // scenes keeps `playing` true forever; the show clock runs out the global Length, parks, and
        // isShowAtEndBound() latches — the audio driver stops the bed — while getStatus().playing goes on
        // reporting a healthy show. Without this line the ONLY revival is a human pressing Stop or
        // Pause→Play. The bed is silent for the rest of the day and nothing says so.
        //
        // Not a new policy: it is row 12 ("Play from the parked end restarts the SHOW clock iff
        // showAtEndBound()") applied at the site row 12 already names. A `play` on a show clock that is
        // NOT parked is a no-op, so this cannot rewind a bed that is merely mid-show.
        //
        // NO DOUBLE-FIRE with the seek() above — but only *IF THAT SEEK RAN*. When the global doc is bound
        // AND it was parked, seek() is mainSeek + the identity: it moved showTime to the same start, so
        // isShowAtEndBound() is already false by the time we get here and this line no-ops. IT DOES NOT
        // FOLLOW that "global bound ⇒ nothing left to do": the two clocks can be bound to the same document
        // and still DISAGREE, because a swap can move one without the other. Recalling a scene with NO
        // TIMELINE OF ITS OWN binds the GLOBAL doc (`const tl = scene.timeline ? … : timeline`, below) with
        // transport:'restart' and the default showClock:'preserve' — playhead back to 0, show clock left
        // PARKED. atEndBound() is false there (the playhead is at the START), so the seek() above never
        // runs, and THIS LINE IS THE ONLY THING THAT REVIVES THE BED. That is the intent, not a leak.
        //
        // ⚠ THE PARK ITSELF IS STILL BY DESIGN: with Global Loop OFF the show has a finite Length and it
        // ENDS. This only restores the ability to start it again from a `play`.
        if (timelineEngine.isShowAtEndBound()) timelineEngine.showSeek(timelineEngine.getGlobalStart());
        setIsVideoPlaying(true);
      }
      else if (i.kind === 'pause') setIsVideoPlaying(false);
      // Stop returns to the in-point, not hard 0 — with a region set, 0 is outside the playable range.
      // The SHOW clock resets too, but to the GLOBAL doc's in-point: getStart() is the BOUND doc's start,
      // and while a scene is bound that number means nothing to the bed. Stop is one of only three things
      // that reset the show clock (the others are opening a project and New Project).
      else if (i.kind === 'stop') {
        setIsVideoPlaying(false);
        timelineEngine.seek(timelineEngine.getStart());
        timelineEngine.showSeek(timelineEngine.getGlobalStart());
      }
      else if (i.kind === 'seek') timelineEngine.seek(i.sec);
      // The loop flag belongs to the document the ENGINE IS ACTUALLY PLAYING — resolved from the engine's
      // active pool key, never from a render-assigned ref.
      //
      // stateMachine.enter() recalls the state's bound scene BEFORE running its entry actions, both
      // synchronously inside ONE rAF frame. The recall repoints the engine immediately (swap()) but only
      // QUEUES setActiveSceneId — so a ref refreshed on render still describes the scene the machine just
      // LEFT. Routing `setLoop` through one wrote `loop:true` into the PREVIOUS scene's timeline (or into
      // the global doc when no scene was bound yet), persisted it on save, and left the scene that asked
      // to loop not looping: it runs to its Length, the end-stop parks it, and the unattended show dies.
      // activePoolKey() is the truth. Functional updaters, so a same-batch edit isn't clobbered by a
      // stale spread. A scene with no timeline of its own PLAYS the global doc (swapTimelineForScene),
      // so the flag belongs to the global doc — not to a timeline that scene does not have.
      else if (i.kind === 'loop') {
        const key = timelineEngine.activePoolKey();
        const owner = key !== GLOBAL_POOL ? scenesRef.current.find(s => s.id === key) : undefined;
        if (owner) setScenes(prev => prev.map(s => (s.id === key ? { ...s, timeline: { ...s.timeline, loop: i.loopOn } } : s)));
        else setTimeline(t => ({ ...t, loop: i.loopOn }));
      }
  }), []);
  // Scene/cue triggers requested by a source (FSM action, OSC) — resolve by id/name and apply.
  useEffect(() => {
    const u1 = cueBus.subscribeRecall((ref, fadeSec) => recallByRefRef.current(ref, fadeSec));
    const u2 = cueBus.subscribeFireCue((ref) => fireCueRef.current(ref));
    const u3 = cueBus.subscribeFireColumn((bankRef, col) => fireColumnRef.current(bankRef, col));
    return () => { u1(); u2(); u3(); };
  }, []);
  // Feed the project-level state machine to the engine, which ticks it each frame on its standalone clock.
  useEffect(() => { timelineEngine.setStateMachine(stateMachine); }, [stateMachine]);
  // Host services handed to feature plugins (calibration, LiDAR). One stable object whose methods
  // delegate to live refs / stable setters, so the plugin captures it once at activation yet always
  // sees current state. Subscriber sets fire from the change effects below and the projector message
  // router; `projectors.onMessage` is the projector→main back-channel (e.g. calibration patternShown).
  const outputSubs = useRef(new Set<() => void>());
  const surfaceSubs = useRef(new Set<() => void>());
  const sceneSubs = useRef(new Set<() => void>());
  const settingsSubs = useRef(new Set<() => void>());
  const showSubs = useRef(new Set<() => void>()); // host `show` service: scenes/cueBanks/FSM/schedule changed
  const audioSubs = useRef(new Set<() => void>()); // host `audio` service: the global bed changed
  const projMsgSubs = useRef(new Set<(surfaceId: string, msg: unknown) => void>());
  const pluginHost = useMemo<RendererHostServices>(() => ({
    // Read through a ref, not the state value: pluginHost is memoized once at activation, so closing
    // over currentProjectPath would freeze a plugin on whichever document was open at boot.
    project: {
      path: () => currentProjectPathRef.current,
      // NEVER opens a dialog. handleSaveProject falls back to Save-As when there is no path, which is
      // right for an operator pressing Ctrl+S and catastrophic for a 4am maintenance task: the venue
      // machine would sit on a modal until someone drives over. No path → refuse and say so.
      save: async () => {
        const p = currentProjectPathRef.current;
        if (!p) return false;
        try { return !!(await window.artlux?.saveProject?.(buildProjectDataRef.current(), p)); }
        catch { return false; }
      },
    },
    projectorOutputs: {
      get: (id) => projectorOutputsRef.current.find(o => o.surfaceId === id),
      list: () => projectorOutputsRef.current,
      patch: (id, partial) => upsertOutput(id, partial as Partial<ProjectorOutput>),
      subscribe: (cb) => { outputSubs.current.add(cb); return () => { outputSubs.current.delete(cb); }; },
    },
    surfaces: {
      list: () => surfacesRef.current,
      get: (id) => surfacesRef.current.find(s => s.id === id),
      subscribe: (cb) => { surfaceSubs.current.add(cb); return () => { surfaceSubs.current.delete(cb); }; },
    },
    scene3D: {
      get: () => scene3DRef.current,
      patch: (partial) => setScene3D(s => ({ ...s, ...(partial as Partial<Scene3D>) })),
      // Through a ref for the same reason as project.save: pluginHost is memoized once, and the
      // handler closes over scene3D for the placement cascade.
      addModel: () => addModelRef.current(),
      subscribe: (cb) => { sceneSubs.current.add(cb); return () => { sceneSubs.current.delete(cb); }; },
    },
    projectors: {
      send: (id, msg) => sendToProjector(id, msg as MainToProjector),
      onMessage: (cb) => { projMsgSubs.current.add(cb); return () => { projMsgSubs.current.delete(cb); }; },
    },
    settings: {
      get: () => settingsRef.current,
      subscribe: (cb) => { settingsSubs.current.add(cb); return () => { settingsSubs.current.delete(cb); }; },
    },
    // Read-mostly show model for the show-control plugin (tablet remote). Reads hit live refs; writes
    // go through App state (the source of truth). setFsmEnabled flips only the enabled flag so the
    // engine picks it up via the setStateMachine effect; setSchedule replaces the opaque entry array.
    show: {
      getStateMachine: () => stateMachineRef.current,
      getScenes: () => scenesRef.current,
      getCueBanks: () => cueBanksRef.current,
      getSchedule: () => scheduleRef.current,
      setFsmEnabled: (on) => setStateMachine(prev => (prev.enabled === on ? prev : { ...prev, enabled: on })),
      setSchedule: (entries) => setSchedule(entries as unknown[]),
      subscribe: (cb) => { showSubs.current.add(cb); return () => { showSubs.current.delete(cb); }; },
      // TWO PLAYHEADS, ONE TRANSPORT. `playhead`/`duration` describe the BOUND document (a scene recall
      // restarts them); `showTime`/`showEnd` describe the SHOW, which a recall does not touch — that is
      // what the audio bed rides. `showEnded` publishes the show clock's PARK (global loop off): a
      // consumer reconciling against a frozen clock has to know it is frozen. See the SDK's comment.
      getStatus: () => ({
        playing: timelineEngine.isPlaying(),
        playhead: timelineEngine.getPlayhead(),
        showTime: timelineEngine.getShowTime(),
        duration: timelineEngine.getDuration(),
        showEnd: timelineEngine.getGlobalEnd(),
        showEnded: timelineEngine.isShowAtEndBound(),
        // …and the SAME publication for the OTHER clock: the current state's picture has finished and
        // is being HELD on its last frame while the show plays on (Timeline.holdAtEnd). It reports
        // playing:true with a frozen timecode, so anything that displays or reconciles has to be told.
        held: timelineEngine.isBoundHeld(),
        currentStateId: currentSmStateRef.current,
        stateElapsedSec: timelineEngine.getSmElapsedSec(),
        activeSceneId: activeSceneIdRef.current,
        lastFiredTransitionId: lastFiredTransitionRef.current,
        // A PRELOAD IS NOT A STOPPED SHOW. Both report playing:false with no current state; one is the
        // operator's decision, the other is a wait that ends by itself. See the SDK's comment.
        booting: bootGate.isBooting(),
        bootPending: bootGate.get().pending.length,
      }),
      // The timeline's live selection. Straight through to the render-free singleton Timeline.tsx writes:
      // it never enters App state, so clicking a clip re-renders the timeline panel and nothing else. The
      // store is idempotent, so a subscriber is woken once per COMMITTED selection change, not per render.
      getSelection: () => selection.getSelection(),
      subscribeSelection: (cb) => selection.subscribe(() => cb()),
      // Command surface — same singletons the OSC controller uses (App's own subscriptions resolve
      // recalls/cues; App stays the single writer of `playing` via dispatchTransportIntent).
      recallScene: (ref) => cueBus.requestRecall(ref),
      fireCue: (ref) => cueBus.requestFireCue(ref),
      fireColumn: (bank, col) => cueBus.requestFireColumn(bank, col),
      transport: (i) => {
        if (i.kind === 'seek') timelineEngine.dispatchTransportIntent({ kind: 'seek', sec: i.sec ?? 0 });
        else if (i.kind === 'loop') timelineEngine.dispatchTransportIntent({ kind: 'loop', loopOn: !!i.loopOn });
        else timelineEngine.dispatchTransportIntent({ kind: i.kind });
      },
      triggerTransition: (id) => timelineEngine.triggerSmTransition(id),
      enterState: (id) => timelineEngine.enterSmState(id),
      // THE HOST HALF OF A TAKEOVER. A provider's releaseFade() drops the path from ITS fade layer; that
      // alone is undone on the next frame, because transitions.apply() re-writes every plugin leg every
      // frame while the fade is live — and then made permanent when the leg lands on its endpoint and
      // persists. This removes the leg from the animation itself, so the release actually sticks. Both
      // halves, or the operator's mid-fade fader move is silently erased. See the SDK's comment.
      dropFadeLeg: (path) => transitions.dropLeg(path),
    },
    // TWO AUDIO CONTAINERS, TWO CLOCKS (see docs/TIMELINE.md).
    //   getMix()           — ProjectData.audio, THE BED. Rides the SHOW clock. Survives a scene recall.
    //                        Reads the live ref; setMix replaces it, normalized on write like the load path.
    //   getTimelineAudio() — the BOUND timeline's own Timeline.audio. Rides the PLAYHEAD, restarts with it.
    //                        Read from the ENGINE, not from a render-assigned ref: a recall repoints the
    //                        engine and mainSeeks the playhead SYNCHRONOUSLY, inside the frame whose React
    //                        commit has not happened yet, and the audio driver ticks in that same frame.
    //                        A ref would hand it the OUTGOING scene's clips against the INCOMING scene's
    //                        playhead for a frame or two — a clip at t=0 would restart from its top: an
    //                        audible click on every GO. See timeline.getBoundAudio()'s comment.
    // Both re-fire the same `subscribe` set, so the driver re-syncs (loads/unloads sources) on either
    // changing.
    audio: {
      getMix: () => audioMixRef.current,
      setMix: (mix) => setAudioMix(normalizeAudioMix(mix as Partial<AudioMix>)),
      // EMPTY_TIMELINE_AUDIO, not a fresh literal: this is read EVERY FRAME and the driver's orphan gate
      // compares clip arrays by identity. See the constant's comment.
      getTimelineAudio: () => timelineEngine.getBoundAudio() ?? EMPTY_TIMELINE_AUDIO,
      // THE THIRD CONTAINER — the bound timeline's video clips' own soundtracks, derived (never authored)
      // and on the same clock as getTimelineAudio. Read from the ENGINE for the same reason: a recall
      // repoints `data` synchronously and the driver ticks in that same frame. The engine memoises on the
      // layers/clips array identities, so this is a ref compare per frame and allocates nothing.
      getVideoAudio: () => timelineEngine.getBoundVideoAudio(),
      // THE SECOND WRITER, AND IT IS NOT A MIRROR OF setMix. setMix replaces the bed — one document, App's
      // own, never rebound. This patches ONE clip, BY ID, inside whichever document CORE has bound right
      // now, through the owner-router every other timeline edit uses; the caller cannot name a scene, and an
      // id that is not in the bound document is DROPPED (clip ids alias across scenes — Capture Scene clones
      // them). The whole argument is on patchBoundTimelineClipRef above and in the SDK's AudioService.
      patchTimelineClip: (clipId, patch) => patchBoundTimelineClipRef.current(clipId, patch as Partial<AudioClip>),
      subscribe: (cb) => { audioSubs.current.add(cb); return () => { audioSubs.current.delete(cb); }; },
    },
    // Cold-start readiness: a plugin that loads content of its own (the audio plugin's conforms + engine
    // loads) registers a probe, and the show is held until it reports ready. Straight through to the
    // service singleton — the gate is App-independent by design (it must keep polling across the very
    // renders a project open causes). See services/bootGate.ts and the SDK's BootService.
    boot: {
      registerProbe: (id, probe) => bootGate.registerProbe(id, probe),
      isBooting: () => bootGate.isBooting(),
      elapsedSec: () => bootGate.get().elapsedSec,
    },
    preload: {
      // The warm-window seam: a plugin keeps its own per-scene resources alive for as long as the host
      // keeps that scene's pictures warm. See services/timelinePreloader.
      registerParticipant: (p) => timelinePreloader.registerParticipant(
        p as { warm(k: string, tl: Timeline): void; release(k: string): void },
      ),
    },
  }), []);
  useEffect(() => { outputSubs.current.forEach(cb => cb()); }, [projectorOutputs]);
  useEffect(() => { surfaceSubs.current.forEach(cb => cb()); }, [surfaces]);
  useEffect(() => { sceneSubs.current.forEach(cb => cb()); }, [scene3D]);
  useEffect(() => { settingsSubs.current.forEach(cb => cb()); }, [settings]);
  useEffect(() => { showSubs.current.forEach(cb => cb()); }, [scenes, cueBanks, stateMachine, schedule]);
  // The audio host fan-out fires on EITHER container changing: the bed (audioMix) or the BOUND timeline's
  // own audio (activeTimeline). A scene recall changes activeTimeline, so the driver re-reads the incoming
  // scene's audio and unloads the outgoing one's — which is exactly the restart-with-its-timeline
  // semantics. (The driver re-reads the CONTAINER every frame; this fan-out is what makes it load and
  // unload the engine-resident SOURCES. Both are needed.)
  useEffect(() => { audioSubs.current.forEach(cb => cb()); }, [audioMix, activeTimeline]);
  // Track the live FSM state id + last-fired transition for the host `show.getStatus()` readback.
  useEffect(() => {
    const u1 = timelineEngine.subscribeSmState((id) => { currentSmStateRef.current = id; });
    const u2 = timelineEngine.subscribeSmFired((tid) => { lastFiredTransitionRef.current = tid; });
    return () => { u1(); u2(); };
  }, []);
  // Activate first-party plugins (main window) before any compositing/OSC: this registers the LiDAR
  // plugin's TRACKING content source + blob ingestion and the calibration back-channel tap.
  useEffect(() => {
    activateRendererPlugins('main', pluginHost);
    timelineEngine.recompileAutomation(); // providers only exist now — anything compiled before this saw no namespaces
  }, [pluginHost]);
  // Tell the calibration plugin which output its board-pose pairing targets (the one being calibrated).
  // The WebCodecs MP4 decoder is ON unless the operator turns it off. A file it cannot configure
  // declines at probe time and the host hands it back to a <video>, so the setting is an escape hatch
  // for a whole machine rather than the thing that keeps a bad file playing.
  useEffect(() => { mp4SetEnabled(settings.mp4WebCodecs ?? true); }, [settings.mp4WebCodecs]);
  // OSC: subscribe the controller to forwarded messages once; (re)bind the UDP listener and refresh
  // the control namespace whenever the OSC settings change. Control intents flow back through the
  // subscribeIntent path above; LiDAR blob data lands in the tracking store.
  useEffect(() => oscController.start(), []);
  useEffect(() => {
      oscController.setControlPrefix(settings.oscControlPrefix);
      window.artlux?.configureOsc?.({
          enabled: settings.oscEnabled,
          listenPort: settings.oscListenPort,
          listenAddress: settings.oscListenAddress,
          controlPrefix: settings.oscControlPrefix,
      });
  }, [settings.oscEnabled, settings.oscListenPort, settings.oscListenAddress, settings.oscControlPrefix]);
  // Generic projector-channel producer: each registered projector channel (e.g. the LiDAR tracking
  // snapshot) sends its payload to the projector windows whose surface it appliesTo, over the generic
  // { t:'pluginData' } bridge. Plugin-agnostic — replaces the former per-feature (tracking) bridge.
  useEffect(() => {
      const unsubs: (() => void)[] = [];
      for (const ch of projectorChannelRegistry.all()) {
          if (!ch.subscribe) continue; // subscribe-driven channels only (tracking); poll channels TBD
          let last = 0;
          const throttle = ch.throttleMs ?? 16;
          unsubs.push(ch.subscribe(() => {
              const now = performance.now();
              if (now - last < throttle) return;
              const ports = [...projectorPortsRef.current].filter(([id]) => {
                  const s = surfacesRef.current.find(x => x.id === id);
                  return !!s && !!ch.appliesTo?.(s);
              });
              if (!ports.length) return;
              const payload = ch.build?.();
              if (payload == null) return;
              last = now;
              for (const [, port] of ports) port.postMessage({ t: 'pluginData', channel: ch.channel, payload });
          }));
      }
      return () => { for (const u of unsubs) u(); };
  }, []);
  // Keep the main-window tracking renderer's smoothing/prediction in sync (stage preview).
  useEffect(() => {
      trackingDrawable.configure(scene3D.trackingSmoothing ?? 0.6, scene3D.trackingPredictMs ?? 50);
  }, [scene3D.trackingSmoothing, scene3D.trackingPredictMs]);
  // Drop temporal person tracks when merging is off so a re-enable starts with fresh person ids.
  useEffect(() => { if (!scene3D.trackingMergePeople) resetPeopleTracking(); }, [scene3D.trackingMergePeople]);
  // Stream transport (playing + playhead) to the projector windows so their video/layer content stays
  // in sync with the main clock.
  //
  // ── THE GATE MUST BE FINER THAN THE PRODUCER'S PERIOD ───────────────────────────────────────────
  // This fires once per engine tick, and the gate used to be 33 ms — written when the engine always
  // ran at display rate, so "every other tick" was stable. v0.25.2 capped the engine at 30 Hz and
  // that assumption inverted: a 33.3 ms producer against a 33 ms gate is decided by sub-millisecond
  // jitter, so updates came 33, 33, 66, 33 … and a projector that decodes a HAP layer LOCALLY uses
  // this playhead as its time base — the dropped update is a visible hitch on the wall, invisible in
  // the editor preview (which reads the engine directly and never crosses this seam).
  //
  // 15 ms passes every tick at BOTH 30 Hz (33.3 ms) and 60 Hz (16.7 ms), so it cannot alias with a
  // rate anyone can select; it only guards against a 120 Hz display flooding the port. The message is
  // three numbers — the send is not what costs, the aliasing was.
  useEffect(() => {
      let last = 0;
      const unsub = timelineEngine.subscribe((playhead) => {
          const now = performance.now();
          if (now - last < 15) return;
          last = now;
          const msg = { t: 'transport' as const, playing: timelineEngine.isPlaying(), playhead, showTime: timelineEngine.getShowTime() };
          for (const port of projectorPortsRef.current.values()) port.postMessage(msg);
      });
      return () => unsub();
  }, []);

  // --- Projector output windows (per-surface fullscreen on a display) ---
  // Enumerate displays + track hot-plug. Skipped in headless: it drives no displays/projectors and the
  // projector IPC (which owns list-displays) isn't registered there, so the invoke would just reject.
  useEffect(() => {
      if (HEADLESS) return;
      window.artlux?.listDisplays?.().then(d => setDisplays(d ?? []));
      const unsub = window.artlux?.onDisplaysChanged?.((d) => setDisplays(d ?? []));
      return () => unsub?.();
  }, []);
  // Reconcile outputs against the live display list: keep valid ones, re-match a vanished
  // displayId to a same-label display (id changes across replug/reboot), else clear it.
  useEffect(() => {
      if (!displays.length) return; // ignore the pre-enumeration empty state
      setProjectorOutputs(prev => {
          let changed = false;
          const next = prev.map(o => {
              if (o.displayId == null || o.displayId === WINDOWED_DISPLAY) return o; // null / windowed: nothing to re-link
              if (displays.some(d => d.id === o.displayId)) return o; // still present
              const byLabel = o.displayLabel ? displays.find(d => d.label === o.displayLabel) : undefined;
              changed = true;
              return byLabel ? { ...o, displayId: byLabel.id } : { ...o, displayId: null, enabled: false };
          });
          return changed ? next : prev;
      });
  }, [displays]);

  // A projector window was closed BY THE USER (its X). Main can't act on this alone — the output
  // lives in project state here. Without this handler the renderer went on believing the window was
  // live: openProjectorsRef still listed it, so the reconciler (which only acts when the desired
  // display CHANGES) saw "already open" and never reopened it, the output stayed `enabled` so the
  // panel showed it Live, and the frame pump kept posting to a dead port. The output was
  // unrecoverable until someone toggled enabled off and on.
  //
  // Closing the window IS the disable gesture, so record it as one. This does NOT stop the show:
  // an output is a destination, not the transport — audio, Art-Net and the timeline keep running,
  // exactly as when you disable an output from the panel.
  useEffect(() => {
      if (HEADLESS) return;
      const unsub = window.artlux?.onProjectorClosed?.((surfaceId) => {
          openProjectorsRef.current.delete(surfaceId);
          projectorPortsRef.current.delete(surfaceId);
          upsertOutput(surfaceId, { enabled: false });
      });
      return () => unsub?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Frame pump for every projector: this (main) renderer is the sole decoder, so transfer
  // each surface's drawable to its projector window as an ImageBitmap (~30 fps, zero-copy).
  // Live singular sources (camera/Spout/DMX-in/NDI) AND HW-decoded file video / timeline
  // layers all stream — only IMAGE / EFFECT self-render in the projector. Decoding the same
  // media in every window otherwise exhausts the GPU's concurrent hardware-decode sessions.
  useEffect(() => {
      const STREAMED = new Set<string>([SourceType.CAMERA, SourceType.SPOUT, SourceType.DMX_IN, SourceType.NDI, SourceType.VIDEO, SourceType.LAYER, SourceType.PROGRAM]); // content-type strings (open type space)
      const inFlight = new Set<string>(); // surfaceIds with a createImageBitmap still pending
      // Last drawable generation actually shipped per surface. A 25/30 fps clip sampled by this
      // 30 fps pump repeats frames; each repeat would otherwise cost a full-surface
      // createImageBitmap (~8 MB at 1080p) and a transfer, per output window. undefined generation
      // = source can't report one (live camera/NDI/effect) → always send, as before.
      //
      // Keyed on the PORT as well as the generation: a projector window that is closed and reopened
      // gets a fresh port for the same surfaceId, and it starts with no frame. On a PAUSED source the
      // generation never advances, so a generation-only check would skip it forever and the new
      // window would stay black. A changed port always re-sends.
      const sentGen = new Map<string, { port: unknown; gen: number }>();
      // Surfaces we've already told to go black, so the idle notice is sent once per transition
      // rather than every tick.
      const idle = new Set<string>();
      // A render-active output is streamed the surfaces its VISIBLE GEOMETRY references, which can be
      // several per window and the same one to several windows. A transferred ImageBitmap is consumed
      // by one postMessage, so it genuinely costs (referenced surfaces × windows) createImageBitmap
      // calls per tick and cannot be shared. Bounded here rather than left to the operator's mesh
      // count: a mesh degrading to 15 fps is a legitimate trade, a stalled pump is not.
      //
      // The cursor makes it starvation-free — each tick resumes where the last stopped, so with more
      // work than budget every pair still gets served in rotation instead of the first N winning
      // forever. Tune EXTRA_PER_TICK against a real multi-projector rig; 6 is a starting point, not a
      // measured constant.
      const EXTRA_PER_TICK = 6;
      let extraCursor = 0;
      // A venue mesh that stays black looks identical whether its surface was deleted or is simply
      // empty, and neither is visible from the wall. Said ONCE per (output, surface) and cleared when
      // the picture comes back — a per-frame log would be useless and expensive at 30 Hz.
      const diagWarned = new Set<string>();
      // (output, layerId) pairs streamed to a venue mesh on the previous tick. The transition OUT of
      // this set is what triggers `layerFrameIdle` — see the scene-layer block.
      const sceneStreamed = new Set<string>();
      let raf = 0; let last = 0; let lastCoarse = 0;
      // ── MEASURE-ONLY: is this pump actually delivering at its nominal rate? ──────────────────────
      // The pump gates itself at ~30 Hz and then dedups on the drawable GENERATION, which for a codec
      // only advances when something ASKS the decoder — i.e. on the engine tick. Two independently
      // phased gates at the same nominal rate alias: sample just before the producer and you ship
      // nothing, so the projector holds its last frame for another period. `ships` vs `sameGen` and
      // the interval histogram are what tell those apart. `window.__artluxProjPump()`.
      const pumpStat = new Map<string, { ships: number; sameGen: number; idle: number; last: number; gaps: number[] }>();
      const pumpOf = (id: string) => {
          let s = pumpStat.get(id);
          if (!s) { s = { ships: 0, sameGen: 0, idle: 0, last: 0, gaps: [] }; pumpStat.set(id, s); }
          return s;
      };
      (window as any).__artluxProjPump = () => Object.fromEntries([...pumpStat].map(([id, s]) => {
          const g = s.gaps.slice().sort((a, b) => a - b);
          const pct = (p: number) => (g.length ? Math.round(g[Math.min(g.length - 1, Math.floor(g.length * p))] * 10) / 10 : 0);
          return [id, { ships: s.ships, sameGen: s.sameGen, idle: s.idle, gapMed: pct(0.5), gapP95: pct(0.95), gapMax: g.length ? Math.round(g[g.length - 1] * 10) / 10 : 0 }];
      }));
      (window as any).__artluxProjPumpReset = () => { pumpStat.clear(); };
      const tick = (now: number) => {
          raf = requestAnimationFrame(tick);
          // ── FINE TICK, COARSE BUDGET ────────────────────────────────────────────────────────────
          // Same lesson as the transport stream above: a 33 ms gate cannot sample a 30 Hz producer.
          // A codec's drawable GENERATION only advances when something asks the decoder — i.e. on the
          // engine tick — so once the engine was capped at 30 Hz this gate and its producer beat
          // against each other and the projector held a frame for an extra period at irregular
          // intervals. 15 ms passes on every tick at 30 and at 60.
          //
          // Shipping does NOT get more expensive: the generation dedup below is what decides whether a
          // bitmap is made, and it only says yes when there really are new pixels. The two consumers
          // that CANNOT dedup keep the old cadence — a live source with no generation (camera, Spout,
          // effects: `coarse` below) and the render-from-projector layer streams, whose EXTRA_PER_TICK
          // budget is per tick and would otherwise more than double.
          if (now - last < 15) return;
          last = now;
          const coarse = now - lastCoarse >= 33;
          if (coarse) lastCoarse = now;
          // Collected in the port loop, issued after it under EXTRA_PER_TICK. Held rather than sent
          // inline so the budget is global across windows — spending it all on the first output would
          // starve the third projector of a wall.
          const wantSurface: { port: MessagePort; outId: string; refId: string }[] = [];
          for (const [surfaceId, port] of projectorPortsRef.current) {
              const surface = surfacesRef.current.find(s => s.id === surfaceId);
              if (!surface) continue;
              // A SLICE is classified by the surface it CROPS — its own type says nothing about where
              // the pixels come from. Without this a spanned wall streamed nothing and every piece
              // stayed black: 'SLICE' is in neither set below, so the tick fell through the STREAMED
              // gate and returned. getDrawable(surface) still takes the SLICE (it returns the crop).
              const eff = resolveSource(surface, surfacesRef.current) ?? surface;
              // RENDER-FROM-PROJECTOR: a window drawing the 3D scene needs the frames of every layer
              // bound to a venue mesh — decoded HERE once, like everything else this pump ships, and
              // landed by the mirror engine (setLayerBitmap) for ProjectorScene's useLayerTexture.
              // Streamed while the output opts in with a solved pose, or while its calibration
              // session is open (the wizard's test projection). A layer the window decodes locally
              // (HAP/codec — see ProjectorApp's local-layer set) simply wins over this stream in the
              // mirror's getLayerDrawable, so redundancy costs a bitmap, never a wrong picture.
              //
              // The PROGRAM composite rides the same channel under its sentinel id. It used to be
              // skipped because a mirror expires a held frame by re-deriving activeClip(), and the
              // sentinel has no clips — so a streamed composite could never expire. That is fixed
              // with an explicit `layerFrameIdle` on the stream-stopping transition below, which also
              // fixes the ordinary case: a mesh unbound mid-show used to hold its last frame, because
              // activeClip still reported a live clip on the layer it was no longer bound to.
              const out = projectorOutputsRef.current.find(o => o.surfaceId === surfaceId);
              const renderActive = !!(out?.useCalibration && out.calibration?.poseRms != null)
                  || calibWorkspace.getState().target === surfaceId;
              // SURFACE-BOUND MESHES. A mesh can be bound to ANY surface, not only this output's own,
              // and until it was streamed one it simply stayed dark. What makes the extra streams
              // affordable is the other half of this change: a render-active window is no longer sent
              // its own surface unconditionally (see the gate further down). Its base canvas is not
              // what it displays — the 3D scene is — so those frames were being decoded, transferred
              // and thrown away, ~750 MB/s on three 1080p projectors. The own surface is now simply
              // one more entry in the referenced set, and it stays FREE when referenced because the
              // base canvas is already being sent it (surfaceFrameChannel holds that one non-owning).
              let ownReferenced = false;
              if (renderActive) {
                  const refs = new Set<string>();
                  for (const mdl of (scene3DRef.current?.models ?? [])) {
                      // layerId wins over surfaceId (SceneModel's documented precedence), and a layer
                      // binding is served by the layerFrame pump below instead.
                      if (!mdl.visible || mdl.layerId || !mdl.surfaceId) continue;
                      if (mdl.surfaceId === surfaceId) { ownReferenced = true; continue; } // arrives as `frame`
                      refs.add(mdl.surfaceId);
                  }
                  for (const refId of refs) wantSurface.push({ port, outId: surfaceId, refId });
              }
              // COARSE, AND AS ONE PIECE. Layer streams have no generation to dedup on and their
              // EXTRA_PER_TICK budget is spent per tick, so they keep the cadence that budget was tuned
              // against. The streaming and the idle reconciliation must be gated TOGETHER: `live` is
              // what decides which layers stopped being streamed, so running the reconciliation on a
              // tick that never populated it would report every live layer as idle, drop the mirror's
              // frame, and re-send it 33 ms later — a flicker on the wall, from a pure throttle change.
              if (coarse) {
                  const live = new Set<string>();
                  if (renderActive) {
                      for (const mdl of (scene3DRef.current?.models ?? [])) {
                          if (!mdl.visible || !mdl.layerId) continue;
                          const layerId = mdl.layerId;
                          live.add(layerId);
                          const key = `${surfaceId}:scene:${layerId}`;
                          if (inFlight.has(key)) continue;
                          // The sentinel resolves to the whole composite; every other id is one track.
                          const d = layerId === PROGRAM_LAYER_ID
                              ? timelineEngine.getProgramDrawable()
                              : timelineEngine.getLayerDrawable(layerId);
                          if (!d) continue;
                          inFlight.add(key);
                          createImageBitmap(d as CanvasImageSource)
                              .then(bitmap => { try { port.postMessage({ t: 'layerFrame', layerId, bitmap }, [bitmap]); } catch { bitmap.close(); } })
                              .catch(() => {})
                              .finally(() => inFlight.delete(key));
                      }
                  }
                  // Say ONCE when a layer stops being streamed to this window, so the mirror drops the
                  // held frame instead of showing it for the rest of the show. A mirror can expire an
                  // ordinary layer itself (it re-derives activeClip from the timeline + playhead it
                  // holds) — but not one it is no longer BOUND to, and never the PROGRAM sentinel,
                  // which has no clips at all.
                  const pfx = `${surfaceId}:scene:`;
                  for (const k of [...sceneStreamed]) {
                      if (!k.startsWith(pfx)) continue;
                      const layerId = k.slice(pfx.length);
                      if (live.has(layerId)) continue;
                      sceneStreamed.delete(k);
                      try { port.postMessage({ t: 'layerFrameIdle', layerId }); } catch { /* window closing */ }
                  }
                  for (const layerId of live) sceneStreamed.add(pfx + layerId);
              }
              // TRACKING self-renders its blobs in the projector, but its optional background
              // timeline layer (a video) must be decoded here and streamed as a layer frame.
              if (eff.content.type === SourceType.TRACKING) {
                  const layerId = eff.content.bgLayerId;
                  if (!layerId) continue;
                  if (!coarse) continue; // no generation to dedup on — keep the original cadence
                  const key = `${surfaceId}:bg`;
                  if (inFlight.has(key)) continue;
                  const bg = timelineEngine.getLayerDrawable(layerId);
                  if (!bg) continue;
                  inFlight.add(key);
                  createImageBitmap(bg as CanvasImageSource)
                      .then(bitmap => { try { port.postMessage({ t: 'layerFrame', layerId, bitmap }, [bitmap]); } catch { bitmap.close(); } })
                      .catch(() => {})
                      .finally(() => inFlight.delete(key));
                  continue;
              }
              // A render-active output DISPLAYS THE 3D SCENE, not its own surface, so stream that
              // surface only when a visible mesh is actually bound to it. Everything else here was
              // being decoded, transferred and then discarded — ProjectorApp returns before the draw
              // (or, with a residual warp, draws the panel canvas instead). Dropping the sentGen entry
              // is what makes leaving render mode re-send immediately even on a PAUSED source, whose
              // generation never advances and would otherwise be skipped forever.
              if (renderActive && !ownReferenced) { sentGen.delete(surfaceId); continue; }
              if (inFlight.has(surfaceId)) continue; // back-pressure: don't pile up decodes
              if (!STREAMED.has(eff.content.type)) continue;
              const drawable = getDrawable(surface);
              if (!drawable) {
                  // Nothing under the playhead (clip ended) or the live source dropped. Say so ONCE —
                  // otherwise the window goes on drawing the last frame it was sent, forever.
                  if (!idle.has(surfaceId)) {
                      idle.add(surfaceId);
                      pumpOf(surfaceId).idle++;
                      sentGen.delete(surfaceId); // a resume must re-send even if the generation repeats
                      try { port.postMessage({ t: 'frameIdle' }); } catch { /* window closing */ }
                  }
                  continue;
              }
              idle.delete(surfaceId);
              // Skip sources that haven't produced a new frame since we last shipped one to THIS port.
              const gen = getDrawableGeneration(surface);
              // A source that cannot say whether its pixels changed (live receivers, effects, plugin
              // sources) has no dedup to protect it, so it keeps the pump's original ~30 Hz cadence
              // rather than riding the fine tick — otherwise the finer gate would double its
              // createImageBitmap cost for no new pictures.
              if (gen === undefined && !coarse) continue;
              const prev = sentGen.get(surfaceId);
              if (gen !== undefined && prev && prev.port === port && prev.gen === gen) { pumpOf(surfaceId).sameGen++; continue; }
              { const st = pumpOf(surfaceId); st.ships++; if (st.last) { st.gaps.push(now - st.last); if (st.gaps.length > 4000) st.gaps.shift(); } st.last = now; }
              inFlight.add(surfaceId);
              if (gen !== undefined) sentGen.set(surfaceId, { port, gen });
              createImageBitmap(drawable as CanvasImageSource)
                  .then(bitmap => { try { port.postMessage({ t: 'frame', bitmap }, [bitmap]); } catch { bitmap.close(); } })
                  .catch(() => { sentGen.delete(surfaceId); }) // failed → don't treat this gen as shipped
                  .finally(() => inFlight.delete(surfaceId));
          }
          // --- Referenced surfaces for render-active outputs, under the global per-tick budget ---
          // Same three mechanisms as the own-surface path above, keyed per (output, surface) pair:
          // back-pressure so decodes don't pile up, generation dedup so a 25 fps clip on a 30 fps pump
          // doesn't re-ship identical frames, and a one-shot idle so a mesh goes black instead of
          // holding a finished clip. The only addition is the rotating cursor.
          // EXTRA_PER_TICK is a per-TICK budget tuned against the original ~30 Hz cadence, and the
          // rotating cursor's fairness is defined in ticks too — so this whole section stays coarse.
          // Running it on the fine tick would silently more than double the ceiling on a multi-
          // projector wall, which is the one rig that can least afford it.
          for (let n = 0, i = 0; coarse && n < wantSurface.length && i < EXTRA_PER_TICK; n++) {
              const w = wantSurface[(extraCursor + n) % wantSurface.length];
              const key = `${w.outId}:surf:${w.refId}`;
              if (inFlight.has(key)) continue;
              const refSurface = surfacesRef.current.find(s => s.id === w.refId);
              if (!refSurface) {
                  if (!diagWarned.has(key)) {
                      diagWarned.add(key);
                      console.warn(`[projector] a venue mesh is bound to surface ${w.refId}, which no longer exists — it will stay black`);
                  }
                  continue;
              }
              const refDrawable = getDrawable(refSurface);
              if (!refDrawable && !diagWarned.has(key)) {
                  diagWarned.add(key);
                  console.warn(`[projector] surface "${refSurface.name}" (${refSurface.content.type}) has nothing to draw — the mesh bound to it stays black until it does`);
              }
              if (refDrawable) diagWarned.delete(key);
              if (!refDrawable) {
                  if (!idle.has(key)) {
                      idle.add(key);
                      sentGen.delete(key);
                      try { w.port.postMessage({ t: 'surfaceFrameIdle', surfaceId: w.refId }); } catch { /* closing */ }
                  }
                  continue;
              }
              idle.delete(key);
              const refGen = getDrawableGeneration(refSurface);
              const refPrev = sentGen.get(key);
              if (refGen !== undefined && refPrev && refPrev.port === w.port && refPrev.gen === refGen) continue;
              // Only a pair that actually SPENDS budget advances the cursor's count — skipping a
              // deduped or in-flight pair must not consume someone else's turn.
              i++;
              inFlight.add(key);
              if (refGen !== undefined) sentGen.set(key, { port: w.port, gen: refGen });
              createImageBitmap(refDrawable as CanvasImageSource)
                  .then(bitmap => {
                      try { w.port.postMessage({ t: 'surfaceFrame', surfaceId: w.refId, bitmap }, [bitmap]); }
                      catch { bitmap.close(); }
                  })
                  .catch(() => { sentGen.delete(key); })
                  .finally(() => inFlight.delete(key));
          }
          // Advanced only when the budget was actually spent — a fine tick serves none of these, and
          // rotating the cursor anyway would skip whole (output, surface) pairs instead of starving
          // none of them, which is the exact property the cursor exists to provide.
          if (coarse && wantSurface.length > 0) extraCursor = (extraCursor + EXTRA_PER_TICK) % wantSurface.length;
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
  }, []);

  // NVAPI hardware warp/blend: detect once on mount (false on the stub build / non-pro GPUs → GLSL path).
  useEffect(() => { window.artlux?.nvwarpAvailable?.().then(v => setNvAvailable(!!v)).catch(() => {}); }, []);
  // The native audio engine graceful-degrades into PERFECT SILENCE, so nothing else in the app announces
  // its absence — the mixer draws a healthy UI over a silent room. Probe once; an addon cannot appear
  // mid-session. On rejection we stay `null` and say NOTHING. Wave 3 acceptance test 0.3.
  useEffect(() => {
      window.artlux?.pluginInvoke?.('audio:available')
          .then(v => setAudioAvailable(!!v))
          .catch(() => {});
  }, []);
  // True when NVAPI owns this output's 2D geometry warp + edge blend (so the GLSL path must render flat to
  // avoid double-warp). Same predicate used by the apply reconciler and the content push — keep them in sync.
  const hwOwnsGeometry = (out: ProjectorOutput | undefined): boolean => {
      if (!nvAvailable || !out?.hwWarp || !out.enabled || out.displayId == null || out.displayId === WINDOWED_DISPLAY) return false;
      const d = displays.find(x => x.id === out.displayId);
      return !!d && !d.internal; // never warp the operator's built-in panel
  };

  // THE SOLVED PROJECTORS, MEMOIZED — and this memo is load-bearing, not tidiness.
  //
  // It was built inline in the Simulator3D props, so it was a new array of new objects on EVERY App
  // render — and this renderer repaints per frame during playback. Everything downstream that keys on
  // it then recomputes 60×/s, and once projected mapping started deriving its matrices from these it
  // was reallocating every SceneModel in the scene every frame: the 3D view dropped to ~14 fps and
  // the cause was three files away from the symptom. If you add a consumer of this, keep it stable.
  const projectorCalibs = useMemo(
      () => projectorOutputs
          .filter(o => o.calibration?.poseRms != null)
          .map(o => ({ surfaceId: o.surfaceId, name: surfaces.find(s => s.id === o.surfaceId)?.name, calibration: o.calibration! })),
      [projectorOutputs, surfaces]);

  // KEEP THE PROGRAM COMPOSITE ALIVE FOR A VENUE MESH.
  //
  // buildProgram only runs while something has retained it, and the only retainers were a surface
  // routed to SourceType.PROGRAM and a mounted 3D view. So a project whose ONLY program consumer is a
  // mesh bound to ★ Timeline (Program) — in --broadcast, or with the 3D viewport simply not open —
  // had programActive false, the composite was never built, and getProgramDrawable returned null IN
  // MAIN. The mesh then stayed black no matter what the projector side did, which reads exactly like
  // the feature not working. Outside the frame pump on purpose: a retain/release per tick would
  // thrash programConsumers 30×/s.
  useEffect(() => {
      const wanted = (scene3D.models ?? []).some(m => m.visible && m.layerId === PROGRAM_LAYER_ID)
          && (projectorOutputs.some(o => o.useCalibration && o.calibration?.poseRms != null)
              || calibratingOutputId != null);
      if (wanted) timelineEngine.retainProgram('venue-mesh'); else timelineEngine.releaseProgram('venue-mesh');
  }, [scene3D, projectorOutputs, calibratingOutputId]);

  // Push the current config (surface + corner-pin + transport) to one projector window.
  const pushProjectorStateRef = useRef<(surfaceId: string) => void>(() => {});
  pushProjectorStateRef.current = (surfaceId: string) => {
      const port = projectorPortsRef.current.get(surfaceId);
      const surface = surfaces.find(s => s.id === surfaceId);
      if (!port || !surface) return;
      const out = projectorOutputs.find(o => o.surfaceId === surfaceId);
      // When NVAPI applies warp + blend at the scanout, the GLSL path must render flat (identity corner-pin,
      // no Bézier warp, no soft-edge feather) or the correction is applied twice. Gamma/brightness stay in GLSL.
      const hwGeom = hwOwnsGeometry(out);
      // A SLICE output shows a region of ANOTHER surface, and this window holds only its own — so send
      // the source alongside it, or the slice cannot resolve locally (see projector/bridge.ts).
      const source = resolveSource(surface, surfaces);
      port.postMessage({
          t: 'config', surface, sources: source && source.id !== surface.id ? [source] : undefined,
          playing: isVideoPlaying,
          // What this window calls itself on its own overlays (cold-start sign, Identify).
          identity: {
              label: out?.name || undefined,
              display: out?.displayId != null ? displays.find(d => d.id === out.displayId)?.label : undefined,
              windowed: out?.displayId === WINDOWED_DISPLAY,
          },
          render: {
              cornerPin: hwGeom ? defaultCornerPin() : (out?.cornerPin ?? defaultCornerPin()),
              warp: hwGeom ? null : (out?.warp ?? null),
              softEdge: hwGeom ? defaultSoftEdge() : (out?.softEdge ?? defaultSoftEdge()),
              // Colour/black match: applied in NVAPI intensity when hardware owns the blend, else in GLSL.
              colorGain: hwGeom ? [1, 1, 1] : (out?.colorGain ?? [1, 1, 1]),
              blackLift: hwGeom ? [0, 0, 0] : (out?.blackLift ?? [0, 0, 0]),
              // The solved rig blend rides the SAME hwGeom gate as the soft edge — that gate IS the
              // double-blend guard. When the scanout carries the intensity map, the GPU must be handed
              // nothing to apply, or the overlap gets alpha twice (a dark seam masquerading as gamma).
              blend: hwGeom ? null : (out?.blend ?? null),
              blendOwner: hwGeom ? 'scanout' : 'gpu',
              gamma: out?.gamma ?? 1,
              brightness: projectorBrightness,
              fpsCap: projectorFpsCap,
              ndiSend: out?.ndiSend ?? false,
              ndiFullRes: BROADCAST,
              trackingSmoothing: scene3D.trackingSmoothing ?? 0.6,
              trackingPredictMs: scene3D.trackingPredictMs ?? 50,
          },
      });
      port.postMessage({ t: 'timeline', timeline: activeTimeline }); // the current scene's timeline, not global
      port.postMessage({ t: 'edit', on: editingOutputIds.includes(surfaceId) });
      port.postMessage({ t: 'identify', on: identifyOutputIds.includes(surfaceId) });
      // The cold-start hold. Sent HERE as well as on every gate change because a window can open INTO a
      // preload — broadcast opens its outputs from the same project load that started the wait — and a
      // window that missed the change event would put a half-loaded look on a real projector.
      { const b = bootGate.get(); port.postMessage({ t: 'boot', booting: b.booting, ready: b.ready, total: b.total, phase: b.phase }); }
      // Render-from-projector: while the calibration panel is open it owns the projector's calib mode;
      // otherwise drive it here — render the 3D venue scene when this output opts in and has a full pose.
      if (surfaceId !== calibratingOutputId) {
          const posed = out?.useCalibration && out.calibration?.poseRms != null;
          if (posed) {
              // Resolve live projected mapping HERE: a projector window is sent only its own
              // calibration, so a mesh projected from another output could never be resolved inside
              // it. Never written back into the document — the projector's pose is the source of
              // truth, and a baked copy would silently disagree after a re-solve.
              port.postMessage({ t: 'scene', scene3D: resolveProjectedScene(scene3D, projectorOutputs) });
              port.postMessage({ t: 'calib', mode: 'render', calibration: out!.calibration });
          } else {
              port.postMessage({ t: 'calib', mode: 'idle' });
          }
      }
  };
  // Receive the bridge MessagePort for each projector window (tagged by surfaceId).
  const onProjectorMsgRef = useRef<(surfaceId: string, m: ProjectorToMain) => void>(() => {});
  onProjectorMsgRef.current = (surfaceId, m) => {
      if (m.t === 'ready') pushProjectorStateRef.current(surfaceId);
      else if (m.t === 'cornerPin') upsertOutput(surfaceId, { cornerPin: m.cornerPin });
      else if (m.t === 'warp') upsertOutput(surfaceId, { warp: m.warp });
      else if (m.t === 'editOff') setEditingOutputIds(prev => prev.filter(x => x !== surfaceId));
      // Fan out to plugin back-channel subscribers: calibration taps patternShown (capture controllers)
      // + calibCrosshair/calibConfirm (pose pairing in calibWorkspace).
      projMsgSubs.current.forEach(cb => cb(surfaceId, m));
  };
  useEffect(() => {
      const onMsg = (e: MessageEvent) => {
          const d = e.data;
          if (!d || d.kind !== 'artlux:projector-port' || !e.ports[0]) return;
          const surfaceId: string = d.surfaceId;
          const port = e.ports[0];
          projectorPortsRef.current.set(surfaceId, port);
          port.onmessage = (ev: MessageEvent) => onProjectorMsgRef.current(surfaceId, ev.data as ProjectorToMain);
          port.start();
          pushProjectorStateRef.current(surfaceId);
      };
      window.addEventListener('message', onMsg);
      // Signal the preload that this window is ready to receive transferred projector ports
      // (the preload buffers them until a renderer announces readiness).
      window.postMessage('artlux:projector-ready', '*');
      return () => window.removeEventListener('message', onMsg);
  }, []);
  // Re-push config (incl. the edit toggle) whenever anything a projector renders changes.
  useEffect(() => {
      for (const surfaceId of projectorPortsRef.current.keys()) pushProjectorStateRef.current(surfaceId);
  }, [surfaces, projectorOutputs, activeTimeline, isVideoPlaying, editingOutputIds, identifyOutputIds, displays, projectorFpsCap, projectorBrightness, scene3D, calibratingOutputId, nvAvailable]);
  // ── THE SHOW STARTS AT THE TOP ────────────────────────────────────────────────────────────────
  // The gate armed on its own, so a show is about to begin: put BOTH clocks back on their in-points
  // first. In the ordinary case this is a no-op — opening a project already restarted them (swap with
  // transport:'restart' + showClock:'reset') — but the hold lasts seconds, and seconds are enough for
  // the playhead to have moved: an operator scrubbing the ruler while the strips filled, a stray seek
  // from OSC or the tablet, an FSM `seek` left over from the outgoing show. Starting a venue's first
  // run three seconds in, or mid-clip, is the kind of thing nobody notices until it is on the wall.
  //
  // ⚠ NOT WHEN THE OPERATOR ARMED IT. `armedBy: 'manual'` means a human reached past the wait and
  // pressed Play; the playhead is then theirs, and yanking it back to zero under their hands would be
  // the app arguing with them. That is exactly why the gate reports WHY it released.
  //
  // Runs SYNCHRONOUSLY inside the release, before the machine can tick: bootGate sets `armed` and then
  // notifies in the same call, so the seek lands ahead of the first FSM frame rather than one frame
  // into the show. Both clocks, because a scene may be bound (the playhead is the scene's) while the
  // bed still rides the global one — seek() only moves them together while they coincide.
  useEffect(() => bootGate.subscribe((p) => {
      if (p.booting || p.armedBy === null || p.armedBy === 'manual') return;
      timelineEngine.seek(timelineEngine.getStart());
      timelineEngine.showSeek(timelineEngine.getGlobalStart());
  }), []);
  // Mirror the cold-start hold to every open output window, render-free (bootGate is a plain service,
  // so this never touches React state). While the gate holds, each projector draws BLACK + "PRELOADING
  // SHOW" instead of a half-decoded look; the release message is what puts the real picture up. Fires at
  // the gate's poll rate for the second or two it is holding, and never again after that.
  useEffect(() => bootGate.subscribe((p) => {
      const msg: MainToProjector = { t: 'boot', booting: p.booting, ready: p.ready, total: p.total, phase: p.phase };
      for (const port of projectorPortsRef.current.values()) port.postMessage(msg);
  }), []);
  // Live projector-brightness push (no full config re-send) — drives slider drag render-free.
  const pushProjectorBrightnessRef = useRef<(v: number) => void>(() => {});
  pushProjectorBrightnessRef.current = (v: number) => {
      for (const port of projectorPortsRef.current.values()) port.postMessage({ t: 'brightness', value: v });
  };
  // Stop aligning any output that got disabled / removed (the rest of the span keeps its grid up).
  useEffect(() => {
      setEditingOutputIds(prev => {
          const live = prev.filter(id => projectorOutputs.some(o => o.surfaceId === id && o.enabled && o.displayId != null));
          return live.length === prev.length ? prev : live; // same array when nothing changed — no re-render loop
      });
  }, [projectorOutputs]);

  // Reconcile desired outputs (enabled + valid display + surface exists) with open windows.
  useEffect(() => {
      if (HEADLESS) return; // headless suppresses projector windows — DMX/Art-Net only, no display output
      const desired = new Map<string, number>();
      for (const o of projectorOutputs) {
          if (o.enabled && o.displayId != null
              && surfaces.some(s => s.id === o.surfaceId)
              && (o.displayId === WINDOWED_DISPLAY || displays.some(d => d.id === o.displayId))) {
              desired.set(o.surfaceId, o.displayId);
          }
      }
      for (const [surfaceId, displayId] of desired) {
          const cur = openProjectorsRef.current.get(surfaceId);
          if (cur === undefined) window.artlux?.openProjector?.(surfaceId, displayId);
          else if (cur !== displayId) window.artlux?.setProjectorDisplay?.(surfaceId, displayId);
          openProjectorsRef.current.set(surfaceId, displayId);
      }
      for (const surfaceId of [...openProjectorsRef.current.keys()]) {
          if (!desired.has(surfaceId)) {
              window.artlux?.closeProjector?.(surfaceId);
              openProjectorsRef.current.delete(surfaceId);
              projectorPortsRef.current.delete(surfaceId);
          }
      }
  }, [surfaces, projectorOutputs, displays]);

  // Reconcile per-output NDI senders: create one for each live output with ndiSend on (named
  // after the surface), destroy it otherwise. The projector window captures + streams frames.
  useEffect(() => {
      if (HEADLESS) return; // no projector windows in headless → nothing to capture; NDI-per-output is off too
      const desired = new Map<string, string>(); // surfaceId -> NDI source name
      for (const o of projectorOutputs) {
          const surface = surfaces.find(s => s.id === o.surfaceId);
          const live = o.enabled && o.displayId != null && surface && displays.some(d => d.id === o.displayId);
          if (live && o.ndiSend) desired.set(o.surfaceId, `ArtLux — ${surface!.name}`);
      }
      for (const [surfaceId, name] of desired) {
          if (!ndiSendersRef.current.has(surfaceId)) {
              window.artlux?.pluginSend?.('ndi:send-configure', { outputId: surfaceId, enabled: true, name });
              ndiSendersRef.current.add(surfaceId);
          }
      }
      for (const surfaceId of [...ndiSendersRef.current]) {
          if (!desired.has(surfaceId)) {
              window.artlux?.pluginSend?.('ndi:send-configure', { outputId: surfaceId, enabled: false });
              ndiSendersRef.current.delete(surfaceId);
          }
      }
  }, [surfaces, projectorOutputs, displays]);

  // Reconcile NVAPI hardware warp/blend: for each output that opts into hwWarp on a real (non-windowed,
  // non-internal) display, push the scanout warp mesh + intensity/blend map; clear it otherwise. Runs once
  // state settles on mount → re-applies saved outputs on relaunch (NVAPI sticky persistence is unreliable).
  // Keyed by Electron display.id; nvwarpManager maps that to the NVAPI displayId by desktop rect.
  useEffect(() => {
      if (HEADLESS) return; // headless drives NO display scanout — a physical warp/blend would be unclearable here
      if (!nvAvailable) return;
      const desired = new Map<string, number>(); // surfaceId -> Electron displayId
      for (const o of projectorOutputs) {
          const display = displays.find(d => d.id === o.displayId);
          if (hwOwnsGeometry(o) && display && surfaces.some(s => s.id === o.surfaceId)) {
              // The scanout owns this output's blend (hwOwnsGeometry is true here), so it — and only
              // it — gets the solved rig map. The GPU path is handed `blend: null` for the same
              // output in pushProjectorState.
              const payload = outputToNvwarp(o, display, toBlendMap(o.blend));
              window.artlux?.nvwarpSetWarp?.(display.id, payload.verts, payload.src);
              window.artlux?.nvwarpSetIntensity?.(display.id, payload.intensity.w, payload.intensity.h, payload.intensity.rgb);
              desired.set(o.surfaceId, display.id);
          }
      }
      for (const [surfaceId, displayId] of [...nvAppliedRef.current]) {
          if (!desired.has(surfaceId)) { window.artlux?.nvwarpClear?.(displayId); nvAppliedRef.current.delete(surfaceId); }
      }
      for (const [surfaceId, displayId] of desired) nvAppliedRef.current.set(surfaceId, displayId);
  }, [projectorOutputs, displays, nvAvailable]);

  // Panic / safety: clear every live NVAPI warp+blend so a wrong mapping or bad mesh can't leave a display
  // warped. Exposed as Outputs ▸ a button and a global Ctrl/Cmd+Shift+W; also runs on unmount/quit.
  const clearAllNvwarp = React.useCallback(() => {
      for (const [surfaceId, displayId] of [...nvAppliedRef.current]) {
          window.artlux?.nvwarpClear?.(displayId);
          nvAppliedRef.current.delete(surfaceId);
      }
      for (const d of displays) window.artlux?.nvwarpClear?.(d.id); // belt-and-braces: every known display
  }, [displays]);
  useEffect(() => {
      if (!nvAvailable) return;
      const onKey = (e: KeyboardEvent) => {
          if (keymap.matches(e, 'global.clearNvwarp')) { e.preventDefault(); clearAllNvwarp(); }
      };
      window.addEventListener('keydown', onKey);
      window.addEventListener('beforeunload', clearAllNvwarp);
      return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', clearAllNvwarp); };
  }, [nvAvailable, clearAllNvwarp]);

  // Broadcast/headless: load the project (--project= or last-opened) and let the show engine run.
  // Broadcast then opens the saved projector outputs; headless suppresses them (gated above).
  // Art-Net starts via the normal output effects in both. The in-project schedule tick fires because
  // both modes mount the full App + activate the show-control plugin.
  useEffect(() => {
      if (!SHOW_ENGINE) return;
      const mode = HEADLESS ? 'headless' : 'broadcast';
      (async () => {
          const prefs = await window.artlux?.getPrefs?.();
          // AppSettings is the MACHINE — the sound card, the Art-Net target, the OSC port — and prefs are where
          // it lives. Broadcast/headless never restored it: it used to arrive (wrongly) inside the project file,
          // and now that a project no longer carries it, THIS IS THE ONLY SOURCE. Without it the show machine
          // runs on DEFAULT_SETTINGS — Art-Net unicast to 127.0.0.1, and audio falling back to binaural/2ch on
          // whatever rig is actually plugged in. This is the one mode a venue actually runs.
          if (prefs?.appSettings) setSettings(s => ({ ...s, ...(prefs.appSettings as Partial<AppSettings>) }));
          const path = QUERY_PROJECT || prefs?.lastProjectPath;
          if (!path) { console.warn(`[${mode}] no project to load`); return; }
          const data = await window.artlux?.loadProjectPath?.(path);
          if (data) { applyProjectData(data); setCurrentProjectPath(path); }
          console.log(`[${mode}] loaded project: ${path}`);
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // EDITOR: honour --project= too. A SEPARATE effect from the show-engine loader above rather than a
  // widening of its guard, because that one also falls back to `prefs.lastProjectPath` *and* restores
  // AppSettings — show-mode behaviour the editor must not inherit.
  //
  // PRECEDENCE, and why it is spelled out in two places: the editor ALREADY reopens the last project
  // on launch (the prefs-restore effect below). Both are mount effects that await, so with no rule
  // between them the two loads race and whichever IPC resolved last wins the document — an operator
  // asking for one project and getting another, intermittently. `--project=` is an explicit
  // instruction and outranks the restore, so THIS effect owns the load whenever the flag is present
  // and the restore skips its own (see `!QUERY_PROJECT` there). Never make one of the two conditions
  // implicit: they only work as a pair.
  //
  // Until now `?project=` was read into QUERY_PROJECT and then consumed ONLY behind `if (!SHOW_ENGINE)
  // return`, so the editor ignored it — main parsed the flag, forwarded it, and the renderer dropped
  // it. `ArtLux.exe --project=<file>` opened an empty editor with nothing in any log to say why. This
  // is also the ONLY contract an external program has for "open this project" (no file association,
  // no protocol handler), so it has to work in the mode a human is actually watching.
  useEffect(() => {
      if (SAFE_MODE) { console.warn('[safe-mode] skipping --project= autoload'); return; }
      if (SHOW_ENGINE || !QUERY_PROJECT) return;
      // Logged like the show-engine loader above: when an EXTERNAL program spawns us with a project
      // and the operator says "nothing opened", this line is the only thing that distinguishes "the
      // flag never arrived" from "the file would not load". Says opening, not opened — a failure
      // surfaces as handleOpenRecent's own toast.
      console.log(`[editor] opening project from --project=: ${QUERY_PROJECT}`);
      handleOpenRecent(QUERY_PROJECT); // load + apply + set path + refresh recents, with its own error toast
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // EDITOR: `--new-project=<folder>`. The launcher owns choosing where a project goes; ArtLux owns
  // what one IS. So main lays out the folder (assets/ tree) and this writes the same clean document
  // the File menu writes — through writeNewProjectTo, not a second copy of the reset list, because
  // that list already drifted three times when it existed twice.
  useEffect(() => {
      if (SHOW_ENGINE || !QUERY_NEW_PROJECT) return;
      (async () => {
          try {
              const prepared = await window.artlux?.prepareProjectFolder?.(QUERY_NEW_PROJECT);
              if (!prepared) { toast.error('Could not create the project', 'The folder could not be prepared.'); return; }
              console.log(`[editor] creating a project from --new-project=: ${prepared.projectFile}`);
              const saved = await writeNewProjectTo(prepared.projectFile);
              if (!saved) toast.error('Could not create the project', 'The project file could not be written.');
          } catch (err) {
              toast.error('Could not create the project', String((err as Error)?.message ?? err));
          }
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore persisted prefs (settings + master brightness + recents + last project) on launch.
  useEffect(() => {
      if (SHOW_ENGINE) return; // broadcast/headless restore AppSettings themselves (above, before project load); the rest of this effect is editor-only UI state (layout, recents, templates) that show mode has no use for
      (async () => {
          const prefs = await window.artlux?.getPrefs?.();
          if (!prefs) return;
          if (prefs.appSettings) setSettings(s => ({ ...s, ...(prefs.appSettings as Partial<AppSettings>) }));
          if (typeof prefs.globalBrightness === 'number') setGlobalBrightness(prefs.globalBrightness);
          setRecentFiles(prefs.recentFiles ?? []);
          // Hydrate the workspace layout (panel sizes/visibility/tabs). One-time migration: older installs
          // kept split view in localStorage — seed from it when there's no saved layout yet, then clear it.
          let savedLayout = prefs.layoutState as Partial<WorkspaceLayout> | undefined;
          if (!savedLayout) {
              const sv = localStorage.getItem('artlux.splitView');
              const sr = parseFloat(localStorage.getItem('artlux.splitRatio') || '');
              if (sv !== null || (sr > 0.2 && sr < 0.85)) {
                  savedLayout = { ...(sv !== null ? { splitView: sv === '1' } : {}), ...(sr > 0.2 && sr < 0.85 ? { splitRatio: sr } : {}) };
              }
              localStorage.removeItem('artlux.splitView');
              localStorage.removeItem('artlux.splitRatio');
          }
          // Safe Mode hydrates DEFAULTS, not the banked layout: the tab an operator left open is the
          // tab that mounts at next boot, so a poisoned panel re-crashes the app every launch. This
          // is the other half of breaking that cycle (the autoload skip below is the first).
          layoutStore.hydrate(SAFE_MODE ? undefined : savedLayout);
          // …then put the active context's own panel sizes back on. See enterActiveContext().
          layoutStore.enterActiveContext(contextLayoutOf(layoutStore.get().activeContext));
          // Adopt the user's keyboard-shortcut overrides (absent → registry defaults). Migrated keydown
          // handlers read keymap.matches(); the editor reads/writes through the same store.
          keymap.hydrate(prefs.shortcuts);
          if (Array.isArray(prefs.fixtureTemplates)) setTemplates(prefs.fixtureTemplates as FixtureTemplate[]);
          // Reopen the last project — UNLESS an explicit --project= was given, which owns the load in
          // its own effect above. Without this guard the two race and the document is whichever IPC
          // happened to resolve last, so `--project=X` intermittently lands on the previous project.
          //
          // …or unless this is a Safe-Mode boot. THIS AUTOLOAD IS THE TRAP: a project that throws on
          // load re-opens itself at every launch, so the app is unusable until someone edits prefs by
          // hand. Rung 3 of the crash-recovery ladder exists to break exactly that cycle — the last
          // path stays in prefs (so re-opening it is one click away once it is fixed), it is just not
          // loaded automatically. Nothing here writes the project file.
          if (prefs.lastProjectPath && !QUERY_PROJECT && !QUERY_NEW_PROJECT && !SAFE_MODE) {
              const data = await window.artlux?.loadProjectPath?.(prefs.lastProjectPath);
              if (data) { applyProjectData(data); setCurrentProjectPath(prefs.lastProjectPath); }
          }
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Safe Mode: say so, once, and say the one thing a panicking operator needs to hear — that an empty
  // editor is NOT data loss. `toast.error` because it is the only sticky kind (KIND_META hold: 0):
  // this must still be on screen when they come back from checking the project folder.
  useEffect(() => {
      if (!SAFE_MODE || SHOW_ENGINE) return;
      toast.error(
          'Opened in Safe Mode',
          'ARTLux crashed twice while opening the last project, so it started empty with the default '
          + 'workspace. Your project file on disk has not been modified — open it again from File ▸ '
          + 'Open Recent to retry.',
      );
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The venue's patience for a cold start. Pushed on every settings change (not read once at hold
  // time): in broadcast the machine's real prefs land ASYNCHRONOUSLY, and can arrive after the project
  // they configure has already started loading. bootGate re-reads it on every poll.
  useEffect(() => { bootGate.setTimeoutSec(settings.bootPreloadSec ?? 15); }, [settings.bootPreloadSec]);

  // Persist settings + master brightness (debounced) so they survive restarts.
  useEffect(() => {
      const t = setTimeout(() => {
          window.artlux?.setPrefs?.({ appSettings: settings, globalBrightness });
      }, 400);
      return () => clearTimeout(t);
  }, [settings, globalBrightness]);

  const updateSettings = (patch: Partial<AppSettings>) => setSettings(s => ({ ...s, ...patch }));

  const selectedFixture = fixtures.find(f => f.id === selectedFixtureId) || null;

  // ── The editor store: what the shell's panels read instead of props ────────────────────────
  // App stays the sole owner of state and of every mutation; this only distributes it. `data` is a
  // fresh object per render on purpose (it mirrors the props it replaces), while `actions` is handed
  // to a facade in <EditorStore> that makes each function's identity permanent — see EditorStore.tsx.
  // TWO memos on purpose. The inner one depends on `fixtures` (it has to — a fixture's kind can
  // change under a live selection, by assigning or clearing a DMX profile) but collapses to a tiny
  // STRING, so the outer one — whose identity every panel is subscribed to — only rebuilds when the
  // selected kinds actually change, not on every fixture edit. See buildSelection's SelectedKinds.
  const selectedFixtureKinds = useMemo<SelectedKinds>(() => {
    const ids = selectedFixtureIds.length ? selectedFixtureIds : selectedFixtureId ? [selectedFixtureId] : [];
    if (!ids.length) return '';
    let pixel = false, light = false;
    for (const id of ids) {
      const f = fixtures.find(x => x.id === id);
      if (!f) continue;
      if (isLight(f)) light = true; else pixel = true;
      if (pixel && light) break;
    }
    return `${pixel ? 'p' : ''}${light ? 'l' : ''}` as SelectedKinds;
  }, [fixtures, selectedFixtureId, selectedFixtureIds]);

  const editorSelection = useMemo(
    () => buildSelection(selectedSurfaceId, selectedFixtureId, selectedFixtureIds, selectedModelId, selectedFixtureKinds),
    [selectedSurfaceId, selectedFixtureId, selectedFixtureIds, selectedModelId, selectedFixtureKinds]);

  // MEMOIZED ON ITS FIELDS, NOT REBUILT PER RENDER — this is load-bearing, not tidiness.
  //
  // Every field here is a useState value with a stable identity, so memoizing keeps the whole object's
  // identity stable across App re-renders that changed none of them. Panels read this through a React
  // context: a fresh object each render would re-render EVERY panel on every unrelated App render, and
  // a repaint under an open native <select> closes the popup mid-interaction (the documented rule in
  // CLAUDE.md, and exactly why the old ScenePanel3D was React.memo'd on its data props). This memo is
  // that same guarantee, applied once for every panel instead of per component.
  const editorData: EditorData = useMemo(() => ({
    surfaces, fixtures, groups, controllers, templates, fixtureProfiles,
    selectedSurfaceId, selectedFixtureId, selectedFixtureIds, selectedModelId,
    selection: editorSelection,
    projectorOutputs, displays, scene3D, modelNaturalSizes, sceneSaved,
    assets, currentProjectPath, projectRefs,
    timeline: activeTimeline, globalTimeline: timeline, scenes, cueBanks, stateMachine, activeSceneId,
    settings, patchPolicy, globalBrightness, projectorBrightness, isVideoPlaying,
  }), [
    surfaces, fixtures, groups, controllers, templates, fixtureProfiles,
    selectedSurfaceId, selectedFixtureId, selectedFixtureIds, selectedModelId, editorSelection,
    projectorOutputs, displays, scene3D, modelNaturalSizes, sceneSaved,
    assets, currentProjectPath, projectRefs,
    activeTimeline, timeline, scenes, cueBanks, stateMachine, activeSceneId,
    settings, patchPolicy, globalBrightness, projectorBrightness, isVideoPlaying,
  ]);

  // ── Stable props for the 2D stage ─────────────────────────────────────────────────────────────
  // Stage is memoized, and a memo is only worth anything if the props it compares actually hold still.
  // These handlers get permanent identities that forward to today's closures (useStableHandlers), and
  // the toolbar is rebuilt only when the two flags it draws change — so switching workspace context,
  // or any other App render that has nothing to do with the stage, no longer reconciles it.
  const stageHandlers = useStableHandlers({
    onDropAsset: handleDropAssetOnSurface,
    onSelectSurface: handleSelectSurface,
    onSelectFixture: handleSelectFixture,
    onRecordHistory: recordHistory,
    onToggle3DMax: handleToggle3DMax,
  });
  const stageExtraControls = useMemo(() => (
    <>
      <button
        onClick={() => setSplitView(v => !v)}
        title={splitView ? 'Hide 3D scene' : 'Show 3D scene (split view)'}
        aria-label="Toggle 3D split view"
        aria-pressed={splitView}
        className={`p-1.5 rounded-sm border transition-colors ${splitView ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1'}`}
      >
        <Columns2 size={14} />
      </button>
      <button
        onClick={stageHandlers.onToggle3DMax}
        title={is3DMaximized ? 'Restore split' : 'Maximize 3D scene'}
        aria-label="Maximize 3D scene"
        aria-pressed={is3DMaximized}
        className={`p-1.5 rounded-sm border transition-colors ${is3DMaximized ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1'}`}
      >
        {is3DMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </button>
    </>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [splitView, is3DMaximized]);

  const editorActions: EditorActions = {
    selectSurface: handleSelectSurface,
    addSurface: handleAddSurface,
    removeSurface: handleRemoveSurface,
    renameSurface: handleRenameSurface,
    moveSurface: handleMoveSurface,
    updateSurface: handleUpdateSurface,
    setSurfaces,
    selectFixture: handleSelectFixture,
    selectFixtures: handleSelectFixtures,
    selectAllFixtures: handleSelectAllFixtures,
    addFixture: handleAddFixture,
    removeFixture: handleRemoveFixture,
    renameFixture: handleRenameFixture,
    updateFixture: handleUpdateFixture,
    setFixtures,
    autoPatch: handleAutoPatch,
    commitFixture3D: handleCommitFixture3D,
    createGroup: handleCreateGroup,
    addSelectedToGroup: handleAddSelectedToGroup,
    removeGroup: handleRemoveGroup,
    selectGroup: handleSelectGroup,
    applyLookToGroup: handleApplyLookToGroup,
    addController: handleAddController,
    updateController: handleUpdateController,
    removeController: handleRemoveController,
    saveTemplate: handleSaveTemplate,
    addFromTemplate: handleAddFromTemplate,
    setFixtureProfile: (id, profileId, modeKey) => { void handleSetFixtureProfile(id, profileId, modeKey); },
    addFixtureFromProfile: (profileId, modeKey) => { void handleAddFixtureFromProfile(profileId, modeKey); },
    removeTemplate: handleRemoveTemplate,
    selectModel: handleSelectModel,
    addModel: handleAddModel,
    addPlane: handleAddPlane,
    removeModel: handleRemoveModel,
    updateModel: handleUpdateModel,
    commitModel: handleCommitModel,
    modelNaturalSize: handleModelNaturalSize,
    sceneConfig: handleSceneConfig,
    saveScene: handleSceneSave,
    importAssets: handleImportAssets,
    scanAssets: handleScanAssets,
    removeAsset: handleRemoveAsset,
    relinkAsset: handleRelinkAsset,
    useAssetOnSurface: handleUseAssetOnSurface,
    dropAssetOnSurface: handleDropAssetOnSurface,
    collectAssets: handleCollectAssets,
    setMasterBrightness: handleMasterBrightness,
    setProjectorBrightness,
    pushProjectorBrightness: (v) => pushProjectorBrightnessRef.current(v),
    setVideoPlaying: setIsVideoPlaying,
    updateSettings,
    updatePatchPolicy: (p) => setPatchPolicy(prev => ({ ...prev, ...p })),
    setStateMachine,
    enterAuthorScene: (sid) => enterAuthor(sid),
    recordHistory,
    saveProject: () => { void handleSaveProject(); },
    menuAction: (a) => dispatchMenuRef.current(a),
  };

  // Broadcast/headless (show) modes: no editor chrome, and now no Stage either.
  //
  // This used to render a hidden 1×1 Stage, not because anything was being shown, but because the
  // frame loop lived inside that component — a venue machine was mounting a React viewport in an
  // invisible one-pixel box so that Art-Net would come out. The engine runs on its own now, fed by the
  // effect above, so the show mode renders literally nothing and the pipeline does not care.
  //
  // All the output effects above still run; broadcast additionally opens the saved projector outputs
  // while headless suppresses them (reconcilers gated on HEADLESS above). isVideoPlaying defaults
  // true, so media-source fixtures play (not black) in both.
  if (SHOW_ENGINE) {
    return null;
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-stage text-fg-1 font-sans overflow-hidden">
      {/* No toolbar icon group beside the window controls anymore: every function it carried has a
          first-class door (menus, the context rail, dock tabs, F1), and rendering them twice was
          noise — see plans/help-merge-and-topbar-removal.md. */}
      <MenuBar onMenuAction={(a) => dispatchMenuRef.current(a)} />

      <EditorStore data={editorData} actions={editorActions}>
      <WorkspaceShell
        selection={editorSelection}
        drawers={
          /* Docs & Tutorials — a GLOBAL drawer, owned by no context (like the Preferences/About
             modals below). It stays pinned to the far right on every context. The bilingual Help
             drawer that used to sit beside it merged into the HelpBrowser modal (F1) — long-form
             docs are a drawer you read WHILE working; help is a lookup you visit and leave. */
          <div
            className={`h-full border-l border-line-1 bg-surface-1 ${docsOpen ? '' : 'w-0 overflow-hidden border-none'}`}
            style={{ width: docsOpen ? docsWidth : 0 }}
          >
            {docsOpen && (
              <div className="h-full" style={{ width: docsWidth }}>
                <DocsBrowser
                  onClose={() => setDocsOpen(false)}
                  width={docsWidth}
                  onResize={setDocsWidth}
                  onOpenExample={(p) => { handleOpenRecent(p); setDocsOpen(false); }}
                />
              </div>
            )}
          </div>
        }
        viewports={{
          // The 2D mapping stage — ALWAYS MOUNTED. This element owns the per-frame GPU sampling that
          // publishes `dmx:frame`, so the shell only ever HIDES it; unmounting it on a context switch
          // would stop Art-Net mid-show.
          [VIEWPORT_STAGE_2D]: (
              <UiProfiler id="viewport:stage2d">
                <div className="w-full h-full relative">
                    {/* Every prop here is referentially stable unless it genuinely changed — the
                        handlers through useStableHandlers, the toolbar through useMemo, the rest are
                        state values and useState setters. That is what lets Stage's React.memo
                        actually bail out instead of paying for a compare that always fails. */}
                    <Stage
                        surfaces={surfaces}
                        onUpdateSurfaces={setSurfaces}
                        onDropAsset={stageHandlers.onDropAsset}
                        selectedSurfaceId={selectedSurfaceId}
                        onSelectSurface={stageHandlers.onSelectSurface}
                        fixtures={fixtures}
                        onUpdateFixtures={setFixtures}
                        selectedFixtureId={selectedFixtureId}
                        selectedFixtureIds={selectedFixtureIds}
                        onSelectFixture={stageHandlers.onSelectFixture}
                        onRecordHistory={stageHandlers.onRecordHistory}
                        extraControls={stageExtraControls}
                    />
                </div>
              </UiProfiler>
          ),
          // The embedded 3D scene. Withheld until first shown (see scene3dMounted), then kept in the
          // right pane so a later 2D⟷3D switch doesn't rebuild the WebGL context or reload the GLBs.
          [VIEWPORT_SCENE_3D]: !scene3dMounted ? null : (
                      <UiProfiler id="viewport:scene3d">
                        <div className="w-full h-full flex">
                            {/* The canvas now fills the pane: the scene outliner that used to dock as a
                                reserved column here is the `3d` context's browser + parameter panels. */}
                            <div className="flex-1 min-w-0 min-h-0 relative">
                            <Simulator3D
                                fixtures={fixtures}
                                selectedFixtureId={selectedFixtureId}
                                selectedFixtureIds={selectedFixtureIds}
                                scene3D={scene3D}
                                modelUrls={modelUrls}
                                selectedModelId={selectedModelId}
                                fixtureProfiles={fixtureProfiles}
                                onSelectFixture={(id: string) => handleSelectFixture(id || null)}
                                onSelectFixtures={handleSelectFixtures}
                                onSelectModel={handleSelectModel}
                                onCommitFixture3D={handleCommitFixture3D}
                                onCommitModel={handleCommitModel}
                                onModelNaturalSize={handleModelNaturalSize}
                                onSceneConfig={handleSceneConfig}
                                onRecordHistory={recordHistory}
                                calibPickMode={calib.pickMode}
                                onCalibPick={(world, source) => calibWorkspace.pick(world, source)}
                                projectorCalibs={projectorCalibs}
                                activePicks={calib.flow === 'auto'
                                    ? calib.picks.map(world => ({ world }))
                                    : (projectorOutputs.find(o => o.surfaceId === calibratingOutputId)?.calibration?.posePicks ?? []).map(p => ({ world: p.world }))}
                                selectedPick={calib.flow === 'board' ? null : calib.selectedPick}
                                onSelectPick={calib.flow === 'board' ? undefined : ((i: number) => calibWorkspace.selectPick(i))}
                                onMovePick={calib.flow === 'auto' ? undefined : ((i: number, world: [number, number, number]) => calibWorkspace.movePickWorld(i, world))}
                                onMovePickEnd={calib.flow === 'auto' ? undefined : (() => calibWorkspace.endPickDrag())}
                                paused={!scene3dVisible}
                            />
                            </div>
                        </div>
                      </UiProfiler>
          ),
          // The one and only TimelinePanel. Two instances double its keyboard hook and its engine
          // subscription, so the fullscreen `timelineMax` overlay below renders a placeholder rather
          // than a second copy — exactly the rule the old dock-XOR-overlay branch enforced.
          [VIEWPORT_TIMELINE]: (
                  <UiProfiler id="viewport:timeline">
                    {timelineMax ? (
                        <div className="h-full flex items-center justify-center text-fg-3 text-mini italic">Timeline maximized — press F or the restore button to dock it</div>
                    ) : (
                        <TimelinePanel timeline={activeTimeline} onChange={handleTimelineChange} author={timelineAuthor} stateMachine={stateMachine} onStateMachineChange={setStateMachine} playing={isVideoPlaying} onTogglePlay={() => setIsVideoPlaying(!isVideoPlaying)} onToggleMax={() => setTimelineMax(true)} projectPath={currentProjectPath} onRegisterAsset={handleRegisterAsset} scenes={scenes} cues={cueBanks.flatMap(b => b.cues.map(c => ({ id: c.id, name: c.name })))} fixtureGroups={groups} rigFixtures={fixtures} rigProfiles={fixtureProfiles} audio={timelineBedProp} baseAutomation={baseAutomationProp} />
                    )}
                  </UiProfiler>
          ),
          // Projector outputs. Was a modal; it is the `project` context's viewport now — you bind
          // displays, warp, blend and gamma-match here for long stretches, which is a workbench,
          // not a dialog. Persistent so its expanded per-output drawer survives a context switch.
          [VIEWPORT_OUTPUTS]: (
                  <UiProfiler id="viewport:outputs">
                    <OutputsPanel
          surfaces={surfaces}
          outputs={projectorOutputs}
          displays={displays}
          editingOutputIds={editingOutputIds}
          identifyOutputIds={identifyOutputIds}
          onToggleIdentify={handleToggleIdentify}
          onIdentifyMany={handleIdentifyMany}
          onSetOutputName={(surfaceId, name) => upsertOutput(surfaceId, { name: name || undefined })}
          fpsCap={projectorFpsCap}
          spans={outputSpans}
          onApplySpan={applySpan}
          onUpdateSpan={updateSpan}
          onRemoveSpan={removeSpan}
          onSetSliceRect={setSliceRect}
          onToggleEditMany={handleToggleEditMany}
          onSetEnabled={handleSetOutputEnabled}
          onSetDisplay={handleSetOutputDisplay}
          onToggleEdit={handleToggleEditOutput}
          onResetCorners={handleResetCorners}
          onToggleWarp={handleToggleWarp}
          onSetSoftEdge={handleSetSoftEdge}
          onSetGamma={handleSetOutputGamma}
          onSetColorMatch={(sid, patch) => upsertOutput(sid, patch)}
          onMeasureGamma={handleMeasureGamma}
          measuringGammaId={measuringGammaId}
          gammaMsg={gammaMsg}
          onToggleNdiSend={handleToggleNdiSend}
          onSetFpsCap={setProjectorFpsCap}
          onRefreshDisplays={refreshDisplays}
          onCalibrate={(surfaceId) => { calibWorkspace.begin(surfaceId); goToContext('calib'); }}
          onSetUseCalibration={(surfaceId, on) => upsertOutput(surfaceId, { useCalibration: on })}
          nvAvailable={nvAvailable}
          onSetHwWarp={(surfaceId, on) => upsertOutput(surfaceId, { hwWarp: on })}
                    />
                  </UiProfiler>
          ),
          // Scenes + cue banks. Persistent so its Live/Edit mode and its own selection survive a
          // trip through another context.
          [VIEWPORT_SCENES]: (
                  <UiProfiler id="viewport:scenes">
                    <CueBankPanel
                        banks={cueBanks}
                        onChangeBanks={setCueBanks}
                        scenes={scenes}
                        surfaces={surfaces}
                        fixtures={fixtures}
                        getCurrentState={() => ({ surfaces, fixtures, globalBrightness })}
                        oscPrefix={settings.oscControlPrefix}
                        onCaptureScene={handleCaptureScene}
                        // These three are the OPERATOR GO surfaces (a human clicking the deck) → 'operator',
                        // so they push undo history. The show-driven recalls/cues route through cueBus →
                        // recallByRefRef/fireCueRef/fireColumnRef and inherit the 'show' default (no record).
                        onRecallScene={(scene) => handleRecallScene(scene, 'operator')}
                        onUpdateScene={handleUpdateScene}
                        onRenameScene={handleRenameScene}
                        onRemoveScene={handleRemoveScene}
                        onUpdateSceneFade={handleUpdateSceneFade}
                        onUpdateSceneAudio={handleUpdateSceneAudio}
                        onFireCue={(cue) => applyCues([cue], 'operator')}
                        onFireColumn={(bank, col) => fireColumn(bank, col, 'operator')}
                        onEditScene={enterAuthor}
                        onPreloadScene={(s) => timelinePreloader.warm(s.id, s.timeline)}
                        activeSceneId={activeSceneId}
                    />
                  </UiProfiler>
          ),
        }}
      />
      </EditorStore>

      <StatusBar
          // Idle help is the ACTIVE CONTEXT's own hint (a hovered control still wins via helpBus).
          help={contextRegistry.get(L.activeContext)?.hint?.[settings.helpLang]
            ?? 'Map content onto surfaces, then patch fixtures. Open the 3D Scene for venue layout.'}
          lang={settings.helpLang}
          connected={isBridgeConnected}
          // Column toggles only on the fallback shell. `showLeft`/`showRight` are read by the
          // hand-built branch of WorkspaceShell and by NOTHING else, so under docking (the default)
          // these buttons flipped a flag, lit up, and left the screen exactly as it was. Passing no
          // handler removes them; the dock tree's own group chevrons are the real control there.
          leftOpen={showLeftPanel}
          onToggleLeft={isDockingOn(L) ? undefined : () => setShowLeftPanel(!showLeftPanel)}
          rightOpen={showRightPanel}
          onToggleRight={isDockingOn(L) ? undefined : () => setShowRightPanel(!showRightPanel)}
          targetIp={settings.artNetIp}
          stateMachine={stateMachine}
      />

      <About open={aboutOpen} onClose={() => setAboutOpen(false)} info={appInfo} />
      {/* No sound, and nothing else would have said so. Dismissible per launch — never permanently: the
          Audio Bed panel keeps a `no audio engine` badge for as long as the state lasts. */}
      <AudioEngineMissing
          open={audioAvailable === false && !audioWarnDismissed}
          onClose={() => setAudioWarnDismissed(true)}
      />
      {/* Plugin modal panels (e.g. LiDAR OSC Monitor) — mounted only while open, toggled by menu action. */}
      {/* Plugin modals are the one plugin surface that renders OUTSIDE the shell's panel boundaries,
          so until now a throw in one unmounted the whole editor — the project loads clean and
          OPENING THE AUDIO BED PANEL is what kills it. The host owns the blast radius here; the
          plugin does not opt in and cannot opt out. `pluginId` names the culprit in the audit log. */}
      {panelRegistry.byMount('modal').map((p) => openModals.has(p.id)
        ? <ErrorBoundary key={p.id} variant="panel" scope={`plugin:${p.id}`} pluginId={p.id} label={p.title ?? p.id}>
            <p.Component onClose={() => setOpenModals((s) => { const n = new Set(s); n.delete(p.id); return n; })} />
          </ErrorBoundary>
        : null)}

      {update && (
        <UpdateNotice
            event={update}
            userInitiated={updateUserInitiated}
            onDownload={() => window.artlux?.downloadUpdate?.()}
            onInstall={() => window.artlux?.installUpdate?.()}
            onOpenExternal={(url) => window.artlux?.openExternal?.(url)}
            onDismiss={() => { setUpdate(null); setUpdateUserInitiated(false); }}
        />
      )}

      {timelineMax && (
        <div className="fixed inset-0 z-50 bg-surface-0 flex flex-col">
          <TimelinePanel timeline={activeTimeline} onChange={handleTimelineChange} author={timelineAuthor} stateMachine={stateMachine} onStateMachineChange={setStateMachine} playing={isVideoPlaying} onTogglePlay={() => setIsVideoPlaying(!isVideoPlaying)} maximized onToggleMax={() => setTimelineMax(false)} projectPath={currentProjectPath} onRegisterAsset={handleRegisterAsset} scenes={scenes} cues={cueBanks.flatMap(b => b.cues.map(c => ({ id: c.id, name: c.name })))} fixtureGroups={groups} rigFixtures={fixtures} rigProfiles={fixtureProfiles} audio={timelineBedProp} baseAutomation={baseAutomationProp} />
        </div>
      )}

    </div>
  );
};

export default App;