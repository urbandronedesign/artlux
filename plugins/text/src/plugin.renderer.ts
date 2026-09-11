// Text plugin — renderer activation.
//
// Registers one contribution: the TEXT content source. The host compositor dispatches unknown content
// types through `contentSourceRegistry` (contentSource.getDrawable's default branch), so a new content
// type costs zero core enum edits and zero project-file migration — the persisted `text*` fields live
// in core `types.ts` for exactly that reason, the same split SourceType.NDI and 'SHADER' already follow.
//
// IT ACTIVATES IN EVERY WINDOW, deliberately. A projector window rasterises the type itself at its own
// native resolution (ProjectorApp's SELF_RENDER set names 'TEXT'), because streaming a bitmap
// rasterised at the MAIN window's density and stretching it onto the projector's raster is the way to
// make glyph edges mushy. What travels between windows is the STRING; the pixels are made where they
// are shown. That is also why `setWindowKind` is the first thing activation does.

import type { RendererPlugin, RendererPluginContext, ContentSourceProvider } from '@artlux/sdk/renderer';
import type { SurfaceContent } from '@/types';
import * as textRaster from './textRaster';
import { TextContentEditor } from './textContentEditor';

export const plugin: RendererPlugin = {
  manifest: { id: 'text', name: 'Text', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    // Decides the raster size: a pixel budget in the main window, the output's own raster in a
    // projector. Must be set before the first getDrawable, hence first.
    textRaster.setWindowKind(ctx.window === 'projector' ? 'projector' : 'main');

    ctx.contentSources.register({
      type: 'TEXT',
      getDrawable: (key, content) => textRaster.getFor(key, content as SurfaceContent),
      // The whole reason text is cheap: still copy re-uses its bitmap, so the 3D texture upload, the
      // projector pump's per-window createImageBitmap and each projector window's repaint all skip it.
      getDrawableGeneration: (key) => textRaster.generationOf(key),
      release: (key) => textRaster.release(key),
      // Never auto-fit the surface to the content. `getAspect` returning a number makes the engine
      // RESIZE the operator's box (frameEngine's aspect follow), which is right for a video with a
      // native shape and wrong for type, which has none — the box is the design decision, and the
      // type is laid out to fit it.
      getAspect: () => null,
      editor: TextContentEditor,
      pickerButton: { label: 'Text', title: 'Typed copy on this surface' },
    } as ContentSourceProvider);
  },
};
