// Structured-light intrinsics orchestration (renderer side). Drives one projector output through the
// Gray-code capture sequence per board pose, decodes via the native OpenCV addon, accumulates
// board-3D ↔ projector-pixel correspondences, and solves projector intrinsics + distortion. Decoupled
// from React; App routes the projector's patternShown acks here and the CalibWizard calls the methods.
//
// Per pose: show white → detect checkerboard + grab the white reference; show black → grab reference;
// show each Gray-code plane → grab; mapCornersToProjector decodes the projector pixel at each board
// corner (local homography). After enough poses, calibrateProjector runs calibrateCamera over them.

import type { MainToProjector } from '../projector/bridge';
import { graycodeLayout } from './graycode';
import * as cam from '../services/calibCapture';

export interface BoardConfig {
  cols: number;       // inner corners across
  rows: number;       // inner corners down
  squareMeters: number;
  settleMs: number;   // extra delay after the projector acks before grabbing (camera exposure lag)
}

export const defaultBoardConfig = (): BoardConfig => ({ cols: 9, rows: 6, squareMeters: 0.025, settleMs: 120 });

export type CaptureResult =
  // bbox: the detected board's normalized camera-frame centroid (cx,cy ∈ 0..1) + area fraction, for
  // the wizard's coverage tracker (spread across the frame + near/far via area).
  | { ok: true; validCorners: number; totalCorners: number; poses: number; bbox: { cx: number; cy: number; areaFrac: number } }
  | { ok: false; reason: string };

type Sender = (m: MainToProjector) => void;
type Ack = { index: number; projW: number; projH: number };

let active: { surfaceId: string; send: Sender } | null = null;
let ackResolver: ((a: Ack) => void) | null = null;
let projW = 0, projH = 0;

// Accumulated correspondences across poses (flat, for the native calibrateProjector call).
let objectPoints: number[] = [];
let imagePoints: number[] = [];
let pointCounts: number[] = [];

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function isActive(): boolean { return !!active; }
export function poseCount(): number { return pointCounts.length; }
export function projectorRaster(): { w: number; h: number } { return { w: projW, h: projH }; }

// Enter structured-light mode on the given projector and reset accumulation.
export function begin(surfaceId: string, send: Sender): void {
  active = { surfaceId, send };
  objectPoints = []; imagePoints = []; pointCounts = [];
  projW = 0; projH = 0;
  send({ t: 'calib', mode: 'pattern' });
}

// Leave calibration mode (back to normal content) and clear state.
export function end(): void {
  active?.send({ t: 'calib', mode: 'idle' });
  active = null; ackResolver = null;
  objectPoints = []; imagePoints = []; pointCounts = [];
}

// App forwards the projector's patternShown ack here so showPattern() can resolve in sync.
export function onPatternShown(a: Ack): void {
  projW = a.projW; projH = a.projH;
  const r = ackResolver; ackResolver = null;
  r?.(a);
}

function showPattern(kind: 'plane' | 'white' | 'black' | 'off', index: number): Promise<Ack> {
  return new Promise<Ack>((resolve) => {
    ackResolver = resolve;
    active!.send({ t: 'calibPattern', kind, index });
  });
}

// Capture one board pose: returns ok with running totals, or a reason it was rejected.
export async function capturePose(cfg: BoardConfig): Promise<CaptureResult> {
  if (!active) return { ok: false, reason: 'calibration not active' };
  const api = window.artlux;
  if (!api?.calibDetectBoard) return { ok: false, reason: 'calibration addon unavailable' };

  // White field: detect the (printed) board and keep the bright reference.
  const wAck = await showPattern('white', -1);
  await delay(cfg.settleMs);
  const white = cam.grabGray();
  if (!white) return { ok: false, reason: 'no camera frame' };
  const camW = white.w, camH = white.h;

  const det = await api.calibDetectBoard(white.data.buffer as ArrayBuffer, camW, camH, cfg.cols, cfg.rows);
  if (!det) return { ok: false, reason: 'calibration addon unavailable' };
  if (!det.found) return { ok: false, reason: 'checkerboard not detected — adjust the board/lighting' };

  // Board coverage in the camera frame (centroid + area fraction) for the wizard's coverage tracker.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sx = 0, sy = 0;
  const nPts = det.corners.length / 2;
  for (let i = 0; i < nPts; i++) {
    const x = det.corners[i * 2], y = det.corners[i * 2 + 1];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    sx += x; sy += y;
  }
  const bbox = {
    cx: (sx / nPts) / camW,
    cy: (sy / nPts) / camH,
    areaFrac: ((maxX - minX) * (maxY - minY)) / (camW * camH),
  };

  // Black field reference.
  await showPattern('black', -1);
  await delay(cfg.settleMs);
  const black = cam.grabGray();
  if (!black) return { ok: false, reason: 'no camera frame' };

  // Gray-code planes (projW/projH come from the projector's acks).
  const { planeCount } = graycodeLayout(wAck.projW, wAck.projH);
  const captures = new Uint8Array(planeCount * camW * camH);
  for (let p = 0; p < planeCount; p++) {
    await showPattern('plane', p);
    await delay(cfg.settleMs);
    const g = cam.grabGray();
    if (!g || g.w !== camW || g.h !== camH) return { ok: false, reason: 'camera frame size changed mid-capture' };
    captures.set(g.data, p * camW * camH);
  }

  const map = await api.calibMapCorners(
    captures.buffer as ArrayBuffer, planeCount, camW, camH, projW, projH,
    Array.from(det.corners), white.data.buffer as ArrayBuffer, black.data.buffer as ArrayBuffer,
  );
  if (!map) return { ok: false, reason: 'decode failed (addon unavailable)' };

  // Accumulate the valid board-corner ↔ projector-pixel pairs for this pose.
  let valid = 0;
  const obj: number[] = [], img: number[] = [];
  const n = det.corners.length / 2;
  for (let i = 0; i < n; i++) {
    if (map.valid[i] !== 1) continue;
    const col = i % cfg.cols, row = Math.floor(i / cfg.cols);
    obj.push(col * cfg.squareMeters, row * cfg.squareMeters, 0);
    img.push(map.projCorners[i * 2], map.projCorners[i * 2 + 1]);
    valid++;
  }
  if (valid < Math.max(8, (cfg.cols * cfg.rows) / 3)) {
    return { ok: false, reason: `only ${valid}/${n} corners decoded — improve focus/contrast` };
  }
  objectPoints.push(...obj);
  imagePoints.push(...img);
  pointCounts.push(valid);
  return { ok: true, validCorners: valid, totalCorners: n, poses: pointCounts.length, bbox };
}

export interface IntrinsicsSolve { k: number[]; dist: number[]; rms: number }

// Solve projector intrinsics + distortion over all captured poses.
export async function solve(): Promise<IntrinsicsSolve | { error: string }> {
  if (pointCounts.length < 3) return { error: 'need at least 3 board poses' };
  const api = window.artlux;
  if (!api?.calibCalibrateProjector) return { error: 'calibration addon unavailable' };
  const r = await api.calibCalibrateProjector(objectPoints, imagePoints, pointCounts, projW, projH);
  if (!r) return { error: 'calibration addon unavailable' };
  return { k: r.k, dist: r.dist, rms: r.rms };
}
