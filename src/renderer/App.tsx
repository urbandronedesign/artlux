import React, { useState, useEffect, useRef } from 'react';
import { Fixture, Surface, SourceType, AppSettings, DockTab, FixtureGroup, Scene, Cue, CueBank, defaultCueBank, FixtureTemplate, Controller, Timeline, defaultTimeline, normalizeTimeline, type AssetEntry, type AssetType } from './types';
import { defaultScene3D, defaultProjectorOutput, defaultCornerPin, defaultSoftEdge, WINDOWED_DISPLAY } from '../../shared/protocol';
import type { ProjectorCalibration } from '../../shared/protocol';
import { CalibWizard } from './components/CalibWizard';
import { AutoAlignWizard } from './components/AutoAlignWizard';
import * as calibController from './calib/calibController';
import * as slCapture from './calib/slCapture';
import type { AppInfo, UpdateEvent, Scene3D, ProjectorOutput, DisplayInfo, SoftEdge } from '../../shared/protocol';
import type { SceneToMain } from './scene/bridge';
import type { ProjectorToMain, MainToProjector } from './projector/bridge';
import { makeBezierWarp } from './projector/warp';
import { OutputsPanel } from './components/OutputsPanel';
import { UpdateNotice } from './components/UpdateNotice';
import { autoPatch } from './services/addressing';
import { TopBar } from './components/TopBar';
import { About } from './components/About';
import { RoutingModal } from './components/RoutingModal';
import { InspectorPanel } from './components/InspectorPanel';
import { ScenePanel } from './components/ScenePanel';
import { CueBankPanel } from './components/CueBankPanel';
import { MediaPanel } from './components/MediaPanel';
import { AssetManager } from './components/AssetManager';
import { Stage } from './components/Stage';
import Simulator3D from './components/Simulator3D/Simulator3D';
import { useModelUrls } from './components/Simulator3D/useModelUrls';
import type { ModelTransform } from './components/Simulator3D/ModelObject';
import { DMXMonitor } from './components/DMXMonitor';
import { FixtureEditor } from './components/FixtureEditor';
import { Dock } from './components/Dock';
import { Timeline as TimelinePanel } from './components/timeline/Timeline';
import { Preferences } from './components/Preferences';
import { OscMonitor } from './components/OscMonitor';
import { MenuBar } from './components/MenuBar';
import { HelpPanel } from './components/HelpPanel';
import { StatusBar } from './components/StatusBar';
import { sendArtNetFrame, configureOutput, addStatusListener } from './services/mockSocketService';
import { dmxSignal } from './services/dmxSignal';
import { getDrawable } from './services/surfaceMedia';
import { timeline as timelineEngine } from './services/timeline';
import * as oscController from './services/oscController';
import * as cueBus from './services/cueBus';
import * as transitions from './services/transitions';
import { collectFadeableTargets, getByPath, setByPath, isFadeablePath, type StateView } from './services/paramPath';
import * as trackingStore from './services/trackingStore';
import { clusterAndTrack, resetPeopleTracking } from './services/blobClustering';
import * as trackingPlayback from './services/trackingPlayback';
import * as trackingDrawable from './services/trackingDrawable';
import { Activity, SlidersHorizontal, Film, Clapperboard, Columns2 } from 'lucide-react';
import { useHistory } from './hooks/useHistory';

const generateId = () => Math.random().toString(36).substr(2, 9);

// Broadcast (show) mode: launched hidden via `--broadcast` (see main/index.ts). Renders only
// the Stage engine + the projector outputs from the loaded project — no editor chrome.
const QS = new URLSearchParams(window.location.search);
const BROADCAST = QS.get('broadcast') === '1';
const QUERY_PROJECT = QS.get('project') || '';

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
  const [isVideoPlaying, setIsVideoPlaying] = useState(true);
  const [globalBrightness, setGlobalBrightness] = useState(1.0);
  const [groups, setGroups] = useState<FixtureGroup[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [cueBanks, setCueBanks] = useState<CueBank[]>([]);
  const [templates, setTemplates] = useState<FixtureTemplate[]>([]);
  const [controllers, setControllers] = useState<Controller[]>([]);
  const [dockOpen, setDockOpen] = useState(true);
  const [dockHeight, setDockHeight] = useState(280);
  // Split view: embed the 3D scene beside the 2D stage (persisted). The calibration wizard turns it on.
  const [splitView, setSplitView] = useState<boolean>(() => localStorage.getItem('artlux.splitView') === '1');
  const [splitRatio, setSplitRatio] = useState<number>(() => { const v = parseFloat(localStorage.getItem('artlux.splitRatio') || ''); return v > 0.2 && v < 0.85 ? v : 0.5; });
  const splitHostRef = useRef<HTMLDivElement | null>(null);
  const [calibPickMode, setCalibPickMode] = useState(false);        // wizard pose step: pick on the embedded 3D
  const [dockTab, setDockTab] = useState<DockTab>(DockTab.FIXTURE_EDITOR);
  const [timelineMax, setTimelineMax] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [oscMonitorOpen, setOscMonitorOpen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [helpWidth, setHelpWidth] = useState(320);
  const [update, setUpdate] = useState<UpdateEvent | null>(null);
  const [updateUserInitiated, setUpdateUserInitiated] = useState(false);
  const [scene3D, setScene3D] = useState<Scene3D>(defaultScene3D());
  const scene3DRef = useRef(scene3D); scene3DRef.current = scene3D; // live mirror for the []-deps tracking bridge
  // Embedded 3D scene (split view): model GLB urls + selection/natural-size, shared with the Scene window.
  const modelUrls = useModelUrls(scene3D.models);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [modelNaturalSizes, setModelNaturalSizes] = useState<Record<string, number>>({});
  const [timeline, setTimeline] = useState<Timeline>(defaultTimeline());
  const [assets, setAssets] = useState<AssetEntry[]>([]); // managed media library (video/image/model)
  const [leftTab, setLeftTab] = useState<'scene' | 'media'>('scene');
  const [assetManagerOpen, setAssetManagerOpen] = useState(false);
  const scenePortRef = useRef<MessagePort | null>(null);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [outputsOpen, setOutputsOpen] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  // Projector outputs: per-surface fullscreen on a physical display.
  const [projectorOutputs, setProjectorOutputs] = useState<ProjectorOutput[]>([]);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [editingOutputId, setEditingOutputId] = useState<string | null>(null); // surface whose corners are being aligned
  const [projectorFpsCap, setProjectorFpsCap] = useState(0); // performance mode: 0 = uncapped
  const [projectorBrightness, setProjectorBrightness] = useState(1); // master brightness of projected content (separate from LED brightness)
  const projectorPortsRef = useRef<Map<string, MessagePort>>(new Map()); // surfaceId -> port
  const openProjectorsRef = useRef<Map<string, number>>(new Map());      // surfaceId -> displayId (open windows)
  const ndiSendersRef = useRef<Set<string>>(new Set());                  // surfaceIds with a live NDI sender
  const surfacesRef = useRef<Surface[]>(surfaces);                        // live mirror for the frame pump
  surfacesRef.current = surfaces;

  const [showLeftPanel, setShowLeftPanel] = useState(true);
  const [showRightPanel, setShowRightPanel] = useState(true);
  
  const [isBridgeConnected, setIsBridgeConnected] = useState(false);
  const [outputStats, setOutputStats] = useState<{ pps: number; fps: number; universes: number } | null>(null);
  const [fps, setFps] = useState(0);
  const frameCount = React.useRef(0);
  const lastTime = React.useRef(performance.now());

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
          const targets = Object.values(data.destinations).map(d => ({
              ip: d.ip,
              port: settings.artNetPort,
              protocol: d.protocol,
              broadcast: d.broadcast,
              sparse: d.sparse,
              priority: d.priority,
              universes: d.universes,
          }));
          sendArtNetFrame(targets);
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
      }
      animationFrameId = requestAnimationFrame(loop);
    };
    loop(performance.now());
    return () => cancelAnimationFrame(animationFrameId);
  }, []);

  // --- Surfaces ---
  const handleSelectSurface = (id: string | null) => { setSelectedSurfaceId(id); if (id) { setSelectedFixtureId(null); setSelectedFixtureIds([]); } };
  // --- embedded 3D model handlers (App is the source of truth; the detached Scene window mirrors) ---
  const handleSelectModel = (id: string | null) => { setSelectedModelId(id); if (id) { setSelectedFixtureId(null); setSelectedFixtureIds([]); setSelectedSurfaceId(null); } };
  const handleCommitModel = (id: string, t: ModelTransform) =>
    setScene3D(s => ({ ...s, models: (s.models ?? []).map(m => m.id === id ? { ...m, ...t } : m) }));
  const handleModelNaturalSize = (id: string, maxDim: number) =>
    setModelNaturalSizes(s => (s[id] === maxDim ? s : { ...s, [id]: maxDim }));
  const handleSceneConfig = (patch: Partial<Scene3D>) => setScene3D(s => ({ ...s, ...patch }));
  useEffect(() => { localStorage.setItem('artlux.splitView', splitView ? '1' : '0'); }, [splitView]);
  useEffect(() => { localStorage.setItem('artlux.splitRatio', String(splitRatio)); }, [splitRatio]);
  const startSplitDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const host = splitHostRef.current; if (!host) return;
    const move = (ev: PointerEvent) => {
      const r = host.getBoundingClientRect();
      setSplitRatio(Math.min(0.85, Math.max(0.2, (ev.clientX - r.left) / r.width)));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
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
  const handleSetOutputEnabled = (surfaceId: string, enabled: boolean) => upsertOutput(surfaceId, { enabled });
  const handleSetOutputDisplay = (surfaceId: string, displayId: number | null) =>
    upsertOutput(surfaceId, {
      displayId,
      displayLabel: displayId != null ? displays.find(d => d.id === displayId)?.label : undefined,
      enabled: displayId != null,
    });
  const handleToggleEditOutput = (surfaceId: string) =>
    setEditingOutputId(prev => prev === surfaceId ? null : surfaceId);
  // --- projector calibration (structured-light intrinsics + solvePnP pose) ---
  const [calibratingOutputId, setCalibratingOutputId] = useState<string | null>(null);
  const [calibFlow, setCalibFlow] = useState<'board' | 'auto'>('board'); // board structured-light vs markerless auto-align
  const sendToProjector = (surfaceId: string, msg: MainToProjector) =>
    projectorPortsRef.current.get(surfaceId)?.postMessage(msg);
  const handleStoreCalibration = (surfaceId: string, patch: Partial<ProjectorCalibration>) => {
    const prev = projectorOutputs.find(x => x.surfaceId === surfaceId)?.calibration ?? null;
    const base: ProjectorCalibration = prev ?? {
      intrinsics: [1, 0, 0, 0, 1, 0, 0, 0, 1], distortion: [0, 0, 0, 0, 0],
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0], imageSize: [0, 0],
    };
    upsertOutput(surfaceId, { calibration: { ...base, ...patch, calibratedAt: new Date().toISOString() } });
  };
  // Pose capture: the projector reports its crosshair pixel; on confirm we hold it as pending and pair
  // it with the next venue-model pick from the scene window → solvePnP (intrinsics fixed).
  const latestCrosshairRef = useRef<[number, number] | null>(null);
  const pendingPixelRef = useRef<[number, number] | null>(null);
  // When the Auto-Align (markerless) wizard is gathering camera-image↔model picks, it registers a
  // handler here so a model click is paired with a camera-image pixel instead of the board-pose logic.
  const markerlessPickRef = useRef<((world: [number, number, number]) => void) | null>(null);
  const solvePose = async (surfaceId: string, picks: NonNullable<ProjectorCalibration['posePicks']>) => {
    const cal = projectorOutputs.find(x => x.surfaceId === surfaceId)?.calibration;
    if (!cal) return;
    const obj = picks.flatMap(p => p.world);
    const img = picks.flatMap(p => p.pixel);
    const res = await window.artlux?.calibSolvePnp?.(obj, img, cal.intrinsics, cal.distortion ?? [0, 0, 0, 0, 0]);
    if (!res) return;
    handleStoreCalibration(surfaceId, { rotation: res.rotation, translation: res.translation, poseRms: res.rms });
  };
  const handleCalibPick = (world: [number, number, number]) => {
    // Markerless camera-pose pick takes precedence when its wizard step is active.
    if (markerlessPickRef.current) { markerlessPickRef.current(world); return; }
    const sid = calibratingOutputId;
    const pixel = pendingPixelRef.current;
    if (!sid || !pixel) return; // operator must confirm a crosshair on the projector first
    pendingPixelRef.current = null;
    const cal = projectorOutputs.find(x => x.surfaceId === sid)?.calibration;
    if (!cal) return;
    const picks = [...(cal.posePicks ?? []), { world, pixel }];
    handleStoreCalibration(sid, { posePicks: picks });
    if (picks.length >= 4) void solvePose(sid, picks);
  };
  const handlePoseModeChange = (surfaceId: string, on: boolean) => {
    scenePortRef.current?.postMessage({ t: 'calibMode', on, surfaceId: on ? surfaceId : null });
    if (!on) { pendingPixelRef.current = null; latestCrosshairRef.current = null; }
  };
  const handleClearPoses = (surfaceId: string) => {
    pendingPixelRef.current = null;
    handleStoreCalibration(surfaceId, { posePicks: [], poseRms: undefined, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] });
  };
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
  const handleToggleNdiSend = (surfaceId: string, on: boolean) => upsertOutput(surfaceId, { ndiSend: on });
  const refreshDisplays = () => { window.artlux?.listDisplays?.().then(d => setDisplays(d ?? [])); };
  const handleUpdateSurface = (id: string, patch: Partial<Surface>) => {
    setSurfaces(surfaces.map(s => s.id === id ? { ...s, ...patch } : s));
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
    setFixtures(autoPatch([...fixtures, fx], controllers));
    handleSelectFixture(newId);
  };

  const handleRemoveFixture = (id: string) => {
    recordHistory();
    setFixtures(autoPatch(fixtures.filter(f => f.id !== id), controllers));
    setSelectedFixtureIds(prev => prev.filter(x => x !== id));
    if (selectedFixtureId === id) setSelectedFixtureId(null);
  };

  // Auto re-patch when something that affects addressing changes.
  const REPATCH_KEYS = ['ledCount', 'channelsPerPixel', 'controllerId', 'patchLocked'] as const;
  const handleUpdateFixture = (id: string, updates: Partial<Fixture>) => {
    recordHistory();
    const mapped = fixtures.map(f => f.id === id ? { ...f, ...updates } : f);
    const repatch = REPATCH_KEYS.some(k => k in updates);
    setFixtures(repatch ? autoPatch(mapped, controllers) : mapped);
  };

  const handleAutoPatch = () => setFixtures(autoPatch(fixtures, controllers));

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
    if ('startUniverse' in patch) setFixtures(autoPatch(fixtures, next));
  };
  const handleRemoveController = (id: string) => {
    const next = controllers.filter(c => c.id !== id);
    setControllers(next);
    setFixtures(autoPatch(fixtures.map(f => f.controllerId === id ? { ...f, controllerId: undefined } : f), next));
  };

  const handleRenameFixture = (id: string, newName: string) => {
    handleUpdateFixture(id, { name: newName });
  };

  // 3D gizmo commit: history already recorded at drag-start, so don't re-record.
  const handleCommitFixture3D = (id: string, updates: Partial<Fixture>) => {
    setFixtures(fixtures.map(f => f.id === id ? { ...f, ...updates } : f));
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
    setFixtures(fixtures.map(f => group.fixtureIds.includes(f.id) ? { ...f, ...look } : f));
  };

  // --- Scenes (look snapshots) ---
  // Capture the visible state — surfaces, fixtures, brightness, groups, 3D scene, projector
  // outputs — but not the timeline/assets (playing transport + media library) or rig wiring.
  const buildSceneSnapshot = (): Omit<Scene, 'id' | 'name' | 'fadeSec'> => ({
    surfaces,
    fixtures: fixtures.map(f => ({ ...f, colorData: [] })),
    globalBrightness,
    groups,
    scene3D,
    projectorOutputs,
  });
  const handleCaptureScene = () => {
    setScenes([...scenes, { id: generateId(), name: `Scene ${scenes.length + 1}`, fadeSec: 0, ...buildSceneSnapshot() }]);
  };
  // Re-capture current state into an existing scene (keeps id/name/fadeSec) — MadMapper "Update Scene".
  const handleUpdateScene = (id: string) => {
    setScenes(scenes.map(s => s.id === id ? { ...s, ...buildSceneSnapshot() } : s));
  };
  const handleRenameScene = (id: string, name: string) => setScenes(scenes.map(s => s.id === id ? { ...s, name } : s));
  const handleUpdateSceneFade = (id: string, fadeSec: number) => setScenes(scenes.map(s => s.id === id ? { ...s, fadeSec } : s));
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
    if (scene.fadeSec && scene.fadeSec > 0) {
      transitions.start(collectFadeableTargets(fromView, toView), { fadeSec: scene.fadeSec, transition: 'smooth' });
    } else {
      transitions.cancel();
    }
  };
  const handleRemoveScene = (id: string) => setScenes(scenes.filter(s => s.id !== id));
  // Resolve a cueBus recall request (id then name) against current scenes. Held in a ref so the
  // once-subscribed cueBus listener always sees the latest scenes/handler closure.
  const recallByRefRef = useRef<(ref: string) => void>(() => {});
  recallByRefRef.current = (ref: string) => {
    const scene = scenes.find(s => s.id === ref) ?? scenes.find(s => s.name === ref);
    if (scene) handleRecallScene(scene);
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
    for (const cue of cues) for (const e of cue.entries) {
      if (isFadeablePath(e.path) && typeof e.value === 'number') {
        const from = getByPath(fromView, e.path);
        if (typeof from === 'number') legs.push({ path: e.path, from, to: e.value, transition: e.transition ?? cue.transition, fadeSec: e.fadeSec ?? cue.fadeSec });
      }
      next = setByPath(next, e.path, e.value);
    }
    setSurfaces(next.surfaces);
    setFixtures(next.fixtures);
    setGlobalBrightness(next.globalBrightness);
    if (legs.length) transitions.start(legs, { fadeSec: cues[0].fadeSec, transition: cues[0].transition });
    else transitions.cancel();
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
      version: '1.1', // 1.1: asset paths stored relative to the project folder when collected
      timestamp: new Date().toISOString(),
      surfaces,
      fixtures,
      controllers,
      settings,
      globalBrightness,
      groups,
      scenes,
      cueBanks,
      scene3D,
      timeline,
      assets,
      projectorOutputs,
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
          // Default-link any unlinked fixture to the first surface (strict per-surface).
          setFixtures(data.fixtures.map((f: any) => ({ ...f, colorData: [], surfaceId: f.surfaceId ?? surf[0]?.id })));
      }
      if (data?.settings) setSettings(prev => ({ ...prev, ...data.settings }));
      if (typeof data?.globalBrightness === 'number') setGlobalBrightness(data.globalBrightness);
      setControllers(Array.isArray(data?.controllers) ? data.controllers : []);
      setGroups(Array.isArray(data?.groups) ? data.groups : []);
      const loadedScenes: Scene[] = Array.isArray(data?.scenes) ? data.scenes : [];
      setScenes(loadedScenes);
      // Cue banks: use saved banks, else synthesize Bank 1 and place existing scenes in row 0 so
      // older (pre-cues) projects open with their scenes already on the grid.
      if (Array.isArray(data?.cueBanks) && data.cueBanks.length) {
        setCueBanks(data.cueBanks as CueBank[]);
      } else {
        const bank = defaultCueBank(generateId());
        bank.sceneCells = loadedScenes.map((s, i) => ({ col: i, sceneId: s.id }));
        setCueBanks([bank]);
      }
      const tl = normalizeTimeline(data?.timeline);
      setTimeline(tl);
      // Asset library: use saved assets; migrate a legacy take-only project (trackingTakes but no
      // assets) so recorded takes still appear in the library. Takes stay owned by the timeline.
      setAssets(Array.isArray(data?.assets) ? data.assets as AssetEntry[] : []);
      setProjectorOutputs(Array.isArray(data?.projectorOutputs) ? data.projectorOutputs as ProjectorOutput[] : []);
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

  // The fresh surfaces/fixtures of a clean single-fixture project (no setState — see callers).
  const makeNewProjectState = () => {
      const surf = defaultSurfaces();
      const fix = [{
          id: generateId(), name: 'Fixture 1',
          x: 0.15, y: 0.15, width: 0.7, height: 0.1,
          universe: 0, startAddress: 1, ledCount: 60, reverse: false, rotation: 0, colorData: [],
          surfaceId: surf[0].id,
      }];
      return { surfaces: surf, fixtures: fix };
  };
  // Reset app state to a clean project. Keeps settings/scene3D/timeline (matches prior New behavior).
  const resetToNewProject = (st: ReturnType<typeof makeNewProjectState>) => {
      recordHistory();
      setSurfaces(st.surfaces);
      setFixtures(st.fixtures);
      setControllers([]);
      setGroups([]);
      setScenes([]);
      setProjectorOutputs([]);
      setAssets([]);
      setSelectedFixtureId(null);
      setSelectedFixtureIds([]);
      setSelectedSurfaceId(null);
  };

  // New Project always creates a *folder* (project.artlux + assets/ tree) and prompts where to put
  // it, then saves immediately — so there's always a destination for imported/collected media.
  const handleNewProject = async () => {
      const res = await window.artlux?.newProjectFolder?.();
      if (!res) return; // user cancelled the folder dialog → keep the current project
      const st = makeNewProjectState();
      resetToNewProject(st);
      // Save from the fresh values directly — setState above hasn't applied to this closure yet.
      const data = { ...buildProjectData(), surfaces: st.surfaces, fixtures: st.fixtures, controllers: [], groups: [], scenes: [], projectorOutputs: [], assets: [] };
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

  // ---- Asset library ----
  // Import media of a type: copy into the project's assets/<cat>/ and add library entries.
  const handleImportAssets = async (type: AssetType) => {
      if (!currentProjectPath) { window.alert('Create a project folder first (File → New Project) to import media.'); return; }
      const entries = await window.artlux?.importAssets?.(currentProjectPath, type);
      if (entries && entries.length) setAssets(prev => [...prev, ...entries]);
  };
  // Remove a library entry. Recorded takes live on the timeline, so removing a take also drops it
  // from trackingTakes (and any clips referencing it). References to imported assets are left as-is.
  const handleRemoveAsset = (asset: AssetEntry) => {
      const usedTake = asset.type === 'take';
      const refs = surfaces.filter(s => (s.content as { url?: string })?.url === asset.path).length
          + timeline.clips.filter(c => c.path === asset.path).length
          + (scene3D.models ?? []).filter(m => m.path === asset.path).length;
      if (refs > 0 && !window.confirm(`"${asset.name}" is used in ${refs} place(s). Remove it from the library anyway?`)) return;
      if (usedTake) {
          setTimeline(t => ({ ...t, trackingTakes: (t.trackingTakes ?? []).filter(r => r.id !== asset.id), clips: t.clips.filter(c => c.takeId !== asset.id) }));
      } else {
          setAssets(prev => prev.filter(a => a.id !== asset.id));
      }
  };
  // Relink: pick a replacement file (copied into assets/) and rewrite this asset + every reference
  // at the old path to point at the new one.
  const handleRelinkAsset = async (asset: AssetEntry) => {
      if (!currentProjectPath) return;
      const picked = await window.artlux?.importAssets?.(currentProjectPath, asset.type);
      const next = picked && picked[0];
      if (!next) return;
      const oldPath = asset.path, newPath = next.path;
      if (asset.type === 'take') {
          setTimeline(t => ({
              ...t,
              trackingTakes: (t.trackingTakes ?? []).map(r => r.id === asset.id ? { ...r, path: newPath } : r),
              clips: t.clips.map(c => c.path === oldPath ? { ...c, path: newPath } : c),
          }));
      } else {
          setAssets(prev => prev.map(a => a.id === asset.id ? { ...a, path: newPath, size: next.size } : a));
          setSurfaces(prev => prev.map(s => ((s.content as { url?: string })?.url === oldPath ? { ...s, content: { ...s.content, url: newPath } } : s)));
          setTimeline(t => ({ ...t, clips: t.clips.map(c => c.path === oldPath ? { ...c, path: newPath } : c) }));
          setScene3D(s => ({ ...s, models: (s.models ?? []).map(m => m.path === oldPath ? { ...m, path: newPath } : m) }));
      }
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
          case 'broadcast': handleLaunchBroadcast(); break;
          case 'export-rig': handleExportRig(); break;
          case 'import-rig': handleImportRig(); break;
          case 'preferences': setPrefsOpen(true); break;
          case 'routing': setRoutingOpen(true); break;
          case 'about': setAboutOpen(true); break;
          case 'osc-monitor': setOscMonitorOpen(true); break;
          case 'help-panel': setShowHelp((v) => !v); break;
          case 'check-updates': setUpdateUserInitiated(true); window.artlux?.checkForUpdates?.(); break;
          case 'undo': undo(); break;
          case 'redo': redo(); break;
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

  // --- 3D Scene window bridge (MessagePort to the separate scene renderer) ---
  // Handle messages coming back from the scene window. Kept in a ref so the port's
  // onmessage (set once) always calls the latest closure.
  // Layer ids whose frames the Scene window wants streamed (its screen-planes' layers).
  const sceneLayersRef = useRef<string[]>([]);
  const onSceneMsgRef = useRef<(m: SceneToMain) => void>(() => {});
  onSceneMsgRef.current = (m: SceneToMain) => {
      if (m.t === 'ready') pushSceneState();
      else if (m.t === 'select') handleSelectFixture(m.id);
      else if (m.t === 'commit') handleCommitFixture3D(m.id, { position3D: m.position3D, rotation3D: m.rotation3D, scale3D: m.scale3D });
      else if (m.t === 'sceneConfig') setScene3D(s => ({ ...s, ...m.patch }));
      else if (m.t === 'sceneLayers') sceneLayersRef.current = m.layerIds;
      else if (m.t === 'calibPick') handleCalibPick(m.world);
      else if (m.t === 'save') handleSaveProject().then((path) => scenePortRef.current?.postMessage({ t: 'saved', ok: !!path }));
  };
  const pushSceneState = () => {
      scenePortRef.current?.postMessage({ t: 'state', fixtures, surfaces, selectedId: selectedFixtureId, scene3D });
      scenePortRef.current?.postMessage({ t: 'timeline', timeline });
  };
  useEffect(() => {
      const onMsg = (e: MessageEvent) => {
          if (e.data !== 'artlux:scene-port' || !e.ports[0]) return;
          const port = e.ports[0];
          scenePortRef.current = port;
          port.onmessage = (ev: MessageEvent) => onSceneMsgRef.current(ev.data as SceneToMain);
          port.start();
          pushSceneState();
      };
      window.addEventListener('message', onMsg);
      window.postMessage('artlux:scene-port-request', '*');
      return () => window.removeEventListener('message', onMsg);
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Push fresh state to the scene window whenever anything it renders changes.
  useEffect(() => {
      scenePortRef.current?.postMessage({ t: 'state', fixtures, surfaces, selectedId: selectedFixtureId, scene3D });
  }, [fixtures, surfaces, selectedFixtureId, scene3D]);
  // Push projector calibrations (for the frustum overlays) to the scene window when they change.
  useEffect(() => {
      scenePortRef.current?.postMessage({
          t: 'projectors',
          calibs: projectorOutputs.map(o => ({ surfaceId: o.surfaceId, calibration: o.calibration ?? null })),
      });
  }, [projectorOutputs]);
  // Forward the live per-LED pixel buffer to the scene window (~30 fps, copy + transfer).
  useEffect(() => {
      let last = 0;
      const unsub = dmxSignal.subscribe(({ pixels }) => {
          const port = scenePortRef.current;
          if (!port) return;
          const now = performance.now();
          if (now - last < 33) return;
          last = now;
          const copy = pixels.slice();
          port.postMessage({ t: 'pixels', buf: copy.buffer }, [copy.buffer]);
      });
      return () => unsub();
  }, []);

  // --- Timeline: feed the playback engine + bridge transport/data to the Scene window ---
  useEffect(() => {
      timelineEngine.setData(timeline);
      trackingPlayback.setData(timeline); // replay recorded blob takes when the playhead crosses them
      scenePortRef.current?.postMessage({ t: 'timeline', timeline });
      for (const port of projectorPortsRef.current.values()) port.postMessage({ t: 'timeline', timeline });
  }, [timeline]);
  // Start the tracking-take replay loop once (main window only; mirrors get snapshots via the bridge).
  useEffect(() => { trackingPlayback.start(); }, []);
  useEffect(() => { timelineEngine.setPlaying(isVideoPlaying); }, [isVideoPlaying]);
  // The FSM control layer drives transport by emitting intents; App turns them into React state so
  // App stays the single writer of `playing` (the setPlaying effect above then drives the engine).
  useEffect(() => timelineEngine.subscribeIntent((i) => {
      if (i.kind === 'play') setIsVideoPlaying(true);
      else if (i.kind === 'pause') setIsVideoPlaying(false);
      else if (i.kind === 'stop') { setIsVideoPlaying(false); timelineEngine.seek(0); }
      else if (i.kind === 'seek') timelineEngine.seek(i.sec);
      else if (i.kind === 'loop') setTimeline(t => ({ ...t, loop: i.loopOn }));
  }), []);
  // Scene/cue triggers requested by a source (FSM action, OSC) — resolve by id/name and apply.
  useEffect(() => {
    const u1 = cueBus.subscribeRecall((ref) => recallByRefRef.current(ref));
    const u2 = cueBus.subscribeFireCue((ref) => fireCueRef.current(ref));
    const u3 = cueBus.subscribeFireColumn((bankRef, col) => fireColumnRef.current(bankRef, col));
    return () => { u1(); u2(); u3(); };
  }, []);
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
  // Stream LiDAR blob snapshots to the 3D Scene window (up to ~60 fps — the payload is tiny, ≤10
  // blobs, and full-rate data tightens the scene's smoothing/prediction). OSC is received only here
  // in the main window, so the Scene window's tracking viz is fed over the bridge like transport.
  useEffect(() => {
      let last = 0;
      const unsub = trackingStore.subscribe(() => {
          const now = performance.now();
          if (now - last < 16) return;
          last = now;
          const scenePort = scenePortRef.current;
          // Only build the snapshot if someone consumes it (the Scene window, or a projector
          // showing TRACKING content).
          const trackingProjectors = [...projectorPortsRef.current].filter(([id]) =>
              surfacesRef.current.find(s => s.id === id)?.content.type === SourceType.TRACKING);
          if (!scenePort && trackingProjectors.length === 0) return;
          const raw = trackingStore.snapshot();
          // Merge the venue's ~2-blobs-per-person into single "people" for the viz + projector
          // outputs (off by default). The raw store + recorded takes stay untouched.
          const cfg = scene3DRef.current;
          const snap = cfg.trackingMergePeople ? clusterAndTrack(raw, cfg.trackingMergeRadius ?? 0.8, now) : raw;
          scenePort?.postMessage({ t: 'tracking', snap });
          for (const [, port] of trackingProjectors) port.postMessage({ t: 'tracking', snap });
      });
      return () => unsub();
  }, []);
  // Keep the main-window tracking renderer's smoothing/prediction in sync (stage preview).
  useEffect(() => {
      trackingDrawable.configure(scene3D.trackingSmoothing ?? 0.6, scene3D.trackingPredictMs ?? 50);
  }, [scene3D.trackingSmoothing, scene3D.trackingPredictMs]);
  // Drop temporal person tracks when merging is off so a re-enable starts with fresh person ids.
  useEffect(() => { if (!scene3D.trackingMergePeople) resetPeopleTracking(); }, [scene3D.trackingMergePeople]);
  // Stream transport (playing + playhead) to the Scene + projector windows ~30 fps so
  // their video/layer content stays in sync with the main clock.
  useEffect(() => {
      let last = 0;
      const unsub = timelineEngine.subscribe((playhead) => {
          const now = performance.now();
          if (now - last < 33) return;
          last = now;
          const msg = { t: 'transport' as const, playing: timelineEngine.isPlaying(), playhead };
          scenePortRef.current?.postMessage(msg);
          for (const port of projectorPortsRef.current.values()) port.postMessage(msg);
      });
      return () => unsub();
  }, []);

  // --- Projector output windows (per-surface fullscreen on a display) ---
  // Enumerate displays + track hot-plug.
  useEffect(() => {
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

  // Frame pump for every projector: this (main) renderer is the sole decoder, so transfer
  // each surface's drawable to its projector window as an ImageBitmap (~30 fps, zero-copy).
  // Live singular sources (camera/Spout/DMX-in/NDI) AND HW-decoded file video / timeline
  // layers all stream — only IMAGE / EFFECT self-render in the projector. Decoding the same
  // media in every window otherwise exhausts the GPU's concurrent hardware-decode sessions.
  useEffect(() => {
      const STREAMED = new Set<SourceType | 'EFFECT'>([SourceType.CAMERA, SourceType.SPOUT, SourceType.DMX_IN, SourceType.NDI, SourceType.VIDEO, SourceType.LAYER]);
      const inFlight = new Set<string>(); // surfaceIds with a createImageBitmap still pending
      let raf = 0; let last = 0;
      const tick = (now: number) => {
          raf = requestAnimationFrame(tick);
          if (now - last < 33) return;
          last = now;
          for (const [surfaceId, port] of projectorPortsRef.current) {
              const surface = surfacesRef.current.find(s => s.id === surfaceId);
              if (!surface) continue;
              // TRACKING self-renders its blobs in the projector, but its optional background
              // timeline layer (a video) must be decoded here and streamed as a layer frame.
              if (surface.content.type === SourceType.TRACKING) {
                  const layerId = surface.content.bgLayerId;
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
              if (!STREAMED.has(surface.content.type)) continue;
              const drawable = getDrawable(surface);
              if (!drawable) continue;
              inFlight.add(surfaceId);
              createImageBitmap(drawable as CanvasImageSource)
                  .then(bitmap => { try { port.postMessage({ t: 'frame', bitmap }, [bitmap]); } catch { bitmap.close(); } })
                  .catch(() => {})
                  .finally(() => inFlight.delete(surfaceId));
          }
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
  }, []);

  // Frame pump for the 3D Scene window's screen-planes: the Scene reports which timeline
  // layers its planes show (sceneLayersRef); decode them once here and stream each as a
  // downscaled ImageBitmap (the planes are small on-screen, so native res is wasteful).
  // flipY because the Scene draws the bitmap through a plain THREE.Texture (which, unlike
  // VideoTexture, can't flip an ImageBitmap) onto a plane.
  useEffect(() => {
      const SCENE_W = 640, SCENE_H = 360;
      const inFlight = new Set<string>(); // layerIds with a createImageBitmap still pending
      let raf = 0; let last = 0;
      const tick = (now: number) => {
          raf = requestAnimationFrame(tick);
          if (now - last < 33) return;
          last = now;
          const port = scenePortRef.current;
          if (!port) return;
          for (const layerId of sceneLayersRef.current) {
              if (inFlight.has(layerId)) continue; // back-pressure: don't pile up decodes
              const drawable = timelineEngine.getLayerDrawable(layerId);
              if (!drawable) continue;
              inFlight.add(layerId);
              createImageBitmap(drawable as CanvasImageSource, { resizeWidth: SCENE_W, resizeHeight: SCENE_H, resizeQuality: 'low', imageOrientation: 'flipY' })
                  .then(bitmap => { try { port.postMessage({ t: 'frame', layerId, bitmap }, [bitmap]); } catch { bitmap.close(); } })
                  .catch(() => {})
                  .finally(() => inFlight.delete(layerId));
          }
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
  }, []);

  // Push the current config (surface + corner-pin + transport) to one projector window.
  const pushProjectorStateRef = useRef<(surfaceId: string) => void>(() => {});
  pushProjectorStateRef.current = (surfaceId: string) => {
      const port = projectorPortsRef.current.get(surfaceId);
      const surface = surfaces.find(s => s.id === surfaceId);
      if (!port || !surface) return;
      const out = projectorOutputs.find(o => o.surfaceId === surfaceId);
      port.postMessage({
          t: 'config', surface, playing: isVideoPlaying,
          render: {
              cornerPin: out?.cornerPin ?? defaultCornerPin(),
              warp: out?.warp ?? null,
              softEdge: out?.softEdge ?? defaultSoftEdge(),
              gamma: out?.gamma ?? 1,
              brightness: projectorBrightness,
              fpsCap: projectorFpsCap,
              ndiSend: out?.ndiSend ?? false,
              ndiFullRes: BROADCAST,
              trackingSmoothing: scene3D.trackingSmoothing ?? 0.6,
              trackingPredictMs: scene3D.trackingPredictMs ?? 50,
          },
      });
      port.postMessage({ t: 'timeline', timeline });
      port.postMessage({ t: 'edit', on: editingOutputId === surfaceId });
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
      else if (m.t === 'editOff') setEditingOutputId(prev => prev === surfaceId ? null : prev);
      else if (m.t === 'patternShown') {
        const ack = { index: m.index, projW: m.projW, projH: m.projH };
        calibController.onPatternShown(ack); // board flow
        slCapture.onPatternShown(ack);       // markerless flow (inactive one is a no-op)
      }
      else if (m.t === 'calibCrosshair') latestCrosshairRef.current = m.pixel;
      else if (m.t === 'calibConfirm') pendingPixelRef.current = latestCrosshairRef.current;
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
      return () => window.removeEventListener('message', onMsg);
  }, []);
  // Re-push config (incl. the edit toggle) whenever anything a projector renders changes.
  useEffect(() => {
      for (const surfaceId of projectorPortsRef.current.keys()) pushProjectorStateRef.current(surfaceId);
  }, [surfaces, projectorOutputs, timeline, isVideoPlaying, editingOutputId, projectorFpsCap, projectorBrightness, scene3D, calibratingOutputId]);
  // Live projector-brightness push (no full config re-send) — drives slider drag render-free.
  const pushProjectorBrightnessRef = useRef<(v: number) => void>(() => {});
  pushProjectorBrightnessRef.current = (v: number) => {
      for (const port of projectorPortsRef.current.values()) port.postMessage({ t: 'brightness', value: v });
  };
  // Stop aligning if the edited output is disabled / removed.
  useEffect(() => {
      if (editingOutputId && !projectorOutputs.some(o => o.surfaceId === editingOutputId && o.enabled && o.displayId != null)) {
          setEditingOutputId(null);
      }
  }, [editingOutputId, projectorOutputs]);

  // Reconcile desired outputs (enabled + valid display + surface exists) with open windows.
  useEffect(() => {
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
      const desired = new Map<string, string>(); // surfaceId -> NDI source name
      for (const o of projectorOutputs) {
          const surface = surfaces.find(s => s.id === o.surfaceId);
          const live = o.enabled && o.displayId != null && surface && displays.some(d => d.id === o.displayId);
          if (live && o.ndiSend) desired.set(o.surfaceId, `ArtLux — ${surface!.name}`);
      }
      for (const [surfaceId, name] of desired) {
          if (!ndiSendersRef.current.has(surfaceId)) {
              window.artlux?.configureNdiSend?.({ outputId: surfaceId, enabled: true, name });
              ndiSendersRef.current.add(surfaceId);
          }
      }
      for (const surfaceId of [...ndiSendersRef.current]) {
          if (!desired.has(surfaceId)) {
              window.artlux?.configureNdiSend?.({ outputId: surfaceId, enabled: false });
              ndiSendersRef.current.delete(surfaceId);
          }
      }
  }, [surfaces, projectorOutputs, displays]);

  // Broadcast mode: load the project (--project= or last-opened) and let the projector
  // reconciler open the saved enabled outputs; Art-Net starts via the normal output effects.
  useEffect(() => {
      if (!BROADCAST) return;
      (async () => {
          const prefs = await window.artlux?.getPrefs?.();
          const path = QUERY_PROJECT || prefs?.lastProjectPath;
          if (!path) { console.warn('[broadcast] no project to load'); return; }
          const data = await window.artlux?.loadProjectPath?.(path);
          if (data) { applyProjectData(data); setCurrentProjectPath(path); }
          console.log(`[broadcast] loaded project: ${path}`);
      })();
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore persisted prefs (settings + master brightness + recents + last project) on launch.
  useEffect(() => {
      if (BROADCAST) return; // broadcast owns project loading (above)
      (async () => {
          const prefs = await window.artlux?.getPrefs?.();
          if (!prefs) return;
          if (prefs.appSettings) setSettings(s => ({ ...s, ...(prefs.appSettings as Partial<AppSettings>) }));
          if (typeof prefs.globalBrightness === 'number') setGlobalBrightness(prefs.globalBrightness);
          setRecentFiles(prefs.recentFiles ?? []);
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
  ];

  // Broadcast (show) mode: no editor chrome — render only the offscreen Stage engine. All the
  // output/projector effects above still run, so Art-Net flows and the saved outputs open.
  if (BROADCAST) {
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
                onOpenScene={() => window.artlux?.openSceneWindow?.()}
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
        <div className={`h-full border-r border-line-1 bg-surface-1 transition-all duration-200 ${showLeftPanel ? 'w-72' : 'w-0 overflow-hidden border-none'}`}>
            <div className="w-72 h-full flex flex-col overflow-hidden">
              <div className="flex shrink-0 border-b border-line-1 bg-surface-2">
                {(['scene', 'media'] as const).map(t => (
                  <button key={t} onClick={() => setLeftTab(t)}
                    className={`flex-1 h-7 text-[11px] font-medium capitalize ${leftTab === t ? 'text-fg-1 border-b-2 border-accent' : 'text-fg-3 hover:text-fg-1'}`}>{t}</button>
                ))}
              </div>
              <div className="flex-1 min-h-0">
                {leftTab === 'media' ? (
                  <MediaPanel
                    assets={assets} timeline={timeline} surfaces={surfaces} scene3D={scene3D}
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
                    onMasterBrightnessChange={setGlobalBrightness}
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
                            <button
                                onClick={() => setSplitView(v => !v)}
                                title={splitView ? 'Hide 3D scene' : 'Show 3D scene (split view)'}
                                aria-label="Toggle 3D split view"
                                aria-pressed={splitView}
                                className={`p-1.5 rounded-[var(--r-sm)] border transition-colors ${splitView ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2/80 backdrop-blur-sm border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1'}`}
                            >
                                <Columns2 size={14} />
                            </button>
                        }
                    />
                </div>
                {/* Right: embedded 3D scene (or camera preview during calibration) */}
                {splitView && (
                    <>
                        <div onPointerDown={startSplitDrag} className="w-1 shrink-0 bg-line-1 hover:bg-accent cursor-col-resize" />
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
                                onCalibPick={handleCalibPick}
                                projectorCalibs={projectorOutputs.filter(o => o.calibration?.poseRms != null).map(o => ({ surfaceId: o.surfaceId, calibration: o.calibration! }))}
                                activePicks={(projectorOutputs.find(o => o.surfaceId === calibratingOutputId)?.calibration?.posePicks ?? []).map(p => ({ world: p.world }))}
                            />
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
                ) : dockTab === DockTab.TIMELINE ? (
                    // Render the timeline in exactly one place (dock XOR fullscreen overlay) so its
                    // keyboard hook + engine subscription aren't doubled.
                    timelineMax ? (
                        <div className="h-full flex items-center justify-center text-fg-3 text-[11px] italic">Timeline maximized — press F or the restore button to dock it</div>
                    ) : (
                        <TimelinePanel timeline={timeline} onChange={setTimeline} playing={isVideoPlaying} onTogglePlay={() => setIsVideoPlaying(!isVideoPlaying)} onToggleMax={() => setTimelineMax(true)} projectPath={currentProjectPath} scenes={scenes} cues={cueBanks.flatMap(b => b.cues.map(c => ({ id: c.id, name: c.name })))} />
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
                        onFireCue={(cue) => applyCues([cue])}
                        onFireColumn={fireColumn}
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
        <div className={`h-full border-l border-line-1 bg-surface-1 transition-all duration-200 ${showRightPanel ? 'w-80' : 'w-0 overflow-hidden border-none'}`}>
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
      />

      <Preferences open={prefsOpen} onClose={() => setPrefsOpen(false)} settings={settings} onChange={updateSettings} />
      <About open={aboutOpen} onClose={() => setAboutOpen(false)} info={appInfo} />
      <OscMonitor open={oscMonitorOpen} onClose={() => setOscMonitorOpen(false)} settings={settings} />

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
          editingOutputId={editingOutputId}
          fpsCap={projectorFpsCap}
          onSetEnabled={handleSetOutputEnabled}
          onSetDisplay={handleSetOutputDisplay}
          onToggleEdit={handleToggleEditOutput}
          onResetCorners={handleResetCorners}
          onToggleWarp={handleToggleWarp}
          onSetSoftEdge={handleSetSoftEdge}
          onSetGamma={handleSetOutputGamma}
          onToggleNdiSend={handleToggleNdiSend}
          onSetFpsCap={setProjectorFpsCap}
          onRefreshDisplays={refreshDisplays}
          onCalibrate={(surfaceId) => setCalibratingOutputId(surfaceId)}
          onSetUseCalibration={(surfaceId, on) => upsertOutput(surfaceId, { useCalibration: on })}
      />
      {calibratingOutputId && (() => {
        const co = projectorOutputs.find(o => o.surfaceId === calibratingOutputId);
        const calibLive = !!co?.enabled && co.displayId != null && (co.displayId === WINDOWED_DISPLAY || displays.some(d => d.id === co.displayId));
        const hasModel = (scene3D.models ?? []).some(m => m.kind !== 'plane' && m.visible);
        const closeCalib = () => { setCalibratingOutputId(null); setCalibPickMode(false); markerlessPickRef.current = null; setCalibFlow('board'); };
        return calibFlow === 'auto' ? (
          <AutoAlignWizard
            surfaceId={calibratingOutputId}
            surfaceName={surfaces.find(s => s.id === calibratingOutputId)?.name ?? 'Output'}
            output={co}
            scene3D={scene3D}
            live={calibLive}
            hasModel={hasModel}
            sendToProjector={sendToProjector}
            onStoreCalibration={handleStoreCalibration}
            onSetUseCalibration={(sid, on) => upsertOutput(sid, { useCalibration: on })}
            onSetCalibPickMode={setCalibPickMode}
            onSetSplit={setSplitView}
            onRegisterMarkerlessPick={(cb) => { markerlessPickRef.current = cb; }}
            onSwitchFlow={setCalibFlow}
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
            sendToProjector={sendToProjector}
            onStoreCalibration={handleStoreCalibration}
            onPoseModeChange={handlePoseModeChange}
            onClearPoses={handleClearPoses}
            onSetUseCalibration={(sid, on) => upsertOutput(sid, { useCalibration: on })}
            onSetCalibPickMode={setCalibPickMode}
            onSetSplit={setSplitView}
            onSwitchFlow={setCalibFlow}
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
          onUpdateFixture={handleUpdateFixture}
          onAddController={handleAddController}
          onUpdateController={handleUpdateController}
          onRemoveController={handleRemoveController}
          onAutoPatch={handleAutoPatch}
      />

      {timelineMax && (
        <div className="fixed inset-0 z-50 bg-surface-0 flex flex-col">
          <TimelinePanel timeline={timeline} onChange={setTimeline} playing={isVideoPlaying} onTogglePlay={() => setIsVideoPlaying(!isVideoPlaying)} maximized onToggleMax={() => setTimelineMax(false)} projectPath={currentProjectPath} scenes={scenes} cues={cueBanks.flatMap(b => b.cues.map(c => ({ id: c.id, name: c.name })))} />
        </div>
      )}

      <AssetManager
        open={assetManagerOpen} onClose={() => setAssetManagerOpen(false)}
        assets={assets} timeline={timeline} surfaces={surfaces} scene3D={scene3D}
        selectedSurfaceId={selectedSurfaceId} hasProjectFolder={!!currentProjectPath}
        onImport={handleImportAssets} onRemoveAsset={handleRemoveAsset} onRelinkAsset={handleRelinkAsset}
        onUseOnSurface={handleUseAssetOnSurface} onSelectSurface={handleSelectSurface}
        onConsolidate={handleCollectAssets}
      />
    </div>
  );
};

export default App;