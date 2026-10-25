// Live reads of the host's project state for the Calibrator's panels: the outputs, the surfaces, the 3D
// scene. One hook so every panel re-renders on the same events (the host services' subscribe), and none
// keeps a stale copy of state App owns.

import { useEffect, useState } from 'react';
import type { ProjectorOutput, Scene3D } from '../../../shared/protocol';
import { getHost } from './calibHost';

function useHostSnapshot<T>(read: () => T, sub: ((cb: () => void) => () => void) | undefined): T {
  const [v, setV] = useState<T>(read);
  useEffect(() => {
    setV(read());
    if (!sub) return;
    return sub(() => setV(read()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return v;
}

/** Structurally typed: `Surface` is a host domain type a plugin does not import (plugin → sdk only). */
export interface SurfaceLite { id: string; name: string; content: { type: string; shaderId?: string; uvChecker?: { size: 'fhd' | '4k' } } & Record<string, unknown> }

export const useOutputs = (): ProjectorOutput[] => {
  const h = getHost();
  return useHostSnapshot(() => ((h?.projectorOutputs.list() as ProjectorOutput[]) ?? []), h?.projectorOutputs.subscribe);
};
export const useSurfaces = (): SurfaceLite[] => {
  const h = getHost();
  return useHostSnapshot(() => ((h?.surfaces.list() as SurfaceLite[]) ?? []), h?.surfaces.subscribe);
};
export const useScene = (): Scene3D => {
  const h = getHost();
  return useHostSnapshot(() => ((h?.scene3D.get() as Scene3D) ?? ({} as Scene3D)), h?.scene3D.subscribe);
};

/** The name an operator knows an output by: its own, else its surface's. */
export const outputName = (o: ProjectorOutput, surfaces: SurfaceLite[]): string =>
  o.name || surfaces.find((s) => s.id === o.surfaceId)?.name || o.surfaceId;

/** The same rule from a surface id — for what is keyed by id (a blend's coverage, a file's regions). */
export const projectorName = (id: string, outputs: ProjectorOutput[], surfaces: SurfaceLite[]): string => {
  const o = outputs.find((x) => x.surfaceId === id);
  return o ? outputName(o, surfaces) : (surfaces.find((s) => s.id === id)?.name ?? id);
};

export type RigState = 'calibrated' | 'calibrating' | 'none' | 'off';
export function rigState(o: ProjectorOutput, sessionTarget: string | null): RigState {
  if (sessionTarget === o.surfaceId) return 'calibrating';
  if (!o.enabled) return 'off';
  return o.calibration?.poseRms != null ? 'calibrated' : 'none';
}
