import { BrowserWindow, screen } from 'electron';
import * as persistence from './persistence';

// Main-window UI scaling. We scale the whole editor chrome with one Electron zoom factor rather than a
// CSS/rem sweep: `setZoomFactor` multiplies every CSS px uniformly (chrome, icons, tokens, arbitrary
// widths) with zero token refactor. It is applied ONLY to the main window — projector output windows
// are separate BrowserWindows loading projector.html, so their physical-pixel warp math is untouched.

export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 2.0;
export const clampUiScale = (s: number): number => Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, s));

// First-run default from the primary display. devicePixelRatio alone is the wrong signal: a 4K panel at
// 100% OS scaling has DPR≈1 but tiny chrome, while at 150% Electron already renders scaled DIPs (chrome
// already right). So key off physical pixels vs. the OS scale factor already applied, and only bump when
// a high-density panel is NOT already being scaled by the OS.
export function detectDefaultUiScale(): number {
  try {
    const d = screen.getPrimaryDisplay();
    const physW = d.size.width * d.scaleFactor; // true physical pixels across the primary display
    if (d.scaleFactor >= 1.5) return 1.0;                    // OS already scales DIPs — don't double up
    if (d.scaleFactor < 1.25 && physW >= 3000) return 1.5;   // 4K/5K at ~100%
    if (d.scaleFactor < 1.5 && physW >= 3800) return 1.4;    // 4K at ~125%
    return 1.0;
  } catch { return 1.0; }
}

// The scale in effect: the user's saved value, else the auto-detected default. Not persisted until the
// user explicitly sets one, so an untouched install adapts to whatever display it launches on.
export function effectiveUiScale(): number {
  const saved = persistence.getPrefs().uiScale;
  return clampUiScale(typeof saved === 'number' ? saved : detectDefaultUiScale());
}

// Apply the effective scale to a window. Call ONLY on the main window. setZoomFactor does not survive a
// reload, so this is re-run on every did-finish-load (see createWindow).
export function applyUiScale(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.setZoomFactor(effectiveUiScale()); } catch { /* window torn down */ }
}

// Persist + apply an explicit scale (the Preferences slider). Returns the clamped value used.
export function setUiScale(win: BrowserWindow | null, scale: number): number {
  const clamped = clampUiScale(scale);
  persistence.setPrefs({ uiScale: clamped });
  applyUiScale(win);
  return clamped;
}

// Keyboard zoom (Ctrl +/−): step the current scale, persist + apply. One source of truth with the slider.
export function stepUiScale(win: BrowserWindow | null, delta: number): number {
  return setUiScale(win, effectiveUiScale() + delta);
}

// Ctrl+0 / "Reset to detected": back to the auto-detected default for this display.
export function resetUiScale(win: BrowserWindow | null): number {
  return setUiScale(win, detectDefaultUiScale());
}
