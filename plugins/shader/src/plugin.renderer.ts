// Shader plugin — renderer activation.
//
// Phase 0 registers exactly one contribution: the SHADER content source. No panel, no editor, no
// library. What it proves is the seam — that a plugin can put GPU-generated pixels on a surface with
// no core rendering change — and what it measures is fill-rate, which is the number every later phase
// is budgeted against.
//
// It activates in BOTH windows. The main window renders at LED density for the mapper; a projector
// window will render the same source at its native raster (Phase 6) rather than being sent pixels —
// which is why the source text, not the picture, is the thing that travels.

import type { RendererPlugin, RendererPluginContext } from '@artlux/sdk/renderer';
import type { SurfaceContent } from '@/types';
import * as shaderDrawable from './shaderDrawable';
import { isAvailable } from './shaderContext';
import { ShaderContentEditor } from './ShaderContentEditor';

export const plugin: RendererPlugin = {
  manifest: { id: 'shader', name: 'Shaders', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    // 'SHADER' is an OPEN content-type string, not a SourceType enum value: `SurfaceContent.type`
    // accepts any plugin type id and the compositor dispatches unknown types through this registry
    // (contentSource.getDrawable's default branch). So a new content type costs zero core enum edits
    // and zero project-file migration.
    ctx.contentSources.register({
      type: 'SHADER',
      getDrawable: (key, content, timeSec) => shaderDrawable.getFor(key, content as SurfaceContent, timeSec),
      release: (key) => shaderDrawable.release(key),
      editor: ShaderContentEditor,
      // Declared, and consumed by nothing — the host's content-type picker hand-writes a button per
      // type in components/ContentEditor.tsx (NDI, Spout, Tracking, MediaPipe and Augmenta all do).
      // Left here because it is the contract the SDK publishes; see docs/ROADMAP.md.
      pickerButton: { label: 'Shader', title: 'Operator-authored GLSL generative content' },
    });
  },

  // On the startup splash. The honest thing to report is whether this machine gave us a context at
  // all: without WebGL2 every shader surface is black, and that must not be discovered on stage.
  status: () => (isAvailable()
    ? { state: 'ok', detail: 'GLSL generative content · one shared WebGL2 context' }
    : { state: 'degraded', detail: 'webgl2 unavailable — shader content disabled' }),
};
