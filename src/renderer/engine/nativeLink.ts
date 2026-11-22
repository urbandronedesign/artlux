import type { Fixture, Surface, Controller, OutputProtocol } from '../types';
import * as surfaceMedia from '../services/surfaceMedia';
import * as contentSource from '../services/contentSource';
import { timeline } from '../services/timeline';

// E1f — THE NATIVE ENGINE'S LIVE LINK, renderer half (plans/native-engine.md; main half src/main/engineHost.ts,
// engine half engine/artlux-engine/src/runtime.rs).
//
// "THE HOST EVALUATES, THE ENGINE DRAWS." The frame engine has already turned the show (scenes, the timeline,
// the state machine, automation, fades) into this frame's EFFECTIVE surfaces and fixtures. This module sends
// exactly those to the native engine — never the authored document, which would make the engine re-implement
// all of that and drift from it:
//   - the DOCUMENT, whenever any part of it changes (references, or what a surface's source resolves to —
//     a codec claiming a file, a bake going live), with a new `rev`;
//   - a TICK every frame: the show time (effects), the brightness, and for each HAP surface the frame INDEX
//     this app is showing right now — so the engine draws the same frame, not one from a clock of its own.
// Per surface the SOURCE is decided by surfaceMedia.nativeSource, beside getDrawable, from the same branches.
//
// OFF unless main says the engine is on (`--native-engine`): then nothing here serialises anything. The app's
// own frames keep flowing either way; main decides which sender reaches the wire.

export interface LinkInputs {
  controllers: Controller[];
  protocol: OutputProtocol;
  targetIp: string;
  broadcast: boolean;
  gamma: number;
  artNetPort: number;
  outputEnabled: boolean;
}

let enabled = false;
try {
  void window.artlux?.nativeEngineEnabled?.().then((v) => { enabled = !!v; }, () => { /* an older main: off */ });
} catch { /* no bridge (a test page): off */ }

let rev = 0;
let lastRefs: unknown[] = [];
let lastSources = '';

/** One frame. Cheap when nothing changed: a reference compare, one small string, one IPC send. */
export function frame(inputs: LinkInputs, surfaces: Surface[], fixtures: Fixture[], brightness: number): void {
  if (!enabled) return;
  const sources: Record<string, contentSource.NativeSource> = {};
  for (const s of surfaces) sources[s.id] = surfaceMedia.nativeSource(s);
  const sourcesKey = JSON.stringify(sources);
  const refs = [surfaces, fixtures, inputs.controllers, inputs.protocol, inputs.targetIp, inputs.broadcast, inputs.gamma, inputs.artNetPort, inputs.outputEnabled];
  if (sourcesKey !== lastSources || refs.length !== lastRefs.length || refs.some((r, i) => r !== lastRefs[i])) {
    lastRefs = refs; lastSources = sourcesKey; rev++;
    const doc = {
      rev, fixtures, surfaces, controllers: inputs.controllers,
      defaults: { protocol: inputs.protocol, ip: inputs.targetIp, broadcast: inputs.broadcast },
      gamma: inputs.gamma, port: inputs.artNetPort, outputEnabled: inputs.outputEnabled, sources,
    };
    window.artlux?.nativeEngineDoc?.(JSON.stringify(doc), rev);
  }
  const hap: Record<string, number> = {};
  for (const s of surfaces) {
    if (sources[s.id].kind !== 'hap') continue;
    const g = contentSource.getDrawableGeneration(s.id, s.content);
    if (g !== undefined) hap[s.id] = g;
  }
  window.artlux?.nativeEngineTick?.(JSON.stringify({ rev, t: timeline.getShowTime(), brightness, hap }));
}
