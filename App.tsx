import React, { useState, useEffect } from 'react';
import { Fixture, SourceType, AppSettings, ViewMode } from './types';
import { TopBar } from './components/TopBar';
import { InspectorPanel } from './components/InspectorPanel';
import { ScenePanel } from './components/ScenePanel';
import { Stage } from './components/Stage';
import { DMXMonitor } from './components/DMXMonitor';
import { sendDmxData, connectToBridge, disconnectBridge, addStatusListener } from './services/mockSocketService';
import { PanelLeft, PanelRight, Activity, Wifi } from 'lucide-react';

const generateId = () => Math.random().toString(36).substr(2, 9);

const DEFAULT_SETTINGS: AppSettings = {
  artNetIp: '127.0.0.1',
  artNetPort: 6454,
  wsBridgeUrl: 'ws://localhost:8080',
  useWsBridge: true
};

const App: React.FC = () => {
  const [fixtures, setFixtures] = useState<Fixture[]>([
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
  const [currentView, setCurrentView] = useState<ViewMode>(ViewMode.MAPPING);
  
  // Docking State
  const [showLeftPanel, setShowLeftPanel] = useState(true);
  const [showRightPanel, setShowRightPanel] = useState(true);
  
  // Real connection status
  const [isBridgeConnected, setIsBridgeConnected] = useState(false);

  // Performance monitoring
  const [fps, setFps] = useState(0);
  const frameCount = React.useRef(0);
  const lastTime = React.useRef(performance.now());

  // Socket Connection Logic
  useEffect(() => {
    const unsubscribe = addStatusListener((status) => {
        setIsBridgeConnected(status);
    });

    if (settings.useWsBridge && settings.wsBridgeUrl) {
      connectToBridge(settings.wsBridgeUrl);
    } else {
      disconnectBridge();
    }

    return () => {
        unsubscribe();
    };
  }, [settings.useWsBridge, settings.wsBridgeUrl]);

  // Main Loop
  useEffect(() => {
    let animationFrameId: number;
    
    const loop = (time: number) => {
      // FPS Calc
      frameCount.current++;
      if (time - lastTime.current >= 1000) {
        setFps(frameCount.current);
        frameCount.current = 0;
        lastTime.current = time;
      }

      if (settings.useWsBridge && isBridgeConnected) {
        sendDmxData(fixtures, settings);
      }
      animationFrameId = requestAnimationFrame(loop);
    };
    
    loop(performance.now());
    return () => cancelAnimationFrame(animationFrameId);
  }, [fixtures, settings, isBridgeConnected]);

  const handleAddFixture = () => {
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
    setFixtures(fixtures.filter(f => f.id !== id));
    if (selectedFixtureId === id) setSelectedFixtureId(null);
  };

  const handleUpdateFixture = (id: string, updates: Partial<Fixture>) => {
    setFixtures(fixtures.map(f => f.id === id ? { ...f, ...updates } : f));
  };

  const handleRenameFixture = (id: string, newName: string) => {
    handleUpdateFixture(id, { name: newName });
  };

  const handleSaveProject = () => {
    const projectData = {
        version: '1.0',
        timestamp: new Date().toISOString(),
        fixtures,
        settings,
        globalBrightness
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
                  const cleanFixtures = data.fixtures.map((f: any) => ({
                      ...f,
                      colorData: [] 
                  }));
                  setFixtures(cleanFixtures);
              }
              
              if (data.settings) {
                  setSettings(prev => ({ ...prev, ...data.settings }));
              }

              if (typeof data.globalBrightness === 'number') {
                  setGlobalBrightness(data.globalBrightness);
              }
              setSelectedFixtureId(null);
          } catch (err) {
              console.error("Failed to parse project file", err);
              alert("Error loading project file. See console for details.");
          }
      };
      reader.readAsText(file);
  };

  const selectedFixture = fixtures.find(f => f.id === selectedFixtureId) || null;

  return (
    <div className="flex flex-col h-screen w-screen bg-black text-slate-200 font-sans overflow-hidden">
      
      {/* Top Bar (Header & Transport) */}
      <TopBar 
          isVideoPlaying={isVideoPlaying}
          onTogglePlay={() => setIsVideoPlaying(!isVideoPlaying)}
          currentView={currentView}
          onChangeView={setCurrentView}
          onSaveProject={handleSaveProject}
          onLoadProject={handleLoadProject}
      />

      {/* Main Workspace */}
      <div className="flex flex-1 overflow-hidden relative">
        
        {/* MAPPING VIEW */}
        <div className={`absolute inset-0 flex transition-opacity duration-300 ${currentView === ViewMode.MAPPING ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
            
            {/* Left Panel Container (Dockable) */}
            <div className={`h-full transition-all duration-300 ease-in-out border-r border-[#222] bg-[#121212] overflow-hidden ${showLeftPanel ? 'w-64 opacity-100' : 'w-0 opacity-0 border-none'}`}>
                <div className="w-64 h-full"> {/* Inner wrapper to prevent content reflow during transition */}
                    <InspectorPanel 
                        sourceType={sourceType}
                        onSetSource={(type, url) => {
                            setSourceType(type);
                            setSourceUrl(url);
                            setIsVideoPlaying(true);
                        }}
                        selectedFixture={selectedFixture}
                        onUpdateFixture={handleUpdateFixture}
                        settings={settings}
                        onUpdateSettings={setSettings}
                    />
                </div>
            </div>

            {/* Center Stage */}
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
                />
            </div>

            {/* Right Panel Container (Dockable) */}
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
                    />
                </div>
            </div>
        </div>

        {/* MONITORING VIEW */}
        <div className={`absolute inset-0 flex transition-opacity duration-300 ${currentView === ViewMode.MONITORING ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
            <DMXMonitor fixtures={fixtures} />
        </div>
      </div>

      {/* Bottom Status Bar */}
      <div className="h-7 bg-[#121212] border-t border-[#222] flex items-center justify-between px-3 text-xs text-gray-500 select-none z-50">
          {/* Left Toggle */}
          <button 
             onClick={() => setShowLeftPanel(!showLeftPanel)}
             className={`flex items-center gap-2 hover:text-gray-300 transition-colors ${showLeftPanel ? 'text-accent' : ''}`}
             title="Toggle Inspector"
          >
             <PanelLeft size={14} />
             <span className="text-[10px] uppercase font-bold tracking-wider">Inspector</span>
          </button>

          {/* Center Status Indicators */}
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

          {/* Right Toggle */}
          <button 
             onClick={() => setShowRightPanel(!showRightPanel)}
             className={`flex items-center gap-2 hover:text-gray-300 transition-colors ${showRightPanel ? 'text-accent' : ''}`}
             title="Toggle Scene Graph"
          >
             <span className="text-[10px] uppercase font-bold tracking-wider">Scene Graph</span>
             <PanelRight size={14} />
          </button>
      </div>

    </div>
  );
};

export default App;