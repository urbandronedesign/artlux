// The Shader plugin's UI HALF (E5/W5): what the content editor shows for a SHADER surface (the shader
// picker, Detail, the parameter controls), with nothing that runs. Activated by the host in the editor
// AND in a panel window (host/pluginUi.ts). The compile status and the GPU's limits belong to the
// editor's GL context and are read through the live view; the WebGL context never reaches here.
import type { RendererPluginUi, ContentSourceUiRegistry } from '@artlux/sdk/renderer';
import { ShaderContentEditor } from './ShaderContentEditor';
import { setLiveView } from './uiLink';

export const ui: RendererPluginUi = {
  id: 'shader',
  activateUi(ctx) {
    setLiveView(ctx.live);
    (ctx.contentSourceUi as ContentSourceUiRegistry).register({
      type: 'SHADER',
      editor: ShaderContentEditor as never,
      pickerButton: { label: 'Shader', title: 'Operator-authored GLSL generative content' },
    });
  },
};
