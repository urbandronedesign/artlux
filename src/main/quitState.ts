import { app } from 'electron';

// WHETHER A QUIT IS IN FLIGHT — and it has to live somewhere both the close guard and the projector
// windows can see, which is neither of them.
//
// THE macOS BUG THIS EXISTS TO END. Quitting emits `before-quit`, THEN `close` on every window; a
// window that calls preventDefault() in `close` ABORTS THE WHOLE QUIT. The close guard does exactly
// that — it must, because only the renderer knows whether the document is dirty — and by the time the
// renderer answers "go ahead", the quit it was answering no longer exists. So Cmd+Q closed the editor
// window and left the process running with nothing on screen, and the second Cmd+Q then ran a
// teardown that `before-quit` had ALREADY run once, which is where the segfault came from.
//
// Hence: `before-quit` only RECORDS the intent (all real teardown moved to `will-quit`, which is the
// event that is emitted only when the quit is actually going through), the guard RESUMES it once the
// renderer has answered, and "Keep editing" ABANDONS it.
let requested = false;

/** A quit has started. Called from the `before-quit` handler in index.ts — and from nowhere else. */
export function noteQuitRequested(): void { requested = true; }

/** The operator cancelled the close, so the quit that triggered it is off. */
export function abandonQuit(): void { requested = false; }

/** True between `before-quit` and the process actually ending (or the quit being abandoned). */
export function quitRequested(): boolean { return requested; }

/**
 * Re-issue the quit a guarded `close` aborted. No-op when nothing asked to quit — the same window
 * close arrives from the title-bar X, and that must close the window WITHOUT ending the app.
 */
export function resumeQuit(): void { if (requested) app.quit(); }
