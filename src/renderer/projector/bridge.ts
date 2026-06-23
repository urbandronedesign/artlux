import type { Surface, Timeline } from '../types';
import type { CornerPin } from '../../../shared/protocol';

// Messages over the MessagePort linking the main window and one projector output window
// (set up in main/projector.ts). The projector renders the surface independently at native
// resolution; only the surface config, corner-pin, and transport clock cross the bridge.

export type MainToProjector =
  | { t: 'config'; surface: Surface; cornerPin: CornerPin; playing: boolean }
  | { t: 'timeline'; timeline: Timeline }                     // for LAYER content
  | { t: 'transport'; playing: boolean; playhead: number }    // ~30 fps clock
  | { t: 'edit'; on: boolean };                               // toggle corner-pin editing

export type ProjectorToMain =
  | { t: 'ready' }                          // window mounted; (re)send config
  | { t: 'cornerPin'; cornerPin: CornerPin } // committed corner-pin (drag end / nudge)
  | { t: 'editOff' };                        // user dismissed edit mode (Esc) in the window
