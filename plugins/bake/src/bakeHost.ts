// The host handle, set once by the renderer plugin's activate() — how the panel reaches
// `host.surfaces` without a prop drill. Same three-line shape as plugins/audio/src/audioHost.ts.

import type { RendererHostServices } from '@artlux/sdk/renderer';

let host: RendererHostServices | null = null;

export function setBakeHost(h: RendererHostServices): void { host = h; }
export function getBakeHost(): RendererHostServices | null { return host; }
