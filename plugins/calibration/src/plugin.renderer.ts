// Calibration plugin — renderer activation (Stage 2, "foundation" slice).
//
// Stage 1 moved the engine + logic here but kept the wizards host-side, so there was no renderer
// `plugin` yet. This registers the first renderer contribution: the projector→main **back-channel**
// tap. The projector windows ack each structured-light pattern with `{ t:'patternShown', … }`; the
// host used to route that from App directly into calibController/slCapture. Now the plugin subscribes
// to the host's projector message stream (`ctx.host.projectors.onMessage`) and feeds its own capture
// controllers — App no longer knows about the calibration ack.
//
// The wizard UIs (CalibWizard/AutoAlignWizard) + their embedded-3D pick workspace stay host-side for
// now (Stage 2b); they'll consume host.projectorOutputs/scene3D/projectors when moved.

import React from 'react';
import { Timer, ListChecks, Layers, ScanEye, Radar } from 'lucide-react';
import { SCENE_3D_VIEWPORT as VIEWPORT_SCENE_3D } from '@/components/shell/viewportIds'; // the ONE scene3d viewport id — a leaf module, never the shell
import type { RendererPlugin, RendererPluginContext } from '@artlux/sdk/renderer';
import { setHost } from './calibHost';
import { CalibProjector } from './CalibProjector';
import { ImportPanel } from './ImportPanel';
import * as baked from './bakedStore';
import * as venueRegistrar from './venueRegistrar';
import { reportInterrupted } from './recalInterrupted';
// The authoring half is NEVER imported statically here — only through the loader, so a plain launch
// and every projector window skip it entirely (suite plan Phase 1; see ./authoring).
import { lazyAuthoring, loadAuthoring, loadedAuthoring } from './authoringLoader';
import { registerCommandHandler } from '@artlux/plugin-show-control/renderer';

// Registered synchronously like any panel; their code loads on first mount.
const CalibViewport = lazyAuthoring((m) => m.CalibViewport);
const RecalPanel = lazyAuthoring((m) => m.RecalPanel);
const RigList = lazyAuthoring((m) => m.RigList);
const RigStatus = lazyAuthoring((m) => m.RigStatus);
const BlendPanel = lazyAuthoring((m) => m.BlendPanel);
const SignoffPanel = lazyAuthoring((m) => m.SignoffPanel);
const CalibInspector = lazyAuthoring((m) => m.CalibInspector);

// The projector→main message shape we care about (a subset of the host's ProjectorToMain union —
// typed structurally so the plugin doesn't import a host module).
type PatternShown = { t: 'patternShown'; index: number; projW: number; projH: number };

let msgUnsub: (() => void) | null = null;
let venueUnsub: (() => void) | null = null;
// Playback-half subscriptions — see the two events in activate().
let outsUnsub: (() => void) | null = null;
let readyUnsub: (() => void) | null = null;
let cmdUnsubs: (() => void)[] = [];

// A hidden show-engine window (--broadcast / --headless). App renders null there, so Simulator3D —
// and with it the ONLY caller of registerVenueMesh — never mounts. Read the same query string App
// reads rather than inventing a second notion of run mode.
function isShowEngineWindow(): boolean {
  try {
    const qs = new URLSearchParams(window.location.search);
    return qs.get('broadcast') === '1' || qs.get('headless') === '1';
  } catch { return false; }
}

// Does this launch carry the AUTHORING half — wizards, camera, OpenCV, the workbench? Read from the
// query string for the same reason isShowEngineWindow does: activation runs during module load, long
// before an IPC round-trip could answer, and every window main opens carries the same param.
//
// The PLAYBACK half is not gated by this and never should be. Importing a baked map is not
// calibrating: no camera, no solve, no second venue render — the projector plays the file through one
// fragment shader. Gating it too is what made a plain editor launch unable to display a calibrated
// output at all, which is the launch you would most want it in.
function isAuthoringLaunch(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('calibrate') === '1';
  } catch { return false; }
}

export const plugin: RendererPlugin = {
  manifest: { id: 'calibration', name: 'Projector Calibration', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    // Give the wizard components host-services access (they mutate outputs/scene + send to projectors
    // through this instead of App callback props). Harmless in projector windows (inert host).
    setHost(ctx.host);

    // ── PLAYBACK — always on, in every launch profile ───────────────────────────────────────────
    //
    // A baked map reaches its window on TWO events, because neither one alone is enough.
    //
    //   the outputs list changed — a map was imported, withdrawn, or the rig was re-patched. Sweeps
    //   every output, and is the only thing that can WITHDRAW one. Edge-triggered, not polled: a map
    //   is ~10 MB and this only has to fire when the rig changes.
    //
    //   a window said `ready` — it exists and its bridge port is up. The list subscription fires when
    //   an output is ENABLED, which is strictly earlier: the window is still opening and the send
    //   lands on nothing. Enabling an output after loading a venue's file is the ordinary order of
    //   events, so without this the projector plays undeformed content while the import panel
    //   correctly reports the map as loaded — a pairing with nothing in it that looks like a lie.
    if (ctx.window === 'main') {
      outsUnsub = ctx.host.projectorOutputs.subscribe(() => baked.pushToProjectors());
      readyUnsub = ctx.host.projectors.onMessage((surfaceId, msg) => {
        if ((msg as { t?: string }).t === 'ready') baked.pushToProjector(surfaceId);
      });
      // BOOT-TIME RESTORE — what makes a show machine come back calibrated.
      //
      // The map is venue state, so its PATH lives in prefs (per machine) and its pixels are re-read
      // here rather than persisted. Without this the import survived only until the process did, which
      // is fine for an editor and wrong for an install: `--broadcast` has no chrome to import from and
      // no operator, so a baked calibration could never reach the one mode that exists to run it.
      //
      // Failure is deliberately quiet and non-fatal — a moved file or an unmounted drive leaves the
      // rig empty and every output on its own warp, which is a show that starts and looks wrong rather
      // than a show that does not start.
      void (async () => {
        const p = (await window.artlux?.getPrefs?.())?.calibrationFile;
        if (!p) return;
        const res = await window.artlux?.importMpcdi?.(p);
        if (!res?.regions.length) { console.warn(`[calibration] remembered calibration could not be loaded: ${p}`); return; }
        console.info(`[calibration] restored ${res.regions.length} region(s) from ${p}`);
        baked.set({ path: res.path, regions: res.regions, importedAt: new Date().toISOString() });
      })();
    }

    // The door to that, in the context the outputs already live in — so a plain editor launch can load
    // a venue's calibration without the authoring half existing at all. See ImportPanel.
    ctx.panels.register({ id: 'calibration.import', mount: 'dock', title: 'Calibration File', Component: ImportPanel });
    ctx.contexts.extend('project', { dock: ['calibration.import'] });

    // The projector-window calibration overlay (structured-light pattern / pose crosshair / render-from-
    // projector). Projector windows mount every registered panel; the editor window ignores this registry.
    //
    // PLAYBACK, so ABOVE the authoring gate. Render-from-projector is how a calibrated output SHOWS its
    // picture, and main drives it from the project alone (useCalibration + a solved pose) in EVERY
    // launch. With this panel gated to --calibrate, a plain launch of a calibrated project told each
    // projector to render the venue and gave it nothing to render with: black projectors, nothing
    // logged (measured 2026-10-24 on the multi-projector template). Its authoring modes (pattern,
    // crosshair) only ever run when a wizard drives them, so registering it everywhere costs nothing
    // until an output is actually calibrated.
    ctx.projectorPanels.register({ id: 'calibration', Component: CalibProjector });

    // ── AUTHORING — only under --calibrate (and every show mode, which implies it) ───────────────
    //
    // Everything below produces a calibration rather than playing one: the wizards, the camera, the
    // structured-light patterns, the pose solve. (The projector-window panel is NOT here — see above:
    // rendering a calibration is playback.) Skipped rather than registered-and-inert, because a Calibration viewport on the rail
    // and a panel on every projector window that both decline to work is worse than their absence.
    if (!isAuthoringLaunch()) return;

    // The calibration WORKBENCH (ROADMAP Stage 2b, closed 2026-07-23). The wizards lived here all
    // along but App mounted them and held their state, because a Stage-coupled workspace had no mount
    // point; the `calib` context is one. The host declares that context (rail slot, title, the 3D as
    // its right pane) and this plugin claims its viewport — so App now imports no calibration UI.
    ctx.panels.register({ id: 'calibration.workbench', mount: 'viewport', title: 'Calibration', Component: CalibViewport });
    // ArtLux Calibrator lays the calib context out around the 3D venue instead (contexts/index.tsx), with
    // the wizard as the step inspector below; only the combined app claims the viewport for the workbench.
    if (__ARTLUX_APP__ !== 'calibrator') ctx.contexts.extend('calib', { viewport: 'calibration.workbench' });

    // ── ARTLUX CALIBRATOR'S FLOW (suite plan Phase 3, step 5 — the approved design) ─────────────────
    // The venue is the workspace: every step is the SAME shell layout — the rig on the left, the ONE 3D
    // scene in the centre, the step's panel on the right — so moving through the flow never moves the
    // venue. Rig → Calibrate (the host's `calib`) → Blend → Test & sign-off → Recalibration. Registered
    // only in a Calibrator build; the combined app keeps its workbench as it was.
    if (__ARTLUX_APP__ === 'calibrator') {
      ctx.panels.register({ id: 'calibration.rig', mount: 'browser', title: 'Rig', icon: React.createElement(Radar, { size: 12 }), grow: true, Component: RigList } as Parameters<typeof ctx.panels.register>[0]);
      ctx.panels.register({ id: 'calibration.wizard', mount: 'inspector', title: 'Calibrate', grow: true, Component: CalibInspector } as Parameters<typeof ctx.panels.register>[0]);
      ctx.panels.register({ id: 'calibration.rigStatus', mount: 'inspector', title: 'Rig status', Component: RigStatus } as Parameters<typeof ctx.panels.register>[0]);
      ctx.panels.register({ id: 'calibration.blend', mount: 'inspector', title: 'Blend', Component: BlendPanel } as Parameters<typeof ctx.panels.register>[0]);
      ctx.panels.register({ id: 'calibration.signoff', mount: 'inspector', title: 'Test & sign-off', Component: SignoffPanel } as Parameters<typeof ctx.panels.register>[0]);
      ctx.panels.register({ id: 'calibration.recal', mount: 'inspector', title: 'Recalibration', Component: RecalPanel } as Parameters<typeof ctx.panels.register>[0]);
      const stepLayout = { showLeft: true, showRight: true, dockOpen: false, splitView: false, bottomOpen: false };
      const step = (id: string, title: string, shortTitle: string, icon: React.ReactNode, order: number, inspector: string[], browser: string[], en: string, fr: string) =>
        ctx.contexts.register({
          id, title, shortTitle, icon, cluster: 'align', order, viewport: VIEWPORT_SCENE_3D, browser, inspector,
          layout: stepLayout, layoutRev: 1, hint: { en, fr },
        } as unknown as Parameters<typeof ctx.contexts.register>[0]);
      step('rig', 'Rig', 'Rig', React.createElement(Radar, { size: 16 }), -1, ['calibration.rigStatus'], ['calibration.rig'],
        'Every projector of the venue, what is done and what is next.', 'Chaque projecteur du lieu, ce qui est fait et ce qui reste.');
      step('blend', 'Blend', 'Blend', React.createElement(Layers, { size: 16 }), 2, ['calibration.blend'], ['calibration.rig'],
        'Solve and inspect the rig blend; solo and mute projectors on the wall.', 'Résoudre et inspecter le blend ; solo et mute des projecteurs sur le mur.');
      step('signoff', 'Test & sign-off', 'Test', React.createElement(ListChecks, { size: 16 }), 3, ['calibration.signoff'], ['calibration.rig'],
        'Play the UV checker on the wall, sign the rig off, hand it to ArtLux Show.', 'Projeter le damier UV, valider le kit, le passer à ArtLux Show.');
      step('recal', 'Recalibration', 'Recal', React.createElement(ScanEye, { size: 16 }), 4, ['calibration.recal'], [],
        'Commission unattended recalibration: camera, thresholds, schedule, history.', 'Mettre en service la recalibration automatique : caméra, seuils, planning, historique.');
    }

    // Commissioning + status for the unattended recalibration. A Preferences section rather than
    // anything in the wizard: it is a property of the INSTALLATION (which camera, which thresholds,
    // may it write), set once when the venue is handed over, not part of calibrating one projector.
    ctx.settings.register({
      id: 'recalibration', title: 'Recalibration',
      icon: React.createElement(Timer, { size: 12 }),
      Component: RecalPanel,
    } as unknown as Parameters<typeof ctx.settings.register>[0]);

    // Venue meshes for the raycaster in a window that has no 3D viewport. Without this, every
    // markerless solve in a permanent (--broadcast) installation fails with "no venue model loaded" —
    // the pipeline could not run in the mode the venue actually runs in. See venueRegistrar.
    if (isShowEngineWindow()) {
      venueUnsub = venueRegistrar.start(
        () => ctx.host.scene3D.get() as never,
        (cb) => ctx.host.scene3D.subscribe(cb),
      );
    }

    // Maintenance commands. Registering them here — rather than show-control knowing about
    // calibration — means the nightly scheduler and the tablet's POST /command both reach them with
    // no extra plumbing: ScheduleEntry.action is any ShowCommand.
    //
    // Only in the window that owns the projector bridge; a projector window has inert host services
    // and would silently "run" a recalibration that can talk to nothing.
    if (ctx.host.projectors) {
      cmdUnsubs = [
        // The handler loads the authoring half when a command ARRIVES: a show that is never asked to
        // recalibrate never loads it. A failed load is logged — the scheduler records a run that did
        // not happen through the audit trail's silence, and this line says why.
        registerCommandHandler('recalibrate', (c) => {
          const cmd = c as { surfaceId?: string; mode?: 'check' | 'full' };
          loadAuthoring().then((a) => a.autoRecal.run({ mode: cmd.mode ?? 'check', surfaceId: cmd.surfaceId }))
            .catch((e) => console.error('[recal] could not load the calibration code — recalibration skipped', e));
        }),
        registerCommandHandler('calibRevert', (c) => {
          loadAuthoring().then((a) => a.autoRecal.revertCalibration((c as { surfaceId: string }).surfaceId))
            .catch((e) => console.error('[recal] could not load the calibration code — revert skipped', e));
        }),
      ];
      // A run killed part-way (watchdog relaunch, power cut) leaves a marker and no other trace —
      // the project file looks untouched because its single save never happened. Say so, once.
      void reportInterrupted();
    }

    // Only the main window owns the bridge ports, so this fires there; in projector windows the host
    // service is inert and the callback is never invoked.
    msgUnsub = ctx.host.projectors.onMessage((_surfaceId, msg) => {
      const m = msg as { t?: string };
      // Every message below exists only while a wizard drives a projector — patterns, the crosshair, a
      // dragged point — so the authoring half is loaded whenever one can arrive; before that there is
      // nobody to deliver it to, and loading it for a stray message would be the cost Phase 1 removed.
      const au = loadedAuthoring();
      if (!au) return;
      if (m.t === 'patternShown') {
        const a = m as PatternShown;
        const ack = { index: a.index, projW: a.projW, projH: a.projH };
        au.calibController.onPatternShown(ack); // board flow
        au.slCapture.onPatternShown(ack);       // markerless flow (the inactive one is a no-op)
      } else if (m.t === 'calibCrosshair') {
        au.calibWorkspace.onCrosshair((m as { pixel: [number, number] }).pixel); // projector aim → pending pose pixel
      } else if (m.t === 'calibConfirm') {
        au.calibWorkspace.onConfirm(); // Enter: releases a live re-aim
      } else if (m.t === 'calibPointDrag') {
        const d = m as { index: number; pixel: [number, number] };
        au.calibWorkspace.onPointDrag(d.index, d.pixel); // a point grabbed + dragged on the projection
      } else if (m.t === 'calibPointDragEnd') {
        au.calibWorkspace.endPickDrag(); // released → commit the provisional picks in one write
      }
    });
  },

  deactivate(): void {
    msgUnsub?.(); msgUnsub = null;
    venueUnsub?.(); venueUnsub = null;
    outsUnsub?.(); outsUnsub = null;
    readyUnsub?.(); readyUnsub = null;
    for (const u of cmdUnsubs) u();
    cmdUnsubs = [];
  },
};
