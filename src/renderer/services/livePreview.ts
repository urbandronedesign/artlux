// Imperative, render-free channel for live preview updates while a slider is being
// dragged. Writing here updates a CSS variable (consumed by the stage preview canvas
// filter) and a plain value (read each frame by the Stage rAF loop to drive the GPU
// mapper) — neither path triggers a React re-render, so dragging stays smooth. React
// state is only committed on pointer release.
let brightness = 1;

export const livePreview = {
  get brightness() {
    return brightness;
  },
  setBrightness(v: number) {
    brightness = v;
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--preview-brightness', String(v));
    }
  },
};
