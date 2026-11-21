// The MediaPipe plugin's UI HALF (E5/W5): what the content editor shows for a MEDIAPIPE surface, with
// nothing that runs. Activated by the host in the editor AND in a panel window (host/pluginUi.ts), so
// it must reach no pose engine, store or drawable — the WASM model and the camera stay in the editor.
import type { RendererPluginUi, ContentSourceUiRegistry } from '@artlux/sdk/renderer';
import { PoseContentEditor } from './poseContentEditor';

export const ui: RendererPluginUi = {
  id: 'mediapipe',
  activateUi(ctx) {
    (ctx.contentSourceUi as ContentSourceUiRegistry).register({
      type: 'MEDIAPIPE',
      editor: PoseContentEditor as never,
      pickerButton: { label: 'MediaPipe', title: 'Camera pose tracking (BlazePose)' },
    });
  },
};
