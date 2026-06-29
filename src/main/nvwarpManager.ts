import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { screen } from 'electron';

// Loads the native NVAPI warp/blend addon (native/nvwarp/nvwarp.node) in the main process and applies
// a per-display scanout warp mesh + intensity/blend map on Quadro/RTX-pro GPUs. Like the calib/NDI
// addons it ships as a committed prebuilt; on non-NVIDIA hosts (or a stub build) `isAvailable()` is
// false and ArtLux uses its GLSL warp/blend instead. NVAPI scanout warp is a 2D framebuffer resample
// (it can't do 3D perspective) — its role is edge blend + lens distortion + persistence, on top of the
// calibrated 3D render. Addresses displays by NVAPI displayId, which we map to Electron display.id by
// matching the scanout source-desktop rect.

interface NvDisplayRaw { displayId: number; x: number; y: number; w: number; h: number }
interface NvWarpNative {
  available(): boolean;
  listDisplays(): NvDisplayRaw[];
  setWarping(displayId: number, verts: number[], src: number[]): boolean;
  setIntensity(displayId: number, w: number, h: number, rgb: number[]): boolean;
  clear(displayId: number): boolean;
}

const req = createRequire(__filename);

function loadNative(): NvWarpNative | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'nvwarp.node'), // packaged (extraResources)
    join(process.cwd(), 'native/nvwarp/nvwarp.node'),
    join(__dirname, '../../native/nvwarp/nvwarp.node'),
  ];
  for (const p of candidates) {
    try { if (existsSync(p)) return req(p) as NvWarpNative; } catch (e) { console.warn('[nvwarp] load failed at', p, e); }
  }
  return null;
}

const native = loadNative();
const hw = (() => { try { return !!native?.available(); } catch { return false; } })();
console.log(
  native
    ? hw ? '[nvwarp] NVAPI warp/blend available (Quadro/RTX-pro)'
         : '[nvwarp] addon loaded, NVAPI unavailable (stub build / non-pro GPU) — GLSL fallback'
    : '[nvwarp] addon missing — GLSL fallback',
);

export function isAvailable(): boolean { return hw; }

// Resolve an Electron display.id → NVAPI displayId by nearest desktop-rect origin. NVAPI source rects
// are physical px; Electron bounds are DIP, so we scale by the display's scaleFactor. Best-effort —
// validate on the real multi-display layout.
function nvIdForElectron(electronId: number): number | null {
  if (!native) return null;
  let nv: NvDisplayRaw[];
  try { nv = native.listDisplays(); } catch { return null; }
  if (!nv.length) return null;
  const el = screen.getAllDisplays().find((d) => d.id === electronId);
  if (!el) return null;
  const px = el.bounds.x * el.scaleFactor, py = el.bounds.y * el.scaleFactor;
  let best: NvDisplayRaw | null = null, bestD = Infinity;
  for (const c of nv) {
    const d = Math.abs(c.x - px) + Math.abs(c.y - py);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best?.displayId ?? null;
}

export function setWarp(electronId: number, verts: number[], src: number[]): boolean {
  if (!native) return false;
  const id = nvIdForElectron(electronId);
  if (id == null) return false;
  try { return native.setWarping(id, verts, src); } catch (e) { console.warn('[nvwarp] setWarping failed:', (e as Error)?.message ?? e); return false; }
}

export function setIntensity(electronId: number, w: number, h: number, rgb: number[]): boolean {
  if (!native) return false;
  const id = nvIdForElectron(electronId);
  if (id == null) return false;
  try { return native.setIntensity(id, w, h, rgb); } catch (e) { console.warn('[nvwarp] setIntensity failed:', (e as Error)?.message ?? e); return false; }
}

export function clearDisplay(electronId: number): boolean {
  if (!native) return false;
  const id = nvIdForElectron(electronId);
  if (id == null) return false;
  try { return native.clear(id); } catch (e) { console.warn('[nvwarp] clear failed:', (e as Error)?.message ?? e); return false; }
}

// Remove warp + intensity from every NVAPI display — called on quit so a crash/exit never leaves a
// projector (or the operator's screen) stuck with a scanout warp the app can no longer clear.
export function clearAll(): void {
  if (!native || !hw) return;
  try { for (const d of native.listDisplays()) native.clear(d.displayId); }
  catch (e) { console.warn('[nvwarp] clearAll failed:', (e as Error)?.message ?? e); }
}
