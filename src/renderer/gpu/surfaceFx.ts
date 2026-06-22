import { buildPaletteLut } from './palettes';
import { SurfaceContent } from '../types';

// 2D generative effects rendered into a small offscreen canvas, used as a
// Surface's content (S2). Mirrors the per-LED effect names but produces a 2D
// field so a surface can be "filled" with an effect that fixtures then sample.

const FW = 96;
const FH = 96;
const LUT = buildPaletteLut(); // 256 × count RGBA

// Sample palette `pid` at position t (wrapped to [0,1)).
function pal(pid: number, t: number): [number, number, number] {
  const rows = LUT.count;
  const p = ((Math.floor(pid) % rows) + rows) % rows;
  let f = t - Math.floor(t);
  if (f < 0) f += 1;
  const x = Math.min(255, Math.max(0, Math.floor(f * 256)));
  const o = (p * 256 + x) * 4;
  return [LUT.data[o], LUT.data[o + 1], LUT.data[o + 2]];
}

export class SurfaceEffect {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private heat = new Float32Array(FW * FH);

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = FW;
    this.canvas.height = FH;
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(FW, FH);
  }

  render(c: SurfaceContent, t: number): HTMLCanvasElement {
    const eff = c.effectId ?? 0;
    const pid = c.paletteId ?? 0;
    const speed = c.speed ?? 0.5;
    const intensity = c.intensity ?? 0.5;
    const d = this.img.data;

    if (eff === 4) {
      this.fire(d, pid, intensity);
    } else {
      const sp = speed * 2;
      for (let y = 0; y < FH; y++) {
        for (let x = 0; x < FW; x++) {
          const u = x / FW;
          let col: [number, number, number];
          if (eff === 1) {
            col = pal(pid, u + t * sp * 0.1);                    // Rainbow scroll
          } else if (eff === 2) {
            col = pal(pid, u * (0.5 + intensity * 4) + t * sp * 0.15); // Palette Flow
          } else if (eff === 3) {
            const base = pal(pid, u);                            // Wave
            const w = 0.5 + 0.5 * Math.sin((u * (1 + intensity * 6) - t * sp * 0.5) * 6.2831853);
            col = [base[0] * w, base[1] * w, base[2] * w];
          } else {
            col = pal(pid, intensity);                           // Solid
          }
          const o = (y * FW + x) * 4;
          d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
        }
      }
    }

    this.ctx.putImageData(this.img, 0, 0);
    return this.canvas;
  }

  // Simple bottom-up 2D fire: ignite the bottom row, propagate + cool upward,
  // then map heat through the chosen palette.
  private fire(d: Uint8ClampedArray, pid: number, intensity: number): void {
    const h = this.heat;
    // Ignite bottom row.
    for (let x = 0; x < FW; x++) {
      h[(FH - 1) * FW + x] = Math.min(1, 0.55 + Math.random() * 0.45) * (0.45 + intensity * 0.55);
    }
    // Propagate upward with cooling.
    for (let y = 0; y < FH - 1; y++) {
      for (let x = 0; x < FW; x++) {
        const bx = (y + 1) * FW;
        const c = h[bx + x];
        const l = h[bx + Math.max(0, x - 1)];
        const r = h[bx + Math.min(FW - 1, x + 1)];
        h[y * FW + x] = Math.max(0, c * 0.5 + l * 0.25 + r * 0.25 - (0.008 + Math.random() * 0.05));
      }
    }
    // Map heat → palette.
    for (let i = 0; i < FW * FH; i++) {
      const col = pal(pid, Math.min(0.999, h[i]));
      const o = i * 4;
      d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
    }
  }
}
