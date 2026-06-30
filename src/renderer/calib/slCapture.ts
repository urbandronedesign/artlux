// Structured-light scan primitive: drives a projector output through the white → black → Gray-code
// plane sequence and returns the raw camera captures. Shared low-level used by the markerless
// controller (the board controller keeps its own copy). The host (App) routes the projector's
// patternShown acks to onPatternShown so showPattern() resolves in sync with the displayed plane.

import type { MainToProjector } from '../projector/bridge';
import { graycodeLayout } from './graycode';
import * as cam from '../services/calibCapture';

type Sender = (m: MainToProjector) => void;
type Ack = { index: number; projW: number; projH: number };

let active: { surfaceId: string; send: Sender } | null = null;
let ackResolver: ((a: Ack) => void) | null = null;
let projW = 0, projH = 0;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function scanActive(): boolean { return !!active; }
export function scanRaster(): { w: number; h: number } { return { w: projW, h: projH }; }

export function beginScan(surfaceId: string, send: Sender): void {
  active = { surfaceId, send };
  projW = 0; projH = 0;
  send({ t: 'calib', mode: 'pattern' });
}

export function endScan(): void {
  active?.send({ t: 'calib', mode: 'idle' });
  active = null; ackResolver = null;
}

export function onPatternShown(a: Ack): void {
  projW = a.projW; projH = a.projH;
  const r = ackResolver; ackResolver = null;
  r?.(a);
}

function showPattern(kind: 'plane' | 'white' | 'black' | 'off' | 'fill', index: number, rgb?: [number, number, number]): Promise<Ack> {
  return new Promise<Ack>((resolve) => {
    ackResolver = resolve;
    active!.send({ t: 'calibPattern', kind, index, rgb });
  });
}

// Project a flat RGB field (0..255 per channel) and resolve once it's on screen. Used by the
// camera-based gamma/colour measurement (gammaController) to drive a per-channel level ramp. Requires
// an active session (beginScan) so the projector is in 'pattern' mode and acks route here.
export function projectField(rgb: [number, number, number]): Promise<Ack> {
  if (!active) return Promise.reject(new Error('measurement session not active'));
  return showPattern('fill', -1, rgb);
}

export interface GrayCodeCapture {
  camW: number; camH: number; planeCount: number;
  captures: Uint8Array; // planeCount * camW*camH grayscale planes, concatenated
  white: Uint8Array; black: Uint8Array; // contrast-mask references
  projW: number; projH: number;
}

// Project white → black → each Gray-code plane onto the venue and grab the camera each time. No board
// involved: this captures the dense camera↔projector correspondence the markerless solve decodes.
export async function captureGrayCode(settleMs: number): Promise<GrayCodeCapture | { error: string }> {
  if (!active) return { error: 'scan not active' };
  const wAck = await showPattern('white', -1);
  await delay(settleMs);
  const white = await cam.grab();
  if (!white) return { error: 'no camera frame' };
  const camW = white.w, camH = white.h;

  await showPattern('black', -1);
  await delay(settleMs);
  const black = await cam.grab();
  if (!black) return { error: 'no camera frame' };
  if (black.w !== camW || black.h !== camH) return { error: 'camera frame size changed' };

  const { planeCount } = graycodeLayout(wAck.projW, wAck.projH);
  const captures = new Uint8Array(planeCount * camW * camH);
  for (let p = 0; p < planeCount; p++) {
    await showPattern('plane', p);
    await delay(settleMs);
    const g = await cam.grab();
    if (!g || g.w !== camW || g.h !== camH) return { error: 'camera frame size changed mid-capture' };
    captures.set(g.data, p * camW * camH);
  }
  return { camW, camH, planeCount, captures, white: white.data, black: black.data, projW, projH };
}
