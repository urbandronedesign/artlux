// Shapes shared by the bake plugin's two halves. Everything here crosses the generic plugin IPC
// bridge, so it must be structured-cloneable: no class instances, no functions, no VideoFrames.

/** What one render is asked to produce. */
export interface BakeRequest {
  surfaceId: string;
  /** Inclusive start and exclusive end, in seconds, on the clock named below. */
  startSec: number;
  endSec: number;
  /** Output frame rate. See bakeRunner for why this is never the engine's tick rate. */
  fps: number;
  width: number;
  height: number;
  /**
   * WHICH clock the range is measured on. A generative surface rides the SHOW clock; a surface fed by
   * timeline tracks rides the bound document's PLAYHEAD. Keying a layer bake to show time drifts out
   * of its own range the first time a scene is recalled. Same two-value choice automation already
   * makes per lane.
   */
  clock: 'show' | 'playhead';
  /** Target bitrate in bits/second. */
  bitrate: number;
  /** Render the show's sound into the file. Off gives a silent MP4 and skips the audio graph entirely. */
  audio: boolean;
  /**
   * Where to write. Absent opens a save dialog.
   *
   * ⚠ A DIALOG IS A MODAL ON THE MAIN WINDOW, and an operator who does not notice it reads the whole
   * application as hung — which is how the first build was experienced. Anything that renders without
   * a person in front of it (a batch, a scheduler, a diagnostic) must pass a path instead.
   */
  outPath?: string;
  /**
   * Write into the project's own `assets/video` without asking. Ignored when `outPath` is given, and
   * refused when the project has never been saved — there is no folder to be relative to yet.
   */
  intoProject?: boolean;
}

/** Progress, pushed from the renderer to whatever is watching. */
export interface BakeProgress {
  frame: number;
  frames: number;
  /** Frames per second the RENDER is achieving — not the output rate. */
  rate: number;
}

// A STRING discriminant, not a boolean one, and that is not a style choice.
//
// This tsconfig sets no `strict` / `strictNullChecks` (CLAUDE.md: "strict-ish TS"), and WITHOUT
// strictNullChecks TypeScript does not narrow a union discriminated by boolean LITERALS: given
// `{ok: true} | {ok: false}`, neither `if (r.ok)` nor `r.ok === false` tells it anything, so the
// refusal branch cannot see `reason` and the only way to compile is a cast — which would throw away
// the one guarantee the union exists to give. String literals narrow correctly with or without the
// flag. Verified by reproduction, not guessed at.

/** Why a render refused, in words an operator can act on. */
export interface BakeRefusal {
  kind: 'refused';
  reason: string;
}

export interface BakeSuccess {
  kind: 'ok';
  path: string;
  frames: number;
  elapsedMs: number;
  /**
   * Set when the render SUCCEEDED but the sound did not make it — no audio addon, no AAC encoder on
   * this machine. A separate field rather than a refusal, because a silent render of good pictures is
   * still worth having; it just must not be mistaken for one WITH sound.
   */
  audioNote?: string | null;
}

export type BakeResult = BakeSuccess | BakeRefusal;
