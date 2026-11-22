// Item 2d step 4 (plans/native-engine.md) — WHICH camera the engine should read for an app camera.
//
// The app names a camera by Chromium's deviceId (an HMAC salted per browser profile: it cannot be turned back
// into anything Windows knows) and by its track label, "<Windows friendly name> (<vid>:<pid>)" (measured:
// "Logi C270 HD WebCam (046d:0825)"). The engine names it by its Media Foundation symbolic link, which
// carries the same vid/pid. Name + vid:pid settles it whenever only one camera matches — different models.
// Two cameras of the SAME model match both, and nothing in either id tells them apart; then the engine reads
// each candidate shared and picks the one whose PICTURE is the app's. This fingerprint is the app's side of
// that: the mean luma of a 16 × 9 grid over the visible picture, in the frame's own (limited-range) Y bytes.
// The engine computes the same grid from its frames (cam.rs fingerprint, requantised to the app's range),
// so the two are equal up to noise for the same camera and far apart for a camera looking elsewhere.

export const FP_COLS = 16;
export const FP_ROWS = 9;

/** The fingerprint of a frame's Y plane: `y` laid out with `stride`, the visible rect `[x, y, w, h]`. */
export function lumaFingerprint(y: Uint8Array, stride: number, visible: [number, number, number, number]): number[] {
  const [vx, vy, vw, vh] = visible;
  const out: number[] = [];
  for (let r = 0; r < FP_ROWS; r++) {
    const y0 = vy + Math.floor((r * vh) / FP_ROWS), y1 = vy + Math.floor(((r + 1) * vh) / FP_ROWS);
    for (let c = 0; c < FP_COLS; c++) {
      const x0 = vx + Math.floor((c * vw) / FP_COLS), x1 = vx + Math.floor(((c + 1) * vw) / FP_COLS);
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += y[yy * stride + xx];
      out.push(Math.round(sum / Math.max(1, (y1 - y0) * (x1 - x0))));
    }
  }
  return out;
}

/** The same from a VideoFrame whose format is planar YUV with Y first (I420 / NV12 — what a camera gives). */
export async function frameFingerprint(frame: VideoFrame): Promise<number[] | null> {
  if (frame.format !== 'I420' && frame.format !== 'NV12') return null;
  const rect = { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
  const buf = new Uint8Array(frame.allocationSize({ rect }));
  const layout = await frame.copyTo(buf, { rect });
  const v = frame.visibleRect!;
  return lumaFingerprint(buf.subarray(layout[0].offset), layout[0].stride, [v.x, v.y, v.width, v.height]);
}

/** "<name> (<vid>:<pid>)" → its parts; a label without the suffix (a DirectShow-only device) has no ids. */
export function splitCameraLabel(label: string): { name: string; vid?: string; pid?: string } {
  const m = /^(.*) \(([0-9a-f]{4}):([0-9a-f]{4})\)$/i.exec(label.trim());
  return m ? { name: m[1], vid: m[2].toLowerCase(), pid: m[3].toLowerCase() } : { name: label.trim() };
}
