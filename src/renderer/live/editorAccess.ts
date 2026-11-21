// The EDITOR's side of the core panels' seams (E5/W5): what the DMX Monitor, Performance, Timing and
// the 3D scene's Model card read, straight from the services that produce it — exactly what those panels read before they
// could leave the editor, with nothing added per frame. A panel window installs the live-channel side
// instead (live/dmxRemote.ts, live/healthRemote.ts). Installed by installCoreLiveStreams (App, at load).
import { dmxSignal } from '../services/dmxSignal';
import { setDmxFeed, type DmxFrameView } from '../services/dmxFeed';
import { setEditorHealth } from '../services/editorHealth';
import { perfMonitor } from '../services/perfMonitor';
import { uiPerfMonitor } from '../services/uiPerfMonitor';
import { timeline } from '../services/timeline';
import { setViewerCapture } from '../services/viewerView';
import { captureViewerViewProj } from '../components/Simulator3D/viewerCamera';
import { setRevealBottom } from '../services/editorShell';
import { setShowMachineLive } from '../services/showMachineLive';
import { setTakesAccess, type TakeKind } from '../services/takesAccess';
import { setTakeDensitySource } from '../services/takeDensity';
import { setThumbView } from '../services/thumbView';
import { getThumb, onThumb } from '../services/thumbnailCache';
import * as takeRecorder from '../services/takeRecorder';
import * as orphanTakes from '../services/orphanTakes';
import { trackingStore, trackingTake } from '@artlux/plugin-lidar-tracking';
import { revealBottom } from '../contexts/nav';

type Packet = Parameters<Parameters<typeof dmxSignal.subscribe>[0]>[0];

// One view per published frame, shared by every subscriber (a monitor of 200 strips allocates one).
let lastPacket: Packet | null = null;
let lastView: DmxFrameView | null = null;
function viewOf(d: Packet): DmxFrameView {
  if (d === lastPacket && lastView) return lastView;
  lastPacket = d;
  lastView = {
    pixels: d.pixels,
    universe(u) {
      for (const dest of Object.values(d.destinations)) { const arr = dest.universes[u]; if (arr) return arr; }
      return undefined;
    },
  };
  return lastView;
}

export function installEditorAccess(): void {
  setDmxFeed({ subscribe: (_needs, cb) => dmxSignal.subscribe((d) => cb(viewOf(d))) });
  setEditorHealth({
    subscribePerf(cb) {
      const tick = () => cb({ render: perfMonitor.stats(), ui: uiPerfMonitor.stats() });
      tick();
      const t = window.setInterval(tick, 1000);
      return () => window.clearInterval(t);
    },
    watchClocks: () => () => {},   // the transport runs here; nothing to ask for
    clocks: () => ({ showTime: timeline.getShowTime(), playhead: timeline.getPlayhead() }),
    stateElapsedSec: () => timeline.getSmElapsedSec(),
    subscribeState: (cb) => timeline.subscribeSmState(cb),
  });
  // The 3D viewer camera, for "Projected from view" (the screens' store is the 3D view's own here).
  setViewerCapture(async () => captureViewerViewProj());
  // The timeline drawer, for the state graph's "edit this state's timeline".
  setRevealBottom(() => revealBottom());
  // The take recorder, for the takes docks — the recorder itself, as they always read it.
  const by = <T,>(kind: TakeKind, l: T, t: T): T => (kind === 'lighting' ? l : t);
  setTakesAccess({
    subscribe: (cb) => {
      const a = takeRecorder.subscribe(cb), b = orphanTakes.subscribe(cb);
      // The blob count changes far less often than the tracker sends (it sends at ~60 fps).
      let n = trackingStore.getActiveBlobs().length;
      const c = trackingStore.subscribe(() => { const m = trackingStore.getActiveBlobs().length; if (m !== n) { n = m; cb(); } });
      return () => { a(); b(); c(); };
    },
    getRec: () => takeRecorder.getRec(),
    elapsed: (k) => takeRecorder.elapsed(k),
    liveBlobs: () => trackingStore.getActiveBlobs().length,
    orphans: () => orphanTakes.get(),
    toggle: (k) => by(k, takeRecorder.toggleLighting, takeRecorder.toggleTracking)(),
    cancel: (k) => by(k, takeRecorder.cancelLighting, takeRecorder.cancelTracking)(),
    addLane: (k) => by(k, takeRecorder.addLightingLane, takeRecorder.addTrackingLane)(),
    rename: (k, id, name) => by(k, takeRecorder.renameLightingTake, takeRecorder.renameTrackingTake)(id, name),
    remove: (k, id) => by(k, takeRecorder.removeLightingTake, takeRecorder.removeTrackingTake)(id),
  });
  // Video stills for the media library's chips: the cache itself.
  setThumbView({ getThumb, onThumb });
  // A tracking take's density, for its sparkline: the plugin's own cache and loader.
  const densityOf = (t: { density?: number[]; duration: number } | null | undefined) => (t && t.density ? { density: t.density, duration: t.duration } : null);
  setTakeDensitySource({
    getCached: (p) => densityOf(trackingTake.getCached(p)),
    ensure: async (p) => densityOf(await trackingTake.ensureLoaded(p)),
  });
  // The running show machine, for the state graph.
  setShowMachineLive({
    subscribeState: (cb) => timeline.subscribeSmState(cb),
    subscribeFired: (cb) => timeline.subscribeSmFired(cb),
    triggerTransition: (id) => timeline.triggerSmTransition(id),
    enterState: (id) => timeline.enterSmState(id),
  });
}
