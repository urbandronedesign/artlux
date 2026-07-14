// Module singleton holding the host services for the audio plugin's UI (the Audio Bed panel gets
// only PanelProps from the host mount, so it reaches host.audio/host.show through here). Set during
// the main-window activate(); barrel-only import keeps it single (the plugin contract).
import type { RendererHostServices } from '@artlux/sdk/renderer';

let host: RendererHostServices | null = null;
export function setAudioHost(h: RendererHostServices): void { host = h; }
export function getAudioHost(): RendererHostServices | null { return host; }
