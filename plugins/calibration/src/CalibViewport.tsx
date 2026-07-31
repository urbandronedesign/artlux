import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Aperture } from 'lucide-react';
import type { DisplayInfo, ProjectorOutput, Scene3D } from '../../../shared/protocol';
import { WINDOWED_DISPLAY } from '../../../shared/protocol';
import { CalibWizard } from './CalibWizard';
import { AutoAlignWizard } from './AutoAlignWizard';
import { ManualWizard } from './ManualWizard';
import * as ws from './calibWorkspace';
import { getHost } from './calibHost';

// The `calib` workspace context's viewport — the calibration workbench.
//
// This closes the ROADMAP "Stage 2b" seam. The two wizards lived in this plugin but were MOUNTED BY
// App, which also held six useStates for them and rendered a black div over the Stage purely as a
// portal target for the camera preview. That existed because there was no mount point for a
// Stage-coupled workspace; a context is one. App now owns none of it and imports no calibration code.
//
// Layout: wizard rail + camera side by side here, with the 3D venue scene as the context's right pane
// (the context declares splitView). The wizard needs the camera and the 3D at once — that IS the job —
// which is exactly what the old portal was faking.

/** Subscribe to a host service that exposes get/list + subscribe. */
function useHostSnapshot<T>(read: () => T, sub: ((cb: () => void) => () => void) | undefined, initial: T): T {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    setV(read());
    if (!sub) return;
    return sub(() => setV(read()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return v;
}

export const CalibViewport: React.FC = () => {
  const state = useSyncExternalStore(ws.subscribe, ws.getState);
  const host = getHost();

  const outputs = useHostSnapshot<ProjectorOutput[]>(
    () => (host?.projectorOutputs.list() as ProjectorOutput[]) ?? [], host?.projectorOutputs.subscribe, []);
  // Structurally typed: `Surface` lives in the renderer's types and a plugin must not import host
  // domain types (plugin → sdk only). The name is all this needs.
  const surfaces = useHostSnapshot<{ id: string; name: string }[]>(
    () => (host?.surfaces.list() as { id: string; name: string }[]) ?? [], host?.surfaces.subscribe, []);
  const scene3D = useHostSnapshot<Scene3D>(
    () => (host?.scene3D.get() as Scene3D) ?? ({} as Scene3D), host?.scene3D.subscribe, {} as Scene3D);

  // Displays come straight from the core API (same door OscMonitor uses for the OSC stream) — the
  // "is this output actually on a screen" test needs them and they change only on replug.
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  useEffect(() => { void window.artlux?.listDisplays?.().then((d) => setDisplays(d ?? [])); }, [state.target]);

  const target = state.target;
  if (!target) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-fg-3 text-mini p-6 text-center bg-surface-0">
        <Aperture size={22} />
        <div className="text-fg-2">No calibration session.</div>
        <div className="text-micro max-w-[420px]">
          Go to Projection Outputs and press <span className="text-fg-2">Calibrate</span> on the output you want to
          align. The camera view opens here and the 3D venue scene sits alongside for placing correspondences.
        </div>
      </div>
    );
  }

  const output = outputs.find((o) => o.surfaceId === target);
  const surfaceName = surfaces.find((s) => s.id === target)?.name ?? 'Output';
  // Live = enabled AND bound to a display that still exists (a stale displayId after a replug is not live).
  const live = !!output?.enabled && output.displayId != null
    && (output.displayId === WINDOWED_DISPLAY || displays.some((d) => d.id === output.displayId));
  const hasModel = (scene3D.models ?? []).some((m) => m.kind !== 'plane' && m.visible);

  const common = {
    surfaceId: target,
    surfaceName,
    output,
    scene3D,
    live,
    hasModel,
    onSetCalibPickMode: ws.setPickMode,
    onSwitchFlow: ws.setFlow,
    onClose: ws.close,
  };

  return state.flow === 'auto'
    ? <AutoAlignWizard {...common} onPicksChange={ws.setPicks} onSelectionChange={ws.setSelectedPick} />
    : state.flow === 'manual'
    ? <ManualWizard {...common} />
    : <CalibWizard {...common} />;
};
