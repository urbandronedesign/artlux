// Stable per-state identity colour. A scene/state carries one accent (Scene.accent) that appears
// on EVERY surface referring to it — the graph node, the timeline pill, the editor panel border,
// the author strip and the Scenes/Cues cell — so the operator's eye tracks one thing and never
// edits the wrong state's timeline. Colours are assigned round-robin from a fixed, high-contrast
// palette; assignment is deterministic given the existing set so a reopened project looks the same.

// Distinct hues that read well on the dark surface tokens (avoids the app's own --accent blue so a
// state's colour never masquerades as a UI-selection highlight).
const PALETTE = [
  '#f5a623', // amber
  '#7ed957', // green
  '#ff6b6b', // coral
  '#c77dff', // violet
  '#4dd0e1', // cyan
  '#ff9ff3', // pink
  '#ffd166', // gold
  '#06d6a0', // teal
  '#e07a5f', // terracotta
  '#a0c4ff', // periwinkle
] as const;

// Pick the next unused accent given the accents already in play; falls back to hashing the id so we
// stay deterministic (and never crash) once every palette slot is taken.
export function nextAccent(used: readonly (string | undefined)[], seedId?: string): string {
  const taken = new Set(used.filter(Boolean) as string[]);
  const free = PALETTE.find(c => !taken.has(c));
  if (free) return free;
  // All slots used — hash the id to a stable palette slot so re-renders don't shuffle colours.
  let h = 0;
  const s = seedId ?? '';
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

// The neutral colour used for the shared/global timeline (never a palette hue).
export const GLOBAL_ACCENT = '#8b94a3';
