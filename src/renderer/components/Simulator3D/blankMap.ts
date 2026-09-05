import * as THREE from 'three';

// A 1×1 OPAQUE WHITE TEXTURE THAT STANDS IN FOR "THIS MATERIAL HAS NO PICTURE YET".
//
// ── WHY A MATERIAL MUST NEVER BE BORN WITH `map = null` ──────────────────────────────────────────
//
// three's WebGPU renderer does not re-upload a texture just because you set `needsUpdate`. Every draw
// goes through `NodeMaterialObserver.needsRefresh(renderObject)`, and only when that says yes does the
// renderer run `bindings.updateForRender` → `textures.updateTexture` → the actual GPU copy. The
// observer answers by diffing a SNAPSHOT of the material's uniforms — and that snapshot is built once,
// lazily, into a module-level WeakMap keyed by the material, with this line in it:
//
//     for ( const property of refreshUniforms ) { const value = material[ property ];
//       if ( value === null || value === undefined ) continue;   // ← the whole bug
//
// A property that was null at snapshot time is therefore **never monitored again**, for the life of
// that material. `material.needsUpdate` does not rebuild the snapshot; nothing does.
//
// So a mesh whose material is created with no `map` and is handed one a few frames later — which is
// EXACTLY what a venue plane bound to an mp4 timeline layer does, because the decoder has to open
// before there is a first frame — gets a picture (the render object is new, so the first couple of
// draws refresh) and then **freezes on it forever**. Measured on the 3D viewport: the source
// VideoFrame advanced at 25 fps, `texture.version` climbed past 14 000, and the GPU texture was still
// the one uploaded at version 2. Nothing threw and nothing logged.
//
// It is a RACE, which is why it looked arbitrary: a still image resolves fast enough that its plane
// usually wins and keeps updating, while the mp4 plane beside it loses every time. And it only became
// permanent when the clip-boundary hold landed (see services/timeline.ts captureCodecHold): before
// that, every cut briefly returned a null drawable, which released the cache entry, disposed the
// texture and built a new one — a fresh render object, and with it an accidental refresh burst that
// was hiding this.
//
// ── THE RULE ─────────────────────────────────────────────────────────────────────────────────────
//
// Any material that will EVER be handed a live texture is constructed with `map: blankMap()`, and the
// "no picture" state assigns this instead of null (`mat.map = tex ?? blankMap()`). Then `map` is in
// the snapshot from the first frame, its id/version are diffed on every draw, and the upload happens.
//
// Assigning null back is not merely a missed refresh — once `map` IS monitored, the observer reaches
// `mtlValue.isTexture` on it and a null throws inside the render loop. Guarded by
// `npm run verify:invariants`.
//
// WHITE, so the stand-in is invisible: MeshBasicMaterial multiplies map × color, and the empty-state
// colour (#161616) has to come out unchanged from what it was when `map` was null. It also means the
// shader is compiled with USE_MAP from the start, so arriving content no longer forces a program
// rebuild — the one thing this makes cheaper rather than merely correct.

let blank: THREE.DataTexture | null = null;

/** The shared stand-in. One instance for the whole app — it is never written to and never disposed. */
export function blankMap(): THREE.DataTexture {
  if (!blank) {
    blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    blank.name = 'artlux-blank-map';
    blank.colorSpace = THREE.SRGBColorSpace;
    blank.minFilter = THREE.LinearFilter;
    blank.magFilter = THREE.LinearFilter;
    blank.generateMipmaps = false;
    blank.needsUpdate = true;
  }
  return blank;
}

/** True when a material is showing nothing — i.e. its map is the stand-in (or absent). */
export function isBlankMap(tex: THREE.Texture | null | undefined): boolean {
  return !tex || tex === blank;
}
