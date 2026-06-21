import React, { useState, useEffect } from 'react';
import { Fixture, SourceType, AppSettings, ViewMode, FixtureGroup, Scene } from './types';
import { TopBar } from './components/TopBar';
import { InspectorPanel } from './components/InspectorPanel';
import { ScenePanel } from './components/ScenePanel';
import { Stage } from './components/Stage';
import { DMXMonitor } from './components/DMXMonitor';
import { sendArtNetFrame, configureOutput, addStatusListener } from './services/mockSocketService';
import { dmxSignal } from './services/dmxSignal';
import { PanelLeft, PanelRight, Activity, Wifi } from 'lucide-react';
import { useHistory } from './hooks/useHistory';

const Simulator3D = React.lazy(() => import('./components/Simulator3D/Simulator3D'));

const generateId = () => Math.random().toString(36).substr(2, 9);

const DEFAULT_SETTINGS: AppSettings = {
  artNetIp: '127.0.0.1',
  artNetPort: 6454,
  outputEnabled: true,
  broadcast: false,
  gamma: 1.0,
  protocol: 'artnet'
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
  const [sourceType, setSourceType] = useState<SourceType>(SourceType.NONE);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isVideoPlaying, setIsVideoPlaying] = useState(true);
  const [globalBrightness, setGlobalBrightness] = useState(1.0);
  const [groups, setGroups] = useState<FixtureGroup[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [currentView, setCurrentView] = useState<ViewMode>(ViewMode.MAPPING);
  
  const [showLeftPanel, setShowLeftPanel] = useState(true);
  const [showRightPanel, setShowRightPanel] = useState(true);
  
  const [isBridgeConnected, setIsBridgeConnected] = useState(false);
  const [fps, setFps] = useState(0);
  const frameCount = React.useRef(0);
  const lastTime = React.useRef(performance.now());

  useEffect(() => {
    const unsubscribe = addStatusListener((status) => {
        setIsBridgeConnected(status);
    });
    return () => {
        unsubscribe();
    };
  }, []);

  // Push output settings to the native transport whenever they change.
  useEffect(() => {
    configureOutput(settings);
  }, [settings.outputEnabled, settings.broadcast, settings.artNetIp, settings.artNetPort]);

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
    setSelectedFixtureId(newId);
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

  const handleSaveProject = () => {
    const projectData = {
        version: '1.0',
        timestamp: new Date().toISOString(),
        fixtures,
        settings,
        globalBrightness,
        groups,
        scenes
    };
    const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `artlux-project-${new Date().getTime()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleLoadProject = (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
          try {
              const content = e.target?.result as string;
              const data = JSON.parse(content);
              if (data.fixtures && Array.isArray(data.fixtures)) {
                  recordHistory();
                  const cleanFixtures = data.fixtures.map((f: any) => ({ ...f, colorData: [] }));
                  setFixtures(cleanFixtures);
              }
              if (data.settings) setSettings(prev => ({ ...prev, ...data.settings }));
              if (typeof data.globalBrightness === 'number') setGlobalBrightness(data.globalBrightness);
              setGroups(Array.isArray(data.groups) ? data.groups : []);
              setScenes(Array.isArray(data.scenes) ? data.scenes : []);
              setSelectedFixtureId(null);
          } catch (err) {
              console.error("Failed to parse project file", err);
              alert("Error loading project file.");
          }
      };
      reader.readAsText(file);
  };

  const selectedFixture = fixtures.find(f => f.id === selectedFixtureId) || null;

  return (
    <div className="flex flex-col h-screen w-screen bg-black text-slate-200 font-sans overflow-hidden">
      <TopBar 
          isVideoPlaying={isVideoPlaying}
          onTogglePlay={() => setIsVideoPlaying(!isVideoPlaying)}
          currentView={currentView}
          onChangeView={setCurrentView}
          onSaveProject={handleSaveProject}
          onLoadProject={handleLoadProject}
          onUndo={undo}
          onRedo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
      />

      <div className="flex flex-1 overflow-hidden relative">
        <div className={`absolute inset-0 flex transition-opacity duration-300 ${currentView === ViewMode.MAPPING ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
            <div className={`h-full transition-all duration-300 ease-in-out border-r border-[#222] bg-[#121212] overflow-hidden ${showLeftPanel ? 'w-64 opacity-100' : 'w-0 opacity-0 border-none'}`}>
                <div className="w-64 h-full">
                    <InspectorPanel 
                        sourceType={sourceType}
                        onSetSource={(type, url) => { setSourceType(type); setSourceUrl(url); setIsVideoPlaying(true); }}
                        selectedFixture={selectedFixture}
                        onUpdateFixture={handleUpdateFixture}
                        settings={settings}
                        onUpdateSettings={setSettings}
                    />
                </div>
            </div>

            <div className="flex-1 bg-[#050505] relative flex flex-col items-center justify-center min-w-0">
                <div className="absolute top-0 w-full h-6 bg-[#0a0a0a] border-b border-[#222] flex items-center px-2 text-[10px] text-gray-600 font-mono z-50">
                    VIEWPORT: 512x512 (UV 1:1)
                </div>
                <Stage 
                    sourceType={sourceType}
                    sourceUrl={sourceUrl}
                    fixtures={fixtures}
                    onUpdateFixtures={setFixtures}
                    selectedFixtureId={selectedFixtureId}
                    onSelectFixture={setSelectedFixtureId}
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

            <div className={`h-full transition-all duration-300 ease-in-out border-l border-[#222] bg-[#121212] overflow-hidden ${showRightPanel ? 'w-64 opacity-100' : 'w-0 opacity-0 border-none'}`}>
                <div className="w-64 h-full">
                    <ScenePanel 
                        fixtures={fixtures}
                        selectedFixtureId={selectedFixtureId}
                        onSelect={setSelectedFixtureId}
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
            </div>
        </div>

        <div className={`absolute inset-0 flex transition-opacity duration-300 ${currentView === ViewMode.MONITORING ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
            <DMXMonitor fixtures={fixtures} />
        </div>

        <div className={`absolute inset-0 ${currentView === ViewMode.SIMULATOR_3D ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
            {currentView === ViewMode.SIMULATOR_3D && (
                <React.Suspense fallback={<div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">Loading 3D…</div>}>
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

      <div className="h-7 bg-[#121212] border-t border-[#222] flex items-center justify-between px-3 text-xs text-gray-500 select-none z-50">
          <button 
             onClick={() => setShowLeftPanel(!showLeftPanel)}
             className={`flex items-center gap-2 hover:text-gray-300 transition-colors ${showLeftPanel ? 'text-accent' : ''}`}
          >
             <PanelLeft size={14} />
             <span className="text-[10px] uppercase font-bold tracking-wider">Inspector</span>
          </button>

          <div className="flex items-center gap-4">
               <div className="flex items-center gap-1.5" title="Render FPS">
                    <Activity size={12} className="text-green-500" />
                    <span className="font-mono">{fps.toFixed(0)} FPS</span>
                </div>
                <div className="h-3 w-px bg-[#333]"></div>
                <div className="flex items-center gap-1.5" title={`Target: ${settings.artNetIp}`}>
                    <Wifi size={12} className={isBridgeConnected ? "text-accent" : "text-gray-600"} />
                    <span className={isBridgeConnected ? "text-accent" : "text-gray-600"}>
                        {isBridgeConnected ? "LIVE" : "OFFLINE"}
                    </span>
                </div>
          </div>

          <button 
             onClick={() => setShowRightPanel(!showRightPanel)}
             className={`flex items-center gap-2 hover:text-gray-300 transition-colors ${showRightPanel ? 'text-accent' : ''}`}
          >
             <span className="text-[10px] uppercase font-bold tracking-wider">Scene Graph</span>
             <PanelRight size={14} />
          </button>
      </div>
    </div>
  );
};

export default App;