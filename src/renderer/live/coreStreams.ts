// The core's live streams and drag targets (E5/W4) — what a panel in another window can watch or drive
// in the engine owner. A plugin adds its own through registerLiveStream / registerLiveDragTarget; this
// file is only the part that belongs to core. The editor's projector-brightness target needs App's
// projector ports, so App registers that one itself.

import { registerLiveCall, registerLiveDragTarget, registerLiveStream } from './broker';
import { listCameras, getCameraInfo, retryCamera, previewCameraControl } from '../services/contentSource';
import { dmxSignal } from '../services/dmxSignal';
import { perfMonitor } from '../services/perfMonitor';
import { uiPerfMonitor } from '../services/uiPerfMonitor';
import { timeline } from '../services/timeline';
import { telemetry } from '../services/telemetry';
import { installEditorAccess } from './editorAccess';
import { captureViewProj } from '../services/viewerView';
import { screensSnapshot, subscribeScreens, focusScreen } from '../services/modelScreenNames';
import { livePreview } from '../services/livePreview';
import { docStore } from '../state/docStore';

let installed = false;

// ── What a panel window cannot derive from its replica ──────────────────────────────────────────
// EditorData (state/EditorStore.tsx) is mostly the document and the session, which a panel window
// already has through its own Show Host replica. The rest App holds itself: the RESOLVED fixture
// profiles (project-embedded → user → bundled, services/fixtureProfiles), the displays main reported,
// app settings (prefs, not project), the 3D model sizes measured on load, the scene-saved flag, the
// open project's path and the selection's fixture KINDS. App publishes them here when they change and
// a panel window watches the stream: one producer, sent only on change, pulled like any other stream.
export interface EditorExtras {
  fixtureProfiles: ReadonlyMap<string, unknown>;
  displays: unknown[];
  settings: unknown;
  modelNaturalSizes: Record<string, number>;
  sceneSaved: boolean;
  currentProjectPath: string | null;
  selectedFixtureKinds: string;
  autoKeyArmed: boolean;
}
let extras: EditorExtras | null = null;
let extrasChanged: (() => void) | null = null;
/** App, on every change of any field (one object per change; unchanged fields keep their identity). */
export function publishEditorExtras(x: EditorExtras): void {
  extras = x;
  extrasChanged?.();
}

export function installCoreLiveStreams(): void {
  if (installed) return;
  installed = true;
  // The editor's own side of the DMX Monitor / Performance / Timing seams (services/dmxFeed,
  // services/editorHealth): the services themselves, as those panels always read them.
  installEditorAccess();

  // THE CANONICAL PIXEL BUFFER — what the DMX monitor draws. `params` = { start, count } in bytes, so a
  // monitor showing one universe is sent that universe, not the rig. The engine's buffer is its own and
  // is reused, so a sample is a copy (and the copy's memory is transferred, not cloned again).
  let pixels: Uint8Array | null = null;
  registerLiveStream('dmx.pixels', {
    watch(onNew) { return dmxSignal.subscribe((d) => { pixels = d.pixels; onNew(); }); },
    read(params) {
      if (!pixels) return undefined;
      const p = (params ?? {}) as { start?: number; count?: number };
      const start = Math.max(0, Math.min(pixels.length, p.start ?? 0));
      const end = p.count == null ? pixels.length : Math.min(pixels.length, start + Math.max(0, p.count));
      const copy = pixels.slice(start, end);
      return { value: { start, total: pixels.length, bytes: copy }, transfer: [copy.buffer] };
    },
  });

  // THE PACKED UNIVERSES — what a light's channel table in the DMX monitor reads: the byte that actually
  // left the machine, per universe, the first destination that carries it (as the docked table does).
  // The whole set in one sample: a monitor's tables share it, and a universe is 512 bytes.
  let dests: Parameters<Parameters<typeof dmxSignal.subscribe>[0]>[0]['destinations'] | null = null;
  registerLiveStream('dmx.universes', {
    watch(onNew) { return dmxSignal.subscribe((d) => { dests = d.destinations; onNew(); }); },
    read() {
      if (!dests) return undefined;
      const out: Record<number, Uint8Array> = {};
      for (const dest of Object.values(dests)) {
        for (const [k, arr] of Object.entries(dest.universes)) if (!(Number(k) in out)) out[Number(k)] = Uint8Array.from(arr);
      }
      return { value: out, transfer: Object.values(out).map((a) => a.buffer) };
    },
  });

  // THE STATE MACHINE, for the Timing panel in a window: which state, and how long in it. Shown as mm:ss,
  // so it is sampled at 4 Hz and SENT only when the state or the displayed second changes.
  registerLiveStream('sm.state', {
    watch(onNew) {
      let sig = '';
      const check = () => { const s = `${timeline.getSmStateId()}:${Math.floor(timeline.getSmElapsedSec())}`; if (s !== sig) { sig = s; onNew(); } };
      const off = timeline.subscribeSmState(check);   // a state change at once, not at the next sample
      const t = setInterval(check, 250);
      return () => { off(); clearInterval(t); };
    },
    read() { return { value: { id: timeline.getSmStateId(), elapsedSec: timeline.getSmElapsedSec() } }; },
  });

  // THE 3D VIEW, for the scene's side panels in a panel window: the named screens each loaded model
  // carries and the one clicked (sent on change only — a file loads, a screen is clicked), the viewer
  // camera for "Projected from view", and a click on a screen row put back into this 3D view.
  registerLiveStream('scene3d.screens', {
    watch: (onNew) => subscribeScreens(onNew),
    read: () => ({ value: screensSnapshot() }),
  });
  registerLiveCall('scene3d.captureView', () => captureViewProj());
  registerLiveCall('scene3d.focusScreen', (modelId, name) => focusScreen(String(modelId), name == null ? null : String(name)));

  // THE CAMERA INSPECTOR in a panel window (services/cameraAccess.ts, live/cameraRemote.ts). The capture
  // is not observable, so this polls at the inspector's own rate (500 ms) — but only while a window is
  // subscribed, and it announces a sample only when what it would say has CHANGED: an idle camera
  // panel costs one getSettings() per open device per half second and no messages.
  const camAsked = new Set<string>();
  let camSig = '';
  const camSignature = () => [...camAsked].map((id) => { const i = getCameraInfo(id); return `${id}:${i.state}:${i.error}:${JSON.stringify(i.settings)}:${i.capabilities ? 1 : 0}`; }).join('|');
  registerLiveStream('camera.info', {
    watch(onNew) {
      const t = setInterval(() => { const s = camSignature(); if (s !== camSig) { camSig = s; onNew(); } }, 500);
      return () => { clearInterval(t); camAsked.clear(); camSig = ''; };
    },
    read(params) {
      const id = typeof params === 'string' ? params : '';
      if (!camAsked.has(id)) { camAsked.add(id); camSig = camSignature(); }
      return { value: getCameraInfo(id) };
    },
  });
  registerLiveCall('camera.list', () => listCameras());
  registerLiveCall('camera.retry', (id) => retryCamera(String(id)));
  registerLiveCall('camera.preview', (id, name, value) => previewCameraControl(String(id), String(name), value as number | string));

  registerLiveStream('editor.extras', {
    watch(onNew) { extrasChanged = onNew; return () => { extrasChanged = null; }; },
    read() { return extras ? { value: extras } : undefined; },
  });

  // Render and output health. The numbers are windowed statistics that move once a second at most, so
  // the producer hook is a 1 Hz timer — running only while someone watches (broker rule 2).
  registerLiveStream('perf', {
    watch(onNew) { const t = setInterval(onNew, 1000); return () => clearInterval(t); },
    // `ui` is the EDITOR's UI thread: a Performance panel in a window reports the editor's health.
    read() { return { value: { render: perfMonitor.stats(), ui: uiPerfMonitor.stats(), telemetry: telemetry.get() } }; },
  });

  // THE LED MASTER, dragged from another window: the same render-free channel the editor's own slider
  // writes (contexts/panels/browser.tsx), so the wire follows the hand at frame rate and the document
  // is written once, on release, by the client — through the Show Host like any edit.
  registerLiveDragTarget('ledBrightness', {
    move: (d) => livePreview.setBrightness(d.value),
    end: () => { /* the client's commit follows; the engine re-reads the committed value */ },
    abandon: () => livePreview.setBrightness(docStore.getSlice('globalBrightness')),
  });

  // A FIXTURE CHANNEL under a hand in another window: the top of the precedence stack, with the same
  // settle-then-retire handover as the inspector's faders (services/livePreview.ts).
  registerLiveDragTarget('fixtureChannel', {
    move: (d) => livePreview.setFixtureChannel(d.fixtureId, d.key, d.value),
    end: (d) => livePreview.releaseFixtureChannel(d.fixtureId, d.key),
    abandon: (d) => livePreview.releaseFixtureChannel(d.fixtureId, d.key),
  });
}
