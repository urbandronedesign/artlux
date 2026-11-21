// The LiDAR plugin's RUNTIME view of other plugins' tracking surfaces (the camera area, …), so the zone
// evaluation and the 3D viz can list them, read their points and place them, without importing the
// plugin that provides them.
//
// Runtime only. The UI half (OSC Monitor, Trigger Zones) reaches the host through uiLink.ts and sees
// these surfaces as data in the zone view (zoneViewSource.ts): their functions run here, in the editor.

import type { TrackingSurfaceRegistry, TrackingSurfaceContribution } from '@artlux/sdk/renderer';

let surfaceRegistry: TrackingSurfaceRegistry | null = null;
export function setSurfaceRegistry(r: TrackingSurfaceRegistry | null): void { surfaceRegistry = r; }
export function providerSurfaces(): TrackingSurfaceContribution[] { return surfaceRegistry?.all() ?? []; }
export function providerSurface(key: string): TrackingSurfaceContribution | undefined { return surfaceRegistry?.get(key); }
