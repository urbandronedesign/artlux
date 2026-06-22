import type { Fixture, Surface, Vec3, Euler3, Timeline } from '../types';
import type { Scene3D } from '../../../shared/protocol';

// Messages exchanged over the MessagePort that links the main window and the 3D Scene
// window (see main/index.ts bridgeSceneToMain). Both are renderer-side modules.

export type MainToScene =
  | { t: 'state'; fixtures: Fixture[]; surfaces: Surface[]; selectedId: string | null; scene3D: Scene3D }
  | { t: 'pixels'; buf: ArrayBuffer } // canonical RGBW per-LED buffer (transferred)
  | { t: 'saved'; ok: boolean }       // ack of a save request
  | { t: 'timeline'; timeline: Timeline }                 // timeline data (on change)
  | { t: 'transport'; playing: boolean; playhead: number }; // ~30 fps clock

export type SceneToMain =
  | { t: 'ready' }                                   // scene window mounted; (re)send state
  | { t: 'select'; id: string | null }
  | { t: 'commit'; id: string; position3D?: Vec3; rotation3D?: Euler3; scale3D?: number }
  | { t: 'sceneConfig'; patch: Partial<Scene3D> }
  | { t: 'save' };                                   // persist the project (incl. the 3D scene)
