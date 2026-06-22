import React, { useState, useEffect, useRef } from 'react';
import { Fixture, Surface, SourceType, AppSettings, Module, DockTab, FixtureGroup, Scene } from './types';
import type { AppInfo } from '../../shared/protocol';
import { TopBar } from './components/TopBar';
import { About } from './components/About';
import { InspectorPanel } from './components/InspectorPanel';
import { ScenePanel } from './components/ScenePanel';
import { Stage } from './components/Stage';
import { DMXMonitor } from './components/DMXMonitor';
import { FixtureEditor } from './components/FixtureEditor';
import { Dock } from './components/Dock';
import { Preferences } from './components/Preferences';
import { StatusBar } from './components/StatusBar';
import { sendArtNetFrame, configureOutput, addStatusListener } from './services/mockSocketService';
import { dmxSignal } from './services/dmxSignal';
import { Activity, SlidersHorizontal } from 'lucide-react';
import { useHistory } from './hooks/useHistory';

const Simulator3D = React.lazy(() => import('./components/Simulator3D/Simulator3D'));

const generateId = () => Math.random().toString(36).substr(2, 9);

const DEFAULT_SETTINGS: AppSettings = {
  artNetIp: '127.0.0.1',
  artNetPort: 6454,
  outputEnabled: true,
  broadcast: false,
  gamma: 1.0,
  protocol: 'artnet',
  fps: 44,
  keepAlive: true,
  artNetSync: false
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
      colorData: []
    }
  ]);
  
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>('fix-1');
  const [surfaces, setSurfaces] = useState<Surface[]>([
    { id: 'surf-1', name: 'Surface 1', x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 0, content: { type: SourceType.NONE } },
  ]);
  const [selectedSurfaceId, setSelectedSurfaceId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isVideoPlaying, setIsVideoPlaying] = useState(true);
  const [globalBrightness, setGlobalBrightness] = useState(1.0);
  const [groups, setGroups] = useState<FixtureGroup[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [module, setModule] = useState<Module>(Module.MAP);
  const [dockOpen, setDockOpen] = useState(false);
  const [dockTab, setDockTab] = useState<DockTab>(DockTab.MONITOR);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  const [showLeftPanel, setShowLeftPanel] = useState(true);
  
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
  const handleSelectSurface = (id: string | null) => { setSelectedSurfaceId(id); if (id) setSelectedFixtureId(null); };
  const handleSelectFixture = (id: string | null) => { setSelectedFixtureId(id); if (id) setSelectedSurfaceId(null); };
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
  const handleRemoveSurface = (id: string) => {
    setSurfaces(surfaces.filter(s => s.id !== id));
    if (selectedSurfaceId === id) setSelectedSurfaceId(null);
  };
  const handleUpdateSurface = (id: string, patch: Partial<Surface>) => {
    setSurfaces(surfaces.map(s => s.id === id ? { ...s, ...patch } : s));
  };
  const handleRenameSurface = (id: string, name: string) => handleUpdateSurface(id, { name });

  const handleAddFixture = () => {
    recordHistory();
    const newId = generateId();
    setFixtures([
      ...fixtures,
      {
        id: newId,
        name: `Fixture ${fixtures.length + 1}`,
        x: 0.4, y: 0.4, width: 0.2, height: 0.2,
        universe: 0, startAddress: 1, ledCount: 30, reverse: false, rotation: 0,
        colorData: []
      }
    ]);
    handleSelectFixture(newId);
  };

  const handleRemoveFixture = (id: string) => {
    recordHistory();
    setFixtures(fixtures.filter(f => f.id !== id));
    if (selectedFixtureId === id) setSelectedFixtureId(null);
  };

  const handleUpdateFixture = (id: string, updates: Partial<Fixture>) => {
    recordHistory();
    setFixtures(fixtures.map(f => f.id === id ? { ...f, ...updates } : f));
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
    const ids = selectedFixtureId ? [selectedFixtureId] : [];
    setGroups([...groups, { id: generateId(), name: `Group ${groups.length + 1}`, fixtureIds: ids }]);
  };
  const handleAddSelectedToGroup = (groupId: string) => {
    if (!selectedFixtureId) return;
    setGroups(groups.map(g => g.id === groupId && !g.fixtureIds.includes(selectedFixtureId)
      ? { ...g, fixtureIds: [...g.fixtureIds, selectedFixtureId] } : g));
  };
  const handleRemoveGroup = (groupId: string) => setGroups(groups.filter(g => g.id !== groupId));
  const handleSelectGroup = (group: FixtureGroup) => {
    if (group.fixtureIds.length) setSelectedFixtureId(group.fixtureIds[0]);
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

  // --- Scenes (snapshots) ---
  const handleCaptureScene = () => {
    const snapshot = fixtures.map(f => ({ ...f, colorData: [] }));
    setScenes([...scenes, { id: generateId(), name: `Scene ${scenes.length + 1}`, fixtures: snapshot, globalBrightness }]);
  };
  const handleRecallScene = (scene: Scene) => {
    recordHistory();
    setFixtures(scene.fixtures.map(f => ({ ...f, colorData: [] })));
    setGlobalBrightness(scene.globalBrightness);
  };
  const handleRemoveScene = (id: string) => setScenes(scenes.filter(s => s.id !== id));

  const defaultSurfaces = (): Surface[] => ([
    { id: generateId(), name: 'Surface 1', x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 0, content: { type: SourceType.NONE } },
  ]);

  const buildProjectData = () => ({
      version: '1.0',
      timestamp: new Date().toISOString(),
      surfaces,
      fixtures,
      settings,
      globalBrightness,
      groups,
      scenes,
  });

  // Apply a loaded project (or rig-free project) to app state. Strips live colorData.
  const applyProjectData = (data: any) => {
      if (data?.fixtures && Array.isArray(data.fixtures)) {
          recordHistory();
          setFixtures(data.fixtures.map((f: any) => ({ ...f, colorData: [] })));
      }
      // Surfaces: use the saved ones, or fall back to a default full-stage surface
      // (back-compat with pre-surfaces projects).
      setSurfaces(Array.isArray(data?.surfaces) && data.surfaces.length ? data.surfaces : defaultSurfaces());
      if (data?.settings) setSettings(prev => ({ ...prev, ...data.settings }));
      if (typeof data?.globalBrightness === 'number') setGlobalBrightness(data.globalBrightness);
      setGroups(Array.isArray(data?.groups) ? data.groups : []);
      setScenes(Array.isArray(data?.scenes) ? data.scenes : []);
      setSelectedFixtureId(null);
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

  const handleNewProject = () => {
      recordHistory();
      setFixtures([{
          id: generateId(), name: 'Fixture 1',
          x: 0.15, y: 0.15, width: 0.7, height: 0.1,
          universe: 0, startAddress: 1, ledCount: 60, reverse: false, rotation: 0, colorData: [],
      }]);
      setSurfaces(defaultSurfaces());
      setGroups([]);
      setScenes([]);
      setSelectedFixtureId(null);
      setSelectedSurfaceId(null);
      setCurrentProjectPath(null);
  };

  // App info for the About modal.
  useEffect(() => { window.artlux?.getAppInfo?.().then((i) => setAppInfo(i ?? null)); }, []);

  // Native-menu commands → existing handlers. A ref keeps the latest closures so
  // the listener can be registered exactly once.
  const dispatchMenu = (action: string) => {
      if (action.startsWith('open-recent:')) { handleOpenRecent(action.slice('open-recent:'.length)); return; }
      switch (action) {
          case 'new': handleNewProject(); break;
          case 'open': handleOpenProject(); break;
          case 'save': handleSaveProject(); break;
          case 'save-as': handleSaveAs(); break;
          case 'export-rig': handleExportRig(); break;
          case 'import-rig': handleImportRig(); break;
          case 'preferences': setPrefsOpen(true); break;
          case 'about': setAboutOpen(true); break;
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

  // Restore persisted prefs (settings + master brightness + recents + last project) on launch.
  useEffect(() => {
      (async () => {
          const prefs = await window.artlux?.getPrefs?.();
          if (!prefs) return;
          if (prefs.appSettings) setSettings(s => ({ ...s, ...(prefs.appSettings as Partial<AppSettings>) }));
          if (typeof prefs.globalBrightness === 'number') setGlobalBrightness(prefs.globalBrightness);
          setRecentFiles(prefs.recentFiles ?? []);
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

  const moduleHelp: Record<Module, string> = {
    [Module.MEDIA]: 'Media — choose a content source (video, image, camera, or DMX in).',
    [Module.MAP]: 'Map — drag fixtures over the content on the stage.',
    [Module.FIXTURES]: 'Fixtures — patch DMX: universe, address, color order, segments, routing.',
    [Module.THREE_D]: '3D — arrange fixtures in space; drag the gizmo to move/rotate.',
  };

  const dockTabs = [
    { id: DockTab.MONITOR, label: 'DMX Monitor', icon: <Activity size={13} /> },
    { id: DockTab.FIXTURE_EDITOR, label: 'Fixture Editor', icon: <SlidersHorizontal size={13} /> },
  ];

  return (
    <div className="flex flex-col h-screen w-screen bg-stage text-fg-1 font-sans overflow-hidden">
      <TopBar
          isVideoPlaying={isVideoPlaying}
          onTogglePlay={() => setIsVideoPlaying(!isVideoPlaying)}
          canPlay={surfaces.some(s => s.content.type === SourceType.VIDEO || s.content.type === SourceType.CAMERA)}
          module={module}
          onChangeModule={setModule}
          onSaveProject={handleSaveProject}
          onSaveAs={handleSaveAs}
          onOpenProject={handleOpenProject}
          recentFiles={recentFiles}
          onOpenRecent={handleOpenRecent}
          onExportRig={handleExportRig}
          onImportRig={handleImportRig}
          onUndo={undo}
          onRedo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
          onOpenPreferences={() => setPrefsOpen(true)}
          monitorOpen={dockOpen && dockTab === DockTab.MONITOR}
          onToggleMonitor={() => {
            if (dockOpen && dockTab === DockTab.MONITOR) setDockOpen(false);
            else { setDockTab(DockTab.MONITOR); setDockOpen(true); }
          }}
      />

      <div className="flex flex-1 min-h-0">
        {/* Left: browser (top) + inspector (bottom) */}
        <div className={`h-full border-r border-line-1 bg-surface-1 transition-all duration-200 ${showLeftPanel ? 'w-72' : 'w-0 overflow-hidden border-none'}`}>
            <div className="w-72 h-full flex flex-col min-h-0">
                <div className="h-[45%] min-h-0 overflow-y-auto border-b border-line-1">
                    <ScenePanel
                        surfaces={surfaces}
                        selectedSurfaceId={selectedSurfaceId}
                        onSelectSurface={handleSelectSurface}
                        onAddSurface={handleAddSurface}
                        onRemoveSurface={handleRemoveSurface}
                        onRenameSurface={handleRenameSurface}
                        fixtures={fixtures}
                        selectedFixtureId={selectedFixtureId}
                        onSelect={handleSelectFixture}
                        onAdd={handleAddFixture}
                        onRemove={handleRemoveFixture}
                        onRename={handleRenameFixture}
                        masterBrightness={globalBrightness}
                        onMasterBrightnessChange={setGlobalBrightness}
                        groups={groups}
                        scenes={scenes}
                        onCreateGroup={handleCreateGroup}
                        onAddSelectedToGroup={handleAddSelectedToGroup}
                        onRemoveGroup={handleRemoveGroup}
                        onSelectGroup={handleSelectGroup}
                        onApplyLookToGroup={handleApplyLookToGroup}
                        onCaptureScene={handleCaptureScene}
                        onRecallScene={handleRecallScene}
                        onRemoveScene={handleRemoveScene}
                    />
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto">
                    <InspectorPanel
                        module={module}
                        selectedSurface={selectedSurface}
                        onUpdateSurface={handleUpdateSurface}
                        selectedFixture={selectedFixture}
                        onUpdateFixture={handleUpdateFixture}
                        settings={settings}
                    />
                </div>
            </div>
        </div>

        {/* Center: persistent stage host + bottom dock */}
        <div className="flex-1 min-w-0 flex flex-col bg-surface-0">
            <div className="flex-1 min-h-0 relative">
                {/* 2D stage (Media/Map/Fixtures) — kept mounted so dmxSignal keeps flowing */}
                <div className={`absolute inset-0 ${module === Module.THREE_D ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
                    <Stage
                        surfaces={surfaces}
                        fixtures={fixtures}
                        onUpdateFixtures={setFixtures}
                        selectedFixtureId={selectedFixtureId}
                        onSelectFixture={handleSelectFixture}
                        isEngineRunning={true}
                        isVideoPlaying={isVideoPlaying}
                        globalBrightness={globalBrightness}
                        gamma={settings.gamma}
                        targetIp={settings.artNetIp}
                        broadcast={settings.broadcast}
                        protocol={settings.protocol}
                        onRecordHistory={recordHistory}
                    />
                </div>
                {/* 3D simulator */}
                <div className={`absolute inset-0 ${module === Module.THREE_D ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                    {module === Module.THREE_D && (
                        <React.Suspense fallback={<div className="w-full h-full flex items-center justify-center text-fg-3 text-xs">Loading 3D…</div>}>
                            <Simulator3D
                                fixtures={fixtures}
                                selectedFixtureId={selectedFixtureId}
                                onSelectFixture={setSelectedFixtureId}
                                onCommitFixture3D={handleCommitFixture3D}
                                onRecordHistory={recordHistory}
                            />
                        </React.Suspense>
                    )}
                </div>
            </div>

            <Dock
                open={dockOpen}
                onToggle={() => setDockOpen(!dockOpen)}
                tabs={dockTabs}
                activeTab={dockTab}
                onTab={(id) => setDockTab(id as DockTab)}
            >
                {dockTab === DockTab.MONITOR
                    ? <DMXMonitor fixtures={fixtures} />
                    : <FixtureEditor fixture={selectedFixture} onUpdateFixture={handleUpdateFixture} />}
            </Dock>
        </div>
      </div>

      <StatusBar
          help={moduleHelp[module]}
          renderFps={fps}
          connected={isBridgeConnected}
          outputStats={outputStats}
          leftOpen={showLeftPanel}
          onToggleLeft={() => setShowLeftPanel(!showLeftPanel)}
          targetIp={settings.artNetIp}
      />

      <Preferences open={prefsOpen} onClose={() => setPrefsOpen(false)} settings={settings} onChange={updateSettings} />
      <About open={aboutOpen} onClose={() => setAboutOpen(false)} info={appInfo} />
    </div>
  );
};

export default App;