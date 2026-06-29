import type { Surface, Timeline } from '../types';
import type { CornerPin, BezierWarp, SoftEdge, ProjectorCalibration, Scene3D } from '../../../shared/protocol';
import type { TrackingSnapshot } from '../services/trackingStore';

export interface ProjectorRender {
  cornerPin: CornerPin;
  warp?: BezierWarp | null;
  softEdge?: SoftEdge;
  gamma?: number;
  brightness?: number; // projector-content master brightness (1 = full)
  colorGain?: [number, number, number]; // per-projector white-point/brightness match (1,1,1 = off)
  blackLift?: [number, number, number]; // per-projector additive black floor (0,0,0 = off)
  fpsCap?: number;   // 0 = uncapped
  ndiSend?: boolean; // also publish this output as an NDI source
  ndiFullRes?: boolean; // Broadcast: capture the NDI send at up to 1080p instead of 720p
  trackingSmoothing?: number; // TRACKING content: One-Euro smoothing 0..1
  trackingPredictMs?: number; // TRACKING content: prediction horizon (ms)
}

// Messages over the MessagePort linking the main window and one projector output window
// (set up in main/projector.ts). The projector renders the surface independently at native
// resolution; only the surface config, corner-pin, and transport clock cross the bridge.

export type MainToProjector =
  | { t: 'config'; surface: Surface; playing: boolean; render: ProjectorRender } // geometry + look
  | { t: 'timeline'; timeline: Timeline }                     // for LAYER content
  | { t: 'transport'; playing: boolean; playhead: number }    // ~30 fps clock
  | { t: 'brightness'; value: number }                        // projector-content master brightness (live drag)
  | { t: 'edit'; on: boolean }                                // toggle corner-pin / mesh editing
  | { t: 'frame'; bitmap: ImageBitmap }                       // streamed source frame (camera/Spout/DMX-in/NDI + video/layer, decoded once in main)
  | { t: 'layerFrame'; layerId: string; bitmap: ImageBitmap } // a timeline layer frame (TRACKING content background; decoded once in main)
  | { t: 'tracking'; snap: TrackingSnapshot }                 // LiDAR blobs for TRACKING content (OSC arrives in main only)
  // --- calibration (physical-projector calibration: structured light + pose) ---
  // mode gates what the projector draws: 'pattern' = a Gray-code/flat field (SL intrinsics capture),
  // 'crosshair' = faint content + an aim crosshair (pose capture), 'render' = render-from-projector.
  | { t: 'calib'; mode: 'idle' | 'pattern' | 'crosshair' | 'render'; crosshair?: [number, number]; calibration?: ProjectorCalibration | null }
  // Set the current structured-light pattern; the projector renders it raw (no warp/gamma) and acks.
  | { t: 'calibPattern'; kind: 'plane' | 'white' | 'black' | 'off'; index: number }
  // The 3D venue scene (models) for render-from-projector mode.
  | { t: 'scene'; scene3D: Scene3D };

export type ProjectorToMain =
  | { t: 'ready' }                           // window mounted; (re)send config
  | { t: 'cornerPin'; cornerPin: CornerPin } // committed corner-pin (drag end / nudge)
  | { t: 'warp'; warp: BezierWarp }          // committed Bézier control net
  | { t: 'editOff' }                         // user dismissed edit mode (Esc) in the window
  // --- calibration ---
  | { t: 'patternShown'; index: number; projW: number; projH: number } // ack: pattern on screen (raster reported so main knows projector resolution)
  | { t: 'calibCrosshair'; pixel: [number, number] }  // current crosshair position in projector raster px (float)
  | { t: 'calibConfirm' };                            // operator confirmed the crosshair is on the target (Enter)
