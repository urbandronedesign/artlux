import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

// A CEILING ON HOW OFTEN AN r3f CANVAS REDRAWS. Mount ONE inside a Canvas whose `frameloop` is
// `'never'`; this is then the only thing that makes a frame happen there.
//
// Shared by the two Canvases that can each saturate this machine on their own:
//   • the editor's 3D viewport (Simulator3D) — `Preferences ▸ GPU rendering ▸ 3D frame rate`
//   • the calibrated projector's render-from-projector scene (plugins/calibration ProjectorScene) —
//     `ProjectData.projectorFpsCap`, the Outputs panel's performance mode
// One implementation because the subtlety below is easy to get wrong twice, and because a cap that
// silently delivers 20 fps when asked for 30 is the kind of bug that reads as "the GPU is slow".
//
// Why a cap at all: these Canvases share one GPU with the frame engine, and the engine is the half
// that feeds the wire. Nothing here touches it — the engine keeps its own rAF
// (renderer/engine/frameEngine.ts) and output does not depend on any component being mounted. This is
// a preview declining GPU time, not the loop moving into the UI.
//
// `frameloop='never'` rather than `'demand'`, deliberately: under 'demand' every drei `invalidate()`
// still renders, and OrbitControls invalidates on each pointermove — so a drag would run uncapped,
// which is exactly the moment a weak GPU is already struggling. 'never' means the cap holds
// everywhere; damping and every `useFrame` still run, just on our tick.
export const FrameRateCap: React.FC<{ hz: number }> = ({ hz }) => {
  const advance = useThree((s) => s.advance);
  useEffect(() => {
    if (!(hz > 0)) return;
    const period = 1000 / hz;
    let raf = 0, next = 0, prev = 0;
    // A rAF cannot fire between vsyncs, so a cap is really a choice of WHICH vsyncs to draw on.
    // Testing `elapsed >= period` exactly would miss the 33.3 ms deadline on a 60 Hz panel about half
    // the time (it arrives as 33.29) and drop to every third frame — a 30 Hz cap delivering 20. Letting
    // through the frame that is within half a display interval of the deadline picks the NEAREST vsync
    // instead. `next` then advances by whole periods rather than resetting to `t`, so the cap does not
    // drift late by the rounding it just forgave; `Math.max(t, next)` stops it trying to catch up a
    // burst of frames after a stall.
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const display = prev ? t - prev : 16.7;
      prev = t;
      if (t < next - display / 2) return;
      next = Math.max(t, next) + period;
      advance(t);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hz, advance]);
  return null;
};
