// The Shader plugin's UI HALF (E5/W5): what the content editor shows for a SHADER surface (the shader
// picker, Detail, the parameter controls), and the three authoring panels — Shader (the code editor),
// Shader Nodes and Effects (the library) — with nothing that runs. Activated by the host in the editor
// AND in a panel window (host/pluginUi.ts).
//
// Everything those need of the editor's GL context or of the library is asked through the live view
// (uiLink.ts, libraryView.ts): the compile verdict, the GPU's limits, the effect and subpatch lists,
// save and delete. The WebGL context, the library store and the IPC never reach here.
//
// A show launch (--broadcast) registers the panels too, and places them nowhere: the runtime only
// extends the mapping workbench with them in an authoring launch, and only answers their questions there.
import type { RendererPluginUi, ContentSourceUiRegistry } from '@artlux/sdk/renderer';
import { ShaderContentEditor } from './ShaderContentEditor';
import { ShaderEditorPanel } from './ShaderEditorPanel';
import { ShaderNodePanel } from './ShaderNodePanel';
import { ShaderLibraryPanel } from './ShaderLibraryPanel';
import { setLiveView } from './uiLink';
import { ShaderSettings } from './ShaderSettings';

export const ui: RendererPluginUi = {
  id: 'shader',
  activateUi(ctx) {
    setLiveView(ctx.live);
    (ctx.contentSourceUi as ContentSourceUiRegistry).register({
      type: 'SHADER',
      editor: ShaderContentEditor as never,
      pickerButton: { label: 'Shader', title: 'Operator-authored GLSL generative content' },
    });
    // The editor and the node editor are DOCK TABS (a place you work IN); the library is a BROWSER
    // panel (a place you pick content FROM). The runtime puts them on the mapping workbench.
    ctx.panels.register({ id: 'shader-editor', mount: 'dock', detachable: true, title: 'Shader', Component: ShaderEditorPanel });
    ctx.panels.register({ id: 'shader-nodes', mount: 'dock', detachable: true, title: 'Shader Nodes', Component: ShaderNodePanel });
    ctx.settings.register({ id: 'shader', title: 'Shaders', Component: ShaderSettings } as never);
    ctx.panels.register({ id: 'shader-library', mount: 'browser', detachable: true, title: 'Effects', grow: true, Component: ShaderLibraryPanel });
  },
};
