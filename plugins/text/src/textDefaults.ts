// What a TEXT surface is when a field is unset, and the detail rungs — one place, so the editor, the
// rasterizer and the docs cannot drift apart. Imports nothing: the editor fragment is the plugin's UI
// half (E5/W5) and is drawn in panel windows, which must not carry the rasterizer.

/** Detail rungs — a PIXEL BUDGET each, not a literal size (see textRaster sizeFor). Mirrors the shader plugin. */
export const RENDER_HEIGHTS = [360, 720, 1080, 1440, 2160] as const;
export const DEFAULT_RES = 720;

// Defaults live here, once, so the editor, the raster and the docs cannot drift apart.
export const DEFAULTS = {
  // Sample copy, not the word "Text" — a box whose contents read as a LABEL is how the first operator
  // to meet this panel failed to realise it was the input. It has to look like something to replace.
  body: 'Your text here',
  font: 'IBM Plex Sans',
  weight: 400,
  size: 0.2,          // fraction of surface height
  lineHeight: 1.2,
  tracking: 0,
  align: 'center' as const,
  color: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 0,
};
