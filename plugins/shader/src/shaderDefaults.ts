// The shader detail rungs — a PIXEL BUDGET each, not a literal size (see shaderDrawable sizeFor).
//
// How far up the ladder a machine may go is decided by its GPU, not by this list: see
// `maxRenderHeight()` (shaderContext), published to the editor fragment as 'shader.gpu'. Imports
// nothing: the editor fragment is the plugin's UI half (E5/W5) and is drawn in panel windows.
export const RENDER_HEIGHTS = [360, 720, 1080, 1440, 2160] as const;
export const DEFAULT_HEIGHT = 720;
