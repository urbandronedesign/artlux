// Host-services access for the Spout plugin — currently one question: how often should the main
// process poll the native receiver?
//
// The receiver used to poll on a hardcoded 16 ms timer (~60 Hz) while the renderer's frame engine
// consumes at AppSettings.engineFps, which defaults to 30. Every surplus poll that finds a new frame
// pays the FULL cost of a receive — a GPU→CPU readback at the sender's resolution, ~9 ms on the main
// process's own thread — and then an 8.3 MB structured clone across IPC, for a frame the engine will
// never look at. At 1080p that is a quarter of a gigabyte per second produced to be dropped.
//
// So the poll follows the engine rate. It is the same reasoning as the setting's own: asking faster
// than anyone consumes does not produce more pictures.

import type { RendererHostServices } from '@artlux/sdk/renderer';

// The one field of AppSettings we read. (AppSettings is a core type; naming the subset keeps the
// runtime dependency direction one-way — see the SDK's note on structural types.)
interface EngineSettings {
  engineFps?: number;
}

let host: RendererHostServices | null = null;

// Called once from the plugin's renderer activate(). Projector windows activate with a NOOP host and
// never acquire Spout anyway (SPOUT is STREAMED, not SELF_RENDER — main decodes once and pushes
// bitmaps), so the null path below is the projector case, not an error.
export function setHost(h: RendererHostServices): void { host = h; }

// The poll rate to ask main for, in Hz.
//
// Absent ⇒ 30, matching AppSettings.engineFps's own documented default and App's `?? 30`. Clamped
// because this becomes a setInterval period in another process: a zero would busy-loop the main
// thread and a negative would throw.
export function pollFps(): number {
  const s = host?.settings.get() as EngineSettings | undefined;
  return Math.max(1, Math.min(240, Math.round(s?.engineFps ?? 30)));
}

// Fires whenever ANY setting changes — the caller re-derives the rate and only acts on a real change,
// so an unrelated preference edit costs a comparison and nothing else.
export function subscribeSettings(cb: () => void): () => void {
  return host?.settings.subscribe(cb) ?? (() => {});
}
