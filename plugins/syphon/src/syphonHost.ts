// Host-services access for the Syphon plugin — currently one question: how often should the main
// process poll the native receiver?
//
// The answer feeds only the poll FLOOR (see pollHz in syphonManager): the poll follows the SERVER,
// because sampling a 60 fps server at the engine's 30 Hz is sampling off an unrelated clock and
// judders. The engine rate still has to reach main, because a rate change is the one thing that can
// alter the poll without any consumer changing.

import type { RendererHostServices } from '@artlux/sdk/renderer';

// The one field of AppSettings we read. (AppSettings is a core type; naming the subset keeps the
// runtime dependency direction one-way — see the SDK's note on structural types.)
interface EngineSettings {
  engineFps?: number;
}

let host: RendererHostServices | null = null;

// Called once from the plugin's renderer activate(). Projector windows activate with a NOOP host and
// never acquire Syphon anyway (it is STREAMED, not SELF_RENDER — main delivers once and pushes), so
// the null path below is the projector case, not an error.
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

// Fires whenever ANY setting changes — the caller re-derives the rate and only acts on a real
// change, so an unrelated preference edit costs a comparison and nothing else.
export function subscribeSettings(cb: () => void): () => void {
  return host?.settings.subscribe(cb) ?? (() => {});
}
