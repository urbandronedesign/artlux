// Camera-based projector gamma + colour measurement. Projects a grayscale level ramp on one output,
// samples the camera's RGB inside that output's lit footprint at each level, and fits the end-to-end
// (projector EOTF × camera OETF) response per channel. The fitted average exponent drives the output's
// scalar `gamma` (shader does input^(1/gamma), so gamma = measured exponent linearises the
// camera-perceived response), and the per-channel white levels drive `colorGain` (neutralise the
// projector's colour cast / match channels). Black level is left to the existing cross-projector
// blend logic.
//
// Reuses slCapture's session (projector 'pattern' mode + patternShown ack routing) so the ramp stays
// in sync with the displayed field. The camera should have auto exposure / white balance / focus
// DISABLED before measuring (the caller freezes them) — otherwise the camera adapts per level and the
// curve is meaningless.

import type { MainToProjector } from '../projector/bridge';
import * as cam from '../services/calibCapture';
import * as slCapture from './slCapture';

export interface GammaSample { level: number; rgb: [number, number, number] }
export interface GammaResult {
  gamma: number;                       // fitted exponent applied to output.gamma (avg of channels)
  gammaRGB: [number, number, number];  // per-channel fitted exponent (report / diagnostics)
  colorGain: [number, number, number]; // per-channel white-point match (≤1, dimmest channel = 1)
  white: [number, number, number];     // measured white-minus-black per channel (camera counts)
  black: [number, number, number];     // measured black per channel (ambient + projector black)
  footprintPx: number;                 // camera pixels in the lit footprint
  samples: GammaSample[];              // measured response curve (for an optional plot)
}

export interface GammaOpts {
  levels?: number;   // ramp steps incl. endpoints (default 9)
  settleMs?: number; // settle after each field before sampling (default 160)
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const luma = (r: number, g: number, b: number) => (r * 77 + g * 150 + b * 29) >> 8;

// Project a flat field, let it settle, drain one stale camera frame, then return the mean RGB over the
// given footprint mask (or the whole frame when mask is null, used for the white/black references).
async function sampleField(
  rgb: [number, number, number], settleMs: number, mask: Uint8Array | null, camW: number, camH: number,
): Promise<{ w: number; h: number; mean: [number, number, number]; frame: cam.ColorFrame } | { error: string }> {
  await slCapture.projectField(rgb);
  await delay(settleMs);
  await cam.grabColor();          // discard a possibly-stale frame
  const f = await cam.grabColor();
  if (!f) return { error: 'no camera frame' };
  if (mask && (f.w !== camW || f.h !== camH)) return { error: 'camera frame size changed mid-measure' };
  let rs = 0, gs = 0, bs = 0, n = 0;
  const d = f.data;
  for (let i = 0, px = f.w * f.h; i < px; i++) {
    if (mask && !mask[i]) continue;
    rs += d[i * 4]; gs += d[i * 4 + 1]; bs += d[i * 4 + 2]; n++;
  }
  if (!n) return { error: 'empty sample region' };
  return { w: f.w, h: f.h, mean: [rs / n, gs / n, bs / n], frame: f };
}

// Least-squares exponent γ for normalised response n(L) ≈ L^γ, fit through the origin in log-log space
// over the interior levels (0<L<1, n>0). slope = Σ(lnL·lnN)/Σ(lnL²).
function fitGamma(levels: number[], norm: number[]): number {
  let num = 0, den = 0;
  for (let i = 0; i < levels.length; i++) {
    const L = levels[i], N = norm[i];
    if (L <= 0 || L >= 1 || N <= 1e-3) continue;
    const x = Math.log(L), y = Math.log(Math.min(1, N));
    num += x * y; den += x * x;
  }
  if (den <= 0) return 1;
  return Math.min(4, Math.max(0.4, num / den));
}

export async function measureGamma(
  surfaceId: string, send: (m: MainToProjector) => void, opts: GammaOpts = {},
): Promise<GammaResult | { error: string }> {
  const levels = Math.max(3, opts.levels ?? 9);
  const settleMs = opts.settleMs ?? 160;
  slCapture.beginScan(surfaceId, send);
  try {
    // Black + white references → footprint mask (pixels the projector actually lights).
    const blackRef = await sampleField([0, 0, 0], settleMs, null, 0, 0);
    if ('error' in blackRef) return blackRef;
    const whiteRef = await sampleField([255, 255, 255], settleMs, null, 0, 0);
    if ('error' in whiteRef) return whiteRef;
    if (whiteRef.w !== blackRef.w || whiteRef.h !== blackRef.h) return { error: 'camera frame size changed' };

    const camW = whiteRef.w, camH = whiteRef.h, px = camW * camH;
    const wl = whiteRef.frame.data, bl = blackRef.frame.data;
    const mask = new Uint8Array(px);
    let footprintPx = 0;
    const THRESH = 30; // camera-luma rise (white − black) that counts as "lit"
    const black: [number, number, number] = [0, 0, 0];
    const white: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < px; i++) {
      const lw = luma(wl[i * 4], wl[i * 4 + 1], wl[i * 4 + 2]);
      const lb = luma(bl[i * 4], bl[i * 4 + 1], bl[i * 4 + 2]);
      if (lw - lb > THRESH) {
        mask[i] = 1; footprintPx++;
        black[0] += bl[i * 4]; black[1] += bl[i * 4 + 1]; black[2] += bl[i * 4 + 2];
        white[0] += wl[i * 4]; white[1] += wl[i * 4 + 1]; white[2] += wl[i * 4 + 2];
      }
    }
    if (footprintPx < 200) return { error: 'projector footprint not visible — aim the camera at the projection, dim the room, and disable camera auto-exposure' };
    for (let c = 0; c < 3; c++) { black[c] /= footprintPx; white[c] /= footprintPx; }

    // Above-black white amplitude per channel (the photometric span the projector can drive).
    const span: [number, number, number] = [white[0] - black[0], white[1] - black[1], white[2] - black[2]];
    if (Math.max(...span) < 12) return { error: 'projector too dim vs ambient — dim the room or raise camera exposure, then retry' };

    // Level ramp → normalised response per channel.
    const Ls: number[] = [];
    const samples: GammaSample[] = [];
    const normR: number[] = [], normG: number[] = [], normB: number[] = [];
    for (let k = 0; k < levels; k++) {
      const L = k / (levels - 1);
      const v = Math.round(L * 255);
      const s = await sampleField([v, v, v], settleMs, mask, camW, camH);
      if ('error' in s) return s;
      Ls.push(L);
      samples.push({ level: L, rgb: s.mean });
      normR.push(span[0] > 1 ? (s.mean[0] - black[0]) / span[0] : 0);
      normG.push(span[1] > 1 ? (s.mean[1] - black[1]) / span[1] : 0);
      normB.push(span[2] > 1 ? (s.mean[2] - black[2]) / span[2] : 0);
    }

    const gammaRGB: [number, number, number] = [fitGamma(Ls, normR), fitGamma(Ls, normG), fitGamma(Ls, normB)];
    // uGamma is a single float in the shader → use the channel average; per-channel differences are
    // absorbed by colorGain (white-point match) below.
    const gamma = Math.min(3, Math.max(0.5, (gammaRGB[0] + gammaRGB[1] + gammaRGB[2]) / 3));
    // Neutralise colour cast: scale each channel down to the dimmest (gain ≤ 1, no clipping).
    const minSpan = Math.min(...span);
    const colorGain: [number, number, number] = [
      span[0] > 1 ? minSpan / span[0] : 1, span[1] > 1 ? minSpan / span[1] : 1, span[2] > 1 ? minSpan / span[2] : 1,
    ];
    return { gamma, gammaRGB, colorGain, white: span, black, footprintPx, samples };
  } finally {
    slCapture.endScan();
  }
}
