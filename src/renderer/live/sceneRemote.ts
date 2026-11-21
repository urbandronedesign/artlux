// The 3D scene's side panels in a PANEL WINDOW (E5/W5h): what they need of the editor's 3D view, over
// the live channel. The window MIRRORS the editor's named-screens store (services/modelScreenNames)
// from the 'scene3d.screens' stream — change-driven, nothing per frame — sends a click on a screen row
// to the editor's 3D view, and asks the editor for its viewer camera when a bake needs it.
import { liveClient } from './client';
import { mirrorScreens, setFocusSink, type ScreenFocus } from '../services/modelScreenNames';
import { setViewerCapture, type ViewCapture } from '../services/viewerView';

const fail = (what: string) => (e: Error) => { console.warn(`[panel] ${what} failed:`, e.message); return null; };

export function installSceneRemote(): void {
  liveClient.subscribe('scene3d.screens', null, (v) => mirrorScreens(v as { names: Record<string, string[]>; focus: ScreenFocus }));
  setFocusSink((modelId, name) => { liveClient.action('scene3d.focusScreen', [modelId, name]).catch(fail('screen focus')); });
  setViewerCapture(() => liveClient.action('scene3d.captureView', []).then((v) => (v ?? null) as ViewCapture).catch(fail('viewer capture')));
}
