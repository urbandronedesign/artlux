import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Fixture, Surface, SurfaceContent, SourceType, AppSettings, DockTab, FixtureGroup, Scene, Cue, CueBank, defaultCueBank, normalizeCueBanks, FixtureTemplate, Controller, Timeline, defaultTimeline, normalizeTimeline, StateMachine, SmState, defaultStateMachine, normalizeStateMachine, AudioMix, defaultAudioMix, normalizeAudioMix, timelineAudioClips, timelineAudioTracks, sceneAudioEntries, cueEntries, isAddressableEntry, type AudioClip, type CueEntry, type CueTransition, type TimelineAudio, type AssetEntry, type AssetType, type PatchPolicy, readPatchPolicy } from './types';
import { defaultScene3D, defaultProjectorOutput, defaultCornerPin, defaultSoftEdge, WINDOWED_DISPLAY } from '../../shared/protocol';
import type { ProjectorCalibration } from '../../shared/protocol';
import { CalibWizard, AutoAlignWizard, calibCapture as cam, measureGamma, calibWorkspace } from '@artlux/plugin-calibration/renderer';
import type { AppInfo, UpdateEvent, Scene3D, SceneModel, ProjectorOutput, OutputSpan, DisplayInfo, SoftEdge, SrcRect } from '../../shared/protocol';
import { spanTiles, tileName } from './services/outputSpan';
import type { ProjectorToMain, MainToProjector } from './projector/bridge';
import { makeBezierWarp } from './projector/warp';
import { outputToNvwarp } from './projector/nvwarpApply';
import { OutputsPanel } from './components/OutputsPanel';
import { UpdateNotice } from './components/UpdateNotice';
import { autoPatch } from './services/addressing';
import { TopBar } from './components/TopBar';
import { About } from './components/About';
import { AudioEngineMissing } from './components/AudioEngineMissing';
import { RoutingModal } from './components/RoutingModal';
import { InspectorPanel } from './components/InspectorPanel';
import { ScenePanel } from './components/ScenePanel';
import { CueBankPanel } from './components/CueBankPanel';
import { MediaPanel } from './components/MediaPanel';
import { AssetManager } from './components/AssetManager';
import { Stage } from './components/Stage';
import Simulator3D from './components/Simulator3D/Simulator3D';
import ScenePanel3D from './components/Simulator3D/ScenePanel3D';
import { useModelUrls } from './components/Simulator3D/useModelUrls';
import type { ModelTransform } from './components/Simulator3D/ModelObject';
import { DMXMonitor } from './components/DMXMonitor';
import { FixtureEditor } from './components/FixtureEditor';
import { Dock } from './components/Dock';
import { Timeline as TimelinePanel } from './components/timeline/Timeline';
import { Preferences } from './components/Preferences';
import { MenuBar } from './components/MenuBar';
import { HelpPanel } from './components/HelpPanel';
import { DocsBrowser } from './components/DocsBrowser';
import { StatusBar } from './components/StatusBar';
import { PerfPanel } from './components/PerfPanel';
import { sendArtNetFrame, configureOutput, addStatusListener } from './services/mockSocketService';
import { dmxSignal } from './services/dmxSignal';
import { perfMonitor } from './services/perfMonitor';
import { getDrawable, getDrawableGeneration, resolveSource } from './services/surfaceMedia';
import { timeline as timelineEngine, GLOBAL_POOL } from './services/timeline';
import { usageForPath, normPath, type ProjectRefs } from './services/assetLibrary';
import { setCoreStateView } from './services/automationTargets.core';
import * as timelinePreloader from './services/timelinePreloader';
import { nextAccent, GLOBAL_ACCENT } from './sceneAccent';
import * as oscController from './services/oscController';
import { useLayout } from './hooks/useLayout';
import { layoutStore, type WorkspaceLayout } from './services/layoutStore';
import { useResizable } from './hooks/useResizable';
import { activateRendererPlugins } from './host/plugins';
import { setEnabled as mp4SetEnabled } from '@artlux/plugin-mp4';
import type { RendererHostServices, AutomationTargetProvider, AutomationTargetDef } from '@artlux/sdk/renderer';
import { projectorChannelRegistry, panelRegistry, automationTargetRegistry } from './host/registries';
import * as cueBus from './services/cueBus';
import * as selection from './services/selection';
import * as transitions from './services/transitions';
import { collectFadeableTargets, getByPath, setByPath, isFadeablePath, type StateView } from './services/paramPath';
import { trackingPlayback, trackingDrawable, resetPeopleTracking } from '@artlux/plugin-lidar-tracking';
import { Activity, SlidersHorizontal, Film, Clapperboard, Columns2, Maximize2, Minimize2, Gauge } from 'lucide-react';
import { useHistory } from './hooks/useHistory';

const generateId = () => Math.random().toString(36).substr(2, 9);

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
const QUERY_PROJECT = QS.get('project') || '';
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
  const { 
      state: fixtures, 
      set: setFixtures, 
      undo, 
      redo, 
      canUndo, 
      canRedo,
      record: recordHistory
  } = useHistory<Fixture[]>([
    {
      id: 'fix-1',
      name: 'Main Arch',
      x: 0.15, y: 0.15, width: 0.7, height: 0.1,
      universe: 0, startAddress: 1, ledCount: 60, reverse: false, rotation: 0,
      colorData: [], surfaceId: 'surf-1'
    }
  ]);
  
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>('fix-1');
  // Full multi-selection set (for grouping/bulk ops); selectedFixtureId is the "primary"
  // member that drives the inspector + on-stage transform gizmo.
  const [selectedFixtureIds, setSelectedFixtureIds] = useState<string[]>(['fix-1']);
  // Live mirror of fixtures for the global keydown handler (avoids stale closure).
  const fixturesRef = useRef<Fixture[]>(fixtures);
  fixturesRef.current = fixtures;
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
  const { dockOpen, dockHeight, splitView, splitRatio, dockTab, timelineMax, showHelp, helpWidth, leftTab, showLeft: showLeftPanel, showRight: showRightPanel } = L;
  const setLayoutField = <K extends keyof WorkspaceLayout>(k: K) =>
    (v: WorkspaceLayout[K] | ((p: WorkspaceLayout[K]) => WorkspaceLayout[K])) =>
      layoutStore.set({ [k]: typeof v === 'function' ? (v as (p: WorkspaceLayout[K]) => WorkspaceLayout[K])(layoutStore.get()[k]) : v } as Partial<WorkspaceLayout>);
  const setDockOpen = setLayoutField('dockOpen');
  const setDockHeight = setLayoutField('dockHeight');
  const setSplitView = setLayoutField('splitView');
  const setSplitRatio = setLayoutField('splitRatio');
  const setDockTab = setLayoutField('dockTab');
  const setTimelineMax = setLayoutField('timelineMax');
  const setShowHelp = setLayoutField('showHelp');
  const setHelpWidth = setLayoutField('helpWidth');
  // Docs Browser panel (local UI state — not persisted in the layout yet).
  const [docsOpen, setDocsOpen] = useState(false);
  const [docsWidth, setDocsWidth] = useState(480);
  const setLeftTab = setLayoutField('leftTab');
  const setShowLeftPanel = setLayoutField('showLeft');
  const setShowRightPanel = setLayoutField('showRight');
  const splitHostRef = useRef<HTMLDivElement | null>(null);
  const [calibPickMode, setCalibPickMode] = useState(false);        // wizard pose step: pick on the embedded 3D
  const [prefsOpen, setPrefsOpen] = useState(false);
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
  const [assetManagerOpen, setAssetManagerOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [outputsOpen, setOutputsOpen] = useState(false);
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
  // Media/AssetManager, the delete confirmation, and Relink's reference count). It must span the LIVE
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
    setCoreStateView(() => ({ surfaces: surfacesRef.current, fixtures: fixturesRef.current, globalBrightness: brightnessRef.current }));
  }, []);
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
  const [outputStats, setOutputStats] = useState<{ pps: number; fps: number; universes: number } | null>(null);
  const [fps, setFps] = useState(0);
  const frameCount = React.useRef(0);
  const lastTime = React.useRef(performance.now());
  // Renderer frame-time metrics live in the Performance dock tab (editor only). Broadcast has no chrome
  // and uses the console line + Prometheus gauges instead. `?perf=1` opens that tab on launch.
  useEffect(() => { if (PERF_FLAG) { setDockOpen(true); setDockTab(DockTab.PERF); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unsubscribe = addStatusListener((status) => {
        setIsBridgeConnected(status);
    });
    const unsubStats = window.artlux?.onDmxStats?.(setOutputStats);
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

  // Subscribe to DMX Signal for ArtNet Output (per-fixture routing).
  useEffect(() => {
      const unsubscribe = dmxSignal.subscribe((data) => {
          if (!settings.outputEnabled) return;
          // Pass destinations straight through; sendArtNetFrame gates on its ~44 FPS throttle before
          // building any target list, so throttled-away frames allocate nothing.
          sendArtNetFrame(data.destinations, settings.artNetPort);
      });
      return () => unsubscribe();
  }, [settings]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            if (e.shiftKey) redo(); else undo();
            e.preventDefault();
        }
        else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
            redo();
            e.preventDefault();
        }
        else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
            const el = e.target as HTMLElement | null;
            const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
            if (!typing && fixturesRef.current.length) {
                handleSelectFixtures(fixturesRef.current.map(f => f.id));
                e.preventDefault();
            }
        }
        // Ctrl/Cmd+Alt+P — open the Performance dock tab (renderer frame-time metrics).
        else if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'p' || e.key === 'P')) {
            setDockOpen(true);
            setDockTab(DockTab.PERF);
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
        setFps(frameCount.current);
        frameCount.current = 0;
        lastTime.current = time;
        // Renderer frame-time baseline (~1 Hz): push to Prometheus (broadcast/headless have no HUD)
        // and, in broadcast, log a line so the show machine has a visible signal in its console/logs.
        const ps = perfMonitor.stats();
        window.artlux?.reportRenderStats?.(ps);
        if (BROADCAST) console.info(`[perf] fps=${ps.fps.toFixed(0)} frameP99=${ps.frameP99.toFixed(1)}ms workP99=${ps.workP99.toFixed(1)}ms long=${ps.longFrames}/${ps.samples}`);
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
  const handleSceneConfig = (patch: Partial<Scene3D>) => setScene3D(s => ({ ...s, ...patch }));
  // --- 3D model CRUD (driven by the in-window scene panel; App owns scene3D) ---
  const addSceneModel = (m: SceneModel) => { recordHistory(); setScene3D(s => ({ ...s, models: [...(s.models ?? []), m] })); handleSelectModel(m.id); };
  const handleAddModel = async () => {
    const path = await window.artlux?.pickModel?.();
    if (!path) return;
    const name = (path.replace(/\\/g, '/').split('/').pop() || path).replace(/\.(glb|gltf)$/i, '');
    const count = (scene3D.models ?? []).length;
    addSceneModel({ id: crypto.randomUUID(), name, path, position: { x: count * 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1, visible: true });
  };
  const handleAddPlane = () => {
    const count = (scene3D.models ?? []).length;
    addSceneModel({ id: crypto.randomUUID(), name: `Screen ${count + 1}`, kind: 'plane', path: '', position: { x: count * 2, y: 1.2, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 2, visible: true });
  };
  const handleUpdateModel = (id: string, patch: Partial<SceneModel>) => { recordHistory(); setScene3D(s => ({ ...s, models: (s.models ?? []).map(m => m.id === id ? { ...m, ...patch } : m) })); };
  const handleRemoveModel = (id: string) => { recordHistory(); setScene3D(s => ({ ...s, models: (s.models ?? []).filter(m => m.id !== id) })); if (selectedModelId === id) setSelectedModelId(null); };
  const [sceneSaved, setSceneSaved] = useState(false);
  const sceneSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSceneSave = () => { handleSaveProject().then((path) => { if (path) { setSceneSaved(true); if (sceneSavedTimer.current) clearTimeout(sceneSavedTimer.current); sceneSavedTimer.current = setTimeout(() => setSceneSaved(false), 1500); } }); };
  const startSplitDrag = useResizable({ axis: 'x', mode: 'ratio', containerRef: splitHostRef, min: 0.2, max: 0.85, onChange: setSplitRatio });
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
    if (ids.length) setSelectedSurfaceId(null);
  };
  const handleSelectAllFixtures = () => handleSelectFixtures(fixtures.map(f => f.id));
  const handleAddSurface = () => {
    const id = generateId();
    const z = surfaces.reduce((m, s) => Math.max(m, s.zIndex), -1) + 1;
    setSurfaces([...surfaces, {
      id, name: `Surface ${surfaces.length + 1}`,
      x: 0.25, y: 0.25, width: 0.5, height: 0.5, rotation: 0, zIndex: z,
      content: { type: SourceType.NONE },
    }]);
    handleSelectSurface(id);
  };
  // Move a surface in the stage z-order (renumbers zIndex by back→front position so ordering stays
  // clean). 'up' = toward the front (drawn later / on top), 'down' = toward the back.
  const handleMoveSurface = (id: string, dir: 'up' | 'down') => {
    const ordered = [...surfaces].sort((a, b) => (a.zIndex - b.zIndex) || (surfaces.indexOf(a) - surfaces.indexOf(b)));
    const i = ordered.findIndex(s => s.id === id);
    const j = dir === 'up' ? i + 1 : i - 1;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    const z = new Map(ordered.map((s, idx) => [s.id, idx]));
    setSurfaces(surfaces.map(s => ({ ...s, zIndex: z.get(s.id)! })));
  };
  const handleRemoveSurface = (id: string) => {
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
  const handleSetOutputEnabled = (surfaceId: string, enabled: boolean) => upsertOutput(surfaceId, { enabled });
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
  const [calibratingOutputId, setCalibratingOutputId] = useState<string | null>(null);
  const [calibFlow, setCalibFlow] = useState<'board' | 'auto'>('board'); // board structured-light vs markerless auto-align
  // Portal target in the left split pane: during calibration the big RGB camera viewport lives here
  // (replacing the 2D Stage) so it sits side-by-side with the 3D scene. Callback ref → re-renders the
  // wizard once the host element exists, so its createPortal target is reliable.
  const [calibCameraHost, setCalibCameraHost] = useState<HTMLDivElement | null>(null);
  const [autoAlignPicks, setAutoAlignPicks] = useState<[number, number, number][]>([]); // Auto-Align anchor world points (for the 3D markers)
  const [autoAlignSelectedPick, setAutoAlignSelectedPick] = useState<number | null>(null); // correspondence being edited (3D highlight)
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
      upsertOutput(surfaceId, { colorGain: res.colorGain });
      setGammaMsg({ id: surfaceId, ok: true, text: `γ ${res.gamma.toFixed(2)} (R ${res.gammaRGB[0].toFixed(2)} · G ${res.gammaRGB[1].toFixed(2)} · B ${res.gammaRGB[2].toFixed(2)}) · gain ${res.colorGain.map(x => x.toFixed(2)).join('/')} · ${res.footprintPx}px` });
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
    const next = surfaces.map(s => s.id === id ? { ...s, ...patch } : s);
    dropTakenOverLegs({ surfaces, fixtures, globalBrightness }, { surfaces: next, fixtures, globalBrightness });
    setSurfaces(next);
  };
  const handleRenameSurface = (id: string, name: string) => handleUpdateSurface(id, { name });

  const handleAddFixture = () => {
    recordHistory();
    const newId = generateId();
    const fx: Fixture = {
      id: newId,
      name: `Fixture ${fixtures.length + 1}`,
      x: 0.4, y: 0.4, width: 0.2, height: 0.2,
      universe: 0, startAddress: 1, ledCount: 30, reverse: false, rotation: 0,
      colorData: [],
      surfaceId: selectedSurfaceId ?? surfaces[0]?.id,
    };
    setFixtures(autoPatch([...fixtures, fx], controllers, patchPolicy));
    handleSelectFixture(newId);
  };

  const handleRemoveFixture = (id: string) => {
    recordHistory();
    setFixtures(autoPatch(fixtures.filter(f => f.id !== id), controllers, patchPolicy));
    setSelectedFixtureIds(prev => prev.filter(x => x !== id));
    if (selectedFixtureId === id) setSelectedFixtureId(null);
  };

  // Auto re-patch when something that affects addressing changes.
  const REPATCH_KEYS = ['ledCount', 'channelsPerPixel', 'controllerId', 'patchLocked'] as const;
  const handleUpdateFixture = (id: string, updates: Partial<Fixture>) => {
    recordHistory();
    const mapped = fixtures.map(f => f.id === id ? { ...f, ...updates } : f);
    const repatch = REPATCH_KEYS.some(k => k in updates);
    const next = repatch ? autoPatch(mapped, controllers, patchPolicy) : mapped;
    dropTakenOverLegs({ surfaces, fixtures, globalBrightness }, { surfaces, fixtures: next, globalBrightness });
    setFixtures(next);
  };

  const handleAutoPatch = () => setFixtures(autoPatch(fixtures, controllers, patchPolicy));

  // --- Controllers (output devices) ---
  const handleAddController = () => {
    setControllers([...controllers, {
      id: generateId(), name: `Controller ${controllers.length + 1}`,
      protocol: settings.protocol, ip: settings.artNetIp, broadcast: settings.broadcast,
    }]);
  };
  const handleUpdateController = (id: string, patch: Partial<Controller>) => {
    const next = controllers.map(c => c.id === id ? { ...c, ...patch } : c);
    setControllers(next);
    if ('startUniverse' in patch) setFixtures(autoPatch(fixtures, next, patchPolicy));
  };
  const handleRemoveController = (id: string) => {
    const next = controllers.filter(c => c.id !== id);
    setControllers(next);
    setFixtures(autoPatch(fixtures.map(f => f.controllerId === id ? { ...f, controllerId: undefined } : f), next, patchPolicy));
  };

  const handleRenameFixture = (id: string, newName: string) => {
    handleUpdateFixture(id, { name: newName });
  };

  // 3D gizmo commit: history already recorded at drag-start, so don't re-record.
  const handleCommitFixture3D = (id: string, updates: Partial<Fixture>) => {
    const next = fixtures.map(f => f.id === id ? { ...f, ...updates } : f);
    dropTakenOverLegs({ surfaces, fixtures, globalBrightness }, { surfaces, fixtures: next, globalBrightness });
    setFixtures(next);
  };

  // --- Groups ---
  const handleCreateGroup = () => {
    const ids = [...selectedFixtureIds];
    setGroups([...groups, { id: generateId(), name: `Group ${groups.length + 1}`, fixtureIds: ids }]);
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
      // INSIDE A GO, with no ErrorBoundary above it: one bad entry would be a white screen mid-show.
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
    groups,
    scene3D,
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
    setScenes([...scenes, { id, name: `Scene ${scenes.length + 1}`, fadeSec: 0, ...buildSceneSnapshot(), timeline, accent: nextAccent(scenes.map(s => s.accent), id) }]);
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
  const handleRecallScene = (scene: Scene) => {
    recordHistory();
    // Capture the pre-recall view for the fade's "from" before committing the target.
    const fromView = { surfaces, fixtures, globalBrightness };
    const toView = { surfaces: scene.surfaces ?? surfaces, fixtures: scene.fixtures, globalBrightness: scene.globalBrightness };
    if (scene.surfaces) setSurfaces(scene.surfaces);
    setFixtures(scene.fixtures.map(f => ({ ...f, colorData: [] })));
    setGlobalBrightness(scene.globalBrightness);
    if (scene.groups) setGroups(scene.groups);
    if (scene.scene3D) setScene3D(scene.scene3D);
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
  // Warm-swap the playback engine to a scene's timeline, preloading its media first (hitless), and
  // bridge the new timeline to the projector windows. Keyed by scene.id (a per-scene pool), so
  // activePoolKey stays == activeSceneId.
  const swapTimelineForScene = (scene: Scene) => {
    // Every scene owns a timeline (types.ts). This used to fall back to the GLOBAL doc when a scene had
    // none — which is what made `data === globalDoc` true under a scene's pool key, and is the entire
    // reason isGlobalDocBound() had to exist as a question distinct from clocksCoincident().
    const tl = normalizeTimeline(scene.timeline);
    timelinePreloader.warm(scene.id, tl);
    timelineEngine.swap(scene.id, tl, { transport: 'restart', holdMs: (scene.fadeSec ?? 0) * 1000 });
    for (const port of projectorPortsRef.current.values()) port.postMessage({ t: 'timeline', timeline: tl });
  };
  const handleRemoveScene = (id: string) => {
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
    recordHistory();
    const id = generateId();
    const accent = nextAccent(scenes.map(s => s.accent), id);
    const scene: Scene = { id, name: `State ${scenes.length + 1}`, fadeSec: 0, ...buildSceneSnapshot(), timeline: defaultTimeline(), accent };
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
  const handleTimelineChange = (next: Timeline) => {
    if (activeSceneId) setScenes(prev => prev.map(s => s.id === activeSceneId ? { ...s, timeline: next } : s));
    else setTimeline(next);
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
    scenes: scenes.map(s => ({ id: s.id, name: s.name, accent: s.accent, clipCount: s.timeline.clips.length })),
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
  const applyCues = (cues: Cue[]) => {
    if (!cues.length) return;
    recordHistory();
    const fromView: StateView = { surfaces, fixtures, globalBrightness };
    let next: StateView = { surfaces, fixtures, globalBrightness };
    const legs: transitions.FadeLeg[] = [];
    // cueEntries(): the container AND the elements. `Cue.entries` has no normalizer, so a `for…of` over a
    // non-array throws and a bad element throws on the very next line — inside a GO, with no ErrorBoundary
    // above it. Coerce, do not drop the show.
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
  const fireColumn = (bankRef: string, col: number) => {
    const bank = cueBanks.find(b => b.id === bankRef) ?? cueBanks.find(b => b.name === bankRef);
    if (!bank) return;
    const cell = bank.sceneCells.find(sc => sc.col === col);
    const scene = cell ? scenes.find(s => s.id === cell.sceneId) : undefined;
    if (scene) { handleRecallScene(scene); return; }
    applyCues(bank.cues.filter(c => c.col === col).sort((a, b) => b.row - a.row));
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
  const handleSaveTemplate = () => {
    if (!selectedFixture) return;
    const f = selectedFixture;
    const t: FixtureTemplate = {
      id: generateId(), name: f.name || `Template ${templates.length + 1}`,
      ledCount: f.ledCount, shape: f.shape, matrixWidth: f.matrixWidth, matrixHeight: f.matrixHeight,
      serpentine: f.serpentine, colorOrder: f.colorOrder, rgbwMode: f.rgbwMode, channelsPerPixel: f.channelsPerPixel,
    };
    persistTemplates([...templates, t]);
  };
  const handleAddFromTemplate = (t: FixtureTemplate) => {
    recordHistory();
    const id = generateId();
    setFixtures([...fixtures, {
      id, name: `${t.name} ${fixtures.length + 1}`,
      x: 0.4, y: 0.4, width: 0.2, height: 0.2,
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
      reserveLockedRanges: patchPolicy.reserveLockedRanges,
      globalBrightness,
      groups,
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
      // Surfaces: use the saved ones, or fall back to a default full-stage surface
      // (back-compat with pre-surfaces projects).
      const surf = Array.isArray(data?.surfaces) && data.surfaces.length ? data.surfaces as Surface[] : defaultSurfaces();
      setSurfaces(surf);
      if (data?.fixtures && Array.isArray(data.fixtures)) {
          recordHistory();
          // Default-link any unlinked fixture to the first surface (strict per-surface). Repair legacy
          // corruption: a non-array `segments` (e.g. `{"0":…}` from a pre-fix cue write) is always
          // garbage — coerce it back to undefined so Stage's `segments.map` can't throw on load.
          setFixtures(data.fixtures.map((f: any) => ({ ...f, colorData: [], surfaceId: f.surfaceId ?? surf[0]?.id, segments: Array.isArray(f.segments) ? f.segments : undefined })));
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
      setScenes(loadedScenes);
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
      const tl = normalizeTimeline(data?.timeline);
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
      // Opening a project RESETS the show clock (the bed's time restarts with the show); a scene recall
      // never does. Both reach swap() with transport:'restart' and cannot be told apart in there.
      timelineEngine.swap(curKey, curTl, { transport: 'restart', showClock: 'reset' });
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
  };

  const refreshRecents = async () => {
      const prefs = await window.artlux?.getPrefs?.();
      if (prefs) setRecentFiles(prefs.recentFiles ?? []);
  };

  // Save to the current file (Save) or prompt for a location (Save As / first save).
  const handleSaveProject = async () => {
      const path = await window.artlux?.saveProject?.(buildProjectData(), currentProjectPath ?? undefined);
      if (path) { setCurrentProjectPath(path); refreshRecents(); }
      return path ?? null;
  };
  const handleSaveAs = async () => {
      const path = await window.artlux?.saveProject?.(buildProjectData(), undefined);
      if (path) { setCurrentProjectPath(path); refreshRecents(); }
  };
  const handleOpenProject = async () => {
      const res = await window.artlux?.openProject?.();
      if (res) { applyProjectData(res.data); setCurrentProjectPath(res.path); refreshRecents(); }
  };
  const handleOpenRecent = async (path: string) => {
      const data = await window.artlux?.loadProjectPath?.(path);
      if (data) { applyProjectData(data); setCurrentProjectPath(path); refreshRecents(); }
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
      recordHistory();
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

  // New Project always creates a *folder* (project.artlux + assets/ tree) and prompts where to put
  // it, then saves immediately — so there's always a destination for imported/collected media.
  const handleNewProject = async () => {
      const res = await window.artlux?.newProjectFolder?.();
      if (!res) return; // user cancelled the folder dialog → keep the current project
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
      const path = await window.artlux?.saveProject?.(data, res.projectFile);
      if (path) { setCurrentProjectPath(path); refreshRecents(); }
  };

  const handleOpenProjectFolder = async () => {
      const res = await window.artlux?.openProjectFolder?.();
      if (res) { applyProjectData(res.data); setCurrentProjectPath(res.path); refreshRecents(); }
  };

  // Copy every referenced external asset into the project folder's assets/ tree, rewrite the
  // references to point there, then save (which stores them as folder-relative paths).
  const handleCollectAssets = async () => {
      if (!currentProjectPath) {
          window.alert('Create a project folder first (File → New Project), then collect assets.');
          return;
      }
      const folder = currentProjectPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      if (!window.confirm(`Collect Assets copies every external file into\n  ${folder}/assets/\nand overwrites\n  ${currentProjectPath}\n\nThis modifies your project in place and can't be undone. Continue?`)) return;
      const res = await window.artlux?.collectAssets?.(currentProjectPath, buildProjectData());
      if (!res) return;
      applyProjectData(res.data);
      await window.artlux?.saveProject?.(res.data, currentProjectPath);
      refreshRecents();
      const lines = [`Collected ${res.copied} asset${res.copied === 1 ? '' : 's'} into the project folder.`];
      if (res.skipped) lines.push(`${res.skipped} already collected or not collectable.`);
      if (res.missing.length) lines.push(`Missing (not found on disk):\n${res.missing.join('\n')}`);
      window.alert(lines.join('\n'));
  };

  // Non-destructive: collect a self-contained copy into a fresh folder, leaving the current file and
  // working directory untouched (pick target → collect → save the copy; no applyProjectData). Offers
  // to open the copy afterwards.
  const handleCollectCopyToFolder = async () => {
      const res = await window.artlux?.collectAssetsTo?.(buildProjectData());
      if (!res) return;
      await window.artlux?.saveProject?.(res.data, res.projectFile);
      refreshRecents();
      const lines = [`Collected a copy to\n  ${res.projectFile}`, ``, `${res.copied} asset${res.copied === 1 ? '' : 's'} copied.`];
      if (res.skipped) lines.push(`${res.skipped} already collected or not collectable.`);
      if (res.missing.length) lines.push(`Missing (not found on disk):\n${res.missing.join('\n')}`);
      lines.push(``, 'Your current project was not modified. Open the copy now?');
      if (window.confirm(lines.join('\n'))) handleOpenRecent(res.projectFile);
  };

  // ---- Asset library ----
  // Import media of a type: copy into the project's assets/<cat>/ and add library entries.
  const handleImportAssets = async (type: AssetType) => {
      if (!currentProjectPath) { window.alert('Create a project folder first (File → New Project) to import media.'); return; }
      const entries = await window.artlux?.importAssets?.(currentProjectPath, type);
      if (entries && entries.length) setAssets(prev => [...prev, ...entries]);
  };
  // A media file dropped straight onto the timeline is copied into the project by the Timeline, then
  // registered here so it appears in the Media library — same as an explicit import. Dedupe by path.
  const handleRegisterAsset = (entry: AssetEntry) => {
      const key = entry.path.replace(/\\/g, '/').toLowerCase();
      setAssets(prev => prev.some(a => a.path.replace(/\\/g, '/').toLowerCase() === key) ? prev : [...prev, entry]);
  };
  // Remove a library entry. Recorded takes live on the timeline, so removing a take also drops it
  // from trackingTakes (and any clips referencing it). References to imported assets are left as-is.
  const handleRemoveAsset = (asset: AssetEntry) => {
      const usedTake = asset.type === 'take';
      // Count references the SAME way the library badges do — across every surface list (live + each
      // scene's look snapshot), every scene3D, every timeline and the audio bed. `refs === 0` short-
      // circuits the confirm below, so anything this count can't see is deleted with no warning at all.
      const refs = usageForPath(asset.path, projectRefs).count;
      if (refs > 0 && !window.confirm(`"${asset.name}" is used in ${refs} place(s). Remove it from the library anyway?`)) return;
      // NB: removing a library entry never removes the CLIPS that reference it — video, audio (bed or
      // Timeline.audio) or content. The reference survives and reads as missing, which is recoverable;
      // deleting the user's placement is not. (A take is the one exception below, because a take's
      // library entry IS its trackingTakes row — the recording itself, not a reference to one.) The
      // confirm above is the guard, and it is only as good as usageIndex's coverage of every field a
      // path can live in — see services/assetLibrary.usageIndex.
      if (usedTake) {
          setTimeline(t => ({ ...t, trackingTakes: (t.trackingTakes ?? []).filter(r => r.id !== asset.id), clips: t.clips.filter(c => c.takeId !== asset.id) }));
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
      if (!window.confirm(`Relink "${asset.name}"\n\nfrom:  ${fileName(oldPath)}\nto:    ${fileName(newPath)}\n\nThis updates ${refCount} reference${refCount === 1 ? '' : 's'} and can't be undone. Continue?`)) return;
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
      window.alert(`Relinked "${asset.name}" — ${refCount} reference${refCount === 1 ? '' : 's'} updated.`);
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
      else window.alert('Save the project to a file first, then launch broadcast mode.');
  };

  // App info for the About modal.
  useEffect(() => { window.artlux?.getAppInfo?.().then((i) => setAppInfo(i ?? null)); }, []);

  // Native-menu commands → existing handlers. A ref keeps the latest closures so
  // the listener can be registered exactly once.
  const dispatchMenu = (action: string) => {
      if (action.startsWith('open-recent:')) { handleOpenRecent(action.slice('open-recent:'.length)); return; }
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
          case 'export-rig': handleExportRig(); break;
          case 'import-rig': handleImportRig(); break;
          case 'preferences': setPrefsOpen(true); break;
          case 'routing': setRoutingOpen(true); break;
          case 'about': setAboutOpen(true); break;
          case 'help-panel': setShowHelp((v) => !v); break;
          case 'docs-browser': setDocsOpen((v) => !v); break;
          case 'check-updates': setUpdateUserInitiated(true); window.artlux?.checkForUpdates?.(); break;
          case 'undo': undo(); break;
          case 'redo': redo(); break;
          default: {
            // Plugin modal panels: a menu action toggles the panel whose menuAction matches (e.g. the
            // LiDAR plugin's 'osc-monitor'). Host owns open state; the panel owns its own chrome.
            const panel = panelRegistry.byMount('modal').find((p) => p.menuAction === action);
            if (panel) setOpenModals((s) => { const n = new Set(s); n.has(panel.id) ? n.delete(panel.id) : n.add(panel.id); return n; });
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
      for (const port of projectorPortsRef.current.values()) port.postMessage({ t: 'timeline', timeline: activeTimeline });
  }, [activeTimeline, activeSceneId]);
  // FSM look-ahead preloading: when the machine enters a state, warm the timelines of every reachable
  // next state so a transition into one is hitless. The warm window follows the show's path (§tiers).
  useEffect(() => timelineEngine.subscribeSmState((stateId) => {
      if (!stateId) return;
      const sm = stateMachineRef.current;
      const nextSceneIds = sm.transitions.filter(t => t.from === stateId)
        .map(t => sm.states.find(s => s.id === t.to)?.sceneId)
        .filter((v): v is string => !!v);
      const entries = nextSceneIds
        .map(sid => ({ key: sid, tl: scenesRef.current.find(s => s.id === sid)?.timeline }))
        .filter(e => !!e.tl);
      if (entries.length) timelinePreloader.predict(entries);
  }), []);
  // Start the tracking-take replay loop once (main window only).
  useEffect(() => { trackingPlayback.start(); }, []);
  // ⚠ DECLARATION ORDER IS LOAD-BEARING: THIS EFFECT MUST STAY *AFTER* THE `setData` EFFECT ABOVE.
  // Effects flush in declaration order. The engine's setData guard needs the engine's `playing` to be
  // still true when the new document lands, so setData has to run first in the flush. Hoisting this one
  // above it kills that guard silently. See the full note on the setData effect.
  useEffect(() => { timelineEngine.setPlaying(isVideoPlaying); }, [isVideoPlaying]);
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
  const sceneSubs = useRef(new Set<() => void>());
  const settingsSubs = useRef(new Set<() => void>());
  const showSubs = useRef(new Set<() => void>()); // host `show` service: scenes/cueBanks/FSM/schedule changed
  const audioSubs = useRef(new Set<() => void>()); // host `audio` service: the global bed changed
  const projMsgSubs = useRef(new Set<(surfaceId: string, msg: unknown) => void>());
  const pluginHost = useMemo<RendererHostServices>(() => ({
    projectorOutputs: {
      get: (id) => projectorOutputsRef.current.find(o => o.surfaceId === id),
      list: () => projectorOutputsRef.current,
      patch: (id, partial) => upsertOutput(id, partial as Partial<ProjectorOutput>),
      subscribe: (cb) => { outputSubs.current.add(cb); return () => { outputSubs.current.delete(cb); }; },
    },
    scene3D: {
      get: () => scene3DRef.current,
      patch: (partial) => setScene3D(s => ({ ...s, ...(partial as Partial<Scene3D>) })),
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
        currentStateId: currentSmStateRef.current,
        stateElapsedSec: timelineEngine.getSmElapsedSec(),
        activeSceneId: activeSceneIdRef.current,
        lastFiredTransitionId: lastFiredTransitionRef.current,
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
  }), []);
  useEffect(() => { outputSubs.current.forEach(cb => cb()); }, [projectorOutputs]);
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
  useEffect(() => { calibWorkspace.setTarget(calibratingOutputId); }, [calibratingOutputId]);
  // Gate the WebCodecs MP4 decoder on its setting (off → .mp4 keeps using the default <video>).
  useEffect(() => { mp4SetEnabled(settings.mp4WebCodecs ?? false); }, [settings.mp4WebCodecs]);
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
  // Stream transport (playing + playhead) to the projector windows ~30 fps so their video/layer
  // content stays in sync with the main clock.
  useEffect(() => {
      let last = 0;
      const unsub = timelineEngine.subscribe((playhead) => {
          const now = performance.now();
          if (now - last < 33) return;
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
      let raf = 0; let last = 0;
      const tick = (now: number) => {
          raf = requestAnimationFrame(tick);
          if (now - last < 33) return;
          last = now;
          for (const [surfaceId, port] of projectorPortsRef.current) {
              const surface = surfacesRef.current.find(s => s.id === surfaceId);
              if (!surface) continue;
              // A SLICE is classified by the surface it CROPS — its own type says nothing about where
              // the pixels come from. Without this a spanned wall streamed nothing and every piece
              // stayed black: 'SLICE' is in neither set below, so the tick fell through the STREAMED
              // gate and returned. getDrawable(surface) still takes the SLICE (it returns the crop).
              const eff = resolveSource(surface, surfacesRef.current) ?? surface;
              // TRACKING self-renders its blobs in the projector, but its optional background
              // timeline layer (a video) must be decoded here and streamed as a layer frame.
              if (eff.content.type === SourceType.TRACKING) {
                  const layerId = eff.content.bgLayerId;
                  if (!layerId) continue;
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
              if (inFlight.has(surfaceId)) continue; // back-pressure: don't pile up decodes
              if (!STREAMED.has(eff.content.type)) continue;
              const drawable = getDrawable(surface);
              if (!drawable) {
                  // Nothing under the playhead (clip ended) or the live source dropped. Say so ONCE —
                  // otherwise the window goes on drawing the last frame it was sent, forever.
                  if (!idle.has(surfaceId)) {
                      idle.add(surfaceId);
                      sentGen.delete(surfaceId); // a resume must re-send even if the generation repeats
                      try { port.postMessage({ t: 'frameIdle' }); } catch { /* window closing */ }
                  }
                  continue;
              }
              idle.delete(surfaceId);
              // Skip sources that haven't produced a new frame since we last shipped one to THIS port.
              const gen = getDrawableGeneration(surface);
              const prev = sentGen.get(surfaceId);
              if (gen !== undefined && prev && prev.port === port && prev.gen === gen) continue;
              inFlight.add(surfaceId);
              if (gen !== undefined) sentGen.set(surfaceId, { port, gen });
              createImageBitmap(drawable as CanvasImageSource)
                  .then(bitmap => { try { port.postMessage({ t: 'frame', bitmap }, [bitmap]); } catch { bitmap.close(); } })
                  .catch(() => { sentGen.delete(surfaceId); }) // failed → don't treat this gen as shipped
                  .finally(() => inFlight.delete(surfaceId));
          }
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
          render: {
              cornerPin: hwGeom ? defaultCornerPin() : (out?.cornerPin ?? defaultCornerPin()),
              warp: hwGeom ? null : (out?.warp ?? null),
              softEdge: hwGeom ? defaultSoftEdge() : (out?.softEdge ?? defaultSoftEdge()),
              // Colour/black match: applied in NVAPI intensity when hardware owns the blend, else in GLSL.
              colorGain: hwGeom ? [1, 1, 1] : (out?.colorGain ?? [1, 1, 1]),
              blackLift: hwGeom ? [0, 0, 0] : (out?.blackLift ?? [0, 0, 0]),
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
      // Render-from-projector: while the calibration panel is open it owns the projector's calib mode;
      // otherwise drive it here — render the 3D venue scene when this output opts in and has a full pose.
      if (surfaceId !== calibratingOutputId) {
          const posed = out?.useCalibration && out.calibration?.poseRms != null;
          if (posed) {
              port.postMessage({ t: 'scene', scene3D });
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
  }, [surfaces, projectorOutputs, activeTimeline, isVideoPlaying, editingOutputIds, projectorFpsCap, projectorBrightness, scene3D, calibratingOutputId, nvAvailable]);
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
              const payload = outputToNvwarp(o, display); // blendMap feed wired with multi-projector capture
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
          if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'W' || e.key === 'w')) { e.preventDefault(); clearAllNvwarp(); }
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
          layoutStore.hydrate(savedLayout);
          if (Array.isArray(prefs.fixtureTemplates)) setTemplates(prefs.fixtureTemplates as FixtureTemplate[]);
          if (prefs.lastProjectPath) {
              const data = await window.artlux?.loadProjectPath?.(prefs.lastProjectPath);
              if (data) { applyProjectData(data); setCurrentProjectPath(prefs.lastProjectPath); }
          }
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist settings + master brightness (debounced) so they survive restarts.
  useEffect(() => {
      const t = setTimeout(() => {
          window.artlux?.setPrefs?.({ appSettings: settings, globalBrightness });
      }, 400);
      return () => clearTimeout(t);
  }, [settings, globalBrightness]);

  const updateSettings = (patch: Partial<AppSettings>) => setSettings(s => ({ ...s, ...patch }));

  const selectedFixture = fixtures.find(f => f.id === selectedFixtureId) || null;
  const selectedSurface = surfaces.find(s => s.id === selectedSurfaceId) || null;

  const dockTabs = [
    { id: DockTab.MONITOR, label: 'DMX Monitor', icon: <Activity size={13} /> },
    { id: DockTab.FIXTURE_EDITOR, label: 'Fixture Editor', icon: <SlidersHorizontal size={13} /> },
    { id: DockTab.TIMELINE, label: 'Timeline', icon: <Film size={13} /> },
    { id: DockTab.SCENES, label: 'Scenes & Cues', icon: <Clapperboard size={13} /> },
    { id: DockTab.PERF, label: 'Performance', icon: <Gauge size={13} /> },
  ];

  // Broadcast/headless (show) modes: no editor chrome — render only the offscreen Stage engine.
  // All the output effects above still run, so Art-Net flows; broadcast additionally opens the saved
  // projector outputs while headless suppresses them (reconcilers gated on HEADLESS above).
  // isVideoPlaying defaults true, so media-source fixtures play (not black) in both.
  if (SHOW_ENGINE) {
    return (
      <div style={{ position: 'fixed', width: 1, height: 1, overflow: 'hidden', opacity: 0, pointerEvents: 'none' }}>
        <Stage
          surfaces={surfaces}
          onUpdateSurfaces={setSurfaces}
          selectedSurfaceId={null}
          onSelectSurface={() => { /* no-op */ }}
          controllers={controllers}
          fixtures={fixtures}
          onUpdateFixtures={setFixtures}
          selectedFixtureId={null}
          selectedFixtureIds={[]}
          onSelectFixture={() => { /* no-op */ }}
          isEngineRunning={true}
          isVideoPlaying={isVideoPlaying}
          globalBrightness={globalBrightness}
          gamma={settings.gamma}
          targetIp={settings.artNetIp}
          broadcast={settings.broadcast}
          protocol={settings.protocol}
          onRecordHistory={() => { /* no-op */ }}
          showPreview={false}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-stage text-fg-1 font-sans overflow-hidden">
      <MenuBar
          onMenuAction={(a) => dispatchMenuRef.current(a)}
          actions={
            <TopBar
                onOpenPreferences={() => setPrefsOpen(true)}
                onOpenRouting={() => setRoutingOpen(true)}
                onOpenOutputs={() => { refreshDisplays(); setOutputsOpen(true); }}
                monitorOpen={dockOpen && dockTab === DockTab.MONITOR}
                onToggleMonitor={() => {
                  if (dockOpen && dockTab === DockTab.MONITOR) setDockOpen(false);
                  else { setDockTab(DockTab.MONITOR); setDockOpen(true); }
                }}
                helpOpen={showHelp}
                onToggleHelp={() => setShowHelp((v) => !v)}
            />
          }
      />

      <div className="flex flex-1 min-h-0">
        {/* Left: Scene ⇄ Media tabs */}
        <div className={`h-full border-r border-line-1 bg-surface-1 transition-all duration-med ${showLeftPanel ? 'w-72' : 'w-0 overflow-hidden border-none'}`}>
            <div className="w-72 h-full flex flex-col overflow-hidden">
              <div className="flex shrink-0 border-b border-line-1 bg-surface-2">
                {(['scene', 'media'] as const).map(t => (
                  <button key={t} onClick={() => setLeftTab(t)}
                    className={`flex-1 h-7 text-mini font-medium capitalize ${leftTab === t ? 'text-fg-1 border-b-2 border-accent' : 'text-fg-3 hover:text-fg-1'}`}>{t}</button>
                ))}
              </div>
              <div className="flex-1 min-h-0">
                {leftTab === 'media' ? (
                  <MediaPanel
                    assets={assets} timeline={timeline} refs={projectRefs}
                    selectedSurfaceId={selectedSurfaceId} hasProjectFolder={!!currentProjectPath}
                    onImport={handleImportAssets} onRemoveAsset={handleRemoveAsset}
                    onRelinkAsset={handleRelinkAsset} onUseOnSurface={handleUseAssetOnSurface}
                    onOpenManager={() => setAssetManagerOpen(true)}
                  />
                ) : (
                <ScenePanel
                    surfaces={surfaces}
                    selectedSurfaceId={selectedSurfaceId}
                    onSelectSurface={handleSelectSurface}
                    onAddSurface={handleAddSurface}
                    onRemoveSurface={handleRemoveSurface}
                    onRenameSurface={handleRenameSurface}
                    onMoveSurface={handleMoveSurface}
                    fixtures={fixtures}
                    selectedFixtureId={selectedFixtureId}
                    selectedFixtureIds={selectedFixtureIds}
                    onSelect={handleSelectFixture}
                    onSelectFixtures={handleSelectFixtures}
                    onSelectAll={handleSelectAllFixtures}
                    onAdd={handleAddFixture}
                    onRemove={handleRemoveFixture}
                    onRename={handleRenameFixture}
                    masterBrightness={globalBrightness}
                    onMasterBrightnessChange={handleMasterBrightness}
                    projectorBrightness={projectorBrightness}
                    onProjectorBrightnessChange={setProjectorBrightness}
                    onProjectorBrightnessInput={(v) => pushProjectorBrightnessRef.current(v)}
                    groups={groups}
                    onCreateGroup={handleCreateGroup}
                    onAddSelectedToGroup={handleAddSelectedToGroup}
                    onRemoveGroup={handleRemoveGroup}
                    onSelectGroup={handleSelectGroup}
                    onApplyLookToGroup={handleApplyLookToGroup}
                    onAutoPatch={handleAutoPatch}
                />
                )}
              </div>
            </div>
        </div>

        {/* Center: persistent stage host + bottom dock */}
        <div className="flex-1 min-w-0 flex flex-col bg-surface-0">
            <div ref={splitHostRef} className="flex-1 min-h-0 relative flex">
                {/* Left: 2D mapping stage */}
                <div className="min-h-0 relative" style={{ width: splitView ? `${splitRatio * 100}%` : '100%' }}>
                    <Stage
                        surfaces={surfaces}
                        onUpdateSurfaces={setSurfaces}
                        onDropAsset={handleDropAssetOnSurface}
                        selectedSurfaceId={selectedSurfaceId}
                        onSelectSurface={handleSelectSurface}
                        controllers={controllers}
                        fixtures={fixtures}
                        onUpdateFixtures={setFixtures}
                        selectedFixtureId={selectedFixtureId}
                        selectedFixtureIds={selectedFixtureIds}
                        onSelectFixture={handleSelectFixture}
                        isEngineRunning={true}
                        isVideoPlaying={isVideoPlaying}
                        globalBrightness={globalBrightness}
                        gamma={settings.gamma}
                        targetIp={settings.artNetIp}
                        broadcast={settings.broadcast}
                        protocol={settings.protocol}
                        onRecordHistory={recordHistory}
                        extraControls={
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
                                    onClick={handleToggle3DMax}
                                    title={is3DMaximized ? 'Restore split' : 'Maximize 3D scene'}
                                    aria-label="Maximize 3D scene"
                                    aria-pressed={is3DMaximized}
                                    className={`p-1.5 rounded-sm border transition-colors ${is3DMaximized ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1'}`}
                                >
                                    {is3DMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                                </button>
                            </>
                        }
                    />
                    {/* During calibration the big RGB camera viewport is portaled here, over the Stage,
                        so the operator works camera (left) ⟷ 3D (right). z-calib-camera clears Stage's own
                        z-stage-overlay layers (Stage's root is position:relative/z-auto → no stacking
                        context, so its children would otherwise paint over a lower-z sibling). */}
                    {calibratingOutputId && <div ref={setCalibCameraHost} className="absolute inset-0 z-calib-camera bg-black" />}
                </div>
                {/* Right: embedded 3D scene (or camera preview during calibration) */}
                {splitView && (
                    <>
                        <div onPointerDown={startSplitDrag} className="w-1 shrink-0 bg-line-1 hover:bg-accent cursor-col-resize" />
                        <div className="flex-1 min-w-0 min-h-0 flex">
                            {/* 3D canvas flexes; the Scene outliner docks as a reserved column beside it. */}
                            <div className="flex-1 min-w-0 min-h-0 relative">
                            <Simulator3D
                                fixtures={fixtures}
                                selectedFixtureId={selectedFixtureId}
                                scene3D={scene3D}
                                modelUrls={modelUrls}
                                selectedModelId={selectedModelId}
                                onSelectFixture={(id: string) => handleSelectFixture(id || null)}
                                onSelectModel={handleSelectModel}
                                onCommitFixture3D={(id, u) => handleCommitFixture3D(id, u)}
                                onCommitModel={handleCommitModel}
                                onModelNaturalSize={handleModelNaturalSize}
                                onSceneConfig={handleSceneConfig}
                                onRecordHistory={recordHistory}
                                calibPickMode={calibPickMode}
                                onCalibPick={(world) => calibWorkspace.pick(world)}
                                projectorCalibs={projectorOutputs.filter(o => o.calibration?.poseRms != null).map(o => ({ surfaceId: o.surfaceId, calibration: o.calibration! }))}
                                activePicks={calibFlow === 'auto'
                                    ? autoAlignPicks.map(world => ({ world }))
                                    : (projectorOutputs.find(o => o.surfaceId === calibratingOutputId)?.calibration?.posePicks ?? []).map(p => ({ world: p.world }))}
                                selectedPick={calibFlow === 'auto' ? autoAlignSelectedPick : null}
                                onSelectPick={calibFlow === 'auto' ? ((i: number) => calibWorkspace.selectPick(i)) : undefined}
                                hideInspector
                            />
                            </div>
                            {/* Full scene outliner (OBJECTS / FIXTURES / transform / LIGHTING + Save).
                                Docked as a reserved column on the pane's right edge; hidden during a projector
                                calibration session so it doesn't block the pick markers.
                                It gets the BOUND timeline, not the global one: its only use of the prop is the
                                selected model's layer picker, and the texture a model shows is composited from
                                the timeline the engine is PLAYING — the scene's own while authoring one. The
                                global doc listed layers that weren't on air. */}
                            {!calibratingOutputId && (
                                <ScenePanel3D
                                    scene3D={scene3D}
                                    fixtures={fixtures}
                                    selectedModelId={selectedModelId}
                                    selectedFixtureId={selectedFixtureId}
                                    timeline={activeTimeline}
                                    naturalSizes={modelNaturalSizes}
                                    saved={sceneSaved}
                                    onSelectModel={handleSelectModel}
                                    onSelectFixture={(id) => handleSelectFixture(id || null)}
                                    onAddModel={handleAddModel}
                                    onAddPlane={handleAddPlane}
                                    onRemoveModel={handleRemoveModel}
                                    onUpdateModel={handleUpdateModel}
                                    onSceneConfig={handleSceneConfig}
                                    onSave={handleSceneSave}
                                />
                            )}
                        </div>
                    </>
                )}
            </div>

            <Dock
                open={dockOpen}
                onToggle={() => setDockOpen(!dockOpen)}
                tabs={dockTabs}
                activeTab={dockTab}
                onTab={(id) => setDockTab(id as DockTab)}
                height={dockHeight}
                onResize={setDockHeight}
            >
                {dockTab === DockTab.MONITOR ? (
                    <DMXMonitor fixtures={fixtures} />
                ) : dockTab === DockTab.PERF ? (
                    <PerfPanel />
                ) : dockTab === DockTab.TIMELINE ? (
                    // Render the timeline in exactly one place (dock XOR fullscreen overlay) so its
                    // keyboard hook + engine subscription aren't doubled.
                    timelineMax ? (
                        <div className="h-full flex items-center justify-center text-fg-3 text-mini italic">Timeline maximized — press F or the restore button to dock it</div>
                    ) : (
                        <TimelinePanel timeline={activeTimeline} onChange={handleTimelineChange} author={timelineAuthor} stateMachine={stateMachine} onStateMachineChange={setStateMachine} playing={isVideoPlaying} onTogglePlay={() => setIsVideoPlaying(!isVideoPlaying)} onToggleMax={() => setTimelineMax(true)} projectPath={currentProjectPath} onRegisterAsset={handleRegisterAsset} scenes={scenes} cues={cueBanks.flatMap(b => b.cues.map(c => ({ id: c.id, name: c.name })))} audio={timelineBedProp} baseAutomation={baseAutomationProp} />
                    )
                ) : dockTab === DockTab.SCENES ? (
                    <CueBankPanel
                        banks={cueBanks}
                        onChangeBanks={setCueBanks}
                        scenes={scenes}
                        surfaces={surfaces}
                        fixtures={fixtures}
                        getCurrentState={() => ({ surfaces, fixtures, globalBrightness })}
                        oscPrefix={settings.oscControlPrefix}
                        onCaptureScene={handleCaptureScene}
                        onRecallScene={handleRecallScene}
                        onUpdateScene={handleUpdateScene}
                        onRenameScene={handleRenameScene}
                        onRemoveScene={handleRemoveScene}
                        onUpdateSceneFade={handleUpdateSceneFade}
                        onUpdateSceneAudio={handleUpdateSceneAudio}
                        onFireCue={(cue) => applyCues([cue])}
                        onFireColumn={fireColumn}
                        onEditScene={enterAuthor}
                        onPreloadScene={(s) => timelinePreloader.warm(s.id, s.timeline)}
                        activeSceneId={activeSceneId}
                    />
                ) : (
                    <FixtureEditor
                        fixture={selectedFixture}
                        onUpdateFixture={handleUpdateFixture}
                        onAdd={handleAddFixture}
                        onAutoPatch={handleAutoPatch}
                        templates={templates}
                        onSaveTemplate={handleSaveTemplate}
                        onAddFromTemplate={handleAddFromTemplate}
                        onRemoveTemplate={handleRemoveTemplate}
                    />
                )}
            </Dock>
        </div>

        {/* Right: inspector / properties */}
        <div className={`h-full border-l border-line-1 bg-surface-1 transition-all duration-med ${showRightPanel ? 'w-80' : 'w-0 overflow-hidden border-none'}`}>
            <div className="w-80 h-full overflow-y-auto">
                <InspectorPanel
                    surfaces={surfaces}
                    selectedSurface={selectedSurface}
                    onUpdateSurface={handleUpdateSurface}
                    selectedFixture={selectedFixture}
                    onUpdateFixture={handleUpdateFixture}
                    settings={settings}
                    layers={timeline.layers}
                />
            </div>
        </div>

        {/* Docs & Tutorials browser (dockable; detach + images are follow-ups) */}
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

        {/* Far right: dockable bilingual Help panel */}
        <div
          className={`h-full border-l border-line-1 bg-surface-1 ${showHelp ? '' : 'w-0 overflow-hidden border-none'}`}
          style={{ width: showHelp ? helpWidth : 0 }}
        >
          {showHelp && (
            <div className="h-full" style={{ width: helpWidth }}>
              <HelpPanel
                lang={settings.helpLang}
                onLang={(l) => updateSettings({ helpLang: l })}
                onClose={() => setShowHelp(false)}
                width={helpWidth}
                onResize={setHelpWidth}
              />
            </div>
          )}
        </div>
      </div>

      <StatusBar
          help="Map content onto surfaces, then patch fixtures. Open the 3D Scene for venue layout."
          lang={settings.helpLang}
          renderFps={fps}
          connected={isBridgeConnected}
          outputStats={outputStats}
          leftOpen={showLeftPanel}
          onToggleLeft={() => setShowLeftPanel(!showLeftPanel)}
          rightOpen={showRightPanel}
          onToggleRight={() => setShowRightPanel(!showRightPanel)}
          targetIp={settings.artNetIp}
          stateMachine={stateMachine}
      />

      <Preferences open={prefsOpen} onClose={() => setPrefsOpen(false)} settings={settings} onChange={updateSettings} />
      <About open={aboutOpen} onClose={() => setAboutOpen(false)} info={appInfo} />
      {/* No sound, and nothing else would have said so. Dismissible per launch — never permanently: the
          Audio Bed panel keeps a `no audio engine` badge for as long as the state lasts. */}
      <AudioEngineMissing
          open={audioAvailable === false && !audioWarnDismissed}
          onClose={() => setAudioWarnDismissed(true)}
      />
      {/* Plugin modal panels (e.g. LiDAR OSC Monitor) — mounted only while open, toggled by menu action. */}
      {panelRegistry.byMount('modal').map((p) => openModals.has(p.id)
        ? <p.Component key={p.id} onClose={() => setOpenModals((s) => { const n = new Set(s); n.delete(p.id); return n; })} />
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
      <OutputsPanel
          open={outputsOpen}
          onClose={() => setOutputsOpen(false)}
          surfaces={surfaces}
          outputs={projectorOutputs}
          displays={displays}
          editingOutputIds={editingOutputIds}
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
          onCalibrate={(surfaceId) => setCalibratingOutputId(surfaceId)}
          onSetUseCalibration={(surfaceId, on) => upsertOutput(surfaceId, { useCalibration: on })}
          nvAvailable={nvAvailable}
          onSetHwWarp={(surfaceId, on) => upsertOutput(surfaceId, { hwWarp: on })}
      />
      {calibratingOutputId && (() => {
        const co = projectorOutputs.find(o => o.surfaceId === calibratingOutputId);
        const calibLive = !!co?.enabled && co.displayId != null && (co.displayId === WINDOWED_DISPLAY || displays.some(d => d.id === co.displayId));
        const hasModel = (scene3D.models ?? []).some(m => m.kind !== 'plane' && m.visible);
        const closeCalib = () => { setCalibratingOutputId(null); setCalibPickMode(false); calibWorkspace.reset(); setCalibFlow('board'); setAutoAlignPicks([]); setAutoAlignSelectedPick(null); };
        return calibFlow === 'auto' ? (
          <AutoAlignWizard
            surfaceId={calibratingOutputId}
            surfaceName={surfaces.find(s => s.id === calibratingOutputId)?.name ?? 'Output'}
            output={co}
            scene3D={scene3D}
            live={calibLive}
            hasModel={hasModel}
            onSetCalibPickMode={setCalibPickMode}
            onSetSplit={setSplitView}
            onPicksChange={setAutoAlignPicks}
            onSwitchFlow={setCalibFlow}
            cameraHost={calibCameraHost}
            onSelectionChange={setAutoAlignSelectedPick}
            onClose={closeCalib}
          />
        ) : (
          <CalibWizard
            surfaceId={calibratingOutputId}
            surfaceName={surfaces.find(s => s.id === calibratingOutputId)?.name ?? 'Output'}
            output={co}
            scene3D={scene3D}
            live={calibLive}
            hasModel={hasModel}
            onSetCalibPickMode={setCalibPickMode}
            onSetSplit={setSplitView}
            onSwitchFlow={setCalibFlow}
            cameraHost={calibCameraHost}
            onClose={closeCalib}
          />
        );
      })()}
      <RoutingModal
          open={routingOpen}
          onClose={() => setRoutingOpen(false)}
          fixtures={fixtures}
          surfaces={surfaces}
          controllers={controllers}
          settings={settings}
          patchPolicy={patchPolicy}
          onUpdateFixture={handleUpdateFixture}
          onAddController={handleAddController}
          onUpdateController={handleUpdateController}
          onRemoveController={handleRemoveController}
          onAutoPatch={handleAutoPatch}
          onUpdateSettings={updateSettings}
          onUpdatePatchPolicy={(p) => setPatchPolicy(prev => ({ ...prev, ...p }))}
      />

      {timelineMax && (
        <div className="fixed inset-0 z-50 bg-surface-0 flex flex-col">
          <TimelinePanel timeline={activeTimeline} onChange={handleTimelineChange} author={timelineAuthor} stateMachine={stateMachine} onStateMachineChange={setStateMachine} playing={isVideoPlaying} onTogglePlay={() => setIsVideoPlaying(!isVideoPlaying)} maximized onToggleMax={() => setTimelineMax(false)} projectPath={currentProjectPath} onRegisterAsset={handleRegisterAsset} scenes={scenes} cues={cueBanks.flatMap(b => b.cues.map(c => ({ id: c.id, name: c.name })))} audio={timelineBedProp} baseAutomation={baseAutomationProp} />
        </div>
      )}

      <AssetManager
        open={assetManagerOpen} onClose={() => setAssetManagerOpen(false)} refs={projectRefs}
        assets={assets} timeline={timeline}
        selectedSurfaceId={selectedSurfaceId} hasProjectFolder={!!currentProjectPath}
        onImport={handleImportAssets} onRemoveAsset={handleRemoveAsset} onRelinkAsset={handleRelinkAsset}
        onUseOnSurface={handleUseAssetOnSurface} onSelectSurface={handleSelectSurface}
        onConsolidate={handleCollectAssets}
      />
    </div>
  );
};

export default App;