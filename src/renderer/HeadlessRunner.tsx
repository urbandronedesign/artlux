import React, { useEffect, useState } from 'react';
import { Fixture, Surface, Controller, AppSettings } from './types';
import { Stage } from './components/Stage';
import { dmxSignal } from './services/dmxSignal';
import { sendArtNetFrame, configureOutput } from './services/mockSocketService';

// Headless runner: reuses the Stage compute/output pipeline with no UI chrome.
// Loads a project off disk, runs the WebGPU mapper, and forwards frames to the
// native engine — same output wiring as App.tsx, minus panels/3D/monitor.

const DEFAULTS: AppSettings = {
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
  helpLang: 'en',
};

export const HeadlessRunner: React.FC<{ projectPath: string | null }> = ({ projectPath }) => {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [controllers, setControllers] = useState<Controller[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [brightness, setBrightness] = useState(1);
  const [loaded, setLoaded] = useState(false);

  // Load the project (explicit --project path, else the last-opened project).
  useEffect(() => {
    (async () => {
      let s = DEFAULTS;
      let fx: Fixture[] = [];
      let surf: Surface[] = [];
      let ctrls: Controller[] = [];
      let gb = 1;
      const prefs = await window.artlux?.getPrefs?.();
      const path = projectPath || prefs?.lastProjectPath;
      // AppSettings is THE MACHINE, not the show (see the header on AppSettings in types.ts) — that holds
      // here too. A headless/broadcast node reads its Art-Net target and output config from `Prefs.appSettings`
      // (this machine's own persisted settings), never from the project file: the project used to carry a
      // `settings` copy of its own, so loading a show authored on a different rig would silently repoint this
      // node's DMX output at the AUTHOR's Art-Net subnet. `ProjectData.settings` no longer exists at all
      // (removed P6/Task 2) — legacy files may still have the key on disk, and it is ignored here exactly as
      // App.tsx's applyProjectData ignores it.
      if (prefs?.appSettings) s = { ...DEFAULTS, ...(prefs.appSettings as Partial<AppSettings>) };
      if (path) {
        const data = await window.artlux?.loadProjectPath?.(path);
        if (data) {
          if (Array.isArray(data.fixtures)) fx = (data.fixtures as Fixture[]).map((f) => ({ ...f, colorData: [] }));
          if (Array.isArray((data as any).surfaces)) surf = (data as any).surfaces as Surface[];
          if (Array.isArray((data as any).controllers)) ctrls = (data as any).controllers as Controller[];
          if (typeof data.globalBrightness === 'number') gb = data.globalBrightness;
        }
      }
      setFixtures(fx);
      setSurfaces(surf);
      setControllers(ctrls);
      setSettings(s);
      setBrightness(gb);
      setLoaded(true);
      console.log(`[headless] loaded ${fx.length} fixtures, ${surf.length} surfaces from ${path ?? '(no project)'}`);
    })();
  }, [projectPath]);

  // Push output settings to the native transport once loaded / on change.
  useEffect(() => { if (loaded) configureOutput(settings); }, [loaded, settings]);

  // Forward generated frames to the native engine (per-fixture routing).
  useEffect(() => {
    const unsub = dmxSignal.subscribe((data) => {
      if (!settings.outputEnabled) return;
      sendArtNetFrame(data.destinations, settings.artNetPort);
    });
    return () => unsub();
  }, [settings]);

  if (!loaded) return null;

  // Offscreen 1×1 host: the Stage canvas keeps its fixed 512×512 backing buffer,
  // so compute is unaffected by the zero display size.
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
        onSelectFixture={() => { /* no-op */ }}
        isEngineRunning={true}
        isVideoPlaying={false}
        globalBrightness={brightness}
        gamma={settings.gamma}
        targetIp={settings.artNetIp}
        broadcast={settings.broadcast}
        protocol={settings.protocol}
        onRecordHistory={() => { /* no-op */ }}
        showPreview={false}
      />
    </div>
  );
};
