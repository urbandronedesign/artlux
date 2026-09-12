import * as matteGL from '@matte';

(globalThis as unknown as { __run: unknown }).__run = () => {
  const W = 64, H = 64;
  // Colour: a red/green split, already "over black". Matte: a left-to-right alpha ramp.
  const col = document.createElement('canvas'); col.width = W; col.height = H;
  const cg = col.getContext('2d')!;
  cg.fillStyle = '#f00'; cg.fillRect(0, 0, W / 2, H);
  cg.fillStyle = '#0f0'; cg.fillRect(W / 2, 0, W / 2, H);

  const mat = document.createElement('canvas'); mat.width = W; mat.height = H;
  const mg = mat.getContext('2d')!;
  for (let x = 0; x < W; x++) {
    const v = Math.round((x / (W - 1)) * 255);
    mg.fillStyle = `rgb(${v},${v},${v})`;
    mg.fillRect(x, 0, 1, H);
  }

  const out = matteGL.combine('test', col, mat, W, H);
  if (!out) return { ok: false, error: 'combine returned null (no WebGL2?)' };

  // Read it back through a 2D canvas, as the compositor would.
  const rc = document.createElement('canvas'); rc.width = W; rc.height = H;
  const rg = rc.getContext('2d', { willReadFrequently: true })!;
  rg.clearRect(0, 0, W, H);
  rg.drawImage(out, 0, 0);
  const d = rg.getImageData(0, 0, W, H).data;
  const at = (x: number, y: number) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
  const left = at(1, 32), mid = at(32, 32), right = at(W - 2, 32);
  // Expected alpha tracks the ramp; colour is red on the left half, green on the right.
  const expLeft = Math.round((1 / (W - 1)) * 255);
  const expRight = Math.round(((W - 2) / (W - 1)) * 255);
  return {
    ok: true, left, mid, right,
    alphaFollowsMatte: Math.abs(left[3] - expLeft) <= 6 && Math.abs(right[3] - expRight) <= 6,
    colourSideCorrect: left[0] > left[1] && right[1] > right[0],
    isAvailable: matteGL.isAvailable(),
  };
};
