// A TYPEFACE THE SHOW CARRIES — loading an imported font file into this window.
//
// Naming a system family costs nothing and is lost the moment the show moves: the venue machine does
// not have it, Chromium substitutes silently, and the wall reads in the wrong face. Importing the file
// puts it in the project folder (assets/fonts/), where Collect Assets consolidates it, the missing
// badge reports it, and the path is relativised on save and resolved on open like every other asset.
//
// EVERY WINDOW LOADS IT SEPARATELY, and that is correct rather than wasteful: projector windows
// self-render their type (ProjectorApp's SELF_RENDER), so each one needs the face registered in its
// own document. This module runs per window and each keeps its own registry.
//
// LOADING IS ASYNC AND THE RASTER IS NOT. Until a face resolves, Canvas draws the fallback — so the
// picture would be permanently wrong unless something told the raster to try again. `revision()` is
// that: it bumps when any face finishes, the raster folds it into its signature, and the frame after a
// font lands is re-drawn with it. Without that the operator sees the substitute until they happen to
// touch an unrelated control.

import { mediaUrl } from '../../../shared/mediaUrl'; // host helper (transitional runtime seam)

interface Face { family: string; state: 'loading' | 'ready' | 'failed' }

const faces = new Map<string, Face>();   // absolute path → the face we registered for it
let rev = 0;

/** Bumped whenever a face finishes loading (or fails), so cached rasters know to redraw. */
export function revision(): number { return rev; }

// A family name of our own, so an imported file can never collide with a system family — and so two
// projects that both ship "Titling.otf" from different folders stay distinct.
function familyName(absPath: string): string {
  let h = 5381;
  for (let i = 0; i < absPath.length; i++) h = ((h * 33) ^ absPath.charCodeAt(i)) >>> 0;
  return `artlux-font-${h.toString(36)}`;
}

/**
 * The CSS family to draw `absPath` with, registering and loading it on first ask.
 *
 * Returns the family immediately, whether or not the bytes have arrived — Canvas falls back to
 * sans-serif meanwhile, and `revision()` is what redraws once they have. Null when fonts cannot be
 * registered at all (no FontFace), which leaves the caller on the named system family.
 */
export function familyFor(absPath: string): string | null {
  if (!absPath || typeof FontFace === 'undefined' || !document?.fonts) return null;
  const hit = faces.get(absPath);
  if (hit) return hit.family;

  const family = familyName(absPath);
  const entry: Face = { family, state: 'loading' };
  faces.set(absPath, entry);

  // Served over the project's own media scheme, which admits everything inside the project folder —
  // the same door images and video use, so no per-file grant is needed.
  const face = new FontFace(family, `url("${mediaUrl(absPath)}")`);
  face.load()
    .then((f) => { document.fonts.add(f); entry.state = 'ready'; rev++; })
    .catch(() => {
      // A missing or corrupt file must not take the surface down: the type keeps drawing in the
      // fallback face, and the asset library's own missing badge is what reports it.
      entry.state = 'failed';
      rev++;
    });
  return family;
}

/** Whether an imported face is on screen yet — for the editor to say so rather than leave it a mystery. */
export function stateOf(absPath: string): 'loading' | 'ready' | 'failed' | 'unknown' {
  return faces.get(absPath)?.state ?? 'unknown';
}
