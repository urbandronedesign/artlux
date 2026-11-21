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
  // The running show machine, for the state graph.
  setShowMachineLive({
    subscribeState: (cb) => timeline.subscribeSmState(cb),
    subscribeFired: (cb) => timeline.subscribeSmFired(cb),
    triggerTransition: (id) => timeline.triggerSmTransition(id),
    enterState: (id) => timeline.enterSmState(id),
  });
}
