// The MediaPipe plugin's UI HALF (E5/W5): what the content editor shows for a MEDIAPIPE surface, with
// nothing that runs. Activated by the host in the editor AND in a panel window (host/pluginUi.ts), so
// it must reach no pose engine, store or drawable — the WASM model and the camera stay in the editor.
import type { RendererPluginUi, ContentSourceUiRegistry } from '@artlux/sdk/renderer';
import { PoseContentEditor } from './poseContentEditor';
import { PosePanel } from './PosePanel';
import { setLiveView } from './uiLink';
import { PoseSettings } from './poseSettings';

export const ui: RendererPluginUi = {
  id: 'mediapipe',
  activateUi(ctx) {
    setLiveView(ctx.live);
    ctx.settings.register({ id: 'mediapipe', title: 'Pose Tracking (MediaPipe)', Component: PoseSettings as never });
    // The Pose Monitor: numbers from the runtime's stream, the picture only where the camera is open.
    ctx.panels.register({ id: 'pose-monitor', mount: 'dock', detachable: true, menuAction: 'pose-monitor', title: 'Pose Monitor', Component: PosePanel });
    (ctx.contentSourceUi as ContentSourceUiRegistry).register({
      type: 'MEDIAPIPE',
      editor: PoseContentEditor as never,
      pickerButton: { label: 'MediaPipe', title: 'Camera pose tracking (BlazePose)' },
    });
  },
};
