// The shader detail rungs — a PIXEL BUDGET each, not a literal size (see shaderDrawable sizeFor).
//
// How far up the ladder a machine may go is decided by its GPU, not by this list: see
// `maxRenderHeight()` (shaderContext), published to the editor fragment as 'shader.gpu'. Imports
// nothing: the editor fragment is the plugin's UI half (E5/W5) and is drawn in panel windows.
export const RENDER_HEIGHTS = [360, 720, 1080, 1440, 2160] as const;
export const DEFAULT_HEIGHT = 720;

// How fast the audio inputs fall back after a hit (seconds) — the defaults the Shaders preferences show.
// Here rather than in audioTap.ts / beatDetect.ts (which run the analysis) so the settings section, a UI
// half's, can show them in a panel window (E5/W5k).
export const DEFAULT_BAND_FALL_SEC = 0.25;
export const DEFAULT_BEAT_FALL_SEC = 0.25;
