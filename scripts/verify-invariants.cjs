#!/usr/bin/env node
/*
 * Source-level invariant verifier — the rules that are load-bearing but invisible.
 *
 * Every check below encodes a bug we actually shipped and then had to hunt. They share a shape that
 * makes them expensive: the code still compiles, the app still boots, nothing throws, and the failure
 * shows up as "I can't select my fixtures" or "Art-Net stopped" — hours later, on someone's rig. A
 * typechecker cannot see any of them, so they are asserted here instead.
 *
 * This reads SOURCE, not the build, so it is instant and runs before `npm run build`.
 * Wired as `npm run verify:invariants`; also part of `npm run verify`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const raw = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

/*
 * Every check below reads CODE, never prose. This repo comments densely and those comments name the
 * very things being asserted ("two <Simulator3D> mounts", "see ledUnderPointer") — matching raw text
 * both reports mounts that do not exist AND lets a stale comment satisfy a check whose call has been
 * deleted, which is the worse failure of the two.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .split(/\r?\n/)
    .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); })
    .join('\n');
}
const read = (p) => stripComments(raw(p));

/** Every .ts/.tsx under a directory. */
function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

/**
 * The body of `const <name> = (…) => { … }` OR `function <name>(…) { … }` — brace-matched, good enough
 * for our handlers. Both forms matter: a check that only knew the arrow form reported "not found" for a
 * plain function declaration, which reads as a broken guard rather than a passing one — but only
 * because it happened to be phrased as a failure. Handle both.
 */
function fnBody(src, name) {
  let i = src.indexOf(`const ${name} = `);
  if (i < 0) i = src.indexOf(`function ${name}(`);
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  return null;
}

/**
 * Brace-matched body starting at an arbitrary anchor — for the shapes fnBody() cannot see, notably
 * OBJECT-LITERAL METHODS (`releasePool(poolKey: string): void { … }`). fnBody returns null for those,
 * and a check written as `if (body && …)` then passes on the null: it reports "I could not find the
 * thing I guard" as success. Returns null when the anchor is absent, and callers MUST treat that as a
 * problem rather than as nothing to say.
 */
function braceBody(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
  }
  return null;
}

const checks = [];
const check = (name, why, fn) => checks.push({ name, why, fn });

// ── 3D: instanced meshes must refresh their bounding sphere ───────────────────────────────────
check(
  'InstancedMesh writes recompute boundingSphere',
  'THREE caches boundingSphere from the FIRST raycast and instanceMatrix.needsUpdate does NOT ' +
  'invalidate it, so the pickable region freezes wherever the instances were and later layout ' +
  'changes silently make objects unclickable.',
  () => {
    const bad = [];
    for (const f of walk('src/renderer')) {
      const src = read(f);
      if (src.includes('instanceMatrix.needsUpdate') && !src.includes('computeBoundingSphere')) bad.push(f);
    }
    return bad.length ? `writes instance matrices without computeBoundingSphere(): ${bad.join(', ')}` : null;
  },
);

// ── 3D: backdrop geometry must not swallow fixture picks ──────────────────────────────────────
check(
  '3D backdrop objects yield picks to fixtures',
  'Venue screens are large planes and fixtures sit ON them, so a screen is always nearer the ' +
  'camera. If its click handler calls stopPropagation() unconditionally, r3f (nearest-first) never ' +
  'reaches the fixture and fixtures become unselectable. Measured once at 648/649 clicks stolen.',
  () => {
    const bad = [];
    for (const f of ['src/renderer/components/Simulator3D/PlaneObject.tsx',
                     'src/renderer/components/Simulator3D/ModelObject.tsx']) {
      if (!exists(f)) { bad.push(`${f} (missing)`); continue; }
      const src = read(f);
      // The CALL, not the identifier: a leftover `import { ledUnderPointer }` would otherwise
      // satisfy this check after the guard itself had been deleted. (It did, first time out.)
      if (src.includes('stopPropagation') && !src.includes('ledUnderPointer(')) bad.push(f);
    }
    return bad.length ? `stopPropagation() without a ledUnderPointer() guard: ${bad.join(', ')}` : null;
  },
);

check(
  'fixtures have a pickable body',
  'The only pick target used to be an individual 12mm LED sphere — not something an operator can ' +
  'hit. FixtureBodies draws the housing that carries the click.',
  () => (exists('src/renderer/components/Simulator3D/FixtureBodies.tsx')
    ? null : 'src/renderer/components/Simulator3D/FixtureBodies.tsx is gone'),
);

// ── 3D: a gizmo gesture is a DELTA against the anchor's basis at grab time ────────────────────
check(
  'the fixture gizmo commits deltas, not the anchor\'s absolute transform',
  'The gizmo anchor does NOT always start at identity: for a single-fixture selection it is parked on ' +
  "that fixture's own rotation so the handles start aligned to it. Reading the anchor's absolute " +
  'orientation as if it were the drag then multiplies the fixture\'s rotation onto itself — a bar at ' +
  'yaw 30 dragged by 10 committed at yaw 70, silently, and only for fixtures that were already ' +
  'rotated (at yaw 0 the bug is the identity). Both halves of the subtraction must be snapshotted on ' +
  'mouseDown, and the same holds for scale.',
  () => {
    const G = 'src/renderer/components/Simulator3D/FixtureGizmo.tsx';
    const D = 'src/renderer/components/Simulator3D/gizmoDelta.ts';
    if (!exists(G)) return `${G} is gone — nothing owns the 3D transform gesture`;
    if (!exists(D)) return `${D} is gone — the preview and the commit have no shared maths to agree on`;
    const giz = stripComments(read(G));
    const del = stripComments(read(D));
    const problems = [];
    // The grab must capture the anchor's own basis, not only the centroid.
    if (!/quat:\s*anchor\.quaternion\.clone\(\)/.test(giz))
      problems.push('mouseDown no longer snapshots the anchor quaternion — the rotation delta has no origin to subtract');
    // …and the maths must subtract it. Reading the anchor's absolute rotation is the exact regression.
    if (/setFromEuler\(\s*anchor\.rotation\s*\)/.test(del))
      problems.push("the delta reads the anchor's ABSOLUTE rotation again (setFromEuler(anchor.rotation))");
    // The inverse may be named (it is also needed to scale a group in the anchor's frame), so accept
    // either form — what must hold is that the basis is INVERTED and multiplied onto the anchor.
    const inverted = /basis\.quat\.clone\(\)\.invert\(\)/.test(del);
    const applied = /anchor\.quaternion\.clone\(\)\.multiply\(\s*(?:invBasis|basis\.quat\.clone\(\)\.invert\(\))\s*\)/.test(del);
    if (!inverted || !applied)
      problems.push('the rotation is not anchorNow · anchorAtGrab⁻¹');
    // Per axis: three drives the three scale handles independently, so reading only .x throws two of
    // them away — which is exactly how "scale each axis" looked like it did nothing.
    for (const ax of ['x', 'y', 'z']) {
      if (!new RegExp(`anchor\\.scale\\.${ax}\\s*/\\s*\\(?basis\\.scale\\.${ax}`).test(del))
        problems.push(`the ${ax} scale factor is not measured against the anchor scale at grab time`);
    }
    // ONE implementation, called from both places. A second copy is how the preview and the committed
    // result drift — and that drift is only discoverable by letting go of the handle.
    const calls = (giz.match(/gizmoDelta\(/g) ?? []).length;
    if (calls < 2)
      problems.push(`FixtureGizmo calls gizmoDelta() ${calls}× — the live preview and the commit must both go through it`);
    return problems.length ? problems.join('; ') : null;
  },
);

// ── 3D: ONE place decides how big a fixture is ────────────────────────────────────────────────
check(
  'a fixture\'s scale is read through effectiveScale3',
  'A fixture carries two scale fields — the legacy uniform `scale3D` every project on disk has, and ' +
  'the per-axis `scaleXYZ` the gizmo writes. `effectiveScale3` is the only thing allowed to choose ' +
  'between them, the same doctrine as fixtureKind and fixtureFootprint. A call site that reads ' +
  '`f.scale3D` itself ignores a stretched fixture AND does it by drawing something plausible: a bar ' +
  'at the wrong length is not an error anybody notices until they measure the rig. The two places ' +
  'that genuinely cannot take three numbers (a beam cone, a light\'s reach) go through meanScale.',
  () => {
    const D = 'src/renderer/services/led3dDefaults.ts';
    if (!read(D).includes('export function effectiveScale3'))
      return `${D} no longer owns effectiveScale3 — nothing arbitrates the two scale fields`;
    const bad = [];
    for (const f of walk('src/renderer').concat(walk('plugins'))) {
      if (f.endsWith('led3dDefaults.ts')) continue;             // the resolver itself
      // The preview channel MERGES the two fields onto a fixture copy; it never decides a size from
      // them (its consumers still go through effectiveScale3), so a passthrough there is correct.
      if (f.endsWith('fixturePreview.ts')) continue;
      const src = stripComments(read(f));
      // Reading the RAW field anywhere else is the regression. `scaleXYZ:` as a written key is fine —
      // it is the read that has to be funnelled, and the layout signatures must name it to notice a
      // change at all, which is why this looks for a value read rather than any mention.
      if (/\bf(?:ixture)?\.scale3D\s*(?:&&|\?|\|\||[><=+*/)])/.test(src)) bad.push(f);
    }
    return bad.length ? `reads f.scale3D directly instead of effectiveScale3: ${bad.join(', ')}` : null;
  },
);

// ── 3D: a layout signature must name every field that MOVES a fixture ─────────────────────────
check(
  'the 3D layout signatures cover the whole transform',
  'InstancedLeds and FixtureBodies rebuild their instance buffers only when a JSON signature of the ' +
  'fixtures changes. A transform field missing from that signature does not throw and does not warn: ' +
  'the fixture simply never moves, and the inspector cheerfully shows the new value. Every field ' +
  'that positions, orients, sizes or lays out a fixture has to be named there.',
  () => {
    const bad = [];
    for (const f of ['src/renderer/components/Simulator3D/InstancedLeds.tsx',
                     'src/renderer/components/Simulator3D/FixtureBodies.tsx']) {
      const src = stripComments(read(f));
      const sig = src.match(/const \w*[Ss]ig\w* = useMemo\(\(\) => JSON\.stringify\([\s\S]*?\)\), \[fixtures\]\);/);
      if (!sig) { bad.push(`${f} (no layout signature found)`); continue; }
      for (const field of ['position3D', 'rotation3D', 'layout3D', 'scale3D', 'scaleXYZ', 'ledCount']) {
        if (!sig[0].includes(field)) bad.push(`${f} omits ${field}`);
      }
    }
    return bad.length ? bad.join('; ') : null;
  },
);

// ── 3D: the drag preview is a pointer-rate channel, never React state ─────────────────────────
check(
  'the fixture drag preview never re-renders',
  'The gizmo commits ONCE on release because App owns all state: pushing the fixtures array per ' +
  'pointer move re-renders the whole editor and re-runs computeLedPositions over every fixture ' +
  '(the same rule the Stage drag check states). The live preview exists so the operator can still ' +
  'see the drag — which only holds if it stays outside React entirely: a module channel the 3D ' +
  'renderers poll by revision in their own useFrame. A hook in that channel would reintroduce, at ' +
  'pointer rate, the exact cost the deferred commit was protecting.',
  () => {
    const P = 'src/renderer/components/Simulator3D/fixturePreview.ts';
    if (!exists(P)) return null; // preview removed entirely — the deferred commit alone is still valid
    const src = stripComments(read(P));
    const problems = [];
    if (/from ['"]react['"]/.test(src) || /useState|useEffect|useRef/.test(src))
      problems.push(`${P} imports React — it is a pointer-rate channel and must hold no hooks`);
    if (!/rev\+\+/.test(src))
      problems.push(`${P} no longer bumps a revision — consumers poll it to skip unchanged frames`);
    // Every consumer must poll, and none may recompute the pick geometry per frame: computeBoundingSphere
    // is an O(instances) walk whose only job is keeping a MOVED fixture clickable, which cannot happen
    // mid-drag. The committed rebuild does it on release.
    for (const f of ['src/renderer/components/Simulator3D/InstancedLeds.tsx',
                     'src/renderer/components/Simulator3D/FixtureBodies.tsx']) {
      const c = stripComments(read(f));
      if (!/previewRev\(\)/.test(c)) { problems.push(`${f} does not poll the preview revision`); continue; }
      const frame = c.match(/useFrame\(\(\)\s*=>\s*\{[\s\S]*?\n  \}\);/);
      if (frame && /computeBoundingSphere/.test(frame[0]))
        problems.push(`${f} recomputes its bounding sphere inside the frame loop — an O(n) walk per drag frame`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── 3D: an overlay pick target must be sized in PIXELS, not world units ───────────────────────
check(
  'calibration anchor markers are screen-constant',
  'The anchor marker was a 0.04-world-unit sphere: a 4 cm dot on a 12 m venue, and a blot the size ' +
  'of the model on a 30 cm one — because you zoom in to work on a small mesh and the marker grows ' +
  'with it. It raycasts and stops propagation, so once it covered the model every click aimed at the ' +
  'SURFACE hit an already-placed marker instead, and the mesh became unpickable after the first ' +
  'anchor. Scale it per frame from the camera distance; keep the geometry a unit sphere so the pick ' +
  'target tracks what is drawn.',
  () => {
    const f = 'src/renderer/components/Simulator3D/AnchorMarker.tsx';
    if (!exists(f)) return `${f} is gone — anchor markers must not be inlined back into Simulator3D`;
    const src = read(f);
    const problems = [];
    if (!src.includes('useFrame')) problems.push('does not rescale per frame (no useFrame)');
    if (!/sphereGeometry args=\{\[1\s*,/.test(src)) problems.push('geometry is not a unit sphere, so the drawn and pickable sizes can diverge');
    if (!/setScalar/.test(src)) problems.push('never writes a scale');
    // A world-unit radius creeping back into the scene file is the exact regression.
    const sim = read('src/renderer/components/Simulator3D/Simulator3D.tsx');
    if (/activePicks[\s\S]{0,600}?sphereGeometry/.test(sim)) problems.push('Simulator3D draws the anchor geometry itself again');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'an orbit drag does not place a calibration anchor',
  'r3f fires onClick on any press/release pair over an object, however far the pointer travelled in ' +
  'between, and applies no movement threshold of its own — it hands you `delta` and leaves it to you. ' +
  'Without that gate every drag that orbited the camera while starting and ending on the venue dropped ' +
  'an anchor nobody asked for, silently corrupting the pose solve.',
  () => {
    const bad = [];
    for (const f of ['src/renderer/components/Simulator3D/ModelObject.tsx',
                     'src/renderer/components/Simulator3D/PlaneObject.tsx']) {
      if (!exists(f)) { bad.push(`${f} (missing)`); continue; }
      const src = read(f);
      if (!src.includes('onCalibPick(')) continue;   // no pick path here to guard
      if (!/\.delta\s*>/.test(src)) bad.push(f);
    }
    return bad.length ? `places a calibration pick without a drag threshold on e.delta: ${bad.join(', ')}` : null;
  },
);

check(
  'the 3D near plane follows the orbit distance',
  'r3f defaults the near plane to a fixed 0.1 world units. The scene has no fixed scale, so on a ' +
  'small venue model that is a wall you cannot get past: you zoom in to place a calibration anchor ' +
  'and the mesh is sliced away before it fills the viewport. Nothing throws and nothing logs — the ' +
  'model just disappears as you approach it. It may be suspended for exactly ONE reason — a camera ' +
  'whose projection is driven from elsewhere (ProjectorView, looking through a calibrated ' +
  'projector), where adapting near/far would fight the intrinsic matrix every frame.',
  () => {
    const src = read('src/renderer/components/Simulator3D/Simulator3D.tsx');
    const problems = [];
    if (!src.includes('AdaptiveClipping')) return 'AdaptiveClipping is gone — the near plane is fixed again';
    const mount = src.match(/<AdaptiveClipping\b([^>]*)\/>/);
    if (!mount) problems.push('AdaptiveClipping is defined but never mounted inside the Canvas');
    // Mounted with props = it can be turned off. The only sanctioned reason is a driven camera, so
    // require that path to exist — otherwise this is a silent way to pin the near plane again.
    else if (mount[1].trim() && !/const ProjectorView/.test(src)) {
      problems.push('AdaptiveClipping is mounted conditionally but there is no driven-camera path (ProjectorView) to justify it');
    }
    if (!/updateProjectionMatrix\(\)/.test(src)) problems.push('writes near/far without updateProjectionMatrix() — the change never reaches the projection');
    // A literal near/far on the Canvas camera would silently win at creation time.
    if (/camera=\{\{[^}]*\bnear:/.test(src)) problems.push('the Canvas camera pins `near` literally');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Dragging a calibration point must not write the document per tick ─────────────────────────
check(
  'a live calibration drag stays out of the document',
  'Every write to an output re-renders the whole app (App owns the state, the tree is not memoised) ' +
  'AND re-pushes the full config to every projector window (the re-push effect depends on ' +
  'projectorOutputs). Writing per drag tick paid both several times a second to move one point, and ' +
  'it also re-uploaded each window\'s blend maps. The provisional position and pose must live in ' +
  'calibWorkspace\'s live-drag channel and reach the projection over the bridge; the document is ' +
  'written ONCE, on release. Symptom when broken: "it works but it is super laggy" — nothing throws.',
  () => {
    const src = read('plugins/calibration/src/calibWorkspace.ts');
    const problems = [];
    for (const fn of ['dragPickTo', 'liveSolve']) {
      const body = fnBody(src, fn);
      if (!body) { problems.push(`${fn} is gone — the live-drag channel has been dismantled`); continue; }
      if (/storeCalibration\s*\(/.test(body)) problems.push(`${fn} writes the document mid-drag (storeCalibration)`);
    }
    const end = fnBody(src, 'endPickDrag');
    if (!end) problems.push('endPickDrag is gone — a drag would never be committed');
    else if (!/storeCalibration\s*\(/.test(end)) problems.push('endPickDrag no longer commits the picks');
    // The release has to be reachable from all three surfaces a point can be dragged on.
    if (!/calibPointDragEnd/.test(read('plugins/calibration/src/plugin.renderer.ts'))) {
      problems.push('the projector-window release (calibPointDragEnd) is not routed — a drag there would only commit on the safety timeout');
    }
    if (!/onMovePickEnd/.test(read('src/renderer/App.tsx'))) {
      problems.push('the 3D marker release (onMovePickEnd) is not wired from App');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── A streamed frame must not arrive upside down on the projector ─────────────────────────────
check(
  'every 3D texture fed a streamed frame compensates for ImageBitmap',
  'three IGNORES Texture.flipY when the source is an ImageBitmap (WebGLTextures sets the unpack ' +
  'flags inside `if (isImageBitmap === false)`). The editor 3D view samples the live canvas/video ' +
  'and gets the flip; a projector window is streamed ImageBitmaps and does not. Miss the ' +
  'compensation and the content is upside down ON THE REAL PROJECTOR while the editor looks right — ' +
  'geometry perfectly aligned, picture mirrored, which reads like a broken calibration and is not ' +
  'one. matchBitmapOrientation (bitmapFlip.ts) does it with the texture matrix, which every source ' +
  'honours; fixing it at the bitmap instead would invert the 2D output that shares the same frame.',
  () => {
    const files = [
      'src/renderer/components/Simulator3D/useLayerTexture.ts',
      'src/renderer/components/Simulator3D/useSurfaceTexture.ts',
      'plugins/calibration/src/ProjectorScene.tsx',
      // The projector window's surface-texture path, extracted OUT of ProjectorScene when a mesh
      // gained the ability to bind any surface. A list that is not extended when the code moves
      // goes quietly vacuous: the check skips files with no `.image =`, so the entry above would
      // still pass while the assignment it was written for lives somewhere unguarded.
      'plugins/calibration/src/useStreamedSurfaceTexture.ts',
    ];
    const problems = [];
    let guarded = 0;
    for (const f of files) {
      const src = read(f);
      // Only the paths that assign a raw source to `.image` are at risk (a VideoTexture is not).
      if (!/\.image\s*=/.test(src)) continue;
      guarded++;
      if (!/matchBitmapOrientation\s*\(/.test(src)) problems.push(`${f} assigns texture.image without matchBitmapOrientation`);
    }
    // The whole list going vacuous is the failure this cannot otherwise see — if every streamed-frame
    // assignment has moved to a file nobody listed, the check passes while guarding nothing.
    if (guarded === 0) problems.push('no listed file assigns texture.image any more — the streamed-frame path moved and this list was not updated');
    if (!read('src/renderer/components/Simulator3D/bitmapFlip.ts').includes('repeat.y')) {
      problems.push('bitmapFlip no longer compensates via the texture matrix');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Projected UV mapping: one definition, and it honours the ImageBitmap flip ─────────────────
check(
  'a projected UV honours the ImageBitmap flip, and its V convention has one definition',
  'Projected mapping computes the texture coordinate in the FRAGMENT stage. three applies a ' +
  'texture\'s repeat/offset in the VERTEX stage (into vMapUv), so a fragment-computed UV bypasses it ' +
  'completely — including matchBitmapOrientation\'s compensation for ImageBitmap\'s ignored flipY. ' +
  'Miss it and content is upside down ON THE REAL PROJECTOR while the geometry stays perfectly ' +
  'aligned and the editor looks right: unfalsifiable from a screenshot, and it gets blamed on the ' +
  'lens or the solve. The V flip itself is empirically anchored, not derived, so a second copy of it ' +
  'anywhere would drift and put one window upside down relative to the other.',
  () => {
    const M = 'src/renderer/components/Simulator3D/projectedMapping.ts';
    if (!exists(M)) return `${M} is gone — nothing owns the projected-UV maths`;
    const m = read(M);
    // The flip compensation must be read back off the texture, not re-derived.
    for (const u of ['uMapRepeat', 'uMapOffset']) {
      if (!m.includes(u)) return `${M}'s fragment chunk no longer applies ${u} — the ImageBitmap flip is bypassed`;
    }
    if (!/artluxUv\s*=\s*artluxUv\s*\*\s*uMapRepeat\s*\+\s*uMapOffset/.test(m))
      return `${M} declares the map-transform uniforms but no longer applies them to the projected UV`;
    // Behind-the-projector rejection: without it those fragments get a mirrored, smeared copy.
    if (!/vProjPos\.w\s*<=\s*0\.0/.test(m))
      return `${M} no longer rejects fragments behind the projector — they will mirror-smear`;
    // Every installer of the chunk must mirror the texture transform when the texture changes.
    for (const f of ['src/renderer/components/Simulator3D/ModelObject.tsx', 'plugins/calibration/src/ProjectorScene.tsx']) {
      const src = read(f);
      if (!/makeProjectedMaterial\s*\(/.test(src)) continue; // not an installer (yet)
      if (!/syncMapTransform\s*\(/.test(src))
        return `${f} installs the projected material without calling syncMapTransform — its content ` +
          `will be upside down wherever the texture is a streamed ImageBitmap`;
    }
    // ONE definition of the NDC→UV V inversion. A second copy is how the two windows disagree.
    const others = ['src/renderer/components/Simulator3D/ModelObject.tsx', 'src/renderer/components/Simulator3D/PlaneObject.tsx', 'plugins/calibration/src/ProjectorScene.tsx'];
    for (const f of others) {
      if (!exists(f)) continue;
      if (/0\.5\s*-\s*[A-Za-z_.]*\.?y\s*\*\s*0\.5/.test(read(f)))
        return `${f} computes a UV from NDC again — the V convention must exist only in ${M}`;
    }
    return null;
  },
);

// ── A venue mesh binds to a SURFACE or a timeline LAYER — never both ──────────────────────────────
check(
  'every writer of a model content binding clears the other id',
  'SceneModel carries `surfaceId` AND `layerId`, and they are mutually exclusive — but the two ' +
  'readers break the tie in OPPOSITE directions. The panel\'s select shows `m.surfaceId ? ... : ' +
  'm.layerId` (surface wins) while ModelObject binds `useSurfaceTexture(model.layerId ? undefined : ' +
  'model.surfaceId)` (layer wins). So a model holding both is not merely ambiguous: the panel names ' +
  'one binding while the engine serves the other, and picking a surface from the select then appears ' +
  'to do NOTHING because the stale layerId still outranks it. The mesh sits at the "no texture" ' +
  'colour and nothing on screen explains why. The ★ Timeline (Program) button shipped exactly that ' +
  'bug: it set layerId and left surfaceId behind. Whichever id a writer sets, it must clear the other ' +
  'in the SAME update — the tie is then unreachable and neither reader\'s precedence can matter.',
  () => {
    const f = 'src/renderer/contexts/panels/scene3d.tsx';
    const src = read(f);
    const problems = [];
    // Paren-match each updateModel( call so a multi-line / ternary argument is read whole — a plain
    // regex stops at the first ')' and would silently pass the very shape this guards.
    for (let i = src.indexOf('updateModel('); i !== -1; i = src.indexOf('updateModel(', i + 1)) {
      const open = src.indexOf('(', i);
      let depth = 0, end = -1;
      for (let j = open; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end === -1) continue;
      const call = src.slice(i, end + 1);
      const touchesLayer = /\blayerId\b/.test(call);
      const touchesSurface = /\bsurfaceId\b/.test(call);
      if (!touchesLayer && !touchesSurface) continue; // an unrelated model update (transform, name, …)
      if (touchesLayer && touchesSurface) continue;   // sets one, clears the other — correct
      const line = src.slice(0, i).split('\n').length;
      problems.push(
        `${f}:${line} updateModel writes ${touchesLayer ? 'layerId' : 'surfaceId'} without clearing ` +
        `${touchesLayer ? 'surfaceId' : 'layerId'} — the model can hold both and the panel will ` +
        `disagree with what the engine renders`,
      );
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── The 3D scene's derived inputs are stable across a repaint ─────────────────────────────────
check(
  'projectorCalibs is memoized, and resolveProjectedScene is identity-stable',
  'This renderer REPAINTS PER FRAME during playback, so a prop built inline in JSX is a new array of ' +
  'new objects 60×/s. `projectorCalibs` was built that way, which was harmless while nothing derived ' +
  'from it — and then projected mapping started deriving every model\'s matrix from it, so the scene ' +
  'reallocated every SceneModel every frame and the 3D view fell to ~14 fps. The symptom was three ' +
  'files from the cause and looked like the shader was expensive; it was not. Two independent ' +
  'guards, because either alone would have prevented it: the prop is memoized, AND the resolver ' +
  'returns models by identity when nothing changed, so correctness never depends on a caller.',
  () => {
    const A = 'src/renderer/App.tsx';
    const a = read(A);
    if (/projectorCalibs=\{projectorOutputs/.test(a))
      return `${A} builds projectorCalibs inline in the Simulator3D props again — that is a new array ` +
        `per repaint, and everything derived from it recomputes at frame rate`;
    if (!/const projectorCalibs = useMemo\(/.test(a))
      return `${A} no longer memoizes projectorCalibs`;
    const R = 'plugins/calibration/src/projectedScene.ts';
    if (!exists(R)) return `${R} is gone — nothing resolves live projected mapping`;
    const r = read(R);
    // The early-out and the per-model identity check are the two halves of "idempotent".
    if (!/return scene;/.test(r))
      return `${R} no longer returns the SAME scene when there is nothing to resolve`;
    if (!/sameNums\(m\.uvProjView/.test(r))
      return `${R} reallocates a SceneModel even when the resolved matrix is unchanged — a per-frame ` +
        `caller will then churn the identity of every 3D object`;
    return null;
  },
);

// ── Selection: the two 3D selections must clear each other ────────────────────────────────────
check(
  'fixture/model selection is symmetric',
  'Simulator3D gates the fixture gizmo on `!selectedModelId`. If selecting a fixture does not clear ' +
  'the model, the click lands but nothing visibly happens — it reads as "fixtures cannot be selected".',
  () => {
    const src = read('src/renderer/App.tsx');
    const problems = [];
    const fix = fnBody(src, 'handleSelectFixture');
    const fixes = fnBody(src, 'handleSelectFixtures');
    const mod = fnBody(src, 'handleSelectModel');
    if (!fix || !mod || !fixes) return 'could not find handleSelectFixture / handleSelectFixtures / handleSelectModel in App.tsx';
    if (!fix.includes('setSelectedModelId')) problems.push('handleSelectFixture does not clear selectedModelId');
    if (!fixes.includes('setSelectedModelId')) problems.push('handleSelectFixtures does not clear selectedModelId');
    if (!mod.includes('setSelectedFixtureId')) problems.push('handleSelectModel does not clear the fixture selection');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Undo/redo: the document-history safety rules ──────────────────────────────────────────────
// Each clause here encodes a bug the widening would otherwise re-introduce (plans/timeline-undo.md):
// an unbounded stack an unattended show fills, a Ctrl+Z after File→Open that pastes the previous
// project, and a show event recorded as an operator edit.
check(
  'the undo stack is bounded and cleared on New/Open, and the show never records',
  'Without a depth cap the stack grows forever; without reset() on project load one Ctrl+Z restores ' +
  'the previous project; without the origin gate an FSM hopping states all night fills the stack.',
  () => {
    const problems = [];
    const hook = read('src/renderer/hooks/useHistory.ts');
    if (!/MAX_DEPTH/.test(hook)) problems.push('useHistory.ts has no MAX_DEPTH cap on the stack');
    const src = read('src/renderer/App.tsx');
    const apply = fnBody(src, 'applyProjectData');
    const reset = fnBody(src, 'resetToNewProject');
    if (!apply || !reset) return 'could not find applyProjectData / resetToNewProject in App.tsx';
    if (!apply.includes('resetHistory(')) problems.push('applyProjectData does not resetHistory() — undo would cross a project open');
    if (!reset.includes('resetHistory(')) problems.push('resetToNewProject does not resetHistory() — undo would cross File→New');
    const recall = fnBody(src, 'handleRecallScene');
    const cues = fnBody(src, 'applyCues');
    if (!recall || !cues) return 'could not find handleRecallScene / applyCues in App.tsx';
    if (!recall.includes("origin === 'operator'")) problems.push('handleRecallScene records unconditionally — a show recall would push history');
    if (!cues.includes("origin === 'operator'")) problems.push('applyCues records unconditionally — a show cue would push history');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Undo/redo: state-graph edits must be on the stack ─────────────────────────────────────────
check(
  'state-graph edits are recorded for undo',
  'stateMachine is in DocSnapshot, so an UNRECORDED graph edit is worse than un-undoable: undoing ' +
  'any unrelated recorded gesture silently reverts the graph work done since. Shipped exactly so — ' +
  'the machine viewport passed a bare setStateMachine for months (adapters.tsx, found 2026-08-07).',
  () => {
    const problems = [];
    // The adapter moved to contexts/panels/stateGraph.tsx (E5/W5i — it may open in a panel window).
    const adapters = read('src/renderer/contexts/panels/stateGraph.tsx');
    // The PROP WIRING, not just the identifier: the adapter must hand recordHistory to the editor.
    if (!/onRecordHistory=\{a\.recordHistory\}/.test(adapters))
      problems.push('stateGraph.tsx does not pass onRecordHistory={a.recordHistory} to StateGraphEditor');
    const sge = read('src/renderer/components/timeline/StateGraphEditor.tsx');
    const patchBody = sge.match(/const patch = [\s\S]*?onChange\(\{ \.\.\.sm, \.\.\.next \}\);/)?.[0] ?? '';
    if (!patchBody.includes('onRecordHistory'))
      problems.push('StateGraphEditor patch() no longer records history — every graph edit funnels through it, so the record must live there');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Undo/redo: the destructive deletes and 3D scene edits record; the gizmo commits must not ──
check(
  'destructive deletes and 3D scene edits record history, and the gizmo commits stay record-free',
  'Every one of these writes a DocSnapshot slice; an UNRECORDED write there is worse than ' +
  'un-undoable — undoing any unrelated gesture silently reverts it (the FSM shipped exactly that). ' +
  'And the commit paths must NOT record: the gizmos latch history at drag start, so a second, ' +
  'post-mutation record would make the next Ctrl+Z a visible no-op.',
  () => {
    const problems = [];
    const src = read('src/renderer/App.tsx');
    for (const fn of ['handleRemoveScene', 'handleRemoveSurface', 'addSceneModel', 'handleRemoveModel', 'handleSceneConfig']) {
      const body = fnBody(src, fn);
      if (!body) { problems.push(`could not find ${fn} in App.tsx`); continue; }
      if (!body.includes('recordHistory(')) problems.push(`${fn} does not recordHistory() — its slice is in DocSnapshot`);
    }
    // handleCommitModel is a braceless arrow fnBody can't see — assert over a source window instead.
    const cm = src.indexOf('const handleCommitModel');
    if (cm < 0) problems.push('could not find handleCommitModel in App.tsx');
    else if (src.slice(cm, cm + 300).includes('recordHistory(')) problems.push('handleCommitModel records — double-record with the gizmo latch');
    const cf = fnBody(src, 'handleCommitFixtures');
    if (!cf) problems.push('could not find handleCommitFixtures in App.tsx');
    else if (cf.includes('recordHistory(')) problems.push('handleCommitFixtures records — double-record with the gizmo latch');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Shell: context switching must carry the layout revision ───────────────────────────────────
check(
  'context switches go through goToContext()',
  'A banked layout slice wins over a context\'s declared layout, so the switch must carry layoutRev. ' +
  'Calling layoutStore.setContext directly means a shipped layout change silently never reaches an ' +
  'operator who already opened that context.',
  () => {
    const allowed = new Set(['src/renderer/services/layoutStore.ts', 'src/renderer/contexts/nav.ts']);
    const bad = walk('src/renderer')
      .filter((f) => !allowed.has(f) && read(f).includes('layoutStore.setContext('));
    return bad.length ? `calls layoutStore.setContext() directly: ${bad.join(', ')}` : null;
  },
);

// ── Shell: every reference to a workspace context must resolve ─────────────────────────────────
check(
  'workspace context ids referenced anywhere still exist',
  'Removing or renaming a context breaks four things and NONE of them raise: goToContext() no-ops on ' +
  'an unknown id, contextRegistry.extend() queues its patch forever in silence (a plugin\'s dock tabs ' +
  'just never appear), a CONTEXT_MENU_ITEMS entry renders a menu item that does nothing, and a stale ' +
  'RETIRED_CONTEXTS target leaves the rail with nothing selected. Dissolving `timeline` and merging ' +
  '`tracking` into `3d` touched all four.',
  () => {
    const core = read('src/renderer/contexts/index.tsx');
    // The ids core registers. Anchored on the `contextRegistry.register({ id: '…'` shape so a panel id
    // or an action id cannot be mistaken for a context.
    const live = new Set();
    for (const m of core.matchAll(/contextRegistry\.register\(\{\s*\n?\s*id:\s*'([^']+)'/g)) live.add(m[1]);
    if (live.size < 5) return `only found ${live.size} registered contexts — the register() shape this check greps for has changed`;

    const problems = [];
    const want = (id, where) => { if (!live.has(id)) problems.push(`${where} → '${id}' is not a registered context`); };

    // 1. The two static menus (both read this one array).
    for (const m of read('shared/protocol.ts').matchAll(/\{\s*id:\s*'([^']+)',\s*label:/g)) {
      // CONTEXT_MENU_ITEMS is the only `{ id, label }` array in that file that names contexts; entries
      // for anything else would fail here loudly rather than silently, which is the right direction.
      want(m[1], 'CONTEXT_MENU_ITEMS');
    }
    // 2. RETIRED_CONTEXTS values — the lookup is one hop, so a chain through a dead id does not resolve.
    const retired = read('src/renderer/services/layoutStore.ts').match(/RETIRED_CONTEXTS[^=]*=\s*\{([\s\S]*?)\}/);
    if (!retired) problems.push('layoutStore.ts no longer declares RETIRED_CONTEXTS');
    else for (const m of retired[1].matchAll(/:\s*'([^']+)'/g)) want(m[1], 'RETIRED_CONTEXTS');
    // 3. Literal goToContext('…') targets, host-wide.
    for (const f of walk('src/renderer')) {
      for (const m of read(f).matchAll(/goToContext\('([^']+)'\)/g)) want(m[1], f);
    }
    // 4. Plugin extend() targets — the silent one.
    for (const f of walk('plugins')) {
      for (const m of read(f).matchAll(/contexts\.extend\('([^']+)'/g)) want(m[1], f);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Shell: a context's declared layout must cover the banked visibility flags ──────────────────
check(
  'every context declares all four visibility flags',
  'setContext() spreads only the keys a context DECLARES over the live layout, so any banked key it ' +
  'omits silently keeps the OUTGOING context\'s value. Caught for real: `bottomOpen` was left ' +
  'undeclared, so opening the timeline drawer in Mapping made it appear pre-opened the first time you ' +
  'entered Venue & Rig — a per-context setting quietly behaving as a global one.',
  () => {
    const src = read('src/renderer/contexts/index.tsx');
    const flags = ['showLeft', 'showRight', 'dockOpen', 'splitView', 'bottomOpen'];
    const bad = [];
    // Each `id: '<x>', … layout: { … }` pair, in registration order.
    const ids = [...src.matchAll(/contextRegistry\.register\(\{\s*\n?\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
    const layouts = [...src.matchAll(/layout:\s*\{([^}]*)\}/g)].map((m) => m[1]);
    if (ids.length !== layouts.length) return `${ids.length} contexts but ${layouts.length} layout literals — one is missing a \`layout\``;
    ids.forEach((id, i) => {
      const missing = flags.filter((f) => !new RegExp(`\\b${f}\\s*:`).test(layouts[i]));
      if (missing.length) bad.push(`${id} omits ${missing.join('/')}`);
    });
    return bad.length ? bad.join('; ') : null;
  },
);

// ── Shell: exactly one 3D scene ───────────────────────────────────────────────────────────────
check(
  'the scene3d viewport id is declared once',
  'WorkspaceShell keeps the 3D viewport out of the left pane by comparing against its own constant. ' +
  'A second, independently-declared copy of the id could drift, and Simulator3D would then mount in ' +
  'BOTH panes: two WebGL contexts, two render loops.',
  () => {
    const lit = "'core.viewport.scene3d'";
    const decls = walk('src/renderer').filter((f) => read(f).includes(lit));
    return decls.length === 1
      ? null
      : `the literal ${lit} appears in ${decls.length} files (${decls.join(', ')}) — it must be declared once and re-exported`;
  },
);

check(
  'only one <Simulator3D> mount site',
  'The 3D scene is a persistent viewport. A second mount means two WebGL contexts fighting over the ' +
  'same scene, which shows up as halved frame rate rather than an error.',
  () => {
    const sites = walk('src/renderer').filter((f) => /<Simulator3D[\s/>]/.test(read(f)));
    return sites.length === 1 ? null : `mounted in ${sites.length} files: ${sites.join(', ')}`;
  },
);

// ── Shell: the engine-critical viewports ──────────────────────────────────────────────────────
check(
  'the timeline is mounted exactly once (through its store adapter, TimelineDock)',
  'Two TimelinePanels double its keyboard hook and its engine subscription, so one keypress seeks twice ' +
  'and one engine event is handled twice. ' +
  'NOTE: this guard used to cover <Stage> as well, on the grounds that unmounting it stopped Art-Net ' +
  'mid-show. That was true while the frame loop lived inside the component; it moved to ' +
  'engine/frameEngine.ts and lost its DOM gates, so the Stage is now an ordinary view and the ' +
  'assertion was DELIBERATELY DROPPED rather than kept as decoration. Free-form docking may legitimately ' +
  'want to place the 2D stage in more than one pane — see plans/engine-decoupling.md.',
  () => {
    // The editor mounts the timeline through its store adapter (components/timeline/TimelineDock.tsx, the
    // detached timeline); a panel window mounts the same adapter from contexts/detachable.tsx, in ITS
    // process. In the editor's tree it is App's, in one file — and nothing renders the bare <Timeline> but
    // the adapter.
    const tl = walk('src/renderer').filter((f) => /<TimelineDock[\s/>]/.test(read(f)));
    // contexts/detachable.tsx is the PANEL WINDOW's mount (the detached timeline). It must never reach the
    // editor's own registry: its entry is `mount: 'dock'` (the editor registers only the browser ones by
    // the loop) and contexts/index.tsx must not register it by id — or the editor's "+" menu would offer
    // a second timeline beside the drawer.
    const DET = 'src/renderer/contexts/detachable.tsx';
    const editorSide = tl.filter((f) => f.split(path.sep).join('/') !== DET);
    if (editorSide.length !== 1) return `<TimelineDock> appears in ${editorSide.length} editor files: ${editorSide.join(', ')}`;
    const det = read(DET);
    const entry = det.match(/\{ id: TIMELINE_WINDOW_PANEL,[^\n]*/);
    if (!entry || !/mount: 'dock'/.test(entry[0])) return `the window timeline's entry in ${DET} is missing or no longer mount: 'dock'`;
    if (/TIMELINE_WINDOW_PANEL|'core\.timeline'/.test(read('src/renderer/contexts/index.tsx'))) return 'contexts/index.tsx registers the window timeline in the editor';
    const bare = walk('src/renderer').filter((f) => /\.tsx$/.test(f) && /<Timeline[\s/>]/.test(read(f)) && !/TimelineDock\.tsx$/.test(f));
    return bare.length ? `the bare <Timeline> is rendered outside its adapter: ${bare.join(', ')}` : null;
  },
);

check(
  'one engine, and it is the only thing that publishes a frame',
  'Two FrameEngine instances would each run a rAF, each sample the GPU and each publish — the fixtures ' +
  'would receive two interleaved streams of DMX and the symptom would be flicker nobody can place. And ' +
  'if anything but the engine calls dmxSignal.publish(, then something outside the pipeline is claiming ' +
  'to have produced a frame: the DMX monitor, the 3D scene and the lighting recorder all trust that call ' +
  'as the authoritative per-frame truth.',
  () => {
    const problems = [];
    const eng = stripComments(read('src/renderer/engine/frameEngine.ts'));
    const built = (eng.match(/new FrameEngine\(/g) || []).length;
    if (built !== 1) problems.push(`FrameEngine is constructed ${built} times in frameEngine.ts — it is a singleton`);
    // Nobody else may construct one either.
    const others = walk('src/renderer')
      .filter((f) => f !== 'src/renderer/engine/frameEngine.ts' && /new FrameEngine\(/.test(stripComments(read(f))));
    if (others.length) problems.push(`FrameEngine constructed outside its module: ${others.join(', ')}`);
    // Publishing is the engine's alone. (Subscribing is open to anyone — that is what the bus is for.)
    const publishers = walk('src/renderer')
      .filter((f) => /dmxSignal\.publish\(/.test(stripComments(read(f))));
    if (publishers.length !== 1 || publishers[0] !== 'src/renderer/engine/frameEngine.ts') {
      problems.push(`dmxSignal.publish( is called from: ${publishers.join(', ') || '(nowhere)'} — only the engine may`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Shell: the single-instance global overlays ─────────────────────────────────────────────────
check(
  'HelpBrowser is mounted exactly once',
  'HelpBrowser is the ONLY help surface (the drawer merged into it), and it self-owns its open state ' +
  'via a global F1 keydown and a helpNav subscription. Two mounts double the shortcut and the ' +
  'subscription, so a single openHelp() opens two overlays and a deep-link scrolls the wrong one. It ' +
  'is a centered modal — mount it once beside CommandPalette in WorkspaceShell, never per-context.',
  () => {
    const hb = walk('src/renderer').filter((f) => /<HelpBrowser[\s/>]/.test(read(f)));
    return hb.length === 1 ? null : `<HelpBrowser> appears in ${hb.length} files: ${hb.join(', ')}`;
  },
);

// ── The frame loop belongs to the engine, and to nothing in the DOM ───────────────────────────
check(
  'the frame loop is owned by the engine, not by a component or a canvas',
  'This is the invariant the whole decoupling exists to create, and it is invisible the moment it is ' +
  'broken: put the rAF back in a component, or re-add a `if (!canvas) return` at the top of the ' +
  'loop, and Art-Net silently becomes a property of whether some React element happens to be mounted ' +
  '— which is how "Stage must never unmount" came to shape the entire workspace. The engine starts ' +
  'its own loop when its module loads, and the only gate on a frame is whether a GPU mapper exists.',
  () => {
    const eng = stripComments(read('src/renderer/engine/frameEngine.ts'));
    const stage = stripComments(read('src/renderer/components/Stage.tsx'));
    const problems = [];
    if (!/requestAnimationFrame\(/.test(eng)) {
      problems.push('frameEngine.ts must drive its own requestAnimationFrame');
    }
    if (/requestAnimationFrame\(/.test(stage)) {
      problems.push('Stage.tsx drives a requestAnimationFrame again — the loop belongs to the engine');
    }
    // The two gates that used to stop output when the view went away. Named so they cannot creep back
    // under their old names; the shape `if (!<something>Ready)` is the one to watch for.
    if (/domReady/.test(eng) || /domReady/.test(stage)) {
      problems.push('a domReady gate is back — output must not wait on the view being laid out');
    }
    // Covers the old single previewCanvas and today's per-surface map (`surfacePreviews.size`) —
    // the preview gate must stay INLINE around the paint, never a return out of the frame.
    if (/if\s*\(\s*!?\s*(this\.)?(previewCanvas|surfacePreviews(\.size)?)[^)]*\)\s*return/.test(eng)) {
      problems.push('the engine returns early on a missing preview target — the preview is cosmetic, output is not');
    }
    // The preview painter lives in the engine; the Stage only LENDS canvases. A Stage that grabs a
    // 2d context is a component painting frames again — the exact regression the extraction fixed.
    if (!/paintSurfacePreviews\(/.test(eng)) {
      problems.push('frameEngine.ts must own paintSurfacePreviews( — the per-surface preview painter belongs to the engine');
    }
    if (/\.getContext\(/.test(stage)) {
      problems.push('Stage.tsx calls .getContext( — painting belongs to the engine; the Stage only lends canvases');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the engine owns the GPU mapper and the wire, and the show modes mount no view',
  'Three things that all had the same shape: the pixel mapper was built and destroyed by a component ' +
  "effect, sending Art-Net was a dmxSignal SUBSCRIBER inside App (so putting frames on the wire was " +
  'something the document opted into, re-subscribing on every settings change), and headless mounted ' +
  'a hidden 1x1 Stage — a venue machine rendering a React viewport in an invisible one-pixel box so ' +
  'that DMX would come out. All three made output a consequence of the UI existing.',
  () => {
    const eng = stripComments(read('src/renderer/engine/frameEngine.ts'));
    const stage = stripComments(read('src/renderer/components/Stage.tsx'));
    const app = stripComments(read('src/renderer/App.tsx'));
    const problems = [];
    // Assert the CALLS: the engine constructs the mapper and puts frames on the wire.
    if (!/WebGPUMapper\.create\(/.test(eng) || !/new GPUMapper\(/.test(eng)) {
      problems.push('frameEngine.ts must construct the GPU mappers itself');
    }
    if (!/sendArtNetFrame\(/.test(eng)) problems.push('frameEngine.ts must be the one that calls sendArtNetFrame(');
    if (/WebGPUMapper\.create\(|new GPUMapper\(/.test(stage)) {
      problems.push('Stage.tsx builds a GPU mapper again — the engine owns it');
    }
    if (/sendArtNetFrame\(/.test(app)) {
      problems.push('App.tsx sends Art-Net again — that is the last step of a frame, not a document side effect');
    }
    // The hidden 1x1 Stage: the show branch must render nothing.
    const showBranch = /if\s*\(SHOW_ENGINE\)\s*\{\s*return([\s\S]{0,400}?)\n\s*\}/.exec(app);
    if (!showBranch) problems.push('could not find the SHOW_ENGINE branch — this guard has gone blind');
    else if (/<Stage[\s/>]/.test(showBranch[1])) {
      problems.push('headless/broadcast mounts a Stage again — the engine runs without a view');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the frame engine never imports React',
  'The whole point of engine/ is that the render/output pipeline outlives any component: it is what ' +
  'lets the Stage be an ordinary view instead of a thing that may never unmount because Art-Net ' +
  'depends on it. A single hook or React type dragged in here re-couples the loop to a render tree ' +
  'and the coupling comes back by the back door. Same discipline as services/ and gpu/, neither of ' +
  'which imports React either.',
  () => {
    const offenders = walk('src/renderer/engine').filter((f) => /(^|\n)\s*import[^;]*['"]react['"]/.test(read(f)));
    return offenders.length ? `engine files importing React: ${offenders.join(', ')}` : null;
  },
);

// ── One render clock, and both frame loops stand down for it ──────────────────────────────────
check(
  'there is ONE render clock, and both frame loops stand down for an offline render',
  'The render path used to read performance.now() in four unrelated places: the two timeline anchors, ' +
  'the scene/cue fade stamp and the lighting-cue tick. Four epochs that agreed only because they all ' +
  'happened to read the wall. An offline bake steps time forward as fast (or as slowly) as the decoders ' +
  'can serve it, and anything still reading the wall then runs at WALL speed while everything else runs ' +
  'at bake speed: a two-second scene fade completes in two real seconds no matter how many baked frames ' +
  'went past. Worse, a live loop left running is a SECOND driver on a single-playhead decoder, and ' +
  'mp4Decoder reads that as a backward scrub and answers by dropping its buffer, so the bake silently ' +
  'records neighbouring frames instead of the ones it asked for. Hence: engine/renderClock.ts is the ' +
  'single answer to what time this frame is, both rAF loops return early while it is offline, and ' +
  'stepFrame() refuses to run a frame when it is not.',
  () => {
    const F = 'src/renderer/engine/renderClock.ts';
    if (!exists(F)) return F + ' is gone — the render path has gone back to reading the wall directly';
    const clock = stripComments(read(F));
    const eng = stripComments(read('src/renderer/engine/frameEngine.ts'));
    const tl = stripComments(read('src/renderer/services/timeline.ts'));
    const tr = stripComments(read('src/renderer/services/transitions.ts'));
    const problems = [];

    // The clock is a LEAF. It is read from the hottest loop in the app and lives under engine/, so it
    // must not drag a dependency (or an import cycle) in behind it.
    if (/(^|\n)\s*import\s/.test(clock)) problems.push('renderClock.ts has grown an import — it must stay a zero-import leaf');
    for (const fn of ['now', 'isOffline', 'beginOffline', 'endOffline', 'stepTo', 'subscribe']) {
      if (!clock.includes('export function ' + fn) && !clock.includes('export const ' + fn)) {
        problems.push('renderClock no longer exports ' + fn + '()');
      }
    }

    // Both loops gate, or the bake and the show fight over the same decoders.
    if (!/renderClock\.isOffline\(\)/.test(eng)) problems.push('frameEngine no longer stands down for an offline render — it would drive the decoders underneath the bake');
    if (!/renderClock\.isOffline\(\)/.test(tl)) problems.push('timeline no longer stands down for an offline render — the transport would advance at wall speed under the bake');

    // stepFrame is the offline driver and must refuse in live mode: two drivers on one transport is
    // exactly the failure the gates above exist to prevent.
    // braceBody, not fnBody: stepFrame is an OBJECT-LITERAL METHOD on `timeline`, the shape fnBody
    // cannot see (see its own note). A null here is a problem, never nothing to say.
    const step = braceBody(tl, 'stepFrame(): void');
    if (!step) problems.push('timeline.stepFrame() is gone — an offline render has no way to advance the transport');
    else if (!/isOffline\(\)/.test(step)) problems.push('stepFrame() no longer refuses in live mode — it would run an extra frame indistinguishable from a dropped one');

    // The anchors and the fade stamp must share the clock epoch, or a fade sampled offline against a
    // wall-stamped start finishes instantly (or never).
    if (/originMs = performance\.now\(\)/.test(tl)) problems.push('a timeline anchor reads performance.now() again — it must ride renderClock so the epoch cannot split');
    if (/startMs: performance\.now\(\)/.test(tr)) problems.push('transitions stamps a fade with performance.now() again — frameEngine samples it with renderClock, and the two must share an epoch');

    return problems.length ? problems.join('; ') : null;
  },
);

// ── App holds no clock of its own ─────────────────────────────────────────────────────────────
check(
  'per-second telemetry never lives in App state',
  'App owns every piece of document state, so ONE of its renders reconciles the whole editor: every ' +
  'useEditor() panel, all five persistent viewports, Stage, the 3D scene and the timeline. renderFps ' +
  'and the pacer\'s outputStats are two numbers drawn in one corner of the status bar, and holding ' +
  'them as App state rebuilt that entire tree twice a second, forever, while completely idle ' +
  '(measured: 6 viewport commits per idle second → 0 once they moved out). They live in ' +
  'services/telemetry; only the status bar subscribes.',
  () => {
    const app = stripComments(read('src/renderer/App.tsx'));
    const bar = stripComments(read('src/renderer/components/StatusBar.tsx'));
    const problems = [];
    // Assert the CALL, and exclude the store's own setters: `setOutputStats(` is a SUBSTRING of
    // `telemetry.setOutputStats(`, so a naive match flags the very code that fixes this.
    if (/(?<![\w.])setFps\(/.test(app) || /(?<![\w.])setOutputStats\(/.test(app)) {
      problems.push('App.tsx still setStates a per-second counter (setFps/setOutputStats) — that is a whole-editor re-render per tick');
    }
    if (!/telemetry\.setRenderFps\(/.test(app) || !/telemetry\.setOutputStats\(/.test(app)) {
      problems.push('App.tsx must push renderFps + outputStats into services/telemetry');
    }
    if (!/useSyncExternalStore\(\s*telemetry\.subscribe/.test(bar)) {
      problems.push('StatusBar.tsx must read telemetry via useSyncExternalStore(telemetry.subscribe, …)');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── ...and neither does the timeline ──────────────────────────────────────────────────────────
check(
  'the timeline never puts a clock in React state',
  'The timeline panel is open in eight of the nine workspace contexts and one render of it costs ' +
  '~22 ms — toolbar, ruler, every track header, every clip, every lane. It used to sample the ' +
  'playhead AND the show clock into React state on a 100 ms setInterval, purely so the automation ' +
  'lanes could print a live value in their gutter: ten full renders a second, for ever, whether or ' +
  'not the transport was moving and whether or not a single automation lane existed. Measured at ' +
  '177-224 ms/s of React commit time on a real project while COMPLETELY IDLE, and it is where the ' +
  'p99 render time went from 54 ms to 155 ms under load. A clock is not state: the lanes read it ' +
  'themselves and write their own text straight to the DOM, exactly as the 60 Hz playhead and ' +
  'timecode have always been drawn. The 1 Hz target re-enumeration that remains must be able to say ' +
  '"nothing changed" and cost nothing, or it is the same bug at a tenth of the rate.',
  () => {
    const tl = read('src/renderer/components/timeline/Timeline.tsx');
    const lane = read('src/renderer/components/timeline/AutomationLane.tsx');
    const problems = [];
    // A timer that samples the clock is the defect itself — whatever it then does with the value.
    for (const m of tl.matchAll(/setInterval\s*\(([\s\S]{0,300}?)\},?\s*\d+\s*\)/g)) {
      if (/get(Playhead|ShowTime)\s*\(/.test(m[1])) {
        problems.push('Timeline.tsx samples the engine clock inside a setInterval again — that is a whole-panel render per tick');
        break;
      }
    }
    // The surviving 1 Hz poll must be idempotent. Returning `prev` hands React the same object, which
    // is the only reason a poll that finds nothing new costs nothing.
    if (!/setDefs\(\s*prev\s*=>\s*\(?\s*prev\.sig\s*===\s*sig\s*\?\s*prev/.test(tl)) {
      problems.push('Timeline.tsx no longer bails out of the 1 Hz target poll when the enumeration is unchanged — it re-renders the panel once a second regardless');
    }
    // The lane is told WHICH clock, and reads it; it is never handed a sample of one.
    if (/playhead\s*:\s*number/.test(lane)) {
      problems.push('AutomationLane takes a playhead NUMBER again — someone has to sample a clock into state to feed it');
    }
    if (!/clock\s*:\s*'playhead'\s*\|\s*'show'/.test(lane)) {
      problems.push('AutomationLane must take the NAME of its clock (clock: \'playhead\' | \'show\'), not a value');
    }
    // ...and the readout it draws with it must stay render-free.
    if (!/engine\.subscribe\(/.test(lane) || !/liveRef\.current/.test(lane)) {
      problems.push('AutomationLane no longer writes its live readout to the DOM via engine.subscribe — it is going through a render again');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the timeline ruler and toolbar are memoized, and handed props that hold still',
  'Dragging a clip setStates a draft on every pointer move, so the panel re-renders at pointer rate — ' +
  'that part is correct, the clip has to follow the cursor. Rebuilding the RULER with it is not: it ' +
  'renders one tick element across the full width, and the timeline is unbounded, so that width grows ' +
  'as the show runs (measured live at 32,957 px — some 800 ticks). Attribution over a real drag put it ' +
  'at 170 ms of the panel\'s 341, with the toolbar at 61 and the lanes at 9.5 — which is why these two ' +
  'are memoized and the lanes are not. A memo is only worth its compare if the props hold still, and ' +
  'each of these three is a way to make it silently inert: an inline arrow handler, or a ' +
  '`timeline.markers ?? []` that mints a fresh array on every render of the common case.',
  () => {
    const ruler = read('src/renderer/components/timeline/TimelineRuler.tsx');
    const toolbar = read('src/renderer/components/timeline/TimelineToolbar.tsx');
    const tl = read('src/renderer/components/timeline/Timeline.tsx');
    const problems = [];
    if (!/React\.memo\(TimelineRulerBase\)/.test(ruler)) problems.push('TimelineRuler is no longer memoized');
    if (!/React\.memo\(TimelineToolbarBase\)/.test(toolbar)) problems.push('TimelineToolbar is no longer memoized');
    // The handlers must arrive as the stable bags, not as fresh closures per render.
    if (!/\{\.\.\.rulerHandlers\}/.test(tl) || !/useStableHandlers\(/.test(tl)) {
      problems.push('Timeline.tsx no longer hands the ruler one stable bag of handlers — every compare will fail');
    }
    if (!/\{\.\.\.toolbarHandlers\}/.test(tl)) {
      problems.push('Timeline.tsx no longer hands the toolbar one stable bag of handlers — every compare will fail');
    }
    // ...and the array that a document without markers would otherwise re-mint forever.
    if (/markers=\{timeline\.markers\s*\?\?\s*\[\]\}/.test(tl)) {
      problems.push('Timeline.tsx passes `timeline.markers ?? []` again — a new array per render defeats the ruler memo');
    }
    if (!/const EMPTY_MARKERS/.test(tl)) problems.push('Timeline.tsx lost EMPTY_MARKERS, the shared empty array the ruler memo depends on');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── The dock tree stays pure, and every read of a saved one goes through the same door ────────
check(
  'the dock tree imports nothing, and no saved tree is trusted without sanitizing',
  'services/dockTree.ts is the docking model: the tree, the ops, the compiler that derives one from a ' +
  "context's flat manifest. It imports NOTHING — not React, not the registries, not even the SDK's " +
  'WorkspaceContext type (it takes a structural view instead). That is not tidiness: it is what lets ' +
  '`npm run test:docktree` verify 40+ behavioural rules in a second with no Electron and no app, ' +
  'instead of someone dragging panels around by hand and hoping. One import of a registry or a React ' +
  'hook ends that, permanently. The second half is the door: a tree read off disk is operator data ' +
  'that has survived version changes, disabled plugins and hand edits, so it reaches the renderer only ' +
  'through `ensureTree` (sanitize, else re-derive) — a raw `layout.contexts[x].dockTree` handed ' +
  'straight to a renderer is how a corrupt slice becomes a white screen.',
  () => {
    const src = read('src/renderer/services/dockTree.ts');
    const problems = [];
    const imports = [...src.matchAll(/(^|\n)\s*import\s[^;]*from\s*['"]([^'"]+)['"]/g)].map((m) => m[2]);
    if (imports.length) problems.push(`dockTree.ts imports ${imports.join(', ')} — it must stay dependency-free`);
    if (!/export function ensureTree\(/.test(src)) problems.push('dockTree.ts lost ensureTree, the single door onto a saved tree');
    if (!/export function sanitizeDockTree\(/.test(src)) problems.push('dockTree.ts lost sanitizeDockTree');
    // Nothing outside this module may reach for a saved tree directly.
    for (const f of walk('src/renderer').concat(walk('plugins'))) {
      if (/services[\\/]dockTree\.ts$/.test(f)) continue;
      if (/\.dockTree\b/.test(read(f)) && !/ensureTree\(/.test(read(f))) {
        problems.push(`${f} reads a saved dockTree without going through ensureTree()`);
      }
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a named workspace is prepared before it is applied, and carries nothing machine-specific',
  'A workspace (services/workspaceStore.ts) is a saved shell arrangement that can arrive from ANOTHER ' +
  'MACHINE, so every way it can be wrong is silent: the app boots, nothing throws, and the shell is the ' +
  'wrong shape. Four rules hold it together. (1) `preparePortable` is the single door — it clamps a ' +
  "4K-authored column onto a laptop, refuses a dock tree this build cannot read, and remaps a workbench " +
  'id that has been retired or is absent here; skipping it is how a workspace lands on a workbench that ' +
  "does not exist and leaves the rail with NOTHING SELECTED, because goToContext() no-ops on an id it " +
  'cannot resolve. (2) That file stays pure (dockTree + types only), which is what lets the rules be ' +
  'tested without an app. (3) An apply never routes through layoutStore.set(), which would stamp ' +
  "activePreset='custom' and re-enter the manual-edit path mid-apply. (4) PortableLayout carries no " +
  'per-MACHINE key: `Prefs` draws that line already (uiScale, the scene3d group, calibrationFile, ' +
  'mediaView, shortcuts describe THIS machine, not the job), and a shared file that quietly rewrote a ' +
  "recipient's UI scale or their keyboard would be worse than no sharing at all.",
  () => {
    const problems = [];
    const pure = 'src/renderer/services/workspacePortable.ts';
    const store = 'src/renderer/services/workspaceStore.ts';
    const src = read(pure);

    // 2 — purity. Only dockTree (itself import-free) and type-only imports may appear.
    for (const m of src.matchAll(/(^|\n)\s*import\s+(type\s+)?([^;]*?)from\s*['"]([^'"]+)['"]/g)) {
      const typeOnly = !!m[2] || /^\s*\{\s*type\s/.test(m[3]);
      if (m[4] !== './dockTree' && !typeOnly) {
        problems.push(`${pure} imports ${m[4]} at runtime — it must stay verifiable without an app`);
      }
    }
    if (!/export function preparePortable\(/.test(src)) problems.push(`${pure} lost preparePortable, the single door onto a saved workspace`);
    // The three things prepare() must still do. Each was a silent failure before it existed.
    if (!/sanitizeDockTree\(/.test(src)) problems.push(`${pure} no longer sanitizes a saved dock tree`);
    if (!/hasContext\(/.test(src)) problems.push(`${pure} no longer verifies the workbench exists on this machine`);
    if (!/env\.remap\(/.test(src)) problems.push(`${pure} no longer remaps a retired workbench id`);

    // 1 — nobody applies a workspace layout without going through it.
    if (!/preparePortable\(/.test(read(store))) problems.push(`${store} applies a workspace without preparing it`);
    for (const f of walk('src/renderer').concat(walk('plugins'))) {
      if (f.endsWith('workspaceStore.ts') || f.endsWith('workspacePortable.ts')) continue;
      const s = read(f);
      // `.applyPortable(` is the CALL; layoutStore.ts's own method definition has no dot.
      if (/\.applyPortable\(/.test(s)) problems.push(`${f} calls layoutStore.applyPortable directly — go through workspaceStore`);
    }

    // 3 — an apply is not a manual edit.
    if (/applyPortable\([^)]*\)[\s\S]{0,200}?layoutStore\.set\(/.test(read(store))) {
      problems.push(`${store} routes an apply through layoutStore.set()`);
    }

    // 4 — the per-machine keys stay out of the portable type AND out of what is captured.
    const portableType = /export type PortableLayout =([\s\S]*?);\n/.exec(src);
    const captured = /export function captureLive\(\)[\s\S]*?\n}/.exec(read(store));
    for (const key of ['uiScale', 'mediaView', 'scene3dRenderScale', 'scene3dMaxFps', 'calibrationFile', 'shortcuts']) {
      if (portableType && portableType[1].includes(`'${key}'`)) problems.push(`PortableLayout carries the per-machine key ${key}`);
      if (captured && captured[0].includes(key)) problems.push(`captureLive() puts the per-machine key ${key} into a workspace`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the persistent viewports are positioned, never reparented, and never followed through React state',
  'Stage, Simulator3D and TimelinePanel are elements App owns, and a dock tree may place a panel ' +
  'anywhere — so the tree renders empty slots and PersistentLayer draws the real element over the ' +
  'winning one. Three things about how it does that are load-bearing. It POSITIONS rather than ' +
  'reparents: createPortal would move the DOM node on every layout change, which loses a canvas\'s ' +
  'contents and can drop a WebGL context outright, and would re-run the very effects whose single ' +
  'registration the timeline depends on. It writes STYLES rather than state: following a rect is a ' +
  'per-frame job, and doing it in React would re-render the shell at pointer rate — measured, the loop ' +
  'adds 0 ms/s on top of the splitter\'s own cost, and that is the number to keep. And its flag is read ' +
  'ONCE at module load: flipping it at runtime changes the element type at those positions and remounts ' +
  'all three, so a debug toggle would cost a WebGL context and double a keyboard hook.',
  () => {
    const layer = read('src/renderer/components/shell/PersistentLayer.tsx');
    const problems = [];
    if (/useState\s*[(<]/.test(layer)) {
      problems.push('PersistentLayer.tsx uses useState — the follow loop must write styles, not re-render');
    }
    // The DYNAMIC write specifically. A first version of this check asked only for `.style.transform =`
    // and passed a build with the positioning line deleted, because the PARKED branch also writes a
    // (static) transform — a guard that matches the wrong line is worse than no guard.
    if (!/style\.transform = `translate\(\$\{/.test(layer)) {
      problems.push('PersistentLayer.tsx no longer positions by writing a computed style.transform');
    }
    if (!/if\s*\(!PERSISTENT_LAYER_ENABLED\)|PERSISTENT_LAYER_ENABLED\s*$|const PERSISTENT_LAYER_ENABLED: boolean = \(\(\) =>/m.test(layer)) {
      problems.push('PERSISTENT_LAYER_ENABLED is no longer a module constant computed once');
    }
    // Reparenting a persistent viewport is the rejected design; keep it rejected.
    for (const f of walk('src/renderer/components/shell')) {
      if (/createPortal/.test(read(f))) problems.push(`${f} uses createPortal — persistent viewports are positioned, not reparented`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'docking drags on pointer events, resets by recompiling, and cannot dock a modal panel',
  'Three rules the docking UI has to keep. (1) PANEL DRAGS USE POINTER EVENTS, never HTML5 ' +
  'drag-and-drop: that channel already carries application/artlux-asset and application/artlux-take ' +
  'between the media library, the lanes and the stage, so sharing it would light every lane up as a ' +
  'drop target while you rearrange — and it carries Chromium\'s documented footgun where a file ' +
  'dropped somewhere unhandled NAVIGATES THE WINDOW, which in a venue means the editor is gone. ' +
  '(2) RESET RECOMPILES through defaultTreeOf, so the way back is always exactly what the context ' +
  'ships, including whatever a plugin has contributed since; a hand-built "default" tree would drift ' +
  'from the manifest the moment either changed. (3) A `mount: "modal"` panel is NOT offerable: those ' +
  'render outside <EditorStore>, so a useEditor() call inside one throws the instant it is docked.',
  () => {
    const files = walk('src/renderer/components/shell');
    const problems = [];
    for (const f of files) {
      const src = read(f);
      // A BARE `draggable` attribute counts too — the first version of this check only matched
      // `draggable=`, so the shortest way to reintroduce HTML5 dragging would have walked straight past.
      if (/onDragStart=|onDragOver=|onDrop=|dataTransfer|\sdraggable[=\s/>]/.test(src)) {
        problems.push(`${f} uses HTML5 drag-and-drop — panel drags are pointer events`);
      }
    }
    const dock = read('src/renderer/components/shell/DockRenderer.tsx');
    // ── The two ways a pane's flex can paint the workspace black, both reported from a real window ──
    // A px pane that cannot shrink overflows the workspace in a short window and paints over the
    // timeline drawer; and `fr` factors that sum to under 1 leave the REST of the free space
    // undistributed, which is a black band across the middle. Both are one-property mistakes that look
    // completely reasonable in the source.
    // Each assertion names the EXACT expression, not a token that survives the mistake: there are two
    //  in the file and three mentions of frSum, so the loose versions of these checks
    // both passed a deliberately broken build.
    if (!/flexGrow: 0, flexShrink: 1, flexBasis: `min\(\$\{s\.px\}px, 45%\)`/.test(dock)) {
      problems.push('the px pane is no longer shrink-and-capped — it will overflow the workspace in a short window, or starve the pane beside it');
    }
    // The panes' flex is asserted imperatively after every render, and must not go back to being a
    // `style` prop. React writes a style property only when its own props change — and an fr pane's
    // computed style is identical before and after a splitter drag, so React sees nothing to do and the
    // drag's pixel values stay on the element for good. Every pane then has grow 0, and new space goes
    // to nobody: a black strip down the edge of the workspace. "The value did not change" is exactly the
    // case that needs repairing, which is why this cannot be declarative.
    // The repair must still run after EVERY render (no dep array) and must still write the longhands.
    // It is now compare-and-set rather than unconditional — writing blind cost a style + layout
    // invalidation of the whole workspace on every frame the transport ran (34 → 56 fps with the
    // browser column collapsed, on a 200-fixture rig) — so what is asserted is that the write still
    // happens against the ELEMENT's current value. Comparing against the element is the part that
    // keeps it working where React could not: React sees unchanged props, the DOM has a drag's
    // pixels on it, and only a DOM read can tell the difference.
    const effect = dock.match(/React\.useLayoutEffect\(\(\) => \{[\s\S]*?\n  \}\);/);
    if (!effect) {
      problems.push('the dock panes no longer assert their flex after every render — a splitter drag will leave pixel sizes pinned on them and new space will be distributed to nobody');
    } else {
      if (/\}, \[/.test(effect[0]))
        problems.push('the dock flex repair grew a dependency array — it must run after EVERY render, because "the props did not change" is exactly the case a drag creates');
      if (!/el\.style\[prop\] = val|el\.style\.flexGrow = /.test(effect[0]))
        problems.push('the dock flex repair no longer writes the flex longhands onto the pane');
      if (!/el\.style\[prop\] !== val|el\.style\.flex = ''/.test(effect[0]))
        problems.push('the dock flex repair neither compares against the element nor clears the shorthand — it either writes blind every frame (a workspace-wide layout invalidation) or cannot undo a drag');
    }
    if (/data-dock-pane[^>]*style=\{/.test(dock)) {
      problems.push('a dock pane styles its flex declaratively again — a drag writes the same properties and React will not correct it');
    }
    if (!/\/ frSum/.test(dock)) {
      problems.push('fr sizes are no longer normalized per split — grow factors summing under 1 leave a black band of undistributed space');
    }
    if (!/flexShrink: 1, flexBasis: '0%'/.test(dock)) problems.push('the fr pane can no longer shrink');
    if (!/defaultTreeOf\(/.test(dock)) problems.push('DockRenderer no longer resets through defaultTreeOf');
    if (!/mount !== 'modal'/.test(dock)) problems.push('DockRenderer offers modal panels in the Add menu — they render outside EditorStore and would throw');
    // The tree's own splitters must not write the layout store per pointer move (the cost WP-5.2 measured).
    if (/layoutStore/.test(dock)) problems.push('DockRenderer touches layoutStore directly — tree edits go through onTree, and splitters commit on release');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Stage: a geometry drag is local until it is released ──────────────────────────────────────
check(
  'stage drags commit on release, not per pointer move',
  'App owns all state, so pushing the fixtures/surfaces array up on every pointermove re-renders the ' +
  'WHOLE editor at pointer rate — every useEditor() panel, all five persistent viewports, and a full ' +
  "rebuild of Simulator3D's LED InstancedMesh (its layout signature includes x/y/w/h/rotation, so " +
  'computeLedPositions runs over every fixture, per mouse move). The move handlers keep the refs and ' +
  'the GPU mapping live — output still follows the drag — and commit to App once, on mouse-up. Same ' +
  'rule the timeline already follows for clip drags.',
  () => {
    const src = stripComments(read('src/renderer/components/Stage.tsx'));
    const problems = [];
    const pairs = [
      ['handleWindowMouseMove', 'handleWindowMouseUp', 'onUpdateFixtures'],
      ['onSurfaceMove', 'onSurfaceUp', 'onUpdateSurfaces'],
    ];
    for (const [moveFn, upFn, commit] of pairs) {
      const move = fnBody(src, moveFn);
      const up = fnBody(src, upFn);
      if (!move) { problems.push(`${moveFn} not found — this guard has gone blind`); continue; }
      if (!up) { problems.push(`${upFn} not found — this guard has gone blind`); continue; }
      // Assert the CALL, not the identifier: a prop merely named in a dependency array is not a commit.
      if (new RegExp(`${commit}\\(`).test(move)) {
        problems.push(`${moveFn} calls ${commit}( — that is the per-pointer-move whole-editor re-render`);
      }
      if (!new RegExp(`${commit}\\(`).test(up)) {
        problems.push(`${upFn} must call ${commit}( — otherwise a drag is never committed and is lost`);
      }
      // Output must still follow the gesture. The engine holds the geometry the frame loop samples,
      // so the move handler has to push into it every move — otherwise the LEDs keep sampling the
      // object's old footprint until the mouse comes up, and only the rectangle moves.
      if (!/frameEngine\.setInputs\(/.test(move)) {
        problems.push(`${moveFn} must push into frameEngine.setInputs( — else output freezes at the pre-drag geometry`);
      }
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Instrumentation must not be able to break the thing it measures ───────────────────────────
check(
  'the UI profiler cannot be switched on at runtime',
  'UiProfiler branches on UI_PROFILING_ENABLED to decide whether to wrap its children in a React ' +
  '<Profiler>. React keys a child by position AND element type, so if that flag could change while ' +
  'the app runs, every wrapped subtree would unmount and rebuild — and the wrapped subtrees are ' +
  'Stage (which publishes dmx:frame), Simulator3D (one WebGL context) and TimelinePanel (one keyboard ' +
  'hook, one engine subscription). A debug toggle must not be able to stop Art-Net mid-show, so the ' +
  'flag is read once at module load and the only way to change it is a reload.',
  () => {
    const problems = [];
    const svc = stripComments(read('src/renderer/services/uiPerfMonitor.ts'));
    // Must be a module-scope const initialized once — not a `let`, not reassigned anywhere.
    if (!/export const UI_PROFILING_ENABLED/.test(svc)) {
      problems.push('uiPerfMonitor.ts must export UI_PROFILING_ENABLED as a module-scope const');
    }
    if (/UI_PROFILING_ENABLED\s*=/.test(svc.replace(/export const UI_PROFILING_ENABLED[^=]*=/, ''))) {
      problems.push('UI_PROFILING_ENABLED is reassigned — it must be written exactly once, at module load');
    }
    // Strip the imports before looking for the flag: a leftover `import { UI_PROFILING_ENABLED }`
    // would otherwise satisfy this check while the branch below it had been rewritten to something
    // re-evaluable. (This check passed the first time it was tried against exactly that break.)
    const comp = stripComments(read('src/renderer/components/UiProfiler.tsx'))
      .replace(/^\s*import[\s\S]*?from\s*'[^']*';?$/gm, '');
    // No local state / props / context may feed the branch: those can change between renders.
    if (/useState|useReducer|useSyncExternalStore/.test(comp)) {
      problems.push('UiProfiler.tsx must hold no state — a re-evaluated branch remounts Stage');
    }
    // Assert the BRANCH, not the identifier: the guard is about what decides whether <Profiler> wraps.
    if (!/if\s*\(\s*!\s*UI_PROFILING_ENABLED\s*\)/.test(comp)) {
      problems.push('UiProfiler.tsx must branch directly on `if (!UI_PROFILING_ENABLED)`, not on a local or a prop');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Shell: panels read state, they do not receive it ──────────────────────────────────────────
check(
  'EditorData is memoized',
  'Rebuilt per render it re-renders every panel through the React context and closes native <select> ' +
  'popups mid-interaction — the documented reason panels used to be individually memoized.',
  () => {
    const src = read('src/renderer/App.tsx');
    return /const editorData: EditorData = useMemo\(/.test(src)
      ? null : 'App.tsx must build `editorData` with useMemo (see state/EditorStore.tsx)';
  },
);

// ── Cold start: the show waits for its content ────────────────────────────────────────────────
check(
  'opening a project holds the show machine',
  'warmPool()/swap() are fire-and-forget, so without the hold the FSM initializes on the NEXT frame, ' +
  'enters its initial state and runs its `play` entry action over decoders that hold nothing: the ' +
  'opening seconds go out BLACK on the projectors and on Art-Net, with an afterDelay dwell already ' +
  'burning. Nothing throws and the show reports itself healthy — the only witness is the audience.',
  () => {
    const src = read('src/renderer/App.tsx');
    const body = fnBody(src, 'applyProjectData');
    if (!body) return 'could not find applyProjectData in App.tsx';
    if (!body.includes('bootGate.hold(')) {
      return 'applyProjectData does not call bootGate.hold() — every cold start (editor open, --project=, ' +
             'the watchdog relaunch, the playlist switch) funnels through it, so the hold has to live there';
    }
    // The gate is only a gate while something can still arm it. armNow on transport start is what keeps
    // a human pressing Play from being ignored for the whole timeout.
    return src.includes('bootGate.armNow(') ? null
      : 'nothing calls bootGate.armNow() — an operator pressing Play during a preload would be held ' +
        'until the timeout expired';
  },
);

check(
  'the FSM tick is gated on the cold-start arm',
  'The hold has exactly one enforcement point: skipping fsm.tick() while unarmed. If the tick runs ' +
  'anyway, bootGate still reports "booting", the status chip still shows a preload, and the show ' +
  'starts on black regardless — a gate that lies is worse than no gate.',
  () => {
    const src = read('src/renderer/services/timeline.ts');
    if (!/if \(armed\) try \{ fsm\.tick\(/.test(src)) return 'frame() must call fsm.tick() only under `if (armed)`';
    // `enabled` is PERSISTED PROJECT DATA — holding the show by flipping it would write the show back
    // to disk disabled on the next save.
    const gate = read('src/renderer/services/bootGate.ts');
    return gate.includes('setFsmEnabled') || /enabled\s*:/.test(gate)
      ? 'bootGate must not touch StateMachine.enabled — that flag is persisted project data; hold via timeline.setArmed()'
      : null;
  },
);

check(
  'a projector draws nothing while the show is preloading',
  'An output window that keeps drawing through the cold-start hold puts a HALF-LOADED look on a real ' +
  'projector — one layer parked on its first frame, the rest still black — which reads to a venue as ' +
  '"the show is broken". The hold is enforced at the DRAW (a ref, not React state: the frame loop must ' +
  'not wait for a commit), with the PRELOADING SHOW sign over it.',
  () => {
    const src = read('src/renderer/projector/ProjectorApp.tsx');
    if (!/if \(bootingRef\.current\) \{ gl\.draw\(null/.test(src)) {
      return 'the frame loop must early-return with gl.draw(null, opts) while bootingRef.current is set';
    }
    if (!src.includes('PRELOADING SHOW')) return 'the projector says nothing while it holds — the sign is gone';
    // The state has to REACH the window, and on both doors: the live gate subscription and the config
    // push (a window can open INTO a preload — broadcast opens its outputs from that very project load).
    const app = read('src/renderer/App.tsx');
    const pushes = (app.match(/t: 'boot'/g) ?? []).length;
    return pushes >= 2 ? null
      : `App pushes the 'boot' message ${pushes}× — it needs both the live bootGate.subscribe fan-out AND ` +
        'the one in pushProjectorState, or a window opened mid-preload never learns it is preloading';
  },
);

// ── Codecs: a mirror window decodes only what it draws ────────────────────────────────────────
check(
  'projector windows decode only the layers they show',
  'A projector renders ONE surface, but the engine\'s mirror layer loop walks the whole document. ' +
  'Ungated, every output window runs its own decode ring over every HAP layer in the show — a window ' +
  'showing an IMAGE decoded the timeline\'s video too — so native decode, disk reads, IPC and GPU ' +
  'uploads all multiply by (1 + number of outputs). Nothing breaks; the frame rate just falls per ' +
  'projector opened.',
  () => {
    const eng = read('src/renderer/services/timeline.ts');
    if (!/if \(external && localLayers && !localLayers\.has\(l\.id\)\) continue;/.test(eng)) {
      return 'the mirror layer-sync loop in timeline.ts must skip layers outside `localLayers`';
    }
    const proj = read('src/renderer/projector/ProjectorApp.tsx');
    return proj.includes('setLocalLayers(')
      ? null
      : 'ProjectorApp never calls engine.setLocalLayers() — the filter exists but no window sets it, ' +
        'so every mirror still decodes the whole document';
  },
);

check(
  'an undecodable HAP is refused once, not retried forever',
  'The decode-ahead ring re-fills from getFrame() on EVERY rAF. With no memory of a failure it ' +
  're-requested a frame that cannot decode three times a frame, forever — each attempt a real ' +
  'seek+read of a multi-MB sample in main, each logging — with black on the output. HAP Q Alpha ' +
  '(HapM) is exactly such a file, and open() used to accept it because it only read the container.',
  () => {
    const dec = read('plugins/hap/src/hapDecode.ts');
    const problems = [];
    if (!dec.includes('failed.has(idx)') || !dec.includes('markFailed(')) {
      problems.push('hapDecode must record failed frame indices and stop re-requesting them');
    }
    // The native door: open() has to validate a frame header, not just the container fourcc.
    const rs = raw('native/hap/src/lib.rs');
    if (!rs.includes('hap::probe_frame(')) problems.push('native open() must probe_frame() sample 0 before accepting a file');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'one HAP file on two surfaces opens on both — a probe in flight is shared, never answered "not HAP"',
  'ensureOpen() used to answer null to a second caller while the first probe was in flight ("re-check ' +
  'next frame"). null also means "not HAP", and hapPlayer.open() cannot tell them apart, so the second ' +
  'surface to open the same .mov in one sync was handed to a <video>, which cannot play HAP: black for ' +
  'good, no error, the first surface playing. Found on the RTX box (2026-11-23) with one HAP on two walls.',
  () => {
    const dec = read('plugins/hap/src/hapDecode.ts');
    const problems = [];
    if (/probing\.has\([^)]*\)\)\s*return\s+null/.test(dec)) problems.push('ensureOpen must not answer null while a probe is in flight');
    if (!/probing\.get\(path\)/.test(dec) || !/new Map<string,\s*Promise</.test(dec)) {
      problems.push('ensureOpen must keep the in-flight probe PROMISE per path and hand it to every caller');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a flat 3D view owns its camera — nothing re-frames a new orthographic camera',
  'Each switch from Perspective to Top/Front/… mounts a NEW orthographic camera (Simulator3D/ViewControls). ' +
  'The lidar-tracking plugin framed every new camera once with perspective maths, so it parked the ortho ' +
  'camera at an elevated perspective framing (an oblique "Top") and reset the orbit target a frame after a ' +
  'saved view was applied — the view came back shifted, nothing thrown (found 2026-11-23 by trapping the ' +
  'writes to the target). A camera-framing pass must skip non-perspective cameras, and the view must keep ' +
  're-deriving the ortho camera from its target every frame rather than placing it once.',
  () => {
    const problems = [];
    const viz = read('plugins/lidar-tracking/src/TrackingViz.tsx');
    if (/venueFramed/.test(viz) && !/isPerspectiveCamera\)\s*return/.test(viz)) problems.push('TrackingViz VenueFraming no longer skips non-perspective cameras');
    const vc = read('src/renderer/components/Simulator3D/ViewControls.tsx');
    if (!/useFrame\([\s\S]{0,2500}?placeOrtho\(cam, view, controls\.target\)/.test(vc)) problems.push('ViewControls no longer re-places the ortho camera from its target every frame');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Cold start: cosmetic decoding must never race the show ────────────────────────────────────
check(
  'filmstrips and waveforms yield to the cold-start gate',
  'Both decode media for LOOKS, on the same native decoder, IPC bridge and GPU the live show uses. ' +
  'Ungated they run at project-open: one measured startup read 99 MB + 127 MB of library video and a ' +
  '1 GB HAP file WHOLE over IPC (main RSS 125 MB → 3.7 GB, its event loop stalled 1.7 s), which starved ' +
  'the playback decode ring for the first ten seconds — a visible stutter at the one moment an audience ' +
  'is guaranteed to be watching.',
  () => {
    const problems = [];
    const thumbs = read('src/renderer/services/thumbnailCache.ts');
    if (!thumbs.includes('bootGate.isBooting()')) problems.push('thumbnailCache does not check bootGate.isBooting()');
    // Deferral without a wake-up is a LOSS: a Filmstrip asks from its render, and a stopped timeline
    // never repaints on its own.
    if (!thumbs.includes('bootGate.subscribe(')) problems.push('thumbnailCache defers work but never wakes it when the gate arms');
    const peaks = read('src/renderer/components/timeline/audioPeaks.ts');
    if (!peaks.includes('bootGate.isBooting()')) problems.push('audioPeaks does not check bootGate.isBooting()');
    // A waveform must not pull a whole video into memory — see AUDIO_CONTAINER.
    if (!/AUDIO_CONTAINER\.test\(path\)/.test(peaks)) problems.push('audioPeaks will blob-read a non-audio container to draw a waveform');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Preload: warming reads what plays next, not the whole document ────────────────────────────
check(
  'warmMedia warms a relevance window, not every clip',
  'warmMedia used to loop EVERY clip of a timeline and open/read each one — at project open, on every ' +
  'GO, and once per FSM look-ahead state. A 40-clip scene was 40 whole-file reads for material that ' +
  'might play twenty minutes later, and on a heavy show it was the largest single share of the open\'s ' +
  'I/O (metric D, scripts/bench-open.cjs). The fix is a window: each layer\'s START clip (the set ' +
  'poolReadiness judges, so the gate\'s contract is unchanged) plus the next WARM_AHEAD_SEC, advanced ' +
  'by the frame body while playing (runFrame(), driven by the live rAF frame() and, offline, stepFrame()). It reverts silently — the app still runs, the show still plays, and only ' +
  'the open gets slow again — so it is asserted here. ' +
  'NOTE: this check once also required a WARM_INFLIGHT bound on concurrent BLOB READS. That clause was ' +
  'removed when media moved to artlux-media:// — there are no whole-file reads left on this path to ' +
  'bound, so requiring the bound would have forced dead code. The window itself still matters, and now ' +
  'bounds how many DECODERS get opened ahead of time rather than how many files get read.',
  () => {
    const src = read('src/renderer/services/timeline.ts');
    const problems = [];
    const body = fnBody(src, 'warmMedia');
    if (!body) return 'warmMedia() not found in services/timeline.ts';
    // The window is built from each layer's start clip, never from a bare walk of t.clips.
    if (!body.includes('startClip(')) problems.push('warmMedia no longer warms per-layer start clips (startClip) — the gate waits on exactly those');
    if (/for \(const c of t\.clips\)/.test(body)) problems.push('warmMedia walks every clip in the document again — that is the flood this check exists to prevent');
    if (!src.includes('WARM_AHEAD_SEC')) problems.push('WARM_AHEAD_SEC is gone — there is no look-ahead window');
    // The window must ADVANCE, or a clip past the opening window never warms until it is already live.
    // The frame BODY lives in runFrame(), which the live rAF frame() and the offline bake's stepFrame()
    // both call — so assert the advance is in the body AND that the live driver still reaches it.
    // Checking only one of the two would go blind to the other being cut.
    if (!fnBody(src, 'runFrame')?.includes('warmWindow(')) problems.push('runFrame() no longer advances the warm window — clips past the opening window warm only once they are on screen');
    if (!fnBody(src, 'frame')?.includes('runFrame(')) problems.push('frame() no longer calls runFrame() — the live rAF driver has been cut off from the frame body');
    // A seek/swap invalidates a window built around the old playhead.
    if (!fnBody(src, 'mainSeek')?.includes('warmHorizon')) problems.push('mainSeek does not reset warmHorizon — after a jump the window still describes the OLD playhead');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Boot progress is a ledger, not a subtraction ──────────────────────────────────────────────
check(
  'the boot fraction counts finished items and cannot go backwards',
  '`total` was frozen on the second poll and `ready` derived as `total - pending.length`, which ' +
  'conflates an item FINISHING with a new one APPEARING: they cancel out, so a gate that completed ' +
  'four things and discovered four more showed no progress, and anything discovered after the freeze ' +
  '(a conform kicked off once the audio driver had synced) pushed `ready` negative or made the chip ' +
  'read n/0. The fix is a ledger of every item ever seen — and it MUST be keyed on identity, not on ' +
  'the display label, because the labels change under it: poolReadiness reports the same clip as ' +
  '"foo.mov (mp4-webcodecs)" while probing and "foo.mov (buffering)" while pre-rolling, so a ' +
  'label-keyed ledger counts one clip as two, one of which never completes.',
  () => {
    const src = read('src/renderer/services/bootGate.ts');
    const problems = [];
    if (/if \(!measured\)/.test(src)) problems.push('the frozen-total measurement is back — late work will make progress go backwards');
    if (/ready:\s*Math\.max\(0,\s*total\s*-\s*pending\.length\)/.test(src)) problems.push('ready is derived by subtracting pending from a fixed total again');
    if (!src.includes('const ledger = new Map')) problems.push('the ledger is gone — nothing remembers items that already finished');
    if (!/keyOf\s*\(/.test(src)) problems.push('the ledger no longer normalises labels to an identity key — a clip whose label changes counts twice');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── The cold-start buffer guarantee is codec-AGNOSTIC ─────────────────────────────────────────
check(
  'a codec that decodes ahead implements preRoll, and the gate primes the LAYER decoder',
  'The gate waits for a decoded BUFFER, not a first frame — a decode-ahead codec starts EMPTY, so a ' +
  'show armed on "the first frame exists" opens by missing the next hundred (measured on HAP: 167 ring ' +
  'misses in the first ten seconds). HAP answered that; mp4 — THE DEFAULT CODEC — did not, so the ' +
  'guarantee silently excluded every .mp4 in every show. Worse, preRoll alone would have fixed nothing: ' +
  'preWarm opens the PATH-keyed surface decoder while a timeline layer reads a LAYER-keyed one that ' +
  'opens lazily on its first frame request, so the gate passed while the layer was still demuxing and ' +
  'the layer was black with the show already running. Both halves, or neither is worth having.',
  () => {
    const problems = [];
    for (const f of walk('plugins')) {
      if (!/Codec\.ts$/.test(f)) continue;
      const src = read(f);
      if (!/layerFrame\s*:/.test(src)) continue; // not a timeline-capable codec
      if (!/preRoll\s*:/.test(src)) problems.push(`${f} defines layerFrame but no preRoll — the gate cannot see its buffer and will arm on an empty one`);
    }
    // The host must pass the layer key through, or a per-layer codec pre-rolls the wrong decoder.
    const tl = read('src/renderer/services/timeline.ts');
    if (!/codec\.preRoll\([^)]*l\.id\)/.test(tl))
      problems.push('poolReadiness does not pass the layer id to preRoll — a codec keying its timeline decoder per layer pre-rolls a decoder nobody reads');
    if (!/preWarmLayer\?\.\(/.test(tl))
      problems.push('warmPoolVideos never calls preWarmLayer — a per-layer codec opens lazily AFTER the gate has armed');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Media streams; it is never read whole into the renderer ───────────────────────────────────
check(
  'media loads over artlux-media://, with the scheme privileged before app-ready',
  'Media used to cross IPC as one Uint8Array and become a Blob: a 1 GB HAP .mov measured 2.3 s of ' +
  'read, main RSS 125 MB -> 3.7 GB and a 1.7 s event-loop stall, for a file the decoder wanted a few ' +
  'MB of. Streaming it back onto that path is invisible in dev (small files, warm cache) and fatal in ' +
  'a venue. THREE THINGS MUST HOLD TOGETHER: (1) the scheme is privileged at MODULE SCOPE — Chromium ' +
  'fixes its scheme registry during startup, so registering inside whenReady yields a scheme without ' +
  'standard/secure/stream and every video silently fails to load; (2) the handler answers Range AND ' +
  'sends Access-Control-Allow-Origin, because both <video> factories set crossOrigin=anonymous (inert ' +
  'under blob:, mandatory under a custom scheme) and that attribute is also what keeps frames ' +
  'UNTAINTED for canvas/WebGPU sampling — i.e. the LED pipeline; (3) the handler aborts its stream, ' +
  'or a scrubbing <video> leaks an fd per cancelled range until the process dies of EMFILE.',
  () => {
    const problems = [];
    if (!exists('src/main/mediaProtocol.ts')) return 'src/main/mediaProtocol.ts is gone — media is no longer streamed';
    const proto = read('src/main/mediaProtocol.ts');
    const index = read('src/main/index.ts');
    // (1) privileged before ready. The call must not sit inside the whenReady callback.
    const readyAt = index.indexOf('app.whenReady()');
    const regAt = index.indexOf('registerMediaScheme()');
    if (regAt < 0) problems.push('src/main/index.ts never calls registerMediaScheme() — the scheme has no privileges');
    else if (readyAt >= 0 && regAt > readyAt) problems.push('registerMediaScheme() is called after app.whenReady() — too late for Chromium to grant standard/secure/stream');
    for (const priv of ['standard', 'secure', 'supportFetchAPI', 'stream']) {
      if (!new RegExp(`${priv}:\\s*true`).test(proto)) problems.push(`the media scheme is missing the \`${priv}\` privilege`);
    }
    // (2) range + CORS on the responses.
    if (!proto.includes('Content-Range')) problems.push('the handler never sends Content-Range — seeking a <video> will refetch from zero or hang');
    if (!proto.includes('Accept-Ranges')) problems.push('the handler never sends Accept-Ranges — clients will not attempt to seek');
    if (!proto.includes('Access-Control-Allow-Origin')) problems.push('the handler never sends Access-Control-Allow-Origin — crossOrigin=anonymous makes EVERY media load fail');
    // (3) the fd-leak guard.
    if (!/signal\?*\.addEventListener\('abort'/.test(proto)) problems.push('the handler does not destroy its stream on abort — a scrubbing <video> will leak file descriptors');
    // …and the allowlist is what stops the scheme being an arbitrary-file-read for the renderer.
    if (!proto.includes('mediaAccess.isAllowed(')) problems.push('the handler serves without asking mediaAccess.isAllowed — the renderer can read any file on disk');
    // The renderer must not have crept back onto whole-file reads for pictures.
    for (const f of ['src/renderer/services/timeline.ts', 'src/renderer/services/contentSource.ts', 'src/renderer/services/thumbnailCache.ts', 'src/renderer/components/AssetChip.tsx']) {
      if (/\bensureBlobUrl\s*\(/.test(read(f))) problems.push(`${f} blob-reads media again — that is the whole-file path this check exists to prevent`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Preload: the residency budget must actually bind ──────────────────────────────────────────
check(
  'the warm-pool budget counts protected pools, and look-ahead is trimmed',
  'evictExcess used to subtract the protected keys from `standby` BEFORE comparing to MAX_WARM, so ' +
  'the one caller that matters could not be bounded by it: the FSM look-ahead hands in every ' +
  'reachable-next state, so a hub state with ten outgoing transitions protected ten pools, `standby` ' +
  'came out empty and `excess` went negative. Ten warm pools — ten sets of per-layer <video> decoders ' +
  'and ten warmed clip sets — against a budget of two, silently, for as long as the show sat there. ' +
  'Both halves are required: counting protected pools in, AND callers ranking + trimming to MAX_WARM ' +
  'before calling (else the fix would warm ten and immediately release eight — thrash, strictly worse).',
  () => {
    const pre = read('src/renderer/services/timelinePreloader.ts');
    const app = read('src/renderer/App.tsx');
    const problems = [];
    if (!/excess\s*=\s*Math\.min\([^)]*standby\.length\s*\+\s*protectedHeld/.test(pre))
      problems.push('evictExcess no longer counts protected pools against MAX_WARM — the budget is unenforceable by the FSM look-ahead');
    if (!pre.includes('export const MAX_WARM'))
      problems.push('MAX_WARM is no longer exported — App cannot trim its look-ahead to the budget without drifting from it');
    // The caller half: rank, then trim. A raw transitions.filter is the shape that shipped the bug.
    if (!app.includes('reachableNext('))
      problems.push('App does not use reachableNext — the look-ahead is unranked, and `fromAny` global transitions are invisible to it again');
    if (!/reachableNext\([\s\S]{0,200}?\.slice\(0,\s*timelinePreloader\.MAX_WARM\)/.test(app))
      problems.push('App does not trim its look-ahead to MAX_WARM — an over-budget protect set is not something evictExcess can resolve');
    if (/sm\.transitions\.filter\(t => t\.from === stateId\)/.test(app))
      problems.push('App filters transitions by `t.from === stateId` again — that can never match a fromAny global rule');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Preload: a demoted pool must release the decoders it opened ───────────────────────────────
check(
  'releasePool frees its path-keyed codec decoders, and there is ONE codec refcount',
  'warmMedia opens a decoder per PATH (mp4 keeps every compressed sample of the track; HAP a ring of ' +
  'decoded 1-4 MB frames) and only closeSurface() frees one. releasePool freed the pool\'s <video>s ' +
  'and its LAYER-keyed codec state and nothing else, so a pool the LRU had demoted to COLD kept the ' +
  'heaviest thing it owned for the life of the session — the tier table in docs/SCENE-TIMELINES.md ' +
  'described a teardown that never happened. It survived because TWO modules refcounted the same ' +
  'shared resource: contentSource counted surface consumers and released them correctly, while the ' +
  'pool side counted nothing. One refcount, one owner vocabulary, or the gap comes back.',
  () => {
    const tl = read('src/renderer/services/timeline.ts');
    const cs = read('src/renderer/services/contentSource.ts');
    const problems = [];
    if (!exists('src/renderer/services/codecResidency.ts')) return 'services/codecResidency.ts is gone — nothing refcounts codec decoders across pools AND surfaces';
    // ⚠ releasePool is an OBJECT-LITERAL METHOD, which fnBody() does not match (it knows `const x =`
    // and `function x(`). Written as `if (fnBody(...) && ...)` this check passed on a null body — it
    // reported the absence of the thing it was looking for as success, which is the exact failure the
    // header of this file warns about. Brace-match from the method anchor instead, and treat a missing
    // anchor as a problem rather than as nothing to say.
    const rel = braceBody(tl, 'releasePool(poolKey: string): void');
    if (!rel) problems.push('releasePool(poolKey) not found in services/timeline.ts — this check can no longer see what it guards');
    else if (!rel.includes('codecResidency.releaseOwner'))
      problems.push('releasePool does not release its codec paths — a COLD pool still holds every decoder its warming opened');
    if (!tl.includes('codecResidency.retain('))
      problems.push('timeline never retains warmed codec paths — releasePool then has nothing to release');
    // The second refcount must stay gone: two counts over one resource is how the gap survived.
    if (/const codecUsers = new Map/.test(cs))
      problems.push('contentSource declares its own codecUsers map again — two refcounts over one shared decoder');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Timeline: one track, one clip at a time ───────────────────────────────────────────────────
check(
  'clips cannot be stacked on a track',
  'activeClip() resolves an overlap by taking the LAST match, so a clip dropped on top of another ' +
  'does not corrupt playback — it becomes invisible and unpickable while still living in the ' +
  'document, saved and reloaded forever. Every placement path must land in free space.',
  () => {
    const tl = read('src/renderer/components/timeline/Timeline.tsx');
    const problems = [];
    if (!tl.includes('nearestFreeStart(')) problems.push('Timeline never calls nearestFreeStart — a drag can stack clips');
    if (!tl.includes('freeStartOn(')) problems.push('Timeline has no freeStartOn() — drops can stack clips');
    if (!tl.includes('freeSpanAt(')) problems.push('Timeline never calls freeSpanAt — a trim can slide under its neighbour');
    // Every clip-creation site must go through the placement helper, not raw `start`.
    const creates = (tl.match(/clips: \[\.\.\.(timelineRef\.current|tl)\.clips, \{/g) ?? []).length;
    const placed = (tl.match(/start: freeStartOn\(/g) ?? []).length;
    if (placed < creates) problems.push(`${creates} clip-creation site(s) but only ${placed} use freeStartOn()`);
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Timeline: every popover escapes the lattice of stacking contexts ──────────────────────────
check(
  'timeline popovers are portalled onto the popover tier',
  'The timeline is a lattice of STACKING CONTEXTS: each track row\'s gutter is `sticky left-0 ' +
  'z-20`, the ruler row is `sticky top-0 z-30`, and the maximised timeline is wrapped in a `fixed ' +
  'inset-0 z-50`. position:sticky/fixed WITH a z-index creates one, so a panel written the obvious ' +
  'way — `absolute … z-50` beside its anchor — is SEALED inside it and its z-index stops meaning ' +
  'anything globally. Walked into three times here. TrackHeader\'s opacity/blend panel collapsed to ' +
  'z-20 and painted under the NEXT track\'s header (same z, later sibling, the same 188px gutter ' +
  'column it drops into), so the button lit up and the operator saw nothing at all; for the bottom ' +
  'track the scroller\'s overflow-auto clipped it instead. AutomationTargetPicker\'s z-40 backdrop ' +
  'lost to the maximised wrapper, so its menu could not be dismissed AND the dismissal click fell ' +
  'through onto the timeline and scrubbed. None of it throws: the panel is in the DOM, at correct ' +
  'geometry, with correct innerText — only the pixels are wrong, which is why every DOM assertion ' +
  'passes and only a screenshot finds it. So: portal to document.body, sit on the `popover` tier, ' +
  'and place from a MEASURED rect (usePopoverAnchor).',
  () => {
    const DIR = 'src/renderer/components/timeline';
    const problems = [];
    // read() strips comments, so the prose above and in those files (which quotes the very classnames
    // being banned) cannot false-positive.
    for (const f of walk(DIR).filter(p => p.endsWith('.tsx'))) {
      const src = read(f);
      // A full-viewport click-outside backdrop is the reliable tell of a popover in this directory.
      const backdrops = src.match(/className="fixed inset-0[^"]*"/g) ?? [];
      if (!backdrops.length) continue;
      if (!src.includes('createPortal'))
        problems.push(`${f} renders a dismiss backdrop but never portals — its z-index is inert inside the timeline's stacking contexts`);
      for (const b of backdrops)
        if (!/\bz-popover\b/.test(b))
          problems.push(`${f} has a backdrop off the popover tier (${b.slice(11, -1)}) — it loses to the maximised-timeline wrapper`);
      // The paired panel must not be `absolute` — that re-anchors it inside the sealed context.
      if (/className="[^"]*\babsolute\b[^"]*\bz-(40|50)\b/.test(src) || /className="[^"]*\bz-(40|50)\b[^"]*\babsolute\b/.test(src))
        problems.push(`${f} positions a layer with absolute + z-40/z-50 — use z-popover inside the portal`);
    }
    // The premise. If the gutter ever stops being a stacking context this check's reasoning is stale,
    // and a silent pass would be worse than a noisy failure.
    const tl = read('src/renderer/components/timeline/Timeline.tsx').replace(/\s+/g, ' ');
    if (!/className="sticky left-0 z-\d+[^"]*"[^>]*> <TrackHeader/.test(tl))
      problems.push('Timeline.tsx no longer wraps TrackHeader in a `sticky left-0 z-*` gutter — re-check this invariant');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── UI: the interaction-state floor ───────────────────────────────────────────────────────────
check(
  'the interaction-state floor is overridable',
  'Every control in the app gets its hover/press from one base-layer rule in styles/index.css. ' +
  'Tailwind v3\'s @layer base is SOURCE ORDER, not a real cascade layer, so the rule only stays ' +
  'overridable because :where() weighs zero. Rewrite it as a plain selector and it silently outranks ' +
  'every hover:/active: utility in the app — nothing throws, the build is clean, and components stop ' +
  'being able to style their own states.',
  () => {
    const css = read('src/renderer/styles/index.css');
    const rules = css.match(/^.*no-press.*:(hover|active) \{$/gm) ?? [];
    if (rules.length !== 2) return `expected one :hover and one :active floor rule in index.css, found ${rules.length}`;
    const bare = rules.filter((r) => !/:where\(:not\(:disabled\)\)/.test(r) || !/^:where\(button,/.test(r.trim()));
    if (bare.length) return `floor rule is not fully wrapped in :where() — it would outrank component utilities:\n      ${bare.join('\n      ')}`;
    // The floor is inert unless it sits in the base layer.
    const base = css.slice(css.indexOf('@layer base'), css.indexOf('/* Scrollbars'));
    return base.includes('no-press') ? null : 'the floor rules must live inside @layer base';
  },
);

// ── Transport: a HOLD must not pause, and a frozen clock must be gated ────────────────────────
check(
  'the end-of-timeline HOLD stays silent on the transport',
  'Timeline.holdAtEnd exists precisely so the state\'s picture can end WITHOUT stopping the show: ' +
  'the transport keeps running, so the global audio bed and the global automation play on while the ' +
  'room waits for a trigger. `playing` is what the show clock is gated on — so if the hold branch ' +
  'ever raises the end-stop\'s pause, the bed dies at every state end and the only symptom is silence.',
  () => {
    const src = read('src/renderer/services/timeline.ts');
    const problems = [];
    if (!src.includes('data.holdAtEnd')) return 'services/timeline.ts no longer reads data.holdAtEnd — the hold is gone';
    // The pause must be raised only under an explicit not-holding test. Matching the ASSIGNMENT (not
    // the identifier) so a surviving declaration can never satisfy this.
    const raises = src.match(/^.*pausePending = true.*$/gm) ?? [];
    if (raises.length !== 1) problems.push(`expected exactly one \`pausePending = true\`, found ${raises.length}`);
    else if (!/if \(!holding\)/.test(raises[0])) problems.push('the end-stop raises `pausePending` without a `if (!holding)` guard — a hold would stop the bed');
    // `held` must be re-derived every frame, never latched: a latch has to be cleared by all seven
    // clock-re-anchor sites, and a missed one leaves the machine believing a running show is held.
    if (!/^\s*held = false;/m.test(src)) problems.push('`held` is never reset at the top of frame() — it must be derived per frame, not latched');
    if (!src.includes('isBoundHeld()')) problems.push('the engine no longer publishes isBoundHeld() — the audio driver cannot see the park');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a held playhead silences its own audio containers',
  'Reconciling an audio container against a FROZEN clock is not a no-op: `desired` freezes while ' +
  '`estimated` runs on, so the driver re-seeks every sounding clip to the same offset every ~50ms. ' +
  'That is a buzz, not silence — the same defect getStatus().showEnded exists to prevent on the show ' +
  'clock. A hold freezes the PLAYHEAD, so its two playhead-clocked containers need the same gate.',
  () => {
    const f = 'plugins/audio/src/plugin.renderer.ts';
    if (!exists(f)) return null; // the audio plugin is optional at build time
    const src = read(f);
    const problems = [];
    if (!src.includes('st.held')) problems.push('the audio driver never reads getStatus().held');
    if (!/if \(held\)/.test(src)) problems.push('reconcile() has no `if (held)` branch — a held state would buzz instead of going silent');
    // Scope: a hold must never take the BED down with it (that is the whole point of holding).
    if (/if \(held\)[\s\S]{0,400}?stopAllSounding\(\)/.test(src)) problems.push('the held branch calls stopAllSounding() — it would silence the audio bed, which must play through a hold');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Trigger zones on another plugin's surface (the camera area) ───────────────────────────────
check(
  'a trigger zone counts PEOPLE from every source, and holds a provider surface running',
  'A camera person has several tagged parts. Counting POINTS made a visitor with both hands on a pad two ' +
  'people, so "People needed: 2" fired for one visitor. And a camera only infers while somebody holds it: ' +
  'a show whose camera zones were its only consumer had NO inference running, and every camera zone sat ' +
  'empty for good with nothing on screen to say why. (Also: a degenerate calibration inverted to the ' +
  'IDENTITY, so a broken area "worked" by mapping the raw picture — it must be null, i.e. not calibrated.)',
  () => {
    const z = read('plugins/lidar-tracking/src/zones.ts');
    const h = read('plugins/mediapipe/src/poseHomography.ts');
    const problems = [];
    if (!/const count = countInZone\(z, pointsFor\(/.test(z)) problems.push('zones.evaluate() no longer counts through countInZone(pointsFor(...)) — the per-person rule');
    if (!/seen\.add\(p\.person\)/.test(z)) problems.push('countInZone() no longer dedupes by person');
    if (!/reconcileHolds\(\);[\s\S]{0,80}let changed = false;/.test(z)) problems.push('evaluate() no longer reconciles provider holds every pass (a provider registered after configure() would never be acquired)');
    if (/return \[1, 0, 0, 0, 1, 0, 0, 0, 1\]/.test(h)) problems.push('poseHomography.invert() returns the identity for a singular matrix again — it must return null');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── FSM: a guard suppresses the ACTION, never the EVALUATION ──────────────────────────────────
check(
  'the FSM evaluates a transition\'s trigger before applying its guard',
  'A trigger source can be STATEFUL (a LiDAR zone rule remembers whether it has been armed since the ' +
  'state was entered) and it only sees the frames on which it is ASKED. Checking requireEnd FIRST ' +
  'blinded it for exactly the window the guard exists to cover: a visitor walked into the zone while ' +
  'the film played, the guard swallowed the question, and when the hold opened the gate the source saw ' +
  'somebody merely STANDING there rather than ARRIVING — the show never advanced and the person had to ' +
  'walk out and back in.',
  () => {
    const src = read('src/renderer/services/stateMachine.ts');
    const problems = [];
    // The evaluation must not sit behind a `continue` on the guard.
    if (/if \(gated\([^)]*\)\) continue;/.test(src)) problems.push('tick() still skips evaluation when the guard is closed (`if (gated(...)) continue`)');
    if (!/triggerFires\([^)]*\)[\s\S]{0,120}?!gated\(/.test(src)) problems.push('could not find the "evaluate, then gate" pairing — triggerFires() must run BEFORE gated() decides');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a global rule cannot re-enter the state it targets',
  'A fromAny rule\'s condition is typically a LEVEL that stays true while somebody stands in a zone. ' +
  'Entry is idempotent-and-restarting, so a global whose target is the CURRENT state would re-enter it ' +
  'every frame — seeking its scene timeline back to frame 0 sixty times a second behind a frozen ' +
  'picture, with the machine reporting itself perfectly healthy.',
  () => {
    const src = read('src/renderer/services/stateMachine.ts');
    if (!src.includes('fromAny')) return 'stateMachine.ts no longer handles fromAny — global rules are gone';
    return /tr\.to === currentStateId\) continue/.test(src)
      ? null : 'the global-rule loop does not skip a transition whose `to` IS the current state';
  },
);

check(
  'the idle reset skips its own target and runs last',
  'StateMachine.idleResetSec force-returns a HELD state to initialStateId when nobody advances it. Two ' +
  'ways it self-destructs: (1) if it did not skip the case where the initial state IS the current state, ' +
  'a held attract loop would re-enter itself every idleResetSec — restarting its scene timeline behind a ' +
  'frozen picture with the machine reporting itself healthy (the same failure as a self-targeting global); ' +
  '(2) if it were evaluated BEFORE the transition loops, it could pre-empt an authored exit out of the ' +
  'held state. It must sit after both loops and guard `init !== currentStateId`.',
  () => {
    const src = read('src/renderer/services/stateMachine.ts');
    if (!src.includes('idleResetSec')) return 'stateMachine.ts no longer reads sm.idleResetSec — the idle reset is gone';
    const problems = [];
    if (!/init !== currentStateId/.test(src)) problems.push('the idle reset does not guard `init !== currentStateId` — it could reset a state to itself');
    // It must come AFTER the global-rule loop (the last `tr.fromAny` gate) — i.e. only fire on a frame
    // where no transition did. Compare source positions of the two anchors.
    const globalLoop = src.indexOf('!tr.fromAny || tr.to === currentStateId');
    const reset = src.indexOf('sm.idleResetSec');
    if (globalLoop < 0 || reset < 0 || reset < globalLoop) problems.push('the idle reset is not placed AFTER the global-rule loop — it could pre-empt an authored exit');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Zones: the room is not part of a look ─────────────────────────────────────────────────────
check(
  'a scene snapshot never carries the room or the sensor',
  'A trigger zone is a rectangle taped to a real floor — it does not change shape because the lighting ' +
  'did. Zones live on Scene3D, Scene3D rides in the look snapshot, and recall assigns the whole object: ' +
  'so every scene silently carried a COPY, and the first GO onto a scene captured BEFORE the zones were ' +
  'drawn replaced the live list with nothing. Every zone vanished and every zone-driven transition went ' +
  'inert, with nothing logged and nothing on screen to explain it. ' +
  'IT THEN HAPPENED A SECOND TIME, to the SENSOR settings, because the fix was written out separately ' +
  'at each site instead of shared: trackingMergePeople/-Radius and the venue dwell were added to ' +
  'Scene3D later and reached NEITHER list. So merging — "this venue reports two blobs per person" — ' +
  'rode every snapshot and the first recall turned it back off; every zone then counted blobs, and a ' +
  'zone asking for two visitors needed four, mid-show, with nothing logged. Found at the venue. ' +
  'Hence ONE list, SCENE3D_NOT_A_LOOK, and hence this check on all three of its readers.',
  () => {
    const src = read('src/renderer/App.tsx');
    const problems = [];
    const list = src.match(/const SCENE3D_NOT_A_LOOK = \[([\s\S]*?)\] as const;/);
    if (!list) return 'SCENE3D_NOT_A_LOOK is gone — the three sites have nothing to share';
    for (const k of ['trackingZones', 'viewFrom', 'trackingMergePeople', 'trackingMergeRadius',
                     'trackingSurfaceMerge', 'trackingZoneEnterSec', 'trackingZoneExitSec',
                     'gridVisible', 'gridLabels']) {
      if (!list[1].includes(`'${k}'`)) problems.push(`SCENE3D_NOT_A_LOOK no longer covers ${k}`);
    }
    // All three readers must USE the list. A literal `trackingZones: undefined` at any of them is how
    // the drift started, so it is itself the failure — not merely the absence of the helper.
    const snap = fnBody(src, 'buildSceneSnapshot');
    if (!snap) problems.push('could not find buildSceneSnapshot in App.tsx');
    else if (!/scene3D: stripNotALook\(scene3D\)/.test(snap)) problems.push('buildSceneSnapshot no longer strips via stripNotALook() — a scene would capture the room and the sensor');
    const recall = fnBody(src, 'handleRecallScene');
    if (!recall) problems.push('could not find handleRecallScene in App.tsx');
    else if (!/keepNotALook\(scene\.scene3D!, prev\)/.test(recall)) problems.push('handleRecallScene no longer preserves via keepNotALook() — an old scene would still wipe them');
    if (!/k === 'scene3D'[\s\S]{0,160}stripNotALook/.test(src)) problems.push('the unsaved-changes norm() no longer normalizes scene3D via stripNotALook() — the Update chip would light permanently');
    if (/trackingZones:\s*undefined/.test(src)) problems.push('a site still spells the fields out inline — that is exactly how the sensor fields got missed');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── A11y/UX floors from the deep UI/UX audit (docs/DESIGN-SYSTEM.md) ──────────────────────────
// Each encodes a shipped defect: the app compiled and ran, but a keyboard/AT user was locked out, a
// save failed silently, or 10px text sat at 3.1:1. A typechecker sees none of them.

check(
  'the dim text tier stays WCAG-AA legible',
  'text-3 (fg-3) is the app\'s meta/label tier and is used at 10–11px. At the old #6a6a6a it was 3.10:1 ' +
  'on surface-2 — below the 4.5:1 floor — across 113 sites. It was raised to #8a8a8a (4.86:1). Darkening ' +
  'it again silently reintroduces the failure everywhere the tier is used.',
  () => {
    const problems = [];
    const tok = read('src/renderer/styles/tokens.css');
    if (!/--text-3:\s*#8a8a8a/i.test(tok)) problems.push('tokens.css --text-3 is not #8a8a8a (must stay AA on the chrome surfaces)');
    const tw = read('tailwind.config.js');
    if (!/3:\s*'#8a8a8a'/i.test(tw)) problems.push('tailwind.config.js fg.3 is not #8a8a8a (must mirror the token)');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'every colour utility names a token that actually exists',
  'Tailwind SILENTLY DROPS an unknown colour: the class compiles to nothing and the element just ' +
  'inherits, so the UI looks almost right and nobody sees a failure. It has now happened twice — ' +
  '`bg-bg-stage` rendered transparent until the `bg` key was added to the config (the splash well had ' +
  'no background), and `text-fg-4` was used at 22 sites across the calibration wizards for a tier that ' +
  'has never existed (fg-3 is the dimmest by design). Neither typechecks, lints or crashes.',
  () => {
    const tw = read('tailwind.config.js');
    // The scales this guard covers — the ones written as `<utility>-<family>-<step>`.
    const families = ['fg', 'surface', 'line', 'accent', 'state', 'sel'];
    const known = new Set();
    for (const fam of families) {
      const block = tw.match(new RegExp(`${fam}:\\s*\\{([^}]*)\\}`));
      if (!block) continue;
      for (const m of block[1].matchAll(/['"]?([\w-]+)['"]?\s*:/g)) known.add(`${fam}-${m[1]}`);
    }
    if (!known.size) return 'could not read any colour scales out of tailwind.config.js';
    const UTIL = /\b(?:text|bg|border|ring|fill|stroke|from|to|via|divide|outline|decoration|shadow)-((?:fg|surface|line|accent|state|sel)-[\w]+)/g;
    const bad = new Map();
    for (const f of [...walk('src/renderer'), ...walk('plugins')]) {
      if (!/\.(tsx|ts)$/.test(f)) continue;
      const src = read(f);
      for (const m of src.matchAll(UTIL)) {
        const token = m[1];
        // `accent` alone (accent-hover/press/dim are keys; bare `accent` is the DEFAULT) and any
        // token carrying an opacity suffix are resolved elsewhere — only flag a plain unknown step.
        if (known.has(token)) continue;
        if (/^accent-(hover|press|dim)$/.test(token)) continue;
        if (!bad.has(token)) bad.set(token, f);
      }
    }
    if (!bad.size) return null;
    return [...bad].map(([t, f]) => `"${t}" (${f}) is not in tailwind.config.js — it renders as nothing`).join('; ');
  },
);

check(
  'no blocking native dialogs in the renderer',
  'window.confirm / window.alert steal focus, are unthemed (a white box over the OLED console), block the ' +
  'JS thread and expose no aria. Every confirmation/notice must route through the in-app substrate ' +
  '(useConfirm / useToast in components/ui/feedback). A native dialog behind a fullscreen projector can ' +
  'hang the operator mid-show.',
  () => {
    const bad = [];
    for (const f of [...walk('src/renderer'), ...walk('plugins')]) {
      const src = read(f);
      // BARE `confirm("…")` COUNTS TOO, and it did not until now. The pattern caught `window.confirm`
      // and bare `alert`, but bare `confirm` walked past it — and that is the form that shipped, in a
      // library panel, where deleting an effect blocked the JS thread and the app looked frozen. A
      // guard with a hole shaped exactly like the bug it exists to stop is worse than no guard,
      // because it is trusted.
      //
      // Discriminated by the ARGUMENT, not the name: the in-app `useConfirm()` handle is also called
      // `confirm` and is called all over App.tsx and Preferences.tsx, so a bare-name match would flag
      // the CORRECT pattern. The native one takes a string; the in-app one takes an options object.
      if (/window\.(confirm|alert)\s*\(/.test(src)
        || /(^|[^.\w])alert\s*\(/.test(src)
        || /(^|[^.\w])confirm\s*\(\s*['"`]/.test(src)) bad.push(f);
    }
    return bad.length ? `native confirm()/alert() found: ${bad.join(', ')}` : null;
  },
);

check(
  'the StatusBar announces output state to assistive tech',
  'The StatusBar is where an operator scans for "is output live". It updates imperatively / every frame, ' +
  'so without an aria-live region a screen-reader user never hears LIVE↔OFFLINE flip — the one status a ' +
  'venue operator must not miss. (The per-frame FPS is deliberately NOT in a live region.)',
  () => {
    const src = read('src/renderer/components/StatusBar.tsx');
    return /aria-live=/.test(src) ? null : 'StatusBar.tsx has no aria-live region';
  },
);

check(
  'the kit never suppresses the focus ring without a replacement',
  'A global :focus-visible ring is the keyboard-focus floor. `focus:outline-none` (not focus-visible:) in ' +
  'a kit primitive kills it for every consumer, leaving keyboard users with no visible focus. The kit must ' +
  'either keep the global ring or draw its own (focus-visible:ring/outline).',
  () => {
    const bad = [];
    for (const f of walk('src/renderer/components/ui')) {
      const src = read(f);
      // focus:outline-none is the offender; focus-visible:outline-none paired with a ring is fine.
      if (/[^-]focus:outline-none/.test(src) && !/focus-visible:(ring|outline)/.test(src)) bad.push(f);
    }
    return bad.length ? `focus:outline-none without a replacement ring: ${bad.join(', ')}` : null;
  },
);

check(
  'ListRow stays keyboard-operable',
  'ListRow is the primary selection primitive (surfaces/fixtures/scenes). As a bare <div onClick> it made ' +
  'the whole object-browser flow mouse-only and invisible to AT. It must carry a role and an onKeyDown so ' +
  'Enter/Space select — regressing it silently re-breaks keyboard selection everywhere it is used.',
  () => {
    const src = read('src/renderer/components/ui/ListRow.tsx');
    const problems = [];
    if (!/role="button"/.test(src)) problems.push('ListRow lost role="button"');
    if (!/onKeyDown/.test(src)) problems.push('ListRow lost its onKeyDown (Enter/Space activation)');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the renderer keeps its error containment + feedback substrate',
  'A top-level ErrorBoundary keeps a render throw from unmounting Stage (which would stop Art-Net), and ' +
  'FeedbackProvider is the only sanctioned place for toasts/confirms. Both are mounted at the editor entry; ' +
  'dropping either silently removes containment or leaves feedback nowhere to go.',
  () => {
    const src = read('src/renderer/index.tsx');
    const problems = [];
    if (!/ErrorBoundary/.test(src)) problems.push('index.tsx no longer mounts the ErrorBoundary');
    if (!/FeedbackProvider/.test(src)) problems.push('index.tsx no longer mounts the FeedbackProvider');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the app logo is drawn from one source, never hand-rolled',
  'The mark used to exist three times over — build/icon.svg, a `sky-400 → blue-600` tile in MenuBar, and ' +
  'an accent tile in About — and they had already drifted to different colours. Nothing failed: it ' +
  'compiled, booted, threw nothing, and simply branded the app two ways at once, which is invisible until ' +
  'someone screenshots it. Every mark now comes from shared/brandMarks.ts (generated by ' +
  'scripts/gen-wordmark.cjs from the app\'s own typeface) via components/brand/AppMark.tsx. A new ' +
  'hand-drawn tile anywhere else re-opens exactly that drift.',
  () => {
    const problems = [];
    // The generated source and its React wrapper must both still exist and be connected.
    if (!exists('shared/brandMarks.ts')) problems.push('shared/brandMarks.ts is gone — run `npm run gen:brand`');
    if (!exists('src/renderer/components/brand/AppMark.tsx')) {
      problems.push('components/brand/AppMark.tsx is gone (the only sanctioned way to draw the mark)');
    } else if (!/brandMarks/.test(read('src/renderer/components/brand/AppMark.tsx'))) {
      problems.push('AppMark.tsx no longer reads shared/brandMarks — it is drawing something of its own');
    }
    // Nobody else may paint a lettered tile. The signature of the old bug: a gradient/rounded box whose
    // entire content is a bare capital A.
    const HAND_ROLLED = />\s*A\s*<\/div>/;
    for (const f of [...walk('src/renderer/components'), ...walk('plugins')]) {
      if (f.includes('components/brand/')) continue;
      const src = read(f);
      if (HAND_ROLLED.test(src) && /bg-gradient|rounded-(md|lg)/.test(src)) {
        problems.push(`${f} hand-draws a lettered tile — use <AppIconMark>/<AppWordmark> instead`);
      }
    }
    // The chrome must actually USE it, or the logo silently reverts to nothing at all.
    for (const f of ['src/renderer/components/MenuBar.tsx', 'src/renderer/components/About.tsx']) {
      if (!/AppWordmark|AppIconMark/.test(read(f))) problems.push(`${f} no longer renders the app mark`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── The byte-sources paint somewhere a worker can reach ───────────────────────────────────────
check(
  'DMX-in and NDI paint into an OffscreenCanvas, and skip the repaint when nothing arrived',
  'These two receive raw RGBA (or DMX channels) over IPC and assemble a picture for the sampler. The ' +
  'canvas they paint into is never displayed — it exists only to be sampled — so a DOM element is the ' +
  'wrong thing twice over: it cannot exist in a worker, which is where the engine is going, and it ties ' +
  'a background data path to the document. They also each get asked for a picture once per consuming ' +
  'surface AND again inside the GPU sampler\'s per-surface closure, so without a "has anything actually ' +
  'arrived" check the same unchanged bytes were re-packed and re-uploaded several times per frame, and ' +
  'on every frame while the sender sat idle. A detached <canvas> stays as the fallback where ' +
  'OffscreenCanvas is missing; it must not be the primary path.',
  () => {
    // Spout is deliberately NOT in this list any more: it receives no bytes at all. See the
    // GPU-texture check below, which guards the stronger property that replaced this one for it.
    const files = [
      'src/renderer/services/dmxInput.ts',
      'plugins/ndi/src/ndiReceiver.ts',
    ];
    const problems = [];
    for (const f of files) {
      const src = stripComments(read(f));
      if (!/new OffscreenCanvas\(/.test(src)) problems.push(`${f} does not paint into an OffscreenCanvas`);
      // The repaint-skip: an arrival counter and a record of what is already painted.
      if (!/painted\s*===\s*seq/.test(src)) problems.push(`${f} repaints unconditionally — it must skip when no new frame arrived`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Spout is GPU-only, and every texture it takes is given back ────────────────────────────────
check(
  'Spout delivers GPU textures only — no readback path, and every VideoFrame is closed',
  'Spout receives the sender\'s texture on the GPU and hands the renderer a VideoFrame. It must not ' +
  'grow a pixel-readback path again, and not as a fallback either. There WAS one, and it was the only ' +
  'path: read back to system memory, resample to a cap, ship 8.3 MB per frame over IPC — ~9 ms of ' +
  'main-thread stall per frame, and for most of its life a 512-pixel cap and a nearest-neighbour ' +
  'resample, so a full-HD sender arrived aliased with nothing in the app to explain it. Reinstated as ' +
  'a silent fallback it is worse than absent: it converts a hardware fact the operator can act on ' +
  '("this machine cannot share GPU textures") into one they cannot ("the picture is soft and the app ' +
  'is slow"). A machine that cannot share textures must be TOLD. And because a VideoFrame is a ' +
  'reference to a GPU image, the receiver must close the one it replaces — a missed close leaks a ' +
  'full-resolution allocation per frame, which at 60 Hz exhausts VRAM in seconds rather than hours. ' +
  'Closing on replacement is enough, including for the projector pump, which reads the drawable with ' +
  'an AWAITED createImageBitmap: that takes its own reference to the underlying image, so a later ' +
  'close cannot invalidate a copy in flight (measured on real imported shared textures — 181 frames ' +
  'closed immediately, 181 bitmaps resolved, 0 rejections). Do not add a grace period for it.',
  () => {
    const problems = [];
    const rx = stripComments(read('plugins/spout/src/spoutReceiver.ts'));
    // No pixel assembly: these are the fingerprints of a readback path returning.
    for (const [re, what] of [[/new OffscreenCanvas\(/, 'builds a canvas'], [/putImageData/, 'paints pixels'], [/createImageData/, 'allocates ImageData']]) {
      if (re.test(rx)) problems.push(`spoutReceiver ${what} — Spout takes textures, not pixels`);
    }
    // The frame it replaces must be released, and the incompatibility must be reportable.
    if (!/\.close\(\)/.test(rx)) problems.push('spoutReceiver never closes a VideoFrame — it leaks a GPU image per frame');
    if (!/spoutIncompatibility/.test(rx)) problems.push('spoutReceiver no longer reports incompatibility — a machine that cannot do this must be told');
    // The measurement that says an immediate close is safe must stay recorded here, or the next
    // reader re-derives the same wrong worry and adds a retirement queue nobody needs. `raw`, not
    // `read`: this asserts a COMMENT, and `read` strips them.
    if (!/createImageBitmap/.test(raw('plugins/spout/src/spoutReceiver.ts'))) {
      problems.push('spoutReceiver lost the note on why closing a frame on replacement is safe for async readers — without it someone will add a grace period again');
    }
    // The addon must not regrow the readback either.
    const lib = stripComments(read('native/spout-receiver/src/lib.rs'));
    if (/fn receive_frame/.test(lib)) problems.push('the addon has a receive_frame again — that is the readback path');
    if (!/fn receive_shared/.test(lib)) problems.push('the addon no longer exposes receive_shared — the GPU path is gone');
    // And the manager must refuse rather than degrade.
    const mgr = stripComments(read('plugins/spout/src/spoutManager.ts'));
    if (!/Incompatibility/.test(mgr)) problems.push('spoutManager no longer reports why Spout is unavailable');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Syphon is GPU-only too, and its IOSurface is given back ────────────────────────────────────
check(
  'Syphon delivers GPU textures only — and the IOSurface reference is released on every path',
  'Syphon is the macOS twin of the Spout check above, and every word of that reasoning applies: no ' +
  'pixel-readback path, not even as a silent fallback, and every VideoFrame closed on replacement. ' +
  'But it carries ONE HAZARD SPOUT DOES NOT, and it is the whole reason this check exists ' +
  'separately. On Windows, Electron DUPLICATES the NT handle on import, so the addon owns its copy ' +
  'and the plugin owes nothing. On macOS, Electron RETAINS the IOSurface instead (Chromium: ' +
  'ScopedCFTypeRef(io_surface, scoped_policy::RETAIN)) — so the +1 that newSurface handed us is ' +
  'STILL OURS after the hand-off, whether the import succeeded, failed, or threw. Release it on the ' +
  'happy path only and a full-resolution surface leaks every time an import fails; forget it and one ' +
  'leaks every frame, which at 60 Hz is VRAM gone in seconds. That is why the release lives in a ' +
  'finally, and why this asserts the finally and not merely the call.',
  () => {
    const problems = [];
    const rx = stripComments(read('plugins/syphon/src/syphonReceiver.ts'));
    for (const [re, what] of [[/new OffscreenCanvas\(/, 'builds a canvas'], [/putImageData/, 'paints pixels'], [/createImageData/, 'allocates ImageData']]) {
      if (re.test(rx)) problems.push(`syphonReceiver ${what} — Syphon takes textures, not pixels`);
    }
    if (!/\.close\(\)/.test(rx)) problems.push('syphonReceiver never closes a VideoFrame — it leaks a GPU image per frame');
    if (!/syphonIncompatibility/.test(rx)) problems.push('syphonReceiver no longer reports incompatibility — a machine that cannot do this must be told');
    // Same comment-preservation rule as Spout: this file is a near-copy, and a copy made without the
    // measurement grows a retirement queue back. `raw`, not `read` — it asserts a COMMENT.
    if (!/createImageBitmap/.test(raw('plugins/syphon/src/syphonReceiver.ts'))) {
      problems.push('syphonReceiver lost the note on why closing a frame on replacement is safe for async readers — without it someone will add a grace period again');
    }
    // THE macOS-SPECIFIC ONE. The release must be unconditional, so require the finally that makes
    // it so — a bare releaseSurface() on the success path is the bug this is here to catch.
    const mgr = stripComments(read('plugins/syphon/src/syphonManager.ts'));
    if (!/releaseSurface/.test(mgr)) problems.push('syphonManager never releases the IOSurface — Electron RETAINS it, so our +1 leaks a surface per frame');
    if (!/finally\s*\{[\s\S]*?releaseSurface/.test(mgr)) {
      problems.push('syphonManager releases the IOSurface outside a finally — a failed or throwing import would leak it');
    }
    if (!/Incompatibility/.test(mgr)) problems.push('syphonManager no longer reports why Syphon is unavailable');
    // The addon must keep the GPU surface entry point and the release that balances it.
    const lib = stripComments(read('native/syphon-receiver/src/lib.rs'));
    if (!/fn receive_shared/.test(lib)) problems.push('the addon no longer exposes receive_shared — the GPU path is gone');
    if (!/fn release_surface/.test(lib)) problems.push('the addon no longer exposes release_surface — nothing can give the +1 back');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── No raw NUL bytes in source ─────────────────────────────────────────────────────────────────
check(
  'no source file contains a raw NUL byte',
  'A NUL inside a string literal is legal JavaScript and compiles, runs and typechecks without a ' +
  'murmur — so nothing catches it. Git does: its binary heuristic keys on NUL in the first 8 KB, and ' +
  'a file that trips it is marked -text, which silently turns OFF line-ending normalisation. The ' +
  'result is a 3,700-line phantom diff on a file whose actual change was one line, a review nobody ' +
  'can read, and a merge conflict surface across the whole file. That happened here: a composite-key ' +
  'separator meant to be a space went in as U+0000, in three files, and the first symptom was ' +
  'Timeline.tsx appearing wholly rewritten. A control character IS a legitimate key separator — the ' +
  'timeline already joins with \\x01 and that is fine — but WRITE IT AS AN ESCAPE (\'\\u0001\'), so ' +
  'the bytes on disk stay ASCII and the intent is visible to the next reader. NUL specifically is ' +
  'never worth it, because it is the one byte git treats as "this is not text".',
  () => {
    const bad = [];
    for (const f of [...walk('src'), ...walk('shared'), ...walk('plugins'), ...walk('packages')]) {
      // Bytes, not text: the whole point is a character that reading as UTF-8 would hide.
      if (fs.readFileSync(path.join(ROOT, f)).includes(0x00)) bad.push(f);
    }
    return bad.length
      ? `raw NUL byte in ${bad.join(', ')} — write it as an escape (\\u0001) or use a printable separator`
      : null;
  },
);

// ── Spout and Syphon are siblings, and the operator can actually REACH Syphon ──────────────────
check(
  'Syphon has a door, and every file that knows about Spout knows about Syphon',
  'Syphon is Spout on the other OS. The behaviour lives in a plugin, but the places that DISPATCH on ' +
  'content type are core and hardcoded — the picker row in ContentEditor, the STREAMED sets in ' +
  'App/ProjectorApp, the timeline conflict check, the atlas key. A content-source plugin can ' +
  'contribute its editor but NOT its own button, so a new type is only half-added until core names ' +
  'it, and every one of those sites fails silently: no button means the feature is unreachable, and ' +
  'a missing STREAMED entry means projector outputs treat it as SELF_RENDER and render NOTHING while ' +
  'the editor preview looks perfect. Both of those were real, in this repo, on this branch — the ' +
  'plugin was complete, shipped, CI-green and had no way to select it. The rule that catches it is ' +
  'blunt on purpose: the two are siblings, so a file that names one must name the other. If you are ' +
  'adding a THIRD GPU-share source, generalise this check rather than deleting it. See also the ' +
  'repo\'s standing lesson that "it already exists" is never the answer to "I cannot find it".',
  () => {
    const problems = [];
    // Sibling parity, by file. Cheap, and it finds a new dispatch site the day someone adds one.
    // Comment-stripped (via read), so a passing mention in prose does not satisfy the rule.
    const files = [...walk('src'), ...walk('shared')];
    for (const f of files) {
      const src = read(f);
      for (const [a, b] of [['SourceType.SPOUT', 'SourceType.SYPHON'], ['spoutName', 'syphonName']]) {
        if (src.includes(a) && !src.includes(b)) {
          problems.push(`${f} handles ${a} but not ${b} — the two are siblings and divergence is always a bug`);
        }
      }
    }
    // The door itself. A button that only exists inside a platform conditional still counts: the
    // point is that the type is reachable somewhere, not that it is always visible.
    const editor = read('src/renderer/components/ContentEditor.tsx');
    if (!/pickType\(SourceType\.SYPHON\)/.test(editor)) {
      problems.push('ContentEditor has no Syphon button — the content type cannot be selected, so the plugin is unreachable');
    }
    // And a glyph with no help entry is the exact shape of a feature that ships and is never found.
    if (!/content\.syphon/.test(read('src/renderer/help/entries/content.ts'))) {
      problems.push('no content.syphon help entry — a picker glyph with no help is how a shipped feature stays invisible');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── The output port copies its frames, and does not transfer them ─────────────────────────────
check(
  'frames are POSTED to the output port, never transferred',
  'postMessage(buf, [buf]) is the standard zero-copy idiom and is perfectly legal on a DOM MessagePort. ' +
  "Across Electron's renderer↔main port it is not: the message ARRIVES — main's handler fires, on time, " +
  'every frame — but e.data is NULL. No error, no warning, nothing in either console; just a steady ' +
  'stream of empty messages and a venue with no output, while every gate you would naturally suspect ' +
  '(is the transport ready? is the port alive?) reports fine. This is the single most plausible ' +
  '"optimisation" someone will make to this file, and it silently kills the show.',
  () => {
    const src = stripComments(read('src/renderer/engine/framePort.ts'));
    // Any postMessage on the port with a transfer list is the mistake.
    if (/port\.postMessage\([^)]*,\s*\[/.test(src)) {
      return 'framePort transfers the frame buffer — Electron delivers null on the main side; post it instead';
    }
    if (!/port\.postMessage\(\s*frame\s*\)/.test(src)) {
      return 'framePort no longer posts the frame — this guard has gone blind';
    }
    return null;
  },
);

// ── HAP decompresses off the DOM, and keeps a way back ────────────────────────────────────────
check(
  'HAP decompresses into an OffscreenCanvas, with the DOM canvas still reachable',
  'hapGL uploads BC blocks as a compressed WebGL2 texture and draws them to a canvas that is NEVER ' +
  'displayed — it is a decompression target that gets sampled. A DOM element there cannot exist in a ' +
  'worker, which is where the engine is going. But HAP is also the most show-critical codec in the app, ' +
  'so the old path must stay reachable: automatically when OffscreenCanvas or a WebGL2 context on it is ' +
  'unavailable, and deliberately via localStorage["artlux.hapDomCanvas"] for a venue that needs to ' +
  'revert without a rebuild. Remove either and the revert becomes theatre.',
  () => {
    const src = stripComments(read('plugins/hap/src/hapGL.ts'));
    const problems = [];
    if (!/new OffscreenCanvas\(/.test(src)) problems.push('hapGL no longer decompresses into an OffscreenCanvas');
    if (!/artlux\.hapDomCanvas/.test(src)) problems.push('the per-machine revert switch (artlux.hapDomCanvas) is gone');
    if (!/document\.createElement\('canvas'\)/.test(src)) problems.push('the DOM-canvas fallback is gone — nothing to fall back TO');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Decoded frames are owned, and owned things get closed ─────────────────────────────────────
check(
  'ImageBitmaps and camera VideoFrames are closed, not dropped',
  'Both hold memory the garbage collector will not hurry to reclaim, and a VideoFrame additionally pins ' +
  'a decoder buffer — leak a few and the camera stalls outright. Neither failure looks like a bug on ' +
  'screen: the picture is fine and the memory climbs, which is the worst way for this to go wrong. So ' +
  'the entry drop path must close an image bitmap, and the camera pump must close the frame it is ' +
  'replacing as well as the one it is holding when it stops.',
  () => {
    const src = stripComments(read('src/renderer/services/contentSource.ts'));
    const problems = [];
    const drop = fnBody(src, 'dropMedia');
    if (!drop) problems.push('dropMedia not found — this guard has gone blind');
    else if (!/\.bmp\?\.close\(\)|\.bmp\.close\(\)/.test(drop)) {
      problems.push('dropMedia does not close the ImageBitmap — that is a GPU-memory leak per surface retype');
    }
    // The pump replaces the held frame every time one arrives; stopCamera closes the last one.
    // Two spellings are accepted because the camera stopped being ONE global: it is a capture per
    // device now (`cams`, keyed by SurfaceContent.cameraDeviceId), so the held frame lives on the
    // per-device record. The obligation is unchanged — only the noun moved.
    const CLOSES_FRAME = /(?:cameraFrame|cam\.frame)\?\.close\(\)/;
    if (!CLOSES_FRAME.test(src)) {
      problems.push('the camera frame is never closed — VideoFrames pin decoder buffers and the camera will stall');
    }
    const stop = fnBody(src, 'stopCamera');
    if (stop && !CLOSES_FRAME.test(stop)) {
      problems.push('stopCamera leaves the last VideoFrame open');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Unsaved work is visible, and closing cannot discard it silently ───────────────────────────
check(
  'the unsaved-work guard cannot be silently defeated',
  'Closing the editor used to throw away every unsaved change with no prompt, and nothing on screen ' +
  'had ever said the document differed from the file. Four things make the fix true, and every one ' +
  'of them fails INVISIBLY — the app still runs, still saves, and merely stops protecting anything. ' +
  '(1) The dirty signature must drop `timestamp`: buildProjectData stamps a fresh ISO date on every ' +
  'call, so keeping it reports an untouched project as permanently modified, and an always-on ' +
  'indicator is worse than none. (2) The close guard needs its backstop, or a crashed or hung ' +
  'renderer makes the app UNQUITTABLE — worse, on a venue machine, than losing the edit. (3) Show ' +
  'modes must not guard at all: nobody is there to answer. (4) Save All must target the ACTIVE scene ' +
  'only — buildSceneSnapshot is the live look, so spreading it across every scene would overwrite ' +
  'the whole show with whatever is on screen.',
  () => {
    const problems = [];
    const app = stripComments(read('src/renderer/App.tsx'));
    if (!/const\s*\{\s*timestamp:[^}]*\}\s*=\s*data/.test(app)) {
      problems.push('the document signature no longer strips `timestamp` — buildProjectData re-stamps it every call, so the document would read as modified forever');
    }
    if (!/fixtureLookEqual\(/.test(app)) {
      problems.push('the scene-look check no longer goes through sceneLook.fixtureLookEqual — comparing whole fixtures reports every recalled scene as modified, because a recall deliberately leaves the rig half alone');
    }
    // Save All commits ONE scene. The signature of the old catastrophe: mapping every scene.
    const saveAll = fnBody(app, 'handleSaveAll');
    if (!saveAll) problems.push('handleSaveAll not found — this guard has gone blind');
    else if (!/s\.id === scene\.id \? sceneWithLook\(s\) : s/.test(saveAll)) {
      problems.push('handleSaveAll no longer stores the look into the ACTIVE scene alone — stamping the live look onto every scene would overwrite the whole show');
    }
    if (!exists('src/main/closeGuard.ts')) return 'src/main/closeGuard.ts is gone — closing would discard unsaved work again';
    const guard = stripComments(read('src/main/closeGuard.ts'));
    if (!/setTimeout\(/.test(guard)) {
      problems.push('closeGuard has no backstop timer — a renderer that never answers would make the window impossible to close');
    }
    const index = stripComments(read('src/main/index.ts'));
    if (!/guardClose\(mainWindow,\s*!HEADLESS && !BROADCAST\)/.test(index)) {
      problems.push('the close guard is not armed editor-only — a show mode has no operator to answer it and must never refuse to close');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── An alignment aid shows the PROJECTOR, not the picture ─────────────────────────────────────
check(
  'alignment aids are drawn unwarped, off the real soft edge, and are never persisted',
  'The aids exist for the job that comes before every other output feature: standing in a venue ' +
  'aiming, zooming, rolling and focusing real machines until they overlap. Three things make them ' +
  'true, and each is invisible to a typechecker. (1) They are drawn in the RAW RASTER — DOM/SVG over ' +
  'the canvas, never through the warp pipeline — because you are adjusting where the light goes, and ' +
  'an aid that moved with the corner-pin would hide the error being hunted. (2) The blend band comes ' +
  "from the output's REAL softEdge, not from the `render` payload, which is deliberately flattened " +
  'when NVAPI owns the geometry (the double-blend guard) — an aid that vanished on a hardware-blended ' +
  'rig would disappear exactly where it is needed most. (3) The state is transient: anything that ' +
  'reached ProjectorOutput could be saved on and then come up over a show, which is the same trap ' +
  'Identify avoids.',
  () => {
    const problems = [];
    if (!exists('src/renderer/projector/AlignAids.tsx')) return 'projector/AlignAids.tsx is gone';
    const aid = stripComments(read('src/renderer/projector/AlignAids.tsx'));
    // Raster space: the overlay is SVG/DOM. A canvas here would mean it had joined the warped path.
    if (!/<svg/.test(aid)) problems.push('AlignAids no longer draws with SVG — the aid must stay in the raw raster, outside the warp pipeline');
    const app = stripComments(read('src/renderer/App.tsx'));
    // The aid payload must read the output's own softEdge, not the flattened one in `render`.
    if (!/t: 'aid'/.test(app)) problems.push('App no longer pushes the alignment aid to its outputs');
    else if (!/soft:\s*out\?\.softEdge/.test(app)) {
      problems.push("the aid's blend band is not taken from out.softEdge — under hwWarp the render payload is flat, so the band would vanish on a hardware-blended rig");
    }
    // Never persisted: no aid field may appear on the ProjectorOutput contract.
    if (/\baid\w*\s*\?:/.test(stripComments(read('shared/protocol.ts')))) {
      problems.push('ProjectorOutput has gained an alignment-aid field — aids must stay transient App state or one can be saved into a show');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Every window ArtLux opens wears ArtLux's mark ──────────────────────────────────────────────
check(
  'every framed window carries the app icon, from one source',
  'Only the editor window ever set `icon:`, so the projector outputs and the Docs window fell back to ' +
  "ELECTRON'S OWN default mark — in their title bar, their taskbar button and Alt-Tab, sitting next to " +
  'an editor window wearing the real one. It is the renderer AppMark bug one process over: it compiles, ' +
  'it boots, nothing throws, and the app is simply branded as somebody else half the time, which is ' +
  'invisible until a person looks at a title bar. The path is easy to get wrong too — it once pointed ' +
  'at build/icon.png, which resolves in dev and never in a packaged build — so there is one constant ' +
  'and every window reads it.',
  () => {
    const problems = [];
    if (!exists('src/main/appIcon.ts')) return 'src/main/appIcon.ts is gone — the one source of the window icon';
    // The path must stay inside what electron-builder actually ships (`files: out/**/*`).
    if (!/renderer\/icon\.png/.test(stripComments(read('src/main/appIcon.ts')))) {
      problems.push('appIcon.ts no longer points at out/renderer/icon.png — build/ is NOT in the asar, so an installer build would find nothing');
    }
    // Every window with a frame (i.e. an OS title bar / taskbar entry) must set it. The splash and the
    // editor are frameless and draw their own chrome, but the editor is also the taskbar entry, so it
    // is included; splash is excluded because it has no frame AND no taskbar button.
    for (const f of ['src/main/index.ts', 'src/main/projector.ts', 'src/main/docsWindow.ts', 'src/main/panelWindows.ts']) {
      const src = stripComments(read(f));
      if (!/new BrowserWindow\(/.test(src)) continue; // no window here any more — nothing to assert
      if (!/icon:\s*APP_ICON/.test(src)) problems.push(`${f} opens a window without icon: APP_ICON`);
      if (!/from '\.\/appIcon'/.test(src)) problems.push(`${f} does not read the icon from ./appIcon — a second path is how this drifted before`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── A live input you can have two of must let the operator say WHICH ──────────────────────────
check(
  'a camera surface names its device, and the inspector can choose it',
  'Spout names a sender and NDI names a source; the camera named NOTHING and opened whatever ' +
  'getUserMedia({video:true}) handed back — the OS default video input. On a show machine that is ' +
  'routinely a VIRTUAL camera (NDI Webcam Input, OBS, a vendor overlay), which opens perfectly and ' +
  'then produces no frames, so the surface sat empty forever. It cost a site visit to diagnose, ' +
  'because the same physical camera worked in the MediaPipe and calibration wizards — they had ' +
  'always had a device picker of their own, and that asymmetry WAS the bug. Nothing about it is ' +
  'visible to a typechecker: the code compiles, the app boots, the permission is granted and no ' +
  'error is thrown. So the demand must carry a device (per consumer, so two surfaces can hold two ' +
  'cameras), the drawable must be resolved by that device, and the inspector must offer the list.',
  () => {
    const src = stripComments(read('src/renderer/services/contentSource.ts'));
    const problems = [];
    const acq = fnBody(src, 'acquire');
    if (!acq) problems.push('contentSource.acquire not found — this guard has gone blind');
    else if (!/cameraDeviceId/.test(acq)) {
      problems.push('acquire ignores content.cameraDeviceId — every camera surface is back on one capture of the DEFAULT device');
    }
    const draw = fnBody(src, 'getDrawable');
    if (!draw) problems.push('contentSource.getDrawable not found — this guard has gone blind');
    else if (!/cameraDeviceId/.test(draw)) {
      problems.push('getDrawable does not resolve the camera by device — a second camera would show the first one picture');
    }
    const editor = stripComments(read('src/renderer/components/ContentEditor.tsx'));
    if (!/SourceType\.CAMERA\s*&&\s*<CameraSettings/.test(editor)) {
      problems.push('the content inspector does not render CameraSettings for a camera surface — the choice exists but the operator cannot reach it');
    }
    const ui = stripComments(read('src/renderer/components/CameraSettings.tsx'));
    if (!/cameraDeviceId/.test(ui)) problems.push('CameraSettings offers no device picker');
    // The picture controls must be driven by the DEVICE's capabilities, not by a hardcoded list —
    // that is what lets one panel serve a plain webcam and a PTZ head, and what stops us shipping a
    // slider for something the camera does not have.
    if (!/capabilities/.test(ui)) {
      problems.push('CameraSettings does not read the device capabilities — the control list must come from the camera, not from a fixed list');
    }
    // A drag must reach the device WITHOUT a document write per pointer move: App owns the state and
    // the tree is only partly memoized, so committing on every move re-renders the editor at pointer
    // rate and the slider feels broken. onInput previews, onChange commits.
    if (!/onInput=\{[^}]*previewCameraControl/.test(ui)) {
      problems.push('a camera control slider must preview through previewCameraControl on onInput, not commit on every pointer move');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── A codec must not claim a file it cannot decode ────────────────────────────────────────────
check(
  'the mp4 codec asks the decoder before claiming a file',
  'mp4Decoder.open() proves only that mp4box can DEMUX the container. Whether WebCodecs can decode the ' +
  'track is a separate question — an HEVC profile or a 10-bit pixel format demuxes perfectly and then ' +
  'fails at configure(), which surfaces far away as a console warning and no frames. By then the host ' +
  'has handed the file to the codec and dropped the <video> that would have played it, so the surface ' +
  'goes BLACK while the app reports it is playing. Declining at probe time is what lets the existing ' +
  'fallbacks do their job (contentSource → <video>, timeline → syncVideoLayer, thumbnails → video ' +
  'queue), and it is what made defaulting WebCodecs ON safe.',
  () => {
    const src = stripComments(read('plugins/mp4/src/mp4Decoder.ts'));
    if (!/VideoDecoder\.isConfigSupported\(/.test(src)) {
      return 'mp4Decoder.ts must call VideoDecoder.isConfigSupported( before reporting a file openable';
    }
    // It must gate the RESULT, not merely be called. Match the RESOLUTION, not any mention of
    // `supported` — the first version of this check accepted a build where the flag was only logged
    // (`if (!s.supported) console.info(...)`) while open() resolved successfully regardless, which is
    // precisely the bug the guard exists for.
    const gatesResult =
      /done\([^;]*\.supported[^;]*\)/.test(src) ||                       // done(s.supported ? info : null)
      /\.supported\s*\)[^;]*\breturn\b[^;]*done\(\s*null\s*\)/.test(src); // if (!s.supported) return done(null)
    if (!gatesResult) {
      return "isConfigSupported() is called but its `supported` flag never decides what open() resolves to";
    }
    return null;
  },
);

check(
  'the startup splash never opens in headless or broadcast mode',
  'Broadcast is the WATCHDOG\'S RELAUNCH MODE: an unattended venue PC self-heals into it, mid-show, with ' +
  'fullscreen projector outputs already on the displays. The splash is alwaysOnTop, so opening it there ' +
  'would flash a credits window over live output every time the app recovered — and headless has no ' +
  'screen to open anything on at all. The gate lives at the ONE call site in main/index.ts; nothing ' +
  'else may call open(). Nothing about this fails at build time: it looks perfect in the editor.',
  () => {
    const problems = [];
    const src = read('src/main/index.ts');
    // The single call site must be guarded by both mode flags on the same line.
    const call = src.split(/\r?\n/).find((l) => /splash\.open\(\)/.test(l));
    if (!call) problems.push('main/index.ts no longer opens the splash at all');
    else if (!/!HEADLESS/.test(call) || !/!BROADCAST/.test(call)) {
      problems.push('splash.open() is no longer gated on !HEADLESS && !BROADCAST on its own line');
    }
    // And it must be the only call site: a second one elsewhere would bypass that gate.
    const callers = [...walk('src/main'), ...walk('src/renderer'), ...walk('plugins')]
      .filter((f) => !f.endsWith('src/main/splashWindow.ts') && !f.endsWith('src/main/index.ts'))
      .filter((f) => /splash\.open\(|openSplash\(/.test(read(f)));
    if (callers.length) problems.push(`splash.open() is called outside main/index.ts: ${callers.join(', ')}`);
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a window that must appear never depends on ready-to-show alone',
  'READY-TO-SHOW DOES NOT ALWAYS FIRE in a packaged build. The editor window has known this for a long ' +
  'time and reveals on three paths (ready-to-show + did-finish-load + a backstop timer) because relying ' +
  'on the event alone once left the app running with NO WINDOW AT ALL. The splash then shipped in ' +
  'v0.25.0 with a single `once(ready-to-show)` and hit exactly that: on the packaged Windows build the ' +
  'event never arrived, showInactive() never ran, and the window existed while being invisible — and ' +
  'because its close deadlines are measured from the show time, `Date.now() - 0` read as "long past" ' +
  'and destroyed it silently. Nothing throws, nothing logs an error, the feature is simply absent.',
  // THIS CHECK WAS ITSELF THE BUG, TWICE OVER, and that is why it now works per reveal SITE.
  //
  // It used to iterate a hardcoded ['splashWindow.ts', 'index.ts'] and regex each file AS A WHOLE. Both
  // halves were holes. (1) `src/main/projector.ts` was never in the list — the one window whose entire
  // purpose is to be seen in a venue, and in broadcast the ONLY thing on screen. It revealed on
  // `ready-to-show` alone at two sites and the guard never looked. (2) `index.ts` PASSED while its
  // broadcast branch was just as exposed, because the editor's `did-finish-load` and
  // `setTimeout(revealEditor, …)` live in the same file and satisfied a whole-file regex on the
  // broadcast branch's behalf. A guard that cannot fail is worse than no guard: CLAUDE.md cites this
  // one as the reason the rule is safe to rely on.
  //
  // So: every `ready-to-show` registration anywhere in src/main must hand it a NAMED handler, and that
  // same handler must also be reachable from `did-finish-load` and from a `setTimeout` backstop. Naming
  // it is what makes the other two paths possible, which is why an inline arrow fails outright.
  () => {
    const problems = [];
    const files = walk('src/main').filter((f) => /\.(?:ts|tsx|cjs)$/.test(f) && /ready-to-show/.test(read(f)));
    for (const f of files) {
      const src = read(f);
      const rel = f.replace(/\\/g, '/').replace(/^.*?(src\/main\/)/, '$1');
      for (const m of src.matchAll(/\.(?:on|once)\(\s*['"]ready-to-show['"]\s*,\s*([^)]*?)\s*\)/g)) {
        const handler = m[1].trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(handler)) {
          problems.push(`${rel}: ready-to-show is given an inline function — name it, so the did-finish-load and backstop paths can reveal the same window`);
          continue;
        }
        // Reached from did-finish-load: either as the handler itself or called inside one.
        if (!new RegExp(`did-finish-load[\\s\\S]{0,160}?\\b${handler}\\b`).test(src)) {
          problems.push(`${rel}: '${handler}' reveals on ready-to-show but is never reached from did-finish-load (the event that ALWAYS fires)`);
        }
        if (!new RegExp(`setTimeout\\(\\s*${handler}\\b`).test(src)) {
          problems.push(`${rel}: '${handler}' has no backstop timer for the case ready-to-show never fires`);
        }
      }
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  '--project= reaches the document in every run mode',
  'A CLI flag that parses, forwards, and is then IGNORED fails silently in the one mode a human is ' +
  'watching. `--project=` was read in main/index.ts, used for the tray label and the watchdog\'s ' +
  'recovery target, and put on the renderer query string — but ONLY in the headless and broadcast ' +
  'branches, while App.tsx guarded its single consumer with `if (!SHOW_ENGINE) return`. So ' +
  '`ArtLux.exe --project=<file>` opened an EMPTY EDITOR: no error, no warning, no clue. It stayed ' +
  'invisible for as long as it did because the two modes that exercise the flag are the two nobody ' +
  'watches. This is also the ONLY contract an external program has for "open this project" — there ' +
  'is no file association and no protocol handler — so the editor path is the one that must work. ' +
  'Same class on the second-instance handler: it discarded the incoming argv and the second process ' +
  'exited 0, so launching a project against a running copy brought the existing window forward still ' +
  'showing the OLD project and reported success to whoever spawned it. Covers the whole launcher CLI ' +
  'contract — `--project=`, `--new-project=` and `--calibrate` — because all three are spelled ' +
  'literally in a product this repository does not build or typecheck.',
  () => {
    const problems = [];
    const src = read('src/main/index.ts');

    // 1. The editor branch of createWindow must carry the path to the renderer. Anchored on the
    //    branch marker rather than on a load call, so a reshuffle of loadURL/loadFile still checks
    //    the right region.
    const i = src.indexOf('} else if (devUrl) {');
    if (i < 0) problems.push('could not find the editor load branch in main/index.ts — this check needs updating');
    else {
      // The branch may forward the path directly or through a helper; what matters is that SOMETHING
      // carrying the flag reaches the renderer. Follow one level of indirection rather than pinning
      // this to a spelling — the first version broke the moment the two flags were factored into
      // editorQuery(), reporting a regression that had not happened.
      const branch = src.slice(i, i + 600);
      const viaHelper = /editorQuery\(/.test(branch) && /function editorQuery[\s\S]{0,300}PROJECT_PATH/.test(src);
      if (!/PROJECT_PATH/.test(branch) && !viaHelper) {
        problems.push('the editor branch of createWindow no longer forwards PROJECT_PATH to the renderer');
      }
    }

    // 2. The second-instance handler must read --project= out of the argv it is handed.
    const si = src.indexOf("app.on('second-instance'");
    if (si < 0) problems.push('main/index.ts no longer handles second-instance');
    else if (!/--project=/.test(src.slice(si, si + 600))) {
      problems.push("the second-instance handler ignores the incoming argv's --project=");
    }

    // 3. The same for --new-project=, which is how the launcher creates a project. It carries an
    //    extra hazard the plain flag does not: the renderer must write the clean document through
    //    the SAME helper the File menu uses. A second copy of "what a new project contains" is the
    //    duplication App.tsx records as having drifted three times.
    if (!/--new-project=/.test(src)) problems.push('main/index.ts no longer parses --new-project=');
    const appSrc = read('src/renderer/App.tsx');
    if (!/QUERY_NEW_PROJECT/.test(appSrc)) {
      problems.push('App.tsx never reads the newProject query — the launcher could not create a project');
    }
    // CALL sites only: the definition is `const writeNewProjectTo = async (…)`, which this pattern
    // deliberately does not match. Two calls are expected — the File menu and the CLI flag — and
    // fewer means one of them has grown its own copy of the clean-document list.
    const writers = (appSrc.match(/writeNewProjectTo\(/g) || []).length;
    if (writers < 2) {
      problems.push(
        `writeNewProjectTo is called ${writers}x (want the menu path and the --new-project= path) — ` +
        'one entry point is no longer sharing the clean-document definition',
      );
    }

    // 4. The renderer must consume --project= OUTSIDE the show-engine guard. Two uses are expected:
    //    the broadcast/headless loader, and the editor-only one.
    const app = appSrc;
    const uses = (app.match(/QUERY_PROJECT/g) || []).length;
    if (uses < 2) {
      problems.push(`App.tsx references QUERY_PROJECT ${uses}x — the editor-mode load is gone (show mode is the other use)`);
    }
    if (!/SHOW_ENGINE\s*\|\|\s*!QUERY_PROJECT|!QUERY_PROJECT\s*\|\|\s*SHOW_ENGINE/.test(app)) {
      problems.push('App.tsx has no editor-mode QUERY_PROJECT path (expected an early return on `SHOW_ENGINE || !QUERY_PROJECT`)');
    }

    // 5. `--calibrate` is the second half of the same contract: the launcher's Projects and Examples
    //    tabs spell it literally when starting a machine that is going to be aligned. Renaming it
    //    would typecheck, boot, and break a SHIPPED SEPARATE PRODUCT that this repo does not build,
    //    with no signal anywhere — the launcher would spawn the flag, ArtLux would drop it the way it
    //    drops any unknown argument, and the operator would get the ordinary editor with no Calib
    //    rail entry and nothing to explain why. The whole chain is asserted, not just the parse:
    //    argv → the renderer query → the registration that puts the workbench on screen.
    const prof = read('src/main/runProfile.ts');
    if (!/'--calibrate'/.test(prof)) {
      problems.push("runProfile.ts no longer parses '--calibrate' — the launcher's calibration launch is dead");
    }
    if (!/calibrate:\s*'1'/.test(prof)) {
      problems.push('profileQuery() no longer emits calibrate=1 — the flag would parse and never reach a window');
    }
    const rprof = read('src/renderer/services/runProfile.ts');
    if (!/QS\.get\('calibrate'\)/.test(rprof)) {
      problems.push('the renderer no longer reads the calibrate query param');
    }
    if (!/if\s*\(CALIBRATION_ENABLED\)\s*contextRegistry\.register/.test(read('src/renderer/contexts/index.tsx'))) {
      problems.push('the Calib workspace context is no longer gated on CALIBRATION_ENABLED — a launch into calibration would show nothing');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the credit + licence line have one source and are actually shown',
  'LICENSE §3 requires a build to show the authorship credit and the non-commercial restriction — so ' +
  'these strings are a licence obligation, not chrome, and a UI that quietly dropped them would put the ' +
  'build out of compliance with its own licence. They live once in shared/credits.ts (the same pattern as ' +
  'shared/brandMarks.ts, for the same reason: About already carried a hand-written explainer that had ' +
  'drifted from package.json\'s description, next to a footer crediting a party that is not an author). ' +
  'Re-typing an author name or the restriction anywhere else re-opens that drift.',
  () => {
    const problems = [];
    if (!exists('LICENSE')) problems.push('LICENSE is gone — the splash/About text cites clauses that must exist');
    if (!exists('shared/credits.ts')) return 'shared/credits.ts is gone (the one source for the credit + licence lines)';
    // Both surfaces must render them, from the module rather than from a literal.
    for (const f of ['src/renderer/components/splash/SplashScreen.tsx', 'src/renderer/components/About.tsx']) {
      if (!exists(f)) { problems.push(`${f} is gone — the credit/licence must be visible in the app`); continue; }
      const src = read(f);
      if (!/credits/.test(src)) problems.push(`${f} no longer imports shared/credits`);
      if (!/AUTHORS_LINE/.test(src)) problems.push(`${f} no longer renders the authorship credit (LICENSE §3)`);
      if (!/LICENSE_HEADLINE/.test(src)) problems.push(`${f} no longer renders the non-commercial licence line (LICENSE §3)`);
    }
    // Nobody hardcodes an author's name outside the one source (credits.ts itself excepted).
    for (const f of [...walk('src/renderer'), ...walk('src/main'), ...walk('plugins'), ...walk('shared')]) {
      if (f.endsWith('shared/credits.ts')) continue;
      if (/Jawhari|Recoules/.test(read(f))) problems.push(`${f} hardcodes an author name — import it from shared/credits`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Naming: a default name is numbered from what is TAKEN, never from the list length ─────────
check(
  'numbered default names come from nextNumberedName, not from a list length',
  'A numbered default name in a list the operator can also DELETE from cannot be `${list.length + 1}`: ' +
  'delete `Track 1` out of `[Track 1, Track 2]` and the count says the next one is `Track 2` — which is ' +
  'already on screen. Nothing breaks (all of these are keyed by uuid, nothing looks up by name) but the ' +
  'operator is then reading two rows wearing one label, and in the state graph or a zone dropdown that ' +
  'costs real time on site. Every door that mints one — surfaces, fixtures (incl. from a template), ' +
  'controllers, groups, scenes, states, video layers, audio tracks, the mixer\'s +Bed, cues, banks, ' +
  'graph regions, zones — shares nextNumberedName from the SDK, which takes the highest number ' +
  'ALREADY WEARING THAT WORD and adds one.',
  () => {
    const problems = [];
    if (!exists('packages/sdk/src/index.ts') || !/export function nextNumberedName/.test(read('packages/sdk/src/index.ts')))
      return 'packages/sdk/src/index.ts no longer exports nextNumberedName (every numbered mint shares it)';
    // The regression itself, anywhere. Deliberately tree-wide rather than a file list — the point is
    // that a NEW door cannot reintroduce it either. Two nets, because the first version of this check
    // keyed on `name:` and three live bugs walked straight through it: `name: f.name || \`Template
    // ${templates.length + 1}\`` (not adjacent to the key) and `tk.name = \`Take ${…}\`` (an assignment,
    // no key at all).
    //
    // Net 2 matches the SHAPE OF A MINTED NAME instead of its syntax: a template that is exactly
    // `Word ` + one interpolation + end, where the expression counts something. That is a default
    // name and nothing else — a label built from a position (`Camera ${i + 1}`, `Fire column ${c + 1}`)
    // counts nothing, and a sentence (`Imported ${n.length} files`) has text after the hole.
    const MINT = /name *[:=] *`[^`]*\$\{[^}]*\.length[^}]*\}[^`]*`/;
    const SHAPE = /`[A-Z][A-Za-z]*(?: [A-Za-z]+)* \$\{[^}]*(?:\.length|count)[^}]*\}`/;
    for (const f of [...walk('src/renderer'), ...walk('src/main'), ...walk('plugins'), ...walk('shared')]) {
      const src = read(f);
      const m = src.match(MINT) || src.match(SHAPE);
      if (m) problems.push(`${f} numbers a default name from a count: ${m[0].trim()}`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Patch: ONE owner of the DMX footprint formula ─────────────────────────────────────────────
check(
  'DMX footprint is computed only by addressing.ts',
  'How many channels a fixture occupies was open-coded as `ledCount * (channelsPerPixel ?? 4)` in ' +
  'SEVEN places: three in addressing.ts, the DMX-in universe span in Stage, the DMX monitor\'s wire ' +
  'footprint, the fixture editor\'s channel count and the routing modal\'s span. That was survivable ' +
  'only while every fixture was a pixel strip. A PROFILED fixture (a moving head) occupies its ' +
  'MODE\'s footprint instead, and the pixel product is simply the wrong number for it. Miss one site ' +
  'and nothing throws: auto-patch overlaps two fixtures, or the collision detector promises a clean ' +
  'patch while the packer writes over its neighbour, and the symptom is "half my rig is dead" at a ' +
  'load-in. addressing.ts already owns destination resolution for the same reason — one formula, one ' +
  'owner, so the patch, the collision detector, the monitor and the packer cannot drift.',
  () => {
    const OWNER = 'src/renderer/services/addressing.ts';
    if (!exists(OWNER) || !/export function fixtureFootprint/.test(read(OWNER)))
      return `${OWNER} no longer exports fixtureFootprint (the single owner of the footprint formula)`;
    // Only the PRODUCT is banned, and only when the multiplier is the channels-per-pixel value.
    // `ledCount * 4` is deliberately left alone: DMXMonitor's live pixel canvas indexes the
    // canonical RGBW buffer, which really is 4 bytes per pixel regardless of the wire format, and
    // conflating that index with a DMX span is its own bug.
    const PRODUCT = /ledCount[^\n]{0,20}\*[^\n]{0,30}(channelsPerPixel|\bcpp\b)|(channelsPerPixel|\bcpp\b)[^\n]{0,30}\*[^\n]{0,20}ledCount/;
    const problems = [];
    for (const f of [...walk('src/renderer'), ...walk('src/main'), ...walk('plugins'), ...walk('shared')]) {
      if (f === OWNER) continue;
      const m = read(f).match(PRODUCT);
      if (m) problems.push(`${f} computes a DMX footprint itself (${m[0].trim()}) — call fixtureFootprint()`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Fixtures: one definition of "every parameter this fixture has" ───────────────────────────
check(
  '"all the parameters" has one definition',
  'The channel strip and the timeline\'s fixture super track both answer "what parameters does this ' +
  'fixture have?", and both must answer it identically: the ACTIVE MODE\'s slots, in DMX order, ' +
  'de-duplicated across a 16-bit pair (an operator adjusts "Pan", not "Pan" and "Pan fine"). It was ' +
  'a five-line inline filter in FixtureChannelsPanel; copied into a second surface it would diverge ' +
  'on the first null slot or repeated channel key, and the symptom — a parameter you can set in one ' +
  'place and not the other, or a DMX address that disagrees between two panels — looks like ' +
  'anything except a duplicated filter. Proved equal to the old inline derivation across all 1659 ' +
  'library modes / 11561 channel rows before extraction, so any drift from here is new.',
  () => {
    const OWNER = 'src/renderer/services/profilePack.ts';
    if (!exists(OWNER) || !/export function modeChannels/.test(read(OWNER)))
      return `${OWNER} no longer exports modeChannels (the single owner of the mode's channel list)`;

    // BOTH consumers, by name: the inspector's channel strip and the timeline's fixture track. They
    // are the two surfaces that claim to list a fixture's parameters, and a runtime test asserts they
    // show the same COUNT (scripts/test-fixture-track.cjs); this asserts they read the same function,
    // which is what makes that count agree by construction rather than by luck.
    for (const consumer of ['src/renderer/contexts/panels/inspector.tsx',
                            'src/renderer/components/timeline/FixtureTrack.tsx']) {
      if (!exists(consumer) || !/\bmodeChannels\b/.test(read(consumer)))
        return `${consumer} no longer calls modeChannels() — it would be re-deriving the parameter list`;
    }

    // The MEMBERSHIP TEST is the ban, because any de-duplication has to contain one. A plain
    // `set.add(s.channelKey)` is deliberately NOT banned: fixtureSignal builds an unordered
    // "does this mode emit this channel" set for the colour model, which is a different question
    // and not a row list. Testing `.has(...channelKey)` outside the owner means someone is
    // rebuilding the deduped list.
    const DEDUPE = /\.has\([^)\n]*channelKey/;
    const problems = [];
    for (const f of [...walk('src/renderer'), ...walk('src/main'), ...walk('plugins'), ...walk('shared')]) {
      if (f === OWNER) continue;
      const m = read(f).match(DEDUPE);
      if (m) problems.push(`${f} de-duplicates channel keys itself (${m[0].trim()}) — call modeChannels()`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Fixtures: one owner for "the same parameter, on that other head" ─────────────────────────
check(
  'cross-fixture channel matching has one owner',
  'Two surfaces ask "which channel on THAT fixture means what this one means": the inspector\'s ' +
  'channel strip, fanning one fader across a multi-fixture selection, and the timeline\'s fixture ' +
  'track, duplicating a whole set of curves onto another head. The rule is subtle in three places ' +
  'at once - match on ROLE (two makes of head never name the channel the same), restrict to what ' +
  'the destination MODE actually emits (a profile can describe a Zoom the patched mode does not ' +
  'address), and treat AMBIGUOUS as ABSENT (two gobo wheels are both role goboWheel, and writing ' +
  'to an arbitrary one is worse than writing to none) - and then carry the value in DEGREES so 270 ' +
  'on a 540 head and a 630 head are the same aim. A second copy that got any one of those wrong ' +
  'would aim a head somewhere nobody asked, and only on the second fixture. Proved equal to the ' +
  'strip\'s old inline logic over 2,992,585 comparisons across the shipped library before extraction.',
  () => {
    const OWNER = 'src/renderer/services/profilePack.ts';
    if (!exists(OWNER) || !/export function matchChannel/.test(read(OWNER)))
      return `${OWNER} no longer exports matchChannel (the single owner of the cross-fixture match)`;

    const STRIP = 'src/renderer/contexts/panels/inspector.tsx';
    if (!exists(STRIP) || !/\bmatchChannel\(/.test(read(STRIP)))
      return `${STRIP} no longer calls matchChannel() — the channel strip must not re-derive the match`;

    // Comparing one channel's role to ANOTHER channel's role is the match itself; nothing else in
    // the tree has a reason to do it. (A role compared to a literal — c.role === 'pan' — is a
    // different question and deliberately untouched.)
    const MATCH = /\.role\s*===\s*\w+\.role/;
    const problems = [];
    for (const f of [...walk('src/renderer'), ...walk('src/main'), ...walk('plugins'), ...walk('shared')]) {
      if (f === OWNER) continue;
      const m = read(f).match(MATCH);
      if (m) problems.push(`${f} matches channels across fixtures itself (${m[0].trim()}) — call matchChannel()`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Timeline: one curve editor, shared by every surface that draws a curve ───────────────────
check(
  'a keyframe curve is drawn by exactly one component',
  'The polyline, the diamond drag and the per-key editor were part of AutomationLane, and the ' +
  'fixture super track draws the same curve for a DMX channel. A forked copy would disagree about ' +
  'bezier handles, about which neighbour a drag clamps against, or about which unit the typed field ' +
  'speaks - and it would do it invisibly, because both copies would still look like a curve. The ' +
  'lane keeps what is genuinely a LANE (gutter, live readout, target-missing policy) and nothing ' +
  'else may re-implement the body. Proved byte-identical across the extraction: same 15,885-char ' +
  'path, same diamonds, same titles.',
  () => {
    const OWNER = 'src/renderer/components/timeline/CurveEditor.tsx';
    if (!exists(OWNER) || !/export const CurveEditor/.test(read(OWNER)))
      return `${OWNER} no longer exports CurveEditor (the single owner of curve drawing and editing)`;

    const LANE = 'src/renderer/components/timeline/AutomationLane.tsx';
    if (!/<CurveEditor\b/.test(read(LANE)))
      return `${LANE} no longer renders <CurveEditor> — the lane would be drawing its own curve again`;

    // The signature is SAMPLING THE CURVE ACROSS THE ROW — walking x from 0 to the width and asking
    // the engine's sampler for a value at each step. Not merely "builds a path": AudioLane draws a
    // waveform from peak BUCKETS and is a different thing entirely. Not merely "calls sampleLane"
    // either: the lane still samples it for the single live value in its gutter.
    const POLYLINE = /for \(let x = 0; x <= width/;

    // ⚠ ONE EXEMPTION, AND IT IS NARROW. The colour row sweeps the width too, but what it draws is a
    // GRADIENT, not a curve: a colour has no value axis to plot against, so there is no polyline, no
    // Y mapping, and no numeric field to disagree about a unit. Forcing it through CurveEditor would
    // mean giving CurveEditor a second rendering mode for a thing that is not a curve — which is how
    // a shared component becomes two components in a trench coat.
    //
    // The exemption is CONDITIONAL, so it cannot become a hiding place: if the colour row ever grows
    // a polyline or a value-to-Y mapping, it has stopped being a gradient and this fires again.
    const COLOR_ROW = 'src/renderer/components/timeline/ColorRow.tsx';
    const problems = [];
    for (const f of walk('src/renderer/components')) {
      if (f === OWNER) continue;
      if (!POLYLINE.test(read(f))) continue;
      if (f === COLOR_ROW) {
        const src = read(f);
        const forked = /<polyline|valueToY|points=\{/.test(src);
        if (forked) problems.push(`${COLOR_ROW} now draws a value curve, not just a gradient — render <CurveEditor>`);
        continue;
      }
      problems.push(`${f} builds a keyframe polyline itself — render <CurveEditor>`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Shell: a column of panels has to be reachable ────────────────────────────────────────────
check(
  'a stack of panels scrolls, in BOTH shell paths',
  'The dockable workspace is ON BY DEFAULT, so the dock tree is what actually renders - and its ' +
  'panel stack was overflow-hidden. A parameter column taller than its pane was CLIPPED with no way ' +
  'to reach the rest: not a scrollbar you could not see, but no scrolling at all. Measured on a ' +
  'moving head at 1489px of content in a 302px pane, so 1187px was simply unreachable. The ' +
  'hand-built column in WorkspaceShell had overflow-y-auto the whole time, which is exactly why it ' +
  'went unnoticed - a shell change made in one path only is half true, and this half was the ' +
  'default. A stack holding a VIEWPORT still clips on purpose: a viewport fills its pane, and the ' +
  'persistent layer positions the real canvas over that slot by direct style writes.',
  () => {
    const problems = [];
    const DOCK = 'src/renderer/components/shell/DockRenderer.tsx';
    const src = read(DOCK);
    const stack = /if \(node\.render === 'stack'\)[\s\S]*?\n  }/.exec(src);
    if (!stack) problems.push(`${DOCK} no longer renders a 'stack' node`);
    else if (!/overflow-y-auto/.test(stack[0]))
      problems.push(`${DOCK} the panel stack does not scroll — a column taller than its pane is unreachable`);

    const SHELL = 'src/renderer/components/shell/WorkspaceShell.tsx';
    if (!/overflow-y-auto/.test(read(SHELL)))
      problems.push(`${SHELL} the hand-built parameter column does not scroll — the fallback path has the same bug`);
    return problems.length ? problems.join('; ') : null;
  },
);

// ── UI kit: one numeric input, one vector row ────────────────────────────────────────────────
check(
  'a number is typed into exactly one control',
  'There were THREE numeric inputs and TWO vector rows across the inspector, and they did not agree. ' +
  'The inspector\'s own copy committed parseFloat() with no finite check at 33 sites, so clearing a ' +
  'Position field to retype wrote NaN into project state. The 3D panel\'s copy guarded with ' +
  '!Number.isNaN, which is TRUE of Infinity - so `1e400` typed into a screen position committed ' +
  'Infinity, and this repo has already been bitten by that exact shape once (types.ts, a hand-edited ' +
  'outPoint). And ModelTransformPanel mounts in the SAME inspector column as the fixture panels, so ' +
  'selecting a fixture and selecting a screen gave two different vector-row styles in one column. ' +
  'ui/NumberField.NumInput and ui/VectorField are the owners; the commit mode (live vs blur) is a ' +
  'named prop, because that difference in feel was real and must not be flattened by accident.',
  () => {
    const problems = [];
    const IN = 'src/renderer/components/ui/NumberField.tsx';
    const VF = 'src/renderer/components/ui/VectorField.tsx';
    if (!exists(IN) || !/export const NumInput/.test(read(IN))) return `${IN} no longer exports NumInput`;
    if (!exists(VF) || !/export const VectorField/.test(read(VF))) return `${VF} no longer exports VectorField`;
    if (!/Number\.isFinite/.test(read(IN)))
      problems.push(`${IN} no longer tests Number.isFinite — !Number.isNaN admits Infinity, which 1e400 parses to`);

    // Nothing else may build a raw numeric <input> or its own axis row. The kit's own files and the
    // Preferences tiles are exempt: Preferences hosts a few one-off numeric controls that are not
    // inspector fields, and rewriting them is not what this guard is for.
    const OWN = new Set([IN, VF]);
    for (const f of walk('src/renderer/contexts/panels')) {
      const src = read(f);
      if (OWN.has(f)) continue;
      const m = /const \w*(NumInput|Vec3Row|NumberInput)\s*:\s*React\.FC/.exec(src);
      if (m) problems.push(`${f} declares its own ${m[1]} — use ui/NumberField's NumInput or ui/VectorField`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Editing: copy/paste must not steal a text field's clipboard, or the source's DMX ─────────
check(
  'copy / paste / delete yield to a text field, and to whoever owns the key',
  'Two ways this feature can do real damage quietly. (1) Ctrl+C is a TEXT FIELD\'s key first: an ' +
  'operator copying an IP address out of Routing, or a cue name, must not silently get a fixture ' +
  'instead - there is no error to see, and they find out at the paste. Every one of the three ' +
  'bindings is therefore gated on the same `typing` predicate undo/redo uses. (2) A pasted fixture ' +
  'must NOT carry the source\'s startAddress: that is two fixtures answering the same DMX channels, ' +
  'a patch that reads correctly in the list and is wrong on the wire, and on a real rig two heads ' +
  'doing the same thing. autoPatch already owns "where does this fit"; paste hands it the grown rig. ' +
  'Proved on the running app: a MAC 250 at address 1 pastes to 14, its own footprint later.',
  () => {
    const APP = 'src/renderer/App.tsx';
    const src = read(APP);
    const problems = [];

    // Every binding gated on `typing` — the same predicate the undo branch uses.
    for (const id of ['global.copy', 'global.paste', 'global.duplicate', 'global.deleteSelected']) {
      const re = new RegExp(`!typing && keymap\\.matches\\(e, '${id}'\\)`);
      if (!re.test(src)) problems.push(`${APP} '${id}' is not gated on \`typing\` — it would hijack a text field's own clipboard`);
    }

    const paste = /const handlePasteClipboard[\s\S]*?\n  };/.exec(src);
    if (!paste) problems.push(`${APP} no longer defines handlePasteClipboard`);
    else {
      if (!/autoPatch\(/.test(paste[0]))
        problems.push(`${APP} paste does not repatch through autoPatch — a copy would overlap the fixture it came from`);
      if (/startAddress:/.test(paste[0]))
        problems.push(`${APP} paste sets a startAddress itself — that is autoPatch's answer to give`);
      if (!/recordHistory\(\)/.test(paste[0]))
        problems.push(`${APP} paste does not record history — it would not be undoable`);
    }

    // DELETE YIELDS TO WHOEVER ELSE OWNS THE KEY. The timeline drawer and the show-machine graph
    // bind Del/Backspace to their own selection and both listen on `window`, so one press would
    // otherwise delete a clip AND a fixture — with only one of them on screen to notice.
    if (!/\[data-owns-delete\]:hover/.test(src))
      problems.push(`${APP} the global delete does not check who owns the key — one press would delete a clip and a fixture`);
    for (const owner of ['src/renderer/components/timeline/Timeline.tsx',
                         'src/renderer/components/timeline/StateGraphEditor.tsx']) {
      if (!/data-owns-delete/.test(read(owner)))
        problems.push(`${owner} binds Del to its own selection but no longer claims it — the global delete would fire over it too`);
    }
    const del = /const handleDeleteSelection[\s\S]*?\n  };/.exec(src);
    if (!del) problems.push(`${APP} no longer defines handleDeleteSelection`);
    else if (!/handleRemoveSurface\(/.test(del[0]))
      // Deleting a surface removes its projector output — that display goes dark, and the binding is
      // not undoable. The key must not become a back door around the question the button asks.
      problems.push(`${APP} the delete key removes a surface without going through handleRemoveSurface — it would skip the projector-output confirm`);
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Auto-key: an armed fader move is ONE gesture ─────────────────────────────────────────────
check(
  'an armed fader move is one undo entry, and cannot arm itself',
  'Arming the channel strip makes a fader release write BOTH the fixture value and a keyframe. Those ' +
  'are one gesture and must be one undo entry: recordHistory() once, before both. writeAutomationKeys ' +
  'must therefore NOT record for itself - if it did, every armed fader move would cost two presses of ' +
  'undo, the second of which appears to do nothing, and the first of which leaves the rig holding a ' +
  'value with no key. It also writes setScenes/setTimeline directly rather than through ' +
  'handleTimelineChange, which records for itself and exists for gestures that touch nothing else. ' +
  'And the arm is TRANSIENT with ONE owner: a persisted or duplicated arm is how an install comes up ' +
  'recording and quietly rewrites a show nobody opened to edit.',
  () => {
    const problems = [];
    const OWNER = 'src/renderer/services/autoKey.ts';
    if (!exists(OWNER) || !/export function setArmed/.test(read(OWNER)))
      return `${OWNER} no longer owns the auto-key arm`;
    // The arm must not be persisted: a project or a pref that can carry it would let an install boot
    // armed. The service holds a plain module-level boolean and nothing else may declare one.
    if (/appSettings|prefs|localStorage/.test(read(OWNER)))
      problems.push(`${OWNER} persists the arm — it must not survive a restart or a project load`);

    const APP = 'src/renderer/App.tsx';
    const app = read(APP);
    const fn = /const writeAutomationKeys[\s\S]*?\n  };/.exec(app);
    if (!fn) problems.push(`${APP} no longer defines writeAutomationKeys`);
    else {
      if (/recordHistory\(\)/.test(fn[0])) problems.push(`${APP} writeAutomationKeys records history itself — an armed fader move would cost two undos`);
      if (/handleTimelineChange/.test(fn[0])) problems.push(`${APP} writeAutomationKeys routes through handleTimelineChange, which records for itself — same two-undo bug`);
    }
    if (!/autoKey\.disarm\(\)/.test(app)) problems.push(`${APP} no longer disarms auto-key on project load — an install could come up recording`);

    const STRIP = 'src/renderer/contexts/panels/inspector.tsx';
    const m = /export const FixtureChannelsPanel[\s\S]*?\n};/.exec(read(STRIP));
    if (!m) problems.push(`${STRIP} no longer defines FixtureChannelsPanel`);
    else {
      const body = m[0];
      if (!/writeAutomationKeys\(/.test(body)) problems.push(`${STRIP} the armed fader no longer writes keyframes — arming would do nothing`);
      if (!/if \(armed\)/.test(body)) problems.push(`${STRIP} the strip writes keyframes without checking the arm — looking at a rig would author it`);
      // The one recordHistory must come BEFORE both writes, or the snapshot misses them.
      const i = body.indexOf('a.recordHistory()');
      const j = body.indexOf('writeAutomationKeys(');
      if (i < 0 || j < 0 || i > j) problems.push(`${STRIP} recordHistory() no longer precedes the keyframe write — the undo snapshot would miss it`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Takes: ONE owner of the take commit ───────────────────────────────────────────────────────
check(
  'a recorded take is committed only by takeRecorder.ts',
  'Committing a take is not one write. It is: name it off the PROJECT library with nextNumberedName, ' +
  '(for tracking) write a .lblob, copy it into the project, seed the replay cache, append the ref to ' +
  'the GLOBAL document, and — only if the bound document has not moved across those two awaits — ' +
  'synthesize a lane in the document you recorded from. That whole sequence ' +
  'was duplicated the moment a second door appeared: the timeline\'s Takes bin and the Venue & Rig ' +
  'action bar each had their own copy, and only one of them carried the doc-key guard. Nothing throws ' +
  'when they drift — a take recorded against scene A simply lands in scene B because an FSM recall ' +
  'fired while the file was being written, and the operator finds out at the next load-in. Now that ' +
  'recording is reachable from a dock panel, the action bar, the status chip and a keyboard shortcut, ' +
  'the sequence has exactly one owner and every door calls it. Guards the APPEND specifically — a ' +
  'library delete or an asset relink rewrites an existing list and must keep calling setTimeline.',
  () => {
    const OWNER = 'src/renderer/services/takeRecorder.ts';
    if (!exists(OWNER)) return `${OWNER} is missing (the single owner of the take commit)`;
    const owner = read(OWNER);
    for (const sym of ['stopLighting', 'stopTracking', 'setHost']) {
      if (!new RegExp(`export (async )?function ${sym}\\b`).test(owner))
        return `${OWNER} no longer exports ${sym}() — the take commit has lost its owner`;
    }
    // THE LIBRARY IS THE GLOBAL DOC. A tracking take is captured reality — every scene may replay it —
    // so its ref must be appended through commitGlobal, never through the bound-document `commit`.
    // Routing it through the bound doc is what made a take recorded during a scene invisible to the
    // media library and unplaceable on any other timeline, for as long as the feature existed.
    const cg = owner.indexOf('commitGlobal({');
    if (cg < 0 || !/trackingTakes: *\[\.\.\./.test(owner.slice(cg, cg + 400)))
      return `${OWNER}.stopTracking() no longer appends the take ref through commitGlobal() — a recorded take must land in the PROJECT library, not in whichever scene was on air`;
    // …and a doc-key guard still spans the two awaits. Its job SHRANK rather than vanished: the ref now
    // has one fixed address, so a recall can no longer misplace the recording — only the convenience
    // lane that gets created in the document you recorded from. That is the whole point of the split,
    // and losing the guard would put an empty tracking lane in a scene the operator never touched.
    if (!/docKey\(\) *!== *\w+/.test(owner))
      return `${OWNER}.stopTracking() lost the doc-key guard across its two awaits — the auto-created lane can land in a document nobody recorded from`;
    // THE APPEND, and only the append — `xTakes: [...prev, take]`. That is the commit, and the thing
    // that was duplicated. Deliberately NOT every write: removing a take from the Media library and
    // rewriting its path on a relink are `filter`/`map` over an existing list, they are not gestures,
    // and handleTimelineChange's own header requires them to keep calling setTimeline directly. Reads
    // (`timeline.lightingTakes ?? []` in a panel) are of course fine and common.
    const APPEND = /(?:lightingTakes|trackingTakes) *: *\[ *\.\.\./;
    const problems = [];
    for (const f of [...walk('src/renderer'), ...walk('src/main'), ...walk('plugins')]) {
      if (f === OWNER) continue;
      const m = read(f).match(APPEND);
      if (m) problems.push(`${f} appends to a take list itself (${m[0].trim()}) — commit through services/takeRecorder`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Assets: a library-wide operation reaches every timeline ───────────────────────────────────
check(
  'removing and relinking a library asset reach the scenes, not just the global timeline',
  'A project holds MANY timelines: the global document plus one per scene. Both of these functions ' +
  'rewrite references across the project, and both have already shipped a version that touched only ' +
  'the global one. Relink was first — scene timelines, scene look snapshots and scene 3D kept ' +
  'pointing at the old path, so the file was "relinked" and the show still went black on the scenes ' +
  'that used it. Remove was second, and worse: a recorded take can be dropped on ANY scene\'s ' +
  'tracking lane, so deleting it globally left scene clips pointing at a recording that no longer ' +
  'exists — a clip that cannot play AND cannot be relinked, because there is nothing left to relink ' +
  'to. Neither failure throws, neither shows up in the editor you are looking at, and both are found ' +
  'at a load-in. If a function in this family does not mention setScenes, it is not finished.',
  () => {
    const src = read('src/renderer/App.tsx');
    const problems = [];
    for (const fn of ['handleRemoveAsset', 'handleRelinkAsset']) {
      const body = fnBody(src, fn);
      if (!body) { problems.push(`App.tsx no longer defines ${fn}() (the asset-wide rewrite paths)`); continue; }
      if (!/setScenes\(/.test(body)) problems.push(`${fn}() never calls setScenes — it rewrites only the global timeline, leaving every scene stale`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Plugins: the lidar barrel is the ONLY door ────────────────────────────────────────────────
check(
  'host code imports @artlux/plugin-lidar-tracking through its barrel only',
  'tsconfig.json AND electron.vite.config.ts both alias the `/*` SUBPATH as well as the bare ' +
  'specifier, so `@artlux/plugin-lidar-tracking/trackingStore` typechecks, builds and runs — and ' +
  'gives you a SECOND MODULE IDENTITY. Every singleton in that plugin then exists twice: the OSC tap ' +
  'writes one trackingStore while the recorder, the 3D viz and the projector bridge read an empty ' +
  'other. Nothing throws; the tracker is simply "not working". The barrel\'s own header has warned ' +
  'about this since it was written, and nothing enforced it — which mattered more the moment ' +
  'services/takeRecorder became a fourth host consumer.',
  () => {
    // Except `/ui` — the plugin's declared UI HALF (package.json "exports", E5/W5), a second ENTRY and
    // not a way into the barrel's modules: it imports none of the plugin's singletons (the panel-window
    // graph check bans every store, receiver and host seam behind it), so there is nothing to duplicate.
    const DEEP = /from ['"]@artlux\/plugin-lidar-tracking\/(?!ui['"])[^'"]+['"]/;
    const problems = [];
    for (const f of [...walk('src'), ...walk('shared')]) {
      const m = read(f).match(DEEP);
      if (m) problems.push(`${f} deep-imports the lidar plugin (${m[0].trim()}) — import from '@artlux/plugin-lidar-tracking'`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Fixtures: ONE owner of "what KIND of fixture is this?" ────────────────────────────────────
check(
  'fixture kind is decided only by fixtureKind.ts',
  'An LED fixture (pixel tape, sampled off a surface, ledCount x channelsPerPixel) and a LIGHT ' +
  'fixture (a moving head, driven by authored role values, occupying its MODE\'s footprint) are two ' +
  'different devices on two different wires. The test was open-coded in ten files, in TWO forms that ' +
  'quietly disagree: `f.profileId` in the packer and the footprint owner, `f.profileId && ' +
  'profiles.has(...)` in the 3D scene. A fixture whose profile does not RESOLVE fell between them — ' +
  'a light to the packer (which writes nothing for it) and a pixel to the 3D scene (which drew it as ' +
  'a stray LED sphere), with nothing naming the state so nothing could report it. fixtureKind.ts owns ' +
  'the question the way addressing.ts owns the footprint, and for the same reason: one definition, so ' +
  'the packer, the patch, the inspector and the 3D scene cannot drift.',
  () => {
    const OWNER = 'src/renderer/services/fixtureKind.ts';
    if (!exists(OWNER)) return `${OWNER} is missing (the single owner of the fixture-kind predicate)`;
    const owner = read(OWNER);
    for (const sym of ['fixtureKind', 'isLight', 'isPixel', 'lightState']) {
      if (!new RegExp(`export (const|function|type) ${sym}\\b`).test(owner))
        return `${OWNER} no longer exports ${sym}`;
    }
    // Only the KIND TEST is banned, never profile RESOLUTION. Reading `f.profileId` to look a profile
    // up, to pass it as an argument, or to destructure it away is fine and unavoidable — the field is
    // the storage. What must not be re-derived is the BRANCH: profileId used as a boolean.
    // `.get(...)`/`.has(...)` arguments never match (the capture needs a boolean operator after it).
    const KIND_TEST = /[!(]\s*\w+\.profileId\s*(\?|&&|\|\||\))|\w+\.profileId\s*(\?[^.]|&&)/;
    const ALLOW = new Set([
      OWNER,
      // Resolves ids to profiles for the whole app; reads the raw field by definition.
      'src/renderer/services/fixtureProfiles.ts',
    ]);
    const problems = [];
    for (const f of [...walk('src/renderer'), ...walk('src/main'), ...walk('plugins'), ...walk('shared')]) {
      if (ALLOW.has(f)) continue;
      const m = read(f).match(KIND_TEST);
      if (m) problems.push(`${f} decides a fixture's KIND itself (${m[0].trim()}) — call isLight()/isPixel()/lightState()`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Shell: BOTH render paths honour appliesTo ─────────────────────────────────────────────────
check(
  'appliesTo is applied by the dock renderer as well as the hand-built column',
  'The shell has TWO paths that draw parameter sections: the hand-built inspector column and ' +
  'DockRenderer, which draws from the dock tree. Only the first filtered on `appliesTo` — and the ' +
  'dockable workspace is ON BY DEFAULT, so the filter was effectively dead. It stayed invisible ' +
  'because every fixture section applied to `fixture` and every surface section to `surface`, so the ' +
  'only symptom was an inspector column longer than it should be (a selected fixture also showing ' +
  'the surface\'s Content and Transform). Splitting fixtures into LED and LIGHT kinds turns that ' +
  'into a correctness bug — a moving head would keep offering Serpentine, a ledmap upload and an ' +
  'editable LED Count. One exported rule, asked by both paths.',
  () => {
    const R = 'src/renderer/host/registries.ts';
    const S = 'src/renderer/components/shell/WorkspaceShell.tsx';
    const D = 'src/renderer/components/shell/DockRenderer.tsx';
    if (!/export const appliesToSelection/.test(read(R)))
      return `${R} no longer exports appliesToSelection (the one selection-filter rule)`;
    const problems = [];
    if (!/appliesToSelection\(/.test(read(S))) problems.push(`${S} no longer calls appliesToSelection()`);
    if (!/appliesToSelection\(/.test(read(D)))
      problems.push(`${D} no longer calls appliesToSelection() — docked parameter sections would ignore the selection again`);
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Shell: a fallback-only control never renders under docking ────────────────────────────────
check(
  'the status bar\'s column toggles are fallback-shell only',
  'showLeft/showRight are read by the hand-built branch of WorkspaceShell and by NOTHING else — ' +
  'under docking a browser or inspector column exists because the dock tree has one, and each dock ' +
  'group carries its own collapse chevron. The two StatusBar buttons kept flipping those flags, ' +
  'persisting them, banking them per context and recolouring themselves to match, while the screen ' +
  'did not move. Docking is ON BY DEFAULT, so that was every operator: a control that answers but ' +
  'does nothing is read as the app being broken, not as the button being obsolete. App must gate ' +
  'them on isDockingOn(), and StatusBar must render each one only when it has a handler.',
  () => {
    const A = 'src/renderer/App.tsx';
    const B = 'src/renderer/components/StatusBar.tsx';
    const S = 'src/renderer/components/shell/WorkspaceShell.tsx';
    const problems = [];
    if (!/export const isDockingOn/.test(read(S)))
      problems.push(`${S} no longer exports isDockingOn() — the one place that decides which shell renders`);
    const app = read(A);
    for (const side of ['Left', 'Right']) {
      if (!new RegExp(`onToggle${side}=\\{isDockingOn\\(`).test(app))
        problems.push(`${A} passes onToggle${side} unconditionally — the button is dead under docking`);
    }
    const bar = read(B);
    for (const side of ['Left', 'Right']) {
      if (!new RegExp(`\\{onToggle${side} &&`).test(bar))
        problems.push(`${B} renders the ${side.toLowerCase()} column toggle unconditionally`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Fixtures: a LIGHT is one emitter — ledCount stays pinned to 1 ─────────────────────────────
check(
  'a light fixture\'s ledCount is pinned on the update funnel',
  'types.ts has said "ledCount is pinned to 1 for a profiled fixture" since profiles landed, and ' +
  'NOTHING enforced it — while both the Mapping inspector and the Routing grid exposed an editable ' +
  '"LED Count" for every fixture, moving heads included. Raising it was silent corruption of an ' +
  'evil shape: the head\'s own DMX is unaffected (its footprint comes from its MODE), so nothing ' +
  'looks wrong at the fixture — but frameEngine walks the canonical pixel buffer with ' +
  '`offset += f.ledCount`, so EVERY fixture patched after it shifts in that buffer. The DMX monitor ' +
  'and the 3D LED colours misalign for the whole rest of the rig while correct Art-Net keeps ' +
  'flowing. Hiding the controls is ergonomics; the clamp on the one funnel every fixture mutation ' +
  'passes through is the cure, and it is what stops a future panel, plugin, OSC path or paste from ' +
  'reopening it.',
  () => {
    const APP = 'src/renderer/App.tsx';
    const src = read(APP);
    if (!/const pinLedCount\s*=/.test(src)) return `${APP} no longer defines pinLedCount`;
    if (!/isLight\(f\)\s*&&\s*f\.ledCount\s*!==\s*1/.test(src))
      return 'pinLedCount no longer clamps a light fixture\'s ledCount to 1';
    if (!/handleUpdateFixture[\s\S]{0,400}?pinLedCount\(/.test(src))
      return 'handleUpdateFixture no longer routes its result through pinLedCount()';
    return null;
  },
);

// ── Shell: every fixture inspector section says which KIND it is for ──────────────────────────
check(
  'every fixture inspector section declares a kind',
  'An LED strip and a moving head are two different devices. Of the eight fixture sections, exactly ' +
  'ONE used to gate on kind — so selecting a moving head offered Serpentine, colour order, a ledmap ' +
  'upload, LED spacing, and an editable LED Count that shifted the whole rig in the pixel buffer. ' +
  'Gating belongs in the REGISTRATION (`appliesTo`), not in each panel body, because the shell ' +
  'already filters on it and a body guard is invisible from the context manifest. Only THREE sections ' +
  'legitimately apply to both kinds: `patch` and `routing` (every fixture is on a wire) and `arrange` ' +
  '(rig-building is kind-agnostic). Anything else must name fixture.pixel or fixture.light — this ' +
  'check is what stops the next panel silently reintroducing the LED Count hole. `profile` was the ' +
  'fourth until it was narrowed to fixture.light: it applied to both because it was the door that ' +
  'CHANGED the kind, which meant an LED fixture opened its column with "Choose a DMX profile…" — a ' +
  'button that reads like an explanation and in fact pins ledCount to 1, drops the surface link and ' +
  'repatches the rig. Do not widen it back; the kind is chosen where the fixture is created.',
  () => {
    // The sections are registered from two files since E5/W5: the ones that can open in a panel window
    // are DECLARED in contexts/detachable.tsx (index.tsx registers them by id), the rest in index.tsx.
    const F = 'src/renderer/contexts/index.tsx + contexts/detachable.tsx';
    const src = read('src/renderer/contexts/index.tsx') + '\n' + read('src/renderer/contexts/detachable.tsx');
    const BOTH = new Set(['patch', 'routing', 'arrange']);
    const problems = [];
    const re = /id:\s*'core\.inspector\.fixture\.(\w+)'[^\n]*?appliesTo:\s*\[([^\]]*)\]/g;
    const seen = new Set();
    let m;
    while ((m = re.exec(src))) {
      const [, name, kinds] = m;
      seen.add(name);
      const narrow = /'fixture\.(pixel|light)'/.test(kinds);
      if (!narrow && !BOTH.has(name))
        problems.push(`core.inspector.fixture.${name} applies to any fixture — name fixture.pixel or fixture.light`);
    }
    if (!seen.size) return `${F} registers no fixture inspector sections (the appliesTo shape changed?)`;
    for (const need of ['mapping', 'channels', 'patch', 'profile'])
      if (!seen.has(need)) return `${F} no longer registers core.inspector.fixture.${need}`;
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Stage: the 2D canvas draws LED fixtures only ──────────────────────────────────────────────
check(
  'the 2D stage renders no light fixture',
  'A moving head is a point in a room, not a rectangle on a stage — but the 2D canvas drew, ' +
  'hit-tested and let you DRAG one. That is not merely useless: led3dDefaults.effectivePosObj ' +
  'derives a fixture\'s 3D position FROM its 2D rect whenever it has no explicit position3D, which ' +
  'is every fixture in every project authored before lights left the canvas. So dropping this ' +
  'filter puts phantom rects back, and dragging one silently teleports a head that is nowhere near ' +
  'where you dropped it — a 3D rig quietly rearranged by a gesture in a different view. Lights are ' +
  'placed and positioned in the 3D scene; they stay in the fixture LIST (the patch is a Mapping ' +
  'job) and have no geometry here.',
  () => {
    const F = 'src/renderer/components/Stage.tsx';
    const src = read(F);
    if (!/renderFixturesList\s*=/.test(src)) return `${F} no longer builds renderFixturesList`;
    if (!/renderFixturesList\s*=[^\n]*\.filter\(isPixel\)/.test(src))
      return `${F} renders fixtures without .filter(isPixel) — light fixtures would be draggable on the 2D canvas again`;
    return null;
  },
);

// ── Calibration: an absolutely-positioned CameraViewport needs a POSITIONED parent ────────────
check(
  'the calibration camera pane is positioned, so it cannot cover the wizard rail',
  'CameraViewport\'s root is `absolute inset-0`, so it resolves against the nearest POSITIONED ' +
  'ancestor. Both wizards lay it out as `flex-1` beside a 340px rail — and that flex pane was ' +
  '`position: static`, so the camera\'s layers escaped it and resolved against the workbench slot ' +
  'instead, painting solid black across the full width. The rail was still laid out at the right ' +
  'coordinates, still visible, still clickable, and reported its text in innerText — it was simply ' +
  'UNDERNEATH. So the wizard looked absent while every DOM assertion about it passed, which is why ' +
  'this survived: only a screenshot or an elementFromPoint hit-test shows it. It reproduced solely ' +
  'in the docked shell, whose slot container is the positioned ancestor that caught the escape.',
  () => {
    const problems = [];
    for (const F of ['plugins/calibration/src/CalibWizard.tsx', 'plugins/calibration/src/AutoAlignWizard.tsx']) {
      const src = read(F);
      if (!/<CameraViewport/.test(src)) { problems.push(`${F} no longer mounts CameraViewport`); continue; }
      // The wrapper is the element immediately preceding the <CameraViewport mount — since the suite's
      // Phase 3 the wizards' <WizardView>, whose box must then be the positioned one (wizardLayout.tsx).
      if (/<WizardView[^>]*>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<CameraViewport/.test(src)) {
        const lay = read('plugins/calibration/src/wizardLayout.tsx');
        const boxes = lay.slice(lay.indexOf('export const WizardView')).match(/className=\{?[`"]([^`"]*bg-black[^`"]*)[`"]/g) || [];
        if (boxes.length < 2 || boxes.some((b) => !/\brelative\b/.test(b)))
          problems.push('wizardLayout.tsx WizardView no longer gives the camera a positioned box in BOTH arrangements');
        continue;
      }
      const m = src.match(/<div className="([^"]*)"[^>]*>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<CameraViewport/);
      if (!m) { problems.push(`${F} CameraViewport is not wrapped in a <div className="…"> — cannot verify it is positioned`); continue; }
      if (!/\brelative\b/.test(m[1]))
        problems.push(`${F} mounts CameraViewport in a static pane ("${m[1]}") — its absolute layers will cover the wizard rail`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Calibration: the camera preview's rAF refs are RE-ARMED on mount, not only disarmed ───────
check(
  'CameraViewport re-arms its rAF guards on mount',
  'Two refs gate the preview\'s redraw: `alive` (set false by the unmount cleanup) and `rafPending` ' +
  '(set true before requestAnimationFrame, cleared only by the frame callback). Both were written ' +
  'ONLY in the disarming direction, so React StrictMode\'s mount → unmount → remount left `alive` ' +
  'false and — because the cleanup cancels the frame without clearing the latch — `rafPending` true. ' +
  'Every later redraw() then returned at its first line. Nothing threw, no error surfaced, and the ' +
  'wizard looked healthy: paint() still updated the resolution badge and fit() still computed a ' +
  'correct zoom %. Only the preview was dead — a canvas left at its default 300×150 backing store. ' +
  'A ref that a cleanup mutates must be reset by the mount that follows it.',
  () => {
    const F = 'plugins/calibration/src/calib/CameraViewport.tsx';
    const src = read(F);
    // The mount effect is the one whose cleanup cancels the frame.
    const m = src.match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[\]\);/);
    if (!m) return `${F} no longer has a mount effect guarding the rAF`;
    const bodyBeforeReturn = m[1].split('return')[0];
    const problems = [];
    if (!/alive\.current\s*=\s*true/.test(bodyBeforeReturn))
      problems.push('the mount effect never re-arms `alive` — the preview stays dead after a StrictMode/HMR remount');
    if (!/rafPending\.current\s*=\s*false/.test(bodyBeforeReturn))
      problems.push('the mount effect never clears `rafPending` — a cancelled frame latches redraw() off forever');
    return problems.length ? `${F}: ${problems.join('; ')}` : null;
  },
);

// ── Patch: the kind-aware fallback keeps its back-compat rung, and both passes share it ───────
check(
  'autoPatch resolves a fixture\'s bucket in ONE place, ending on the old behaviour',
  'Two things here are load-bearing. FIRST, autoPatch resolves a fixture\'s controller TWICE — once ' +
  'to harvest locked fixtures\' reserved ranges, once to assign — and the two must agree, or the ' +
  'collision detector reserves space in one bucket while the packer writes into another. They were ' +
  'two hand-copied expressions carrying a comment saying they must not drift; they are now one ' +
  '`bucketOf`. SECOND, the fallback chain MUST end on `controllers[0]`: that last rung is what makes ' +
  'a project with no controller declaring `drives` patch byte-identically to before, which is the ' +
  'only reason this could ship without re-addressing every saved rig. Delete it and an unclassified ' +
  'rig silently re-patches on load.',
  () => {
    const F = 'src/renderer/services/addressing.ts';
    const src = read(F);
    if (!/function fallbackFor\(/.test(src)) return `${F} no longer defines fallbackFor`;
    if (!/controllers\[0\]\?\.id/.test(src))
      return 'the fallback chain no longer ends on controllers[0] — an unclassified rig would re-patch on load';
    if (!/const bucketOf\s*=/.test(src)) return `${F} no longer defines the single bucketOf resolver`;
    // Neither pass may re-derive the bucket inline again.
    const inline = src.match(/defaultControllerId && ctrlById\.has\(defaultControllerId\)/g) ?? [];
    if (inline.length > 1)
      return `${F} resolves a fixture's bucket in ${inline.length} places — the reserve and assign passes must share bucketOf()`;
    return null;
  },
);

// ── Lighting: ONE curve format, and the legacy shape stays a read-only door ───────────────────
check(
  'a lighting take stores Keyframe[], and LightingCurve is read-only legacy',
  'The app had TWO curve formats. Automation lanes used `Keyframe` — sparse, with hold/linear/bezier ' +
  'segments, an O(1) cursor sampler and a drawn editor. Lighting takes used `LightingCurve` — dense ' +
  'parallel arrays, linear-only, its own binary search, and NO editor anywhere in the tree, so a ' +
  'recorded show could never be tuned, only re-recorded. The worse format owned the light show. ' +
  'They are now one: a take stores Keyframe[] and is sampled by automation.ts. `LightingCurve` ' +
  'survives ONLY so normalizeLightingTakes can read a project saved before the change — if anything ' +
  'starts writing or sampling it again, the two formats are back.',
  () => {
    const T = 'src/renderer/types.ts';
    const K = 'src/renderer/services/lightingTake.ts';
    const types = read(T);
    if (!/channels:\s*Partial<Record<ChannelRole,\s*Keyframe\[\]>>/.test(types))
      return 'LightingTakePart.channels is no longer Keyframe[] — the two curve formats are back';
    if (!/const normalizeLightingTakes\s*=/.test(types))
      return `${T} no longer normalizes lighting takes — a legacy {t,v} curve would reach the sampler`;
    if (!/lightingTakes:\s*normalizeLightingTakes\(/.test(types))
      return 'normalizeTimeline no longer runs normalizeLightingTakes (it would ride the ...rest spread)';
    if (!/sampleLane\(/.test(read(K)))
      return `${K} no longer samples through automation.ts — the second sampler is back`;
    // The legacy interface may be named only where it is read FROM.
    const problems = [];
    for (const f of [...walk('src/renderer'), ...walk('src/main'), ...walk('plugins'), ...walk('shared')]) {
      if (f === T) continue;
      if (/\bLightingCurve\b/.test(read(f))) problems.push(`${f} still references LightingCurve`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Lighting: a pose sequence is COMPILED, never filtered per frame ───────────────────────────
check(
  'pose sequences are compiled on edit, not resolved in the frame loop',
  'A LightingSequence is stored the way an operator thinks — a list of moments, each holding a POSE ' +
  'per slot. The engine wants the opposite: for one fixture and one role, a curve. The rule that ' +
  'converts between them ("the nearest keys before and after that CARRY this role") is a scan over ' +
  'every key — and evaluated live it would run per fixture, per role, PER FRAME, which is allocation ' +
  'and search on the exact path lightingOverlay is a plain nested map to avoid. So it is applied ' +
  'once, on edit and on load, and the frame loop only ever calls sampleLane on a plain Keyframe[]. ' +
  'The cache is a WeakMap on the sequence OBJECT: state is immutable here, so an edited sequence ' +
  'misses by construction and there is no revision counter to forget to bump.',
  () => {
    const C = 'src/renderer/services/lightingSequence.ts';
    const P = 'src/renderer/services/lightingPlayback.ts';
    if (!exists(C)) return `${C} is missing (the sequence compiler)`;
    const comp = read(C);
    if (!/new WeakMap</.test(comp))
      return `${C} no longer caches compilations in a WeakMap — every frame would recompile`;
    if (!/export function compile\(/.test(comp)) return `${C} no longer exports compile()`;
    const play = read(P);
    if (!/compileSequence\(/.test(play))
      return `${P} no longer compiles the sequence — it would be resolving pose keys in the frame loop`;
    // The frame loop must not walk a sequence's keys itself.
    if (/\.keys\b[^\n]*\b(find|filter|map|forEach|reduce)\b/.test(play))
      return `${P} iterates a sequence's keys in the frame loop — that work belongs in compile()`;
    return null;
  },
);

// ── Lighting: the precedence stack, in the one closure that enforces it ───────────────────────
check(
  'a pose cue sits between the lighting clip and the automation lane',
  'The stack is: profile default < authored dmx < lighting clip < POSE CUE < automation lane < live ' +
  'override, and it is enforced in ONE closure in the packer. Two orderings are load-bearing. The ' +
  'lane must be asked FIRST and win — "a lane always wins" is the single precedence story this app ' +
  'keeps across audio, surfaces and fixtures, and automation has already been folded into the ' +
  'fixture by then, so failing to ask means the clip or the cue overwrites it. And the cue must be ' +
  'asked BEFORE the clip, or firing a look would do nothing while a clip happened to be running. ' +
  'Putting the cue at the TOP instead is the tempting error: that layer is livePreview, a fader drag ' +
  'right now, which a cue fired by the scheduler at 3 a.m. is not. Getting any of it backwards is ' +
  'invisible until a show.',
  () => {
    const F = 'src/renderer/engine/frameEngine.ts';
    const src = read(F);
    const m = /const roleOverride[\s\S]{0,2200}?\n      : undefined;/.exec(src);
    if (!m) return `${F} no longer builds roleOverride in one closure — the precedence stack has moved`;
    const body = m[0];
    const lane = body.indexOf('automationOverlay.owns');
    const cue = body.indexOf('lightingCue.get');
    const clip = body.indexOf('lightingOverlay.get');
    if (lane < 0) return 'the packer no longer asks automationOverlay.owns() — a drawn lane would lose';
    if (cue < 0) return 'the packer no longer consults lightingCue — a fired pose cue would be inert';
    if (clip < 0) return 'the packer no longer consults lightingOverlay — lighting clips would be inert';
    if (!(lane < cue && cue < clip))
      return `precedence is out of order (lane ${lane}, cue ${cue}, clip ${clip}) — must be lane, then cue, then clip`;
    return null;
  },
);

// ── Lighting: a fader drag is LIVE, and reaches the recorder as well as the wire ──────────────
check(
  'aiming a head is live, and the take recorder sees it',
  'The whole authoring loop docs/LIGHTING-SHOW.md is written around — select a light, aim it, Store ' +
  'Key or Record — rests on the rig following your hand. It did not. Slider commits on pointer ' +
  'RELEASE (deliberately: a React write per drag tick re-renders the app and, through ' +
  'handleUpdateFixture, pushes an undo entry per tick), and nothing implemented the "live override" ' +
  'layer the packer has named at the top of its precedence stack since lighting shipped. Measured on ' +
  'the wire: a four-second pan drag produced ONE transition, at the release. The second half is the ' +
  'subtle one — the take recorder samples the RESOLVED fixture signal, so resolveFixture must ' +
  'receive the live layer too, or a busk still records a STEP while the wire looks correct. The take ' +
  'that came back was pan [[0.02,136.4],[5.68,136.4],[5.83,403.6],[10.11,403.6]].',
  () => {
    const P = 'src/renderer/services/profilePack.ts';
    const F = 'src/renderer/engine/frameEngine.ts';
    const I = 'src/renderer/contexts/panels/inspector.tsx';
    const problems = [];
    const pack = read(P);
    if (!/export type ChannelOverride/.test(pack)) problems.push(P + ' no longer declares ChannelOverride — the live layer has no type');
    const live = pack.indexOf('live?.(f, channel)');
    const role = pack.indexOf('override?.(f.id, channel)');
    if (live < 0) problems.push(P + '.channelValue no longer reads the live layer');
    else if (role >= 0 && live > role) problems.push(P + '.channelValue reads the live layer AFTER the clip — a fader drag would lose to a running clip');
    const eng = read(F);
    if (!/livePreview\.readFixtureChannel\(/.test(eng)) problems.push(F + ' never consults livePreview.readFixtureChannel — a drag would not reach the wire');
    if (!/packProfiled\([^)]*liveOverride\)/.test(eng)) problems.push(F + ' does not pass the live layer to packProfiled — the rig would not follow the hand');
    if (!/resolveFixture\([^)]*liveOverride\)/.test(eng)) problems.push(F + ' does not pass the live layer to resolveFixture — the 3D scene and the TAKE RECORDER would see the committed value only');
    const insp = read(I);
    if (!/onInput=\{\(v\) => live\(channel, v\)\}/.test(insp)) problems.push(I + ': the channel strip fader no longer drives the live layer while dragging');
    // Since E5/W5 the strip reaches the live layer through two editor ACTIONS (so a fader in a panel
    // window drives the editor's layer); App's implementation of them is the livePreview call.
    if (!/a\.releaseFixtureChannels\(/.test(insp)) problems.push(I + ': nothing releases the live layer on commit — an entry sitting above a lighting clip would pin the channel');
    if (!/const live = \(channel: ProfileChannel, v: number\) => \{[\s\S]*?a\.pushFixtureChannels\(/.test(insp)) problems.push(I + ': the fader tick no longer drives the live layer (a.pushFixtureChannels)');
    const appSrc = read('src/renderer/App.tsx');
    if (!/releaseFixtureChannels: \(writes\) => \{ for \(const w of writes\) livePreview\.releaseFixtureChannel\(w\.fixtureId, w\.key\); \}/.test(appSrc)) problems.push('App.releaseFixtureChannels no longer releases the live layer');
    if (!/pushFixtureChannels: \(writes\) => \{ for \(const w of writes\) livePreview\.setFixtureChannel\(w\.fixtureId, w\.key, w\.value\); \}/.test(appSrc)) problems.push('App.pushFixtureChannels no longer writes the live layer');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Lighting: one wheel moves the whole selection ─────────────────────────────────────────────
check(
  'a channel edit drives every selected light, as one change',
  'The Lighting Takes panel promises "N lights - selection order is the take" and the recorder duly ' +
  'opens N parts. But the channel strip drove only the PRIMARY of the selection, so a four-head busk ' +
  'came back with three EMPTY parts and a phase spread with nothing to spread along. It must also be ' +
  'ONE commit: updateFixture per fixture would read the same stale array each time (only the last ' +
  'write surviving) and push one undo entry each. The fan-out matches by ROLE in degrees, not by ' +
  'channel key in fractions, because two heads with different travel must land on the same ANGLE — ' +
  'the same head-morphing rule that lets a take replay on a rig it was not recorded on.',
  () => {
    const I = 'src/renderer/contexts/panels/inspector.tsx';
    const src = read(I);
    const m = /export const FixtureChannelsPanel[\s\S]*?\n};/.exec(src);
    if (!m) return I + ' no longer defines FixtureChannelsPanel';
    const body = m[0];
    const problems = [];
    if (!/selectedFixtureIds/.test(body)) problems.push('the channel strip ignores the selection — only the primary head would move');
    // The role match itself now lives in profilePack.matchChannel (its own invariant guards that
    // it stays the only copy). What THIS check still owns is that the strip goes THROUGH it:
    // a fan-out that stopped matching by role would skip or mis-drive a second make of head.
    if (!/matchChannel\(/.test(body)) problems.push('the fan-out no longer matches by role — a second make of head would be skipped or mis-driven');
    if (!/a\.commitFixtures\(/.test(body)) problems.push('the commit is not commitFixtures() — writing per fixture loses every write but the last');
    if (/a\.updateFixture\(/.test(body)) problems.push('the channel strip still calls updateFixture() — the per-fixture door this panel must not use');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Lighting: CMY is a filter, not an emitter ─────────────────────────────────────────────────
check(
  'subtractive colour mixing is subtractive',
  'A discharge head is a white lamp behind three dichroic flags, and the DMX convention is 0 = flag ' +
  'OUT, so cyan/magenta/yellow at zero is OPEN WHITE. Read off the additive emitter table they said ' +
  '"no light", so every CMY fixture rendered BLACK in the 3D scene at full dimmer and roleValue ' +
  'published red/green/blue = 0 — which is exactly what a busk records and a pose key stores, so the ' +
  'colour half of a take on a CMY rig was not merely wrong but inverted. The table is still right for ' +
  'an RGB(W)+CM LED wash, where those roles really are emitters; the two are told apart by whether ' +
  'the MODE also emits red/green/blue, never by guessing from the model name.',
  () => {
    const F = 'src/renderer/services/fixtureSignal.ts';
    const E = 'src/renderer/engine/frameEngine.ts';
    const src = read(F);
    const problems = [];
    if (!/const SUBTRACTIVE/.test(src)) problems.push(F + ' no longer separates the subtractive flags from the emitter table');
    // ONE OWNER for the additive-vs-subtractive test. It lives in colorModel() because the PACKER
    // needs the same answer: its RGB→CMY bridge is only correct on a head that really is subtractive,
    // and while it fired on role alone, a clip driving the RED role also drove the CYAN CHANNEL on
    // the 17 shipped modes that emit BOTH primaries and CMY (ETC Source Four LED Series 2/3, fos/4,
    // cameo TS 200 FC, Clay Paky Spheriscan). The read path called those heads additive and the write
    // path called them subtractive, about the same fixture. Proved on the wire, and the fix proved by
    // removing it again, in scripts/test-cmy-bridge.cjs.
    if (!/export function colorModel\(/.test(src)) problems.push(F + ' no longer exports colorModel — the single owner of the additive-vs-subtractive test');
    if (!/subtractive: hasCmy && !hasPrimaries/.test(src)) problems.push(F + " no longer decides subtractive-vs-additive from the mode's own channel list");
    if (!/colorModel\(profile, mode\)/.test(src)) problems.push(F + ' resolveFixture no longer asks colorModel — it would be re-deriving the test it owns');
    for (const other of [...walk('src/renderer'), ...walk('src/main'), ...walk('plugins')]) {
      if (other === F) continue;
      if (/hasCmy\s*&&\s*!hasPrimaries/.test(read(other))) problems.push(other + ' re-derives the subtractive test — call fixtureSignal.colorModel()');
    }
    if (!/!complement \|\| !isSubtractive\(/.test(read(E))) problems.push(E + ' applies the RGB→CMY bridge without asking whether the head is subtractive — it would drive cyan on an additive wash');
    if (!/out\.r \*= 1 - cmy\[0\]/.test(src)) problems.push(F + ' no longer applies the flags multiplicatively — CMY would add light instead of removing it');
    if (!/CMY_FROM_RGB/.test(read(E))) problems.push(E + ' has no RGB→CMY bridge — a recorded colour move would land on a CMY rig as silence');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Lighting: a take can be placed by dropping it where it plays ──────────────────────────────
check(
  'a lighting take can be dropped onto a lighting lane',
  'The take chip sets application/artlux-take on dragstart and its own tooltip reads "Drag it onto a ' +
  'lighting lane", but Timeline.onDropFile had no lighting branch: the drop fell through to the "a ' +
  'take cannot go on a video lane" return and NOTHING happened — silently, because a failed drop ' +
  'looks exactly like a missed one. The only way to place a take was a clip inspector you can reach ' +
  'only by first creating a clip you did not want. Unlike a tracking take there is no payload ' +
  'fallback and there must not be: a lighting take is stored INLINE in its own document, so one this ' +
  'timeline does not hold is one it could not play.',
  () => {
    const T = 'src/renderer/components/timeline/Timeline.tsx';
    const src = read(T);
    const m = /const onDropFile = [\s\S]*?\n  };/.exec(src);
    if (!m) return T + ' no longer defines onDropFile';
    const body = m[0];
    const lighting = body.indexOf("layer?.kind === 'lighting'");
    const reject = body.indexOf('if (takeId) return;');
    if (lighting < 0) return 'onDropFile has no lighting branch — dropping a take on a lighting lane does nothing';
    if (reject >= 0 && lighting > reject) return 'the lighting branch is AFTER the take rejection — the drop is still swallowed';
    if (!/lightingTakes \?\? \[\]\)\.find/.test(body)) return 'the lighting branch does not resolve the take against THIS document';
    return null;
  },
);

// ── 3D: a beam is drawn on BOTH backends, and its colour survives the crossing ────────────────
check(
  'a beam carries its own tint buffer',
  'The beams were invisible on the renderer the 3D scene DEFAULTS to. They tinted per instance through ' +
  "three's instanceColor + setColorAt — the natural WebGL idiom — and read it back on the node path " +
  "as attribute('instanceColor'), which resolves to NOTHING on a WebGPURenderer: three does not expose " +
  'instanceColor as a plain geometry attribute there, it wraps it into an instancedDynamicBufferAttribute ' +
  'and hands it to the material as instanceColorNode. So every cone resolved to colour 0, and 0 through ' +
  'an ADDITIVE blend is exactly nothing — a material that draws black and a material that does not draw ' +
  'look identical, which is why it went unnoticed from the day the scene moved to WebGPU. The fix is to ' +
  'own the buffer: one attribute, named by us, read the same way in both languages.',
  () => {
    const F = 'src/renderer/components/Simulator3D/Beams.tsx';
    const src = read(F);
    const problems = [];
    if (/setColorAt\(/.test(src)) problems.push(F + ' is back on setColorAt/instanceColor — that tint is unreadable on the node path');
    if (/attribute\('instanceColor'/.test(src)) problems.push(F + " reads attribute('instanceColor'), which resolves to nothing on a WebGPURenderer");
    if (!/instancedDynamicBufferAttribute\(/.test(src)) problems.push(F + ' no longer reads its tint through instancedDynamicBufferAttribute on the node path');
    if (!/attribute vec3 aTint/.test(raw(F))) problems.push(F + ' no longer declares the aTint attribute in its GLSL');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── 3D: no WebGL-only drei material in the scene ──────────────────────────────────────────────
check(
  'the 3D scene mounts no MeshReflectorMaterial',
  "The Reflective floor toggle blacked out the WHOLE 3D viewport on the renderer the scene defaults to. " +
  "drei's MeshReflectorMaterial renders a mirror pass in useFrame and calls gl.state.buffers.depth — " +
  'WebGLRenderer API. On a WebGPURenderer gl.state is undefined, so it threw on every frame, the frame ' +
  'aborted, and grid, models and LEDs all vanished — no error on screen, just black. It survived months ' +
  'because the toggle defaulted off and a black viewport reads as "the 3D view is broken today". Found ' +
  'capturing screenshots (2026-10-22); the feature was removed. A planar reflection on WebGPU needs a ' +
  "node-material reflector (three's reflector() TSL), not this component.",
  () => {
    const files = [...walk('src/renderer'), ...walk('plugins')];
    const hits = files.filter((f) => /\bMeshReflectorMaterial\b/.test(read(f)));
    return hits.length ? 'MeshReflectorMaterial is used again in: ' + hits.join(', ') : null;
  },
);

// ── 3D: the cone DIAGRAM is lines, and is not on the volumetric budget ────────────────────────
check(
  'the beam cone diagram is uncapped lines',
  'Two representations, two costs, and the whole point is that they are not the same. The volumetric ' +
  'shell is FILL-RATE bound — 200 cones overlapping is 200 screenfuls of shaded pixels — so it is ' +
  'hard-capped by MAX_BEAMS and only the brightest are drawn. The cone DIAGRAM (apex, beam angle, ' +
  'optical axis, illumination boundary) is lines: a few hundred pixels whatever the throw, so every lit ' +
  'fixture gets one and no cap applies. Put the outline behind the volumetric cap and a rig of fifty ' +
  'heads silently stops showing where half of them are pointed, which is the one question the diagram ' +
  'exists to answer. It must also stay a LineBasicMaterial: the fat-line LineMaterial is WebGL-only and ' +
  "three's node renderer rejects it outright — the same trap that made every projector frustum vanish.",
  () => {
    const F = 'src/renderer/components/Simulator3D/Beams.tsx';
    const src = read(F);
    const problems = [];
    if (!/lineBasicMaterial/.test(src)) problems.push(F + ' no longer draws the diagram with a lineBasicMaterial');
    if (/from '@react-three\/drei'/.test(src) && /<Line\b/.test(src)) problems.push(F + " uses drei's fat <Line>, which the node renderer rejects");
    // The outline must be written BEFORE the MAX_BEAMS branch, or the cap silently applies to it too.
    const outline = src.indexOf('if (cones)');
    const cap = src.indexOf('if (!drawn.has(i))');
    if (outline < 0) problems.push(F + ' no longer builds the cone diagram');
    else if (cap >= 0 && outline > cap) problems.push(F + ' builds the diagram AFTER the MAX_BEAMS cap — capped heads would lose their outline');
    // …and it must come off the fixture's own live parameters, not a constant.
    if (!/halfAngle\(rm, st!\.zoomDeg\)/.test(src)) problems.push(F + ' no longer takes the beam angle from the fixture profile + its live zoom channel');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── 3D: nothing in this scene may depend on a raw ShaderMaterial alone ────────────────────────
check(
  'the 3D scene draws on both backends',
  "three's node renderer REJECTS a raw ShaderMaterial and drei's fat LineMaterial outright, and it " +
  'does it silently: the object is simply not drawn, or is drawn as its bare geometry. The 3D scene ' +
  'defaults to the WebGPU backend, so this has now cost three separate features. The projector ' +
  'frustum vanished (LineMaterial). The beams vanished (an instanceColor tint that reads as nothing ' +
  'on the node path, and 0 through an additive blend IS nothing). And the ground grid — drei <Grid>, ' +
  'a 30x30 plane whose shader is what flattens it onto the floor and makes it infinite — rendered as ' +
  'a BLACK WALL standing at the origin, which is how an operator reported it. A LineBasicMaterial ' +
  'renders identically on both; a shader that genuinely needs to exist must ship a TSL twin, the way ' +
  'Beams does, and be chosen by which RENDERER is live rather than by which modules happen to be loaded. ' +
  'The family has since grown two more members. gl.capabilities (drei GizmoViewport) is the worst of them: ' +
  'it does not merely fail to draw, it THROWS inside the Canvas and blacks the whole viewport on the first ' +
  'frame. And in-scene TEXT — troika, drei <Text>, a sprite — is built out of exactly these ingredients, ' +
  'which is why the grid numbers are glyph quads from a CanvasTexture atlas on a plain MeshBasicMaterial ' +
  '(GridLabels.tsx) — in the scene, so they are depth-tested, and built only from parts both renderers ' +
  'draw. drei <Html> stays legitimate: it is a DOM overlay, not a material.',
  () => {
    // The host's scene AND every plugin file that draws into it (scene-viz contributions are mounted
    // inside the same Canvas). Scanning only Simulator3D let MediaPipe's PoseViz keep a drei <Line>
    // for months; reshaping it on a calibration save threw on every frame and froze the 3D view
    // (2026-11-09). A plugin file is in scope when it imports @react-three/fiber — i.e. it is 3D.
    const DIR = 'src/renderer/components/Simulator3D';
    const pluginScene = walk('plugins').filter((f) => /\.tsx?$/.test(f) && /@react-three\/fiber/.test(read(f)));
    const problems = [];
    for (const rel of [...walk(DIR), ...pluginScene]) {
      const src = read(rel);
      if (/<Grid\b/.test(src) || /\bGrid\b[^\n]*from '@react-three\/drei'/.test(src))
        problems.push(rel + " uses drei's <Grid>, whose ShaderMaterial does not run on the node renderer");
      if (/LineMaterial|<Line\b/.test(src) && /@react-three\/drei/.test(src))
        problems.push(rel + " uses drei's fat <Line>, which the node renderer rejects — use lineSegments + lineBasicMaterial");
      // A ShaderMaterial is allowed only where a node twin is built beside it — or in a file that
      // draws it on a WebGLRenderer it creates itself (projectorBake's offscreen pass), which the
      // viewport's node renderer never sees.
      if (/new THREE\.ShaderMaterial|<shaderMaterial\b/.test(src) && !/isWebGPURenderer|nodes\(\)/.test(src)
        && !/new THREE\.WebGLRenderer\(/.test(src))
        problems.push(rel + ' builds a raw ShaderMaterial with no node twin — it will not draw on the WebGPU backend');
      // The GizmoViewport crash, which is the worst of the family: it does not merely fail to draw,
      // it THROWS inside the Canvas and takes the entire viewport black on the first frame.
      if (/gl\.capabilities|getMaxAnisotropy/.test(src))
        problems.push(rel + ' reaches for gl.capabilities — a WebGLRenderer-only API that throws inside the Canvas on the node renderer, blacking the whole viewport');
      // Text in this scene. All three routes are built out of the things above.
      if (/troika/.test(src))
        problems.push(rel + ' pulls in troika-three-text, whose derived ShaderMaterial the node renderer will not run — draw text as atlas glyph quads on a MeshBasicMaterial instead (see GridLabels.tsx)');
      // Match the IMPORT BINDING, not just JSX usage: `import { Text } from '@react-three/drei'` is
      // already unambiguous, and catching it there is what makes this fire on the commit that adds it
      // rather than on the one that first renders it.
      const drei = src.match(/import\s*\{([^}]*)\}\s*from\s*'@react-three\/drei'/);
      if ((drei && /\b(Text|Text3D|Billboard)\b/.test(drei[1])) || /<Text3D\b|<Text\b/.test(src))
        problems.push(rel + " uses drei's <Text>/<Text3D>/<Billboard>, which is troika — draw text as atlas glyph quads on a MeshBasicMaterial instead (see GridLabels.tsx)");
      if (/<sprite\b|SpriteMaterial/.test(src))
        problems.push(rel + ' draws a sprite — the GizmoViewport failure mode; sprites here go through WebGL-only texture paths');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Timeline: zoom-to-fit actually fits ───────────────────────────────────────────────────────
check(
  'zoom-to-fit does not share the wheel zoom floor',
  'Fitting is a promise about the RESULT — every clip on screen at once — and it was computed with ' +
  "the wheel's floor of 5 px/s. That turns the promise into a silent refusal for exactly the " +
  'documents that need it most: the floor caps what can fit at roughly (lane width / 5) seconds, so a ' +
  'drawer docked at ~800px could not fit more than about two and a half minutes of content. Press the ' +
  'button on a real show and clips stay off the right edge, with nothing to say why. The wheel floor ' +
  'is still right FOR THE WHEEL — below 5 px/s a clip is a smear and a drag cannot be aimed — which ' +
  'is why these are two named constants and not one.',
  () => {
    const T = 'src/renderer/components/timeline/Timeline.tsx';
    const G = 'src/renderer/components/timeline/geometry.ts';
    if (!exists(T) || !exists(G)) return 'the timeline or its geometry is gone';
    const geo = read(G), tl = read(T);
    const problems = [];
    if (!/FIT_MIN_PX_PER_SEC/.test(geo)) problems.push('FIT_MIN_PX_PER_SEC is gone — the fit is sharing a floor with something again');
    if (!/ZOOM_MIN_PX_PER_SEC/.test(geo)) problems.push('ZOOM_MIN_PX_PER_SEC is gone');
    const fit = fnBody(tl, 'onZoomFit') ?? '';
    if (!fit) problems.push('could not find onZoomFit');
    else {
      if (!/FIT_MIN_PX_PER_SEC/.test(fit)) problems.push('onZoomFit no longer uses the fit floor — it is refusing to fit long documents again');
      if (/ZOOM_MIN_PX_PER_SEC/.test(fit)) problems.push('onZoomFit uses the WHEEL floor, which caps what it can fit');
      if (/clamp\([^)]*,\s*5\s*,/.test(fit)) problems.push('onZoomFit has a hardcoded 5 px/s floor again');
      // Sizing alone is not fitting: the canvas keeps a paged extent, so the view must go back to the start.
      if (!/scrollLeft\s*=\s*0/.test(fit)) problems.push('onZoomFit no longer returns the view to the start — content can be correctly sized and still off screen');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Projector: a surface's opacity reaches the wall, on every path ────────────────────────────
check(
  "a surface's opacity reaches every projector output path",
  'frameEngine has always applied Surface.content.opacity — for the LED sampler, the 2D preview and ' +
  'the 3D scene — and NOTHING in the projector path ever read it. A surface dimmed to 40%, or faded ' +
  'out by a cue, played at full on the projector: the one output an audience is actually looking at. ' +
  'Nothing threw, and every other view agreed with the operator, which is what made it invisible. ' +
  'There are THREE paths and a fix that covers two of them is the same bug with a smaller blast ' +
  'radius: the ordinary warp/blend draw, the calibrated draw when an output carries a residual warp, ' +
  'and the calibrated output with NO residual warp — where ProjectorGL draws nothing at all and the ' +
  "panel's own canvas IS the output, so the only place left is the element itself.",
  () => {
    const F = 'src/renderer/projector/ProjectorApp.tsx';
    if (!exists(F)) return `${F} is gone`;
    const src = read(F);
    const problems = [];
    if (!/function surfaceOpacity\s*\(/.test(src)) problems.push('surfaceOpacity is gone — the surface opacity is being read somewhere ad hoc, or not at all');
    // Every gl.draw options object that carries a brightness must carry the opacity with it.
    const draws = src.match(/brightness:\s*[^,}]+/g) ?? [];
    if (draws.length < 2) problems.push(`only ${draws.length} draw path passes a brightness — the calibrated path has stopped carrying it, so a fade would not happen on a calibrated projector`);
    for (const d of draws) {
      if (!/opacity/.test(d)) problems.push(`a draw path passes brightness without the surface opacity: ${d.trim()}`);
    }
    // …and the identity-warp case, which draws nothing and must dim the element instead.
    if (!/style\.opacity/.test(src)) problems.push('nothing sets the panel element opacity — a calibrated output with no residual warp draws through no GL stage at all, so it would ignore the fade entirely');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Projector pump: a generation dedups, it does not raise the rate ───────────────────────────
check(
  'the projector pump keys its fine tick on the source type, not on having a generation',
  'The pump runs at ~66 Hz with a ~30 Hz coarse gate, and the fine tick is only affordable for a ' +
  'source whose generation ACTUALLY repeats. A decoded clip does: 25 fps of new frames against 66 ' +
  'ticks means most ticks dedup, so riding fine costs nothing and lands each frame sooner. A ' +
  'GENERATIVE source is the opposite — a shader or moving text mints a new picture every frame, so ' +
  'its generation never repeats, and the fine tick simply doubles its createImageBitmap and transfer ' +
  'cost for pictures nothing can receive any faster. ' +
  'This has shipped once: plugin content sources gained getDrawableGeneration so a STILL one could be ' +
  'skipped entirely — the real win, and one a coarse tick delivers just as well — and the old ' +
  '`gen === undefined && !coarse` test silently promoted every one of them to 66 Hz. Video playback ' +
  'went visibly rough and it was reported as a framerate regression. The dedup below still applies to ' +
  'everything, which is where a motionless surface stops costing anything at all.',
  () => {
    const src = read('src/renderer/App.tsx');
    const problems = [];
    // The old shape, exactly: cadence decided by whether a generation exists.
    if (/if\s*\(\s*gen === undefined\s*&&\s*!coarse\s*\)\s*continue/.test(src)) {
      problems.push('the fine-tick gate is back to `gen === undefined && !coarse` — every generative plugin source is promoted to the fine tick again');
    }
    if (!/ridesFine/.test(src)) problems.push('no ridesFine gate — the pump no longer distinguishes a decode-rate generation from a frame-rate one');
    else if (!/ridesFine[\s\S]{0,160}SourceType\.VIDEO/.test(src)) problems.push('ridesFine no longer keys on the content type, so what rides the fine tick is decided by something other than what the source IS');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Timeline: one compositor, for the program and for a surface's track stack ─────────────────
check(
  'the program and a per-surface track stack share one compositor',
  'A surface can show ONE track, or a SET of them stacked (SurfaceContent.layerIds), or the whole ' +
  'timeline (PROGRAM). The last two are the same operation over a different list, and the loop that ' +
  'performs it is where `muted`, `solo`, `opacity`, `blendMode`, the excludeFromProgram clip-kinds ' +
  'and the back-to-front track order are DEFINED. Copying it gives those words two definitions, and ' +
  'they drift the first time one copy is taught something the other is not — the failure being that ' +
  'the same two tracks composite differently depending on whether a surface named them or the ' +
  'program did, with nothing on screen to say why. So compositeLayers() takes the list, and every ' +
  'caller passes one — the program, each per-surface stack, and an offline render compositing the ' +
  'ticked tracks into its own canvas at export size.',
  () => {
    const F = 'src/renderer/services/timeline.ts';
    if (!exists(F)) return `${F} is gone`;
    const src = read(F);
    const problems = [];
    if (!/function compositeLayers\s*\(/.test(src)) problems.push('compositeLayers is gone — the stacking loop has been inlined somewhere again');
    const prog = fnBody(src, 'buildProgram');
    if (!prog) problems.push('could not find buildProgram');
    else if (!/compositeLayers\(/.test(prog)) problems.push('buildProgram no longer calls compositeLayers — the program has its own copy of the loop');
    const stack = fnBody(src, 'buildStack');
    if (!stack) problems.push('could not find buildStack');
    else if (!/compositeLayers\(/.test(stack)) problems.push('buildStack no longer calls compositeLayers — a track stack has its own copy of the loop');
    // The THIRD caller: an offline render composites the ticked tracks into its own canvas at export
    // size (the live stack canvas is an area budget, grow-only, and sized off whichever clip happens
    // to be under the playhead — all wrong for a file). braceBody, not fnBody: it is an
    // object-literal method on `timeline`, the shape fnBody cannot see.
    const into = braceBody(src, 'compositeInto(ctx: CanvasRenderingContext2D');
    if (!into) problems.push('timeline.compositeInto() is gone — an offline render has no way to composite a ticked track set');
    else if (!/compositeLayers\(/.test(into)) problems.push('compositeInto no longer calls compositeLayers — a render has its own copy of the loop');
    // Solo is judged across the WHOLE timeline, and a render must ask the same question the
    // compositor answers, or it will bake black without being able to say why.
    if (!/function anySoloActive\s*\(/.test(src)) problems.push('anySoloActive is gone — the solo rule has been inlined again');
    // The tell-tale of a second copy: a drawImage over data.layers outside the shared function.
    const shared = fnBody(src, 'compositeLayers') ?? '';
    for (const [name, body] of [['buildProgram', prog], ['buildStack', stack], ['compositeInto', into]]) {
      if (body && body !== shared && /blendOp\(|\.blendMode/.test(body)) {
        problems.push(`${name} reads blendMode itself — that belongs to compositeLayers`);
      }
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// -- A pre-rendered surface is PROJECT data, never look data ------------------------------------
check(
  'a bake lives in the project, never on a Surface, and its file is collected',
  'The obvious place to put a pre-rendered surface is `Surface.content` — swap in the file, remember ' +
  'the original. It cannot work, and it fails without a sound. A Scene captures `surfaces` (placement ' +
  'AND content); unlike fixtures, which get a look/rig allow-list, surfaces are restored WHOLESALE by ' +
  'handleRecallScene; and the state machine recalls a scene on entering EVERY state, including its ' +
  'initial one, at load. So a swapped surface reverts to its shader seconds after the project opens, ' +
  'with no dialog (a show-origin recall must never raise one) and no undo record (it passes no origin, ' +
  'so nothing is written to history). The bake would simply never play. ' +
  'The rule this codebase already has is "project-scope data must not ride a look snapshot" — it is ' +
  'why assets, groups, trackingZones and projectorOutputs are not captured. Hence ProjectData.bakes, ' +
  'and hence this check: the store must exist, the compositor must consult it, the scene snapshot must ' +
  'not carry it, and the asset visitor must map BOTH its files (a transparent bake is a colour video ' +
  'plus a matte) or Collect Assets reports a clean project whose baked surfaces are all black.',
  () => {
    const problems = [];
    const F = 'src/renderer/services/bakeStore.ts';
    if (!exists(F)) return `${F} is gone — a bake has nowhere to live but a Surface`;

    // The ONE seam: every consumer (2D preview, LED sampler, projector pump, 3D texture) already
    // comes through surfaceMedia.getDrawable, so the substitution belongs there and only there.
    const sm = stripComments(read('src/renderer/services/surfaceMedia.ts'));
    if (!/bakeStore\.drawableFor\(/.test(sm)) {
      problems.push('surfaceMedia.getDrawable no longer consults bakeStore — a recorded bake would never play');
    }

    // The document carries it, and the asset machinery must see the file.
    if (!/bakes\?:\s*BakeEntry\[\]/.test(read('shared/protocol.ts'))) {
      problems.push('ProjectData.bakes is gone — a bake would have to live on a Surface, which a scene recall reverts');
    }
    const pf = stripComments(read('src/main/projectFolder.ts'));
    const mapBody = fnBody(pf, 'mapAssetPaths') ?? '';
    if (!/bakes/.test(mapBody)) {
      problems.push('mapAssetPaths never visits `bakes` — relativize, resolve AND collect would all skip the rendered file, and it would not even appear in CollectResult.missing');
    } else if (/mattePath\?:/.test(read('shared/protocol.ts')) && !/mattePath/.test(mapBody)) {
      // A TRANSPARENT bake is TWO files, and the second one fails differently from the first. Miss the
      // colour video and the surface falls back to live content — visibly a missing asset. Miss the
      // MATTE and the colour video is still there and still plays, so the show comes up with every
      // transparent surface filled in solid black over whatever is beneath it. That reads as a broken
      // renderer, not as a file left on the authoring machine, which is why it is worth its own line.
      problems.push('mapAssetPaths visits `bakes` but not `mattePath` — a transparent bake would collect its colour video and leave its alpha behind, and the surface would come up opaque black rather than reported missing');
    }

    // …and the look snapshot must NOT. This is the whole reason for the design.
    const app = stripComments(read('src/renderer/App.tsx'));
    const snap = fnBody(app, 'buildSceneSnapshot');
    if (!snap) problems.push('could not find buildSceneSnapshot — this guard has gone blind');
    else if (/\bbakes\b/.test(snap)) {
      problems.push('buildSceneSnapshot captures `bakes` — a recall would then restore a stale binding, which is exactly what keeping bakes off the look snapshot prevents');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// -- A silent soundtrack explains itself ---------------------------------------------------------
check(
  'a bake judges its own sound by its OUTPUT, and the track advisory stays in videoAudio',
  'A ticked "render the sound" and a silent file look exactly like a broken encoder. The usual cause ' +
  'is mundane — a muted track audio strip — and it cost a whole render to find. So the runner ' +
  'measures the samples it actually encoded and says so. It must NOT instead model what would sound: ' +
  'that would mean re-deriving the bed, the scene audio, every layer strip, each clip flag, the ' +
  'container-scoped solo inversion and the venue kill switch, and would be wrong the first time any ' +
  'of them changed. Reading the output cannot be wrong. ' +
  'The BEFORE-the-render advisory is the other half, and it lives in services/videoAudio.ts because ' +
  'the vl: id shape and the solo scoping belong to that module — a caller re-deriving either would ' +
  'be a second copy of the rule that silences a track. It is also deliberately a claim about TRACKS, ' +
  'never about the file: a render carries the bed too, so "these tracks are silent" is not "the file ' +
  'will be silent", and the stronger claim would be wrong on any show with a bed.',
  () => {
    const problems = [];
    const runner = stripComments(read('plugins/bake/src/bakeRunner.ts'));
    // The peak must be WRITTEN, not merely mentioned. Testing for the identifier alone passed a
    // mutation that deleted the measurement and left the verdict reading a variable nothing updates
    // — so this asks for an assignment of something other than the initial zero. The class excludes
    // WHITESPACE deliberately: a `(?!0)` lookahead is defeated by backtracking, because \s* can match
    // zero spaces and leave the lookahead staring at the space instead of the 0. It passed the mutation.
    if (!/audioPeak\s*=\s*[^\s0]/.test(runner)) {
      problems.push('bakeRunner never updates audioPeak — the soundtrack is not being measured, so a silent render would read as a broken encoder');
    }
    if (!/audioPeak\s*<\s*SILENCE_FLOOR/.test(runner)) {
      problems.push('nothing compares audioPeak against the silence floor — the measurement is taken and never used');
    }
    if (!/offlinePull/.test(runner)) {
      problems.push('bakeRunner no longer pulls offline audio at all');
    }
    if (!/audioNote\s*=/.test(runner)) problems.push('bakeRunner never sets audioNote — a silent render would say nothing');

    const va = read('src/renderer/services/videoAudio.ts');
    if (!/export function videoAudioOutlook/.test(va)) {
      problems.push('videoAudioOutlook is gone from services/videoAudio.ts — the panel would have to re-derive what silences a track');
    }
    const panel = stripComments(read('plugins/bake/src/BakePanel.tsx'));
    if (/vl:/.test(panel)) {
      problems.push('BakePanel spells the vl: track-id prefix itself — that shape belongs to videoAudio.ts, and a second copy drifts the first time the derivation changes');
    }
    if (/\.audio\?\.(mute|solo)/.test(panel)) {
      problems.push('BakePanel reads layer audio mute/solo directly — it must ask videoAudioOutlook, or the solo inversion lives in two places');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// -- A render refuses to deliver a file the show moved underneath --------------------------------
check(
  'a bake aborts if the state machine changes state mid-render',
  'fsm.tick() lives in the timeline frame body, and the offline stepFrame() runs that same body — so ' +
  'the state machine advances on the STEPPED playhead, at render speed. If it changes state mid-render ' +
  'it recalls a scene, and a recall restores `surfaces` WHOLESALE, so the surface being rendered swaps ' +
  'content halfway through its own file. Every individual frame is perfect; the file is two scenes ' +
  'spliced together, which is the kind of fault that is only ever found on a wall. ' +
  'OBSERVED, not theorised: a render started just after a project opens catches the FSM entering its ' +
  'INITIAL state — measured firing at frame 8 and frame 18 of 120 on two cold runs — and the file came ' +
  'back with its opening frames from one scene and the rest from another. ' +
  'It cannot be predicted (a transition may wait on a tracker, an OSC message or the clock), so the ' +
  'runner samples the state every frame and refuses rather than hand over the file. Same doctrine as ' +
  'frameExact: a renderer that cannot tell a near-miss from a hit must not deliver the near-miss.',
  () => {
    const F = 'plugins/bake/src/bakeRunner.ts';
    if (!exists(F)) return `${F} is gone`;
    const src = stripComments(read(F));
    if (!/stateMachine/.test(src)) {
      return 'bakeRunner no longer consults the state machine — a scene recall mid-render would splice two scenes into one file and nothing would say so';
    }
    if (!/getCurrentStateId\(\)/.test(src)) {
      return 'bakeRunner imports the state machine but never reads getCurrentStateId() — the guard has gone blind';
    }
    // The comparison must live INSIDE the frame loop: sampling once before it would detect nothing.
    const loop = src.slice(src.indexOf('for (let i = 0; i < frames'));
    if (!/getCurrentStateId\(\)/.test(loop)) {
      return 'the state check is outside the render loop — it would compare the start against itself and never fire';
    }
    return null;
  },
);

// -- A LIVE content source can never be baked ---------------------------------------------------
check(
  'no live content source claims to be renderable off the wall clock',
  'ContentSourceProvider.offlineSafe says "ask me for time t and I will draw t", which is what lets a ' +
  'non-realtime render step a source faster or slower than real time and still get the right pictures. ' +
  'A generative source qualifies. A LIVE one never can: a camera, an NDI or Spout receiver, a DMX input ' +
  'or a tracker shows whatever arrived from outside the machine, and stepping a clock does not move it. ' +
  'The flag is one word and sits among a dozen other provider fields, so the way it gets onto a live ' +
  'source is a copy-paste, not a decision — and the result is not a crash but a baked file holding one ' +
  'frozen frame, or a jittering one, which reads as a bug in the renderer rather than in the source. ' +
  'The host default is already refuse-unless-declared; this asserts the declarations that exist are ' +
  'not the wrong ones.',
  () => {
    // Plugins whose content is, by definition, whatever the outside world just sent.
    const LIVE = ['ndi', 'spout', 'lidar-tracking', 'mediapipe', 'augmenta'];
    const problems = [];
    for (const name of LIVE) {
      const dir = `plugins/${name}/src`;
      if (!exists(dir)) continue; // a plugin that has been removed is not a failure of this rule
      for (const f of walk(dir)) {
        if (/offlineSafe\s*:\s*true/.test(stripComments(read(f)))) {
          problems.push(`${f} declares offlineSafe on a LIVE source — it cannot be rendered off the wall clock`);
        }
      }
    }
    // …and the host must keep refusing by default, or the declarations stop meaning anything.
    const cs = stripComments(read('src/renderer/services/contentSource.ts'));
    if (!/offlineSafe/.test(cs)) {
      problems.push('contentSource no longer consults offlineSafe — every plugin source would be baked blind');
    }
    for (const live of ['SourceType.CAMERA', 'SourceType.DMX_IN']) {
      if (!cs.includes(live)) problems.push(`prepareExact no longer names ${live} as live`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Assets: a content type's file paths are mapped in ONE place ───────────────────────────────
check(
  "every content type's file paths go through one visitor",
  'A SurfaceContent lives in two places — on a surface and on a timeline clip — and projectFolder ' +
  'spelled the "which fields hold a path" rule out SEPARATELY in mapSurfaces and in mapTimeline. A ' +
  'content type added to one of them is simply missed by the other: mapped on a surface, unmapped on ' +
  'a clip of the same content. The failure is the silent kind this file has already shipped twice ' +
  '(the audio bed; the audio-only scene) — relativize, resolve AND collect skip the path together, so ' +
  'the file is baked to the authoring machine, is never copied into the folder, and does NOT appear ' +
  'in CollectResult.missing. The show just looks wrong at the venue, with nothing logged. ' +
  'One table (CONTENT_PATHS) read by one visitor (mapContent) is what makes a new type a one-line ' +
  'change that cannot be half-done.',
  () => {
    const F = 'src/main/projectFolder.ts';
    if (!exists(F)) return `${F} is gone`;
    const src = read(F);
    const problems = [];
    if (!/const CONTENT_PATHS\s*:/.test(src)) problems.push('CONTENT_PATHS is gone — the path rule has been inlined somewhere again');
    if (!/function mapContent\s*\(/.test(src)) problems.push('mapContent is gone — the two call sites are deriving the rule separately again');
    const surfaces = fnBody(src, 'mapSurfaces');
    if (!surfaces) problems.push('could not find mapSurfaces');
    else if (!/mapContent\(/.test(surfaces)) problems.push('mapSurfaces no longer routes through mapContent');
    const timeline = fnBody(src, 'mapTimeline');
    if (!timeline) problems.push('could not find mapTimeline');
    else if (!/mapContent\(/.test(timeline)) problems.push('mapTimeline no longer routes clip content through mapContent — a clip of a new content type would go unmapped');
    // A hand-written type test in either visitor is the shape that drifted; the table is the only
    // place a content type may be named.
    for (const [name, body] of [['mapSurfaces', surfaces], ['mapTimeline', timeline]]) {
      if (body && /content\?\.type\s*===|c\.type\s*===/.test(body)) {
        problems.push(`${name} tests a content type inline again instead of reading CONTENT_PATHS`);
      }
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── 3D: the ImageBitmap flip is per-BACKEND ───────────────────────────────────────────────────
check(
  'the ImageBitmap flip compensation asks which backend is live',
  'three IGNORES Texture.flipY for an ImageBitmap on WebGL (the unpack flags are set inside an ' +
  '`if (isImageBitmap === false)`) and HONOURS it on WebGPU, which uploads through ' +
  'copyExternalImageToTexture. bitmapFlip.ts compensates for the WebGL behaviour, so on the backend ' +
  'the 3D scene actually DEFAULTS to, that compensation was a second flip and every ImageBitmap-backed ' +
  'texture came out upside down. It hid for two releases because of what reaches a 3D plane as a ' +
  'bitmap: shader output, which is generative noise, where a vertical flip is undetectable. The first ' +
  'TEXT surface on a mesh showed it in one frame. ' +
  'And it must ask which renderer is LIVE (isWebGPUActive), never which one was REQUESTED ' +
  '(wantsWebGPU): a machine that asked for WebGPU and fell back is running WebGL and still needs the ' +
  'compensation — inferring it from the request re-creates the same upside-down picture on exactly ' +
  'the machines that are already having a bad day.',
  () => {
    const F = 'src/renderer/components/Simulator3D/bitmapFlip.ts';
    if (!exists(F)) return `${F} is gone — the flip rule must stay in one place`;
    const src = read(F);
    const problems = [];
    if (!/isWebGPUActive\s*\(/.test(src)) problems.push('no longer branches on the live backend, so one of WebGL/WebGPU is inverted');
    if (/wantsWebGPU\s*\(/.test(src)) problems.push('branches on wantsWebGPU() — that is the REQUEST; a fallen-back machine would be inverted');
    const R = 'src/renderer/components/Simulator3D/renderer3d.ts';
    if (!exists(R)) return problems.concat(`${R} is gone`).join('; ');
    const r = read(R);
    if (!/export function isWebGPUActive/.test(r)) problems.push('renderer3d no longer publishes isWebGPUActive()');
    // Every fallback path must clear the flag, or it reports the request rather than the reality. The
    // ONE legal call is inside the wrapper that clears it; a second is a path that bypassed it.
    const direct = (r.match(/onFallback\(reason\)/g) || []).length;
    if (direct !== 1) problems.push(`onFallback(reason) is called ${direct} times — exactly one, inside the wrapper that clears the live-backend flag, is correct; more means a fallback path leaves the flag still saying WebGPU`);
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Content: a new source type must also reach the projector windows ──────────────────────────
check(
  'every plugin content type is named in SELF_RENDER or STREAMED',
  'A projector window classifies a surface by its content type into SELF_RENDER (rasterise it here) ' +
  'or STREAMED (the main window decodes it and pushes bitmaps). A type in NEITHER set renders ' +
  'NOTHING — not an error, not a fallback: a black output, in the mode with no operator watching. ' +
  "This has shipped twice. 'SLICE' did it first; 'SHADER' did it again the day it was added, with the " +
  'plugin registered, the stage correct and the fixtures correct, because those two sets are the one ' +
  'place a new type must ALSO be named and nothing pointed that out. ProjectorApp.tsx carries a ' +
  'comment begging whoever adds the next one to remember; this is that comment made mechanical.',
  () => {
    const APP = 'src/renderer/projector/ProjectorApp.tsx';
    if (!exists(APP)) return `${APP} is gone`;
    const app = read(APP);
    const sets = app.match(/const (?:SELF_RENDER|STREAMED) = new Set<string>\(\[([\s\S]*?)\]\)/g);
    if (!sets || sets.length !== 2) return 'SELF_RENDER / STREAMED are no longer two Set<string> literals — the classification moved and this check is blind';
    const named = sets.join('\n');
    // A registered content type is a `type: 'X'` sitting in a file that also implements getDrawable.
    const problems = [];
    for (const rel of walk('plugins')) {
      const src = read(rel);
      if (!/getDrawable\s*[:(]/.test(src)) continue;
      for (const m of src.matchAll(/\btype:\s*'([A-Z][A-Z0-9_]*)'/g)) {
        const t = m[1];
        // Either spelling counts: the sets mix SourceType.X constants and bare plugin strings.
        if (named.includes(`'${t}'`) || named.includes(`SourceType.${t}`)) continue;
        problems.push(`${rel} registers content type '${t}', which ProjectorApp names in neither set — that output will be BLACK`);
      }
    }
    return problems.length ? [...new Set(problems)].join('; ') : null;
  },
);

// ── 3D: the ruler tells the truth ─────────────────────────────────────────────────────────────
check(
  'the floor grid, its numbers and the gnomon read one ladder',
  'The floor fades between decade families as you zoom (gridScale.gridFamilies / labelFamilies), ' +
  'and three separate things have to agree on the zoom they read: the lines that are drawn, the ' +
  'numbers printed beside them, and the origin gnomon (screen-constant, sized from the same ' +
  'pixels-per-metre). If any of them derives the scale independently they can disagree by a frame ' +
  'or by a whole decade, and the failure is ' +
  'silent and actively harmful: a "2 m" printed over a line that is 1 m away is not a cosmetic bug, ' +
  'it is a wrong measurement an operator will scale an imported model by. Nothing throws. So the ' +
  'ladder lives in gridScale.ts, GroundGrid is the single writer of the solved frame, and the other ' +
  'two read it.',
  () => {
    const S = 'src/renderer/components/Simulator3D/';
    const files = ['GroundGrid.tsx', 'GridLabels.tsx', 'OriginGnomon.tsx'];
    const problems = [];
    for (const f of files) {
      if (!exists(S + f)) { problems.push(`${S}${f} is gone`); continue; }
      const src = read(S + f);
      if (!/from '\.\/gridScale'/.test(src)) problems.push(`${f} no longer reads gridScale.ts`);
      if (/\[\s*1\s*,\s*2\s*,\s*5\s*\]|Math\.log10/.test(src)) problems.push(`${f} derives its own 1-2-5 ladder instead of reading gridScale.ts`);
    }
    if (exists(S + 'GroundGrid.tsx') && !/setGridFrame\(/.test(read(S + 'GroundGrid.tsx')))
      problems.push('GroundGrid no longer publishes the solved frame — the numbers and the gnomon would read a stale one forever');
    for (const f of ['GridLabels.tsx', 'OriginGnomon.tsx'])
      if (exists(S + f) && /setGridFrame\(/.test(read(S + f)))
        problems.push(`${f} writes the grid frame — there must be exactly ONE writer, or which one wins depends on mount order`);
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'grabbing a gizmo never moves the camera',
  'drei TransformControls switches the orbit off from its OWN pointerdown, and OrbitControls hears the ' +
  'same press — whichever listener registered first wins, so the camera could start rotating as the ' +
  'operator grabbed a move/rotate/scale handle. In four views it was certain: MultiView re-enables the ' +
  'orbit on every pointermove to hold it off over the flat panes, which undid the switch-off for the ' +
  'whole drag (owner, 2026-11-23: "when I move, scale or rotate, the cam moves"). Nothing throws; the ' +
  'object AND the view move together. GizmoOrbitGuard turns the orbit off in a window CAPTURE listener ' +
  'before the canvas sees the press, and anything else that writes controls.enabled must ask gizmoHeld(). ' +
  'It also swallows the click that ends such a press: r3f fires onClick on whatever is under both ends, ' +
  'so a drag released over another object selected it (the floor, edge-on in the Front pane).',
  () => {
    const S = 'src/renderer/components/Simulator3D/';
    const problems = [];
    const g = S + 'GizmoOrbitGuard.tsx';
    if (!exists(g)) return `${g} is gone`;
    const gs = read(g);
    if (!/addEventListener\('pointerdown',\s*onDown,\s*true\)/.test(gs)) problems.push('GizmoOrbitGuard no longer listens to pointerdown in the CAPTURE phase — the orbit would hear the press first');
    if (!/addEventListener\('click',\s*onClick,\s*true\)/.test(gs)) problems.push('GizmoOrbitGuard no longer swallows the click that ends a gizmo drag — releasing over another object would select it');
    if (!/<GizmoOrbitGuard\s*\/>/.test(read(S + 'Simulator3D.tsx'))) problems.push('Simulator3D no longer mounts <GizmoOrbitGuard />');
    for (const f of ['MultiView.tsx', 'ViewControls.tsx', 'Simulator3D.tsx']) {
      if (!exists(S + f)) continue;
      const src = read(S + f);
      if (/\.enabled\s*=(?!=)/.test(src) && !/gizmoHeld\(\)/.test(src))
        problems.push(`${f} writes controls.enabled without asking gizmoHeld() — it can turn the orbit back on mid-drag`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'object snaps stay off the frame and off React',
  'Object snaps run at pointer rate during a drag, against venue models that can be millions of ' +
  'triangles. Two ways to make every drag stutter, neither of which throws: building a mesh BVH (or the ' +
  'feature-edge list) inside the pointer handler — a one-second hitch the first time a big venue is ' +
  'snapped to — and putting the drag in React state, which re-renders the whole 3D tree per pointer move ' +
  '(the fixturePreview rule). So the per-geometry data is built in snapQuery.ts in an idle callback ' +
  'only, nothing else builds a BVH, and ObjectDrag.tsx keeps no React state. A press also lets a fixture ' +
  'under the pointer win over a model nearer the camera (pickPriority.ts) — without it a bar lying on a ' +
  'screen or floor could never be grabbed.',
  () => {
    const S = 'src/renderer/components/Simulator3D/';
    const problems = [];
    const q = S + 'snapQuery.ts', d = S + 'ObjectDrag.tsx';
    if (!exists(q) || !exists(d)) return 'snapQuery.ts / ObjectDrag.tsx is gone';
    const qs = read(q);
    const idleAt = qs.indexOf('idle(() => {');
    const bvhAt = qs.indexOf('new MeshBVH(');
    const edgesAt = qs.indexOf('new THREE.EdgesGeometry(');
    if (idleAt < 0 || bvhAt < idleAt || edgesAt < idleAt) problems.push('snapQuery.ts builds the BVH / feature edges outside its idle callback');
    if (!/return b \?\? a;/.test(qs)) problems.push('pressHit no longer lets a fixture under the pointer win over a model (pickPriority rule)');
    for (const f of walk('src/renderer')) {
      if (!/\.(ts|tsx)$/.test(f) || f.endsWith('snapQuery.ts')) continue;
      if (/new MeshBVH\(|computeBoundsTree/.test(read(f))) problems.push(`${f} builds a BVH — only snapQuery.ts may, off the frame`);
    }
    for (const f of [d, S + 'MeasureTool.tsx']) {
      if (exists(f) && /useState\(/.test(read(f))) problems.push(`${f} keeps React state — it would re-render the 3D tree per pointer move`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the engine\'s 3D view keeps drawing when the engine does not own the wire',
  'E4a: the engine draws the 3D view window from the pictures and the composed LED buffer its render ' +
  'thread makes — but that thread used to compose ONLY while the engine owned the wire or a projector. ' +
  'Ownership is all or nothing per show (one layer surface, one shader → the app keeps the wire), so on ' +
  'most real shows the 3D window would have shown every screen dark and every LED black, with nothing ' +
  'thrown. The runtime therefore treats an open view as a consumer of its own (`viewing`), and the view ' +
  'reads the editor\'s own world matrices (engineView.tsx sends matrixWorld) rather than re-deriving any.',
  () => {
    const problems = [];
    const rt = 'engine/artlux-engine/src/runtime.rs', ev = 'src/renderer/components/Simulator3D/engineView.tsx';
    if (!exists(rt) || !exists(ev)) return 'runtime.rs / engineView.tsx is gone';
    const r = read(rt);
    if (!/let viewing = self\.view_open\(\);/.test(r)) problems.push('runtime.rs no longer asks whether a 3D view is open before deciding to compose');
    if (!/!doc\.owns && self\.projectors\.is_empty\(\) && !viewing/.test(r)) problems.push('runtime.rs composes only for the wire / projectors again — an open 3D view would go dark on a show the engine does not own');
    if (!/if viewing \{ self\.publish_view\(doc, &raw\); \}/.test(r)) problems.push('runtime.rs no longer publishes the LED colours to the 3D view');
    if (!/matrixWorld/.test(read(ev))) problems.push('engineView.tsx no longer sends the editor\'s world matrices');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine draws tracking markers exactly as the app\'s three copies do',
  'E2 tracking: the engine draws LiDAR, Augmenta and MediaPipe markers with ONE port (engine blobs.rs) of the ' +
  'marker shader the three plugins each carry (blobPass.ts ×2, posePass.ts). A tweak to the arrowhead, its ' +
  'edge softness or the disc edge in one plugin would make the engine\'s wall disagree with that plugin\'s ' +
  'preview — so every copy must carry the same numbers.',
  () => {
    const files = ['plugins/lidar-tracking/src/blobPass.ts', 'plugins/augmenta/src/blobPass.ts', 'plugins/mediapipe/src/posePass.ts', 'engine/artlux-engine/src/blobs.rs'];
    const missing = files.filter((f) => !exists(f));
    if (missing.length) return `${missing.join(', ')} is gone`;
    const problems = [];
    for (const f of files) {
      const t = raw(f).replace(/\s+/g, '');
      for (const [what, re] of [
        ['the disc edge smoothstep(0.9, 1.0)', /smoothstep\(0\.9,1\.0,d\)/],
        ['the arrowhead corners (0.62,0) (-0.32,±0.42)', /0\.62,0\.0\)[^;]*;?[\s\S]{0,80}-0\.32,0\.42\)[\s\S]{0,80}-0\.32,-0\.42\)/],
        ['the edge softness 0.05', /=0\.05;/],
        ['premultiplied output rgb * a', /rgb\*a,a\)/],
      ]) if (!re.test(t)) problems.push(`${f}: ${what}`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine composites the timeline from the app\'s own track list and blend modes',
  'E3a: the engine composites LAYER / stack / PROGRAM surfaces itself (engine comp.rs) from what ' +
  'timeline.nativeLayers reports. That list must be contributingLayers — the SAME list compositeLayers draws — ' +
  'or a muted, disabled or un-soloed track would reach the wall from the engine while the editor hides it. ' +
  'And the engine must map the four blend modes as blendOp does (add → lighter, screen, multiply, else ' +
  'source-over), or a screen track would composite as normal on the wire and as screen in the preview.',
  () => {
    const problems = [];
    const T = 'src/renderer/services/timeline.ts', C = 'engine/artlux-engine/src/comp.rs';
    if (!exists(T) || !exists(C)) return 'timeline.ts / comp.rs is gone';
    const t = read(T);
    if (!/function contributingLayers\s*\(/.test(t)) problems.push('contributingLayers is gone');
    const comp = fnBody(t, 'compositeLayers') ?? '';
    if (!/contributingLayers\(/.test(comp)) problems.push('compositeLayers no longer draws contributingLayers');
    if (!/nativeLayers\([\s\S]*?contributingLayers\(/.test(t)) problems.push('timeline.nativeLayers no longer reads contributingLayers');
    if (!/m === 'add' \? 'lighter' : m === 'screen' \? 'screen' : m === 'multiply' \? 'multiply' : 'source-over'/.test(t)) problems.push('blendOp changed — re-port it to comp.rs and update this check');
    if (!/"add" => 1, "screen" => 2, "multiply" => 3, _ => 0/.test(read(C))) problems.push('comp.rs no longer maps the blend modes as blendOp does');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine evaluates the timeline\'s time with the app\'s own formulas',
  'E3c: the engine evaluates each composited track\'s clip alpha and clip-local time from the playhead (engine ' +
  'eval.rs, a port of automation.ts / clipFadeAlpha / layerAlpha) and draws ITS values. A curve kind added to ' +
  'EASE_FN and not to eval.rs would play linear in the engine and eased in the editor; a change to the fade or ' +
  'clip-time formula would move the wall and not the preview. test:eval-parity holds the numbers (it needs the ' +
  'engine built); this holds the shape: every ease name, the bezier default, the two formulas and the playhead ' +
  'on the tick.',
  () => {
    const problems = [];
    const A = 'src/renderer/services/automation.ts', E = 'engine/artlux-engine/src/eval.rs', T = 'src/renderer/services/timeline.ts', N = 'src/renderer/engine/nativeLink.ts';
    if (![A, E, T, N].every(exists)) return 'automation.ts / eval.rs / timeline.ts / nativeLink.ts is gone';
    const a = read(A), e = read(E), t = read(T);
    const table = (a.match(/export const EASE_FN\b[^{]*\{([\s\S]*?)\r?\n\};/) ?? [])[1] ?? '';
    const names = [...table.matchAll(/^\s*(ease\w+)\s*:/gm)].map((m) => m[1]);
    if (names.length < 30) problems.push(`EASE_FN not found as expected (${names.length} names)`);
    for (const n of names) if (!e.includes(`"${n}" =>`)) problems.push(`eval.rs has no ${n}`);
    const bd = (a.match(/BEZ_DEFAULT = \{ cx1: ([\d.]+), cy1: ([\d.]+), cx2: ([\d.]+), cy2: ([\d.]+) \}/) ?? []).slice(1).map(Number);
    const be = (e.match(/BEZ_DEFAULT: \[f64; 4\] = \[([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\]/) ?? []).slice(1).map(Number);
    if (bd.length !== 4 || be.length !== 4 || bd.some((v, i) => v !== be[i])) problems.push('BEZ_DEFAULT differs between automation.ts and eval.rs');
    if (!/base \* clipFadeAlpha\(c, playhead - c\.start\)/.test(fnBody(t, 'layerAlpha') ?? '')) problems.push('layerAlpha changed — re-port it to eval.rs clip_alpha');
    if (!/time: c \? playhead - c\.start \+ c\.inPoint : 0/.test(t)) problems.push('the clip-local time nativeLayers reports changed — re-port it to eval.rs clip_time');
    if (!/ph: (at\.ph \?\? )?timeline\.getPlayhead\(\)/.test(read(N))) problems.push('the tick no longer carries the playhead the engine evaluates from');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'every transport EVENT records an anchor for the native engine\'s clock, and the engine runs the app\'s wrap and park',
  'E3 (§4, the clock): the engine runs the playhead and the show clock ITSELF from the latest transport anchor ' +
  '(timeline.ts markAnchor → nativeLink `tp`, on every tick → transport.rs), applying runFrame\'s underrun / loop-wrap / end-park ' +
  'rules on its own. An event that moves a clock\'s origin without recording an anchor (a new seek path, a new ' +
  'resume) leaves the engine on the old one — the playhead it will draw from is then wrong by the whole jump. ' +
  'test:transport-clock catches it on the show; this catches it in the source: every function that re-anchors on ' +
  'an event calls markAnchor, and the number of origin assignments is pinned so a NEW one has to be classified ' +
  '(an event → markAnchor; a rule → port it to transport.rs step_one).',
  () => {
    const problems = [];
    const T = 'src/renderer/services/timeline.ts', R = 'engine/artlux-engine/src/transport.rs', N = 'src/renderer/engine/nativeLink.ts';
    if (![T, R, N].every(exists)) return 'timeline.ts / transport.rs / nativeLink.ts is gone';
    const t = read(T), r = read(R), n = read(N);
    for (const f of ['mainSeek', 'showSeekInternal']) if (!/markAnchor\(\)/.test(fnBody(t, f) ?? '')) problems.push(`${f} does not record an anchor`);
    for (const m of ['setPlaying(p: boolean): void', 'setData(t: Timeline): void', 'setGlobalDoc(t: Timeline): void', 'start(): void', "showClock?: 'preserve' | 'reset'; holdMs?: number }): void"]) {
      const b = braceBody(t, m);
      if (!b) problems.push(`timeline.${m.includes('holdMs') ? 'swap' : m.split('(')[0]} not found`);
      else if (!/markAnchor\(/.test(b)) problems.push(`timeline.${m.includes('holdMs') ? 'swap' : m.split('(')[0]} does not record an anchor`);
    }
    if (!/renderClock\.subscribe\(\(\) => \{[\s\S]{0,200}markAnchor\(n\)/.test(t)) problems.push('the render-clock flip does not record an anchor');
    if ((t.match(/markAnchor\(now\)/g) ?? []).length !== 2) problems.push('the two underrun clamps (scene and show) must each record an anchor at the frame time');
    const sites = (t.match(/^\s*.*\b(show)?[oO]riginMs (=|-=) (?!0;)/gm) ?? []).length;
    if (sites !== 19) problems.push(`timeline.ts has ${sites} clock-origin assignments (expected 19) — classify the new one: an event calls markAnchor, a rule is ported to transport.rs step_one; then update this count`);
    if (!/t = a \+ \(\(t - a\) % \(b - a\)\);/.test(t) || !/t = a \+ \(\(t - a\) % \(b - a\)\);/.test(r)) problems.push('the loop wrap is no longer the same formula in timeline.ts and transport.rs');
    if (!/t = Math\.max\(a, b - eps\);/.test(t) || !/t = js_max\(a, b - f\);/.test(r)) problems.push('the end park is no longer the same in timeline.ts and transport.rs');
    if (!/fm: timeline\.getFrameTimeMs\(\), tp,/.test(n)) problems.push('the tick no longer carries the frame time and the anchor');
    // Main DROPS ticks the engine is too busy for, so an anchor sent only on the tick that changed it can be lost.
    if (!/const tp = timeline\.transportAnchor\(\) \?\? undefined;/.test(n)) problems.push('the anchor must ride EVERY tick (main drops ticks; an anchor sent once can be lost with one)');
    // E3h: lanes and lights are DRAWN at the engine's own clock and CHECKED at the app's instant; the composite stays
    // on the app's playhead (the document carries each track's ACTIVE clip only, and the app decodes the frames).
    const rt = exists('engine/artlux-engine/src/runtime.rs') ? read('engine/artlux-engine/src/runtime.rs') : '';
    const body = (name) => { const i = rt.indexOf(`fn ${name}(`); if (i < 0) return ''; let d = 0; for (let j = rt.indexOf('{', i); j < rt.length; j++) { if (rt[j] === '{') d++; else if (rt[j] === '}' && --d === 0) return rt.slice(i, j); } return ''; };
    if (!/self\.transport\.own\(\)/.test(body('draw_clock'))) problems.push("draw_clock no longer reads the engine's own clock");
    if (!/at_app = crate::eval::sample_lane\(&l\.keys, if l\.show \{ st \} else \{ ph \}/.test(body('evaluate_lanes'))) problems.push("the lane check is no longer at the app's instant");
    if (!/self\.show\.roles\(dph\)/.test(body('evaluate_lighting')) || !/self\.show\.roles\(ph\)/.test(body('evaluate_lighting'))) problems.push("the light show is no longer checked at the app's instant and drawn at the engine's clock");
    // E3i: a track is drawn at the engine's clock ONLY while the clip under it is the one the document describes.
    if (!/let under = crate::eval::active_clip\(&track\.spans, dph\);[\s\S]{0,120}under == track\.id\.as_deref\(\)/.test(body('evaluate_clock'))) problems.push("the composite is drawn at the engine's clock without the clip-boundary rule (the document only describes the clip active at the app's playhead)");
    const ev = exists('engine/artlux-engine/src/eval.rs') ? read('engine/artlux-engine/src/eval.rs') : '';
    if (!/if \(c\.layerId === layerId && t >= c\.start && t < c\.start \+ c\.duration\) found = c;/.test(t) || !/if t >= \*start && t < start \+ duration \{ found = Some\(id\.as_str\(\)\); \}/.test(ev)) problems.push('activeClip changed — re-port it to eval.rs active_clip');
    if (!/spans: data\.clips\.filter\(\(x\) => x\.layerId === l\.id\)/.test(t)) problems.push("the composite document no longer carries each track's clip spans in activeClip's order");
    // E3j: the engine CHOOSES a video track's frame as the app's codecs do.
    const hc = exists('plugins/hap/src/hapCodec.ts') ? read('plugins/hap/src/hapCodec.ts') : '';
    const md = exists('plugins/mp4/src/mp4Decoder.ts') ? read('plugins/mp4/src/mp4Decoder.ts') : '';
    const dm = exists('engine/artlux-engine/src/mp4demux.rs') ? read('engine/artlux-engine/src/mp4demux.rs') : '';
    if (!/layerFrame: \(layerKey, path, clipTimeSec\) => \{[\s\S]{0,200}Math\.max\(0, Math\.min\(Math\.round\(clipTimeSec \* info\.fps\), info\.frameCount - 1\)\)/.test(hc) || !/let i = \(t \* fps \+ 0\.5\)\.floor\(\);/.test(ev)) problems.push("the HAP layer frame rule changed — re-port it to eval.rs VidTable");
    const epsApp = (md.match(/const PRESENT_EPS_US = ([\d_]+);/) ?? [])[1]?.replace(/_/g, '');
    const epsEng = (ev.match(/pub const PRESENT_EPS_US: f64 = ([\d.]+);/) ?? [])[1];
    if (!epsApp || !epsEng || Number(epsApp) !== Number(epsEng)) problems.push(`the MP4 present tolerance differs (app ${epsApp}, engine ${epsEng})`);
    if (!/f\.timestamp <= this\.wantUs \+ PRESENT_EPS_US/.test(md)) problems.push("the MP4 decoder no longer shows the last frame at or before the playhead + PRESENT_EPS_US — re-port it to eval.rs VidTable");
    if (!/let off = raw as i32 as i64;/.test(dm)) problems.push("mp4demux reads ctts offsets as unsigned again — a version-0 box with negative offsets loses two frames of three (E3j)");
    // E3k: the picture across a cut.
    const hand = rt.indexOf("decoder handed to"), keep = rt.indexOf("self.mp4s.retain(|k, (p, _)| matches!(doc.sources.get(k), Some(Source::Mp4(q, _)) if q == p));");
    if (hand < 0 || keep < 0 || hand > keep) problems.push("the next clip's decoder is no longer handed to its track BEFORE the retain closes it — every cut would open a cold decoder");
    if (!/self\.comp_sub\.get\(layer\)/.test(body('composite'))) problems.push("the composite no longer draws the next clip's picture across a cut the engine's clock reached first");
    const sm = exists('src/renderer/services/surfaceMedia.ts') ? read('src/renderer/services/surfaceMedia.ts') : '';
    if (!/if \(src\.kind === 'unsupported' && !e\.element\) src = contentSource\.nextClipNativeSource\(key, e\.clip, undefined\) \?\? src;/.test(sm)) problems.push("a cut the app's decoder has not caught up with makes the document unsupported again — the wire would go back to the app at every video cut");
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the audio engine has ONE core behind its two front doors (the addon and the native engine\'s library)',
  'E3 (JUCE in the engine process): native/audio-engine builds the same core.h twice — engine.cpp as the N-API ' +
  'addon the app plays through, capi.cpp as artlux_audio, the C library the native engine loads (audio.rs). A ' +
  'second copy of the bus, the clips or the device code in either front door would be two audio engines that drift ' +
  'apart the first time one is fixed. And the library must ship next to the engine (where audio.rs looks first), ' +
  'speak the ABI audio.rs expects, and count the audio clock where the device pulls samples.',
  () => {
    const problems = [];
    const C = 'native/audio-engine/src/core.h', E = 'native/audio-engine/src/engine.cpp', A = 'native/audio-engine/src/capi.cpp', R = 'engine/artlux-engine/src/audio.rs', M = 'native/audio-engine/CMakeLists.txt';
    if (![C, E, A, R, M].every(exists)) return 'core.h / engine.cpp / capi.cpp / audio.rs / CMakeLists.txt is gone';
    const c = read(C), e = read(E), a = read(A), r = read(R), m = read(M);
    for (const [n, s] of [['engine.cpp', e], ['capi.cpp', a]]) {
      if (!/#include "core\.h"/.test(s)) problems.push(`${n} does not include core.h`);
      if (/class (Engine|SpatialBus|MeteringAudioSource)\b|struct Clip\b/.test(s)) problems.push(`${n} defines engine classes of its own — they belong in core.h`);
    }
    if (/#include <napi\.h>/.test(c)) problems.push('core.h includes N-API — the C library would need Node');
    if (!/rendered\.fetch_add\(info\.numSamples/.test(c)) problems.push('the audio clock is no longer counted where the device pulls samples (MeteringAudioSource)');
    // E3o: the engine's clock follows the CARD's rate — fitted on exact (sample index, wall time) stamps written by the
    // device callback under a sequence counter, and applied only once the fit is certain.
    if (!/stampSeq\.fetch_add\(1, std::memory_order_acq_rel\);[\s\S]{0,200}stampWall\.store\(wall[\s\S]{0,80}stampSeq\.fetch_add\(1, std::memory_order_release\);/.test(c)) problems.push('the clock stamp is no longer written as a matched pair under its sequence counter');
    const T = read('engine/artlux-engine/src/transport.rs'), RT = read('engine/artlux-engine/src/runtime.rs');
    if (!/let now = a\.at \+ \(render_now\(a\.w0\) - a\.at\) \* self\.audio\.ratio;/.test(T)) problems.push("the engine's own clock no longer advances at the audio clock's rate");
    if (!/se < Self::MAX_SE/.test(T) || !/pub const MAX_SE: f64 = 2e-6;/.test(T)) problems.push('a measured audio rate is applied before the fit is certain (or the bound moved)');
    if (!/crate::audio::audio_stamp\(\)/.test(RT)) problems.push('the render thread no longer feeds the device callback stamps to the transport');
    if (!/set\(SOURCE_FILES src\/engine\.cpp\)/.test(m) || !/add_library\(artlux_audio SHARED src\/capi\.cpp\)/.test(m)) problems.push('CMakeLists no longer builds the two front doors from their own files');
    const abiC = (a.match(/artlux_audio_abi\(\) \{ return (\d+); \}/) ?? [])[1], abiR = (r.match(/Ok\(f\) if unsafe \{ f\(\) \} == (\d+)/) ?? [])[1];
    if (!abiC || abiC !== abiR) problems.push(`the C API's ABI (${abiC}) is not the one audio.rs speaks (${abiR})`);
    // E3m: every call the relay sends (audioManager.useEngineAudio: tell / ask by the addon's own names) has its case
    // in artlux_audio_call — an op without one is answered "no such call" and that feature goes silent in the engine.
    const am = read('plugins/audio/src/audioManager.ts');
    const ops = [...am.matchAll(/(?:tell|ask<[^>]*>)\('(\w+)'/g)].map((x) => x[1]);
    if (ops.length < 15) problems.push(`useEngineAudio no longer relays the addon's calls (${ops.length} found)`);
    // …except the ops the ENGINE answers itself (audio.rs ENGINE_OPS — E3p's lockClip), which never reach the library.
    const engineOps = new Set([...((r.match(/pub const ENGINE_OPS: &\[&str\] = &\[([^\]]*)\]/) ?? [])[1] ?? '').matchAll(/"(\w+)"/g)].map((x) => x[1]));
    for (const op of engineOps) if (!new RegExp(`if op == "${op}" \{`).test(r)) problems.push(`audio.rs names '${op}' as its own but serve() does not answer it`);
    for (const op of ops) if (!engineOps.has(op) && !a.includes(`op == "${op}"`)) problems.push(`the relay sends '${op}' but artlux_audio_call has no case for it`);
    // E3p: THE SOUND HELD TO THE ENGINE'S CLOCK — the driver tells each sounding clip's lock (bed → show clock, the
    // playhead's containers → scene clock), the engine reads where the clip REALLY is and seeks it at a mix sample.
    const dr = read('plugins/audio/src/plugin.renderer.ts');
    if (!/startClip\(clip, clip\.inPoint \+ tLocal, tLocal, nowMs\);\s*lockClip\(clip, clockName\);/.test(dr)) problems.push('the driver no longer tells the engine what a clip it starts is held to');
    if (!/reconcileContainer\(bed\.clips, bed\.tracks, showTime, 'show', nowMs\)/.test(dr) || (dr.match(/reconcileContainer\(\w+\.clips, \w+\.tracks, playhead, 'scene', nowMs\)/g) ?? []).length !== 2) problems.push('a container is held to the wrong clock (the bed is the show clock; the playhead\'s containers the scene clock)');
    if (!/crate::transport::clocks_at_wall\(wall\)/.test(r) || !/"op": "seekClipAt", "args": \[id, want, at\]/.test(r)) problems.push('the engine no longer holds a clip to its own clock at the mix sample it read');
    if (!/pos \+ \(double\) \(mixed - at\) \/ sampleRate/.test(read('native/audio-engine/src/core.h'))) problems.push('seekClipAt no longer lands at the mix sample the decision was made for');
    if (!/self\.transport\.publish\(\);/.test(RT)) problems.push('the render thread no longer hands its clock to the audio thread');
    if (!/if \(c\.lock\) \{ send\('lockClip'/.test(read('src/main/engineHost.ts'))) problems.push('a restarted engine is no longer told what its clips are held to');
    // E3q: THE ENGINE DECIDES THE PLAYS — with the sound in the engine the driver describes and never acts (except
    // during an offline render, when the engine's clock is not running); the engine starts, cues and stops on its own
    // clock, never plays against a parked one, and stops a clip whose lock goes.
    if (!/const nowDecides = engineDecides && !audioClient\.isOffline\(\);/.test(dr)) problems.push('the driver no longer hands the plays to the engine (or keeps them during a bake)');
    if (!/if \(decides\) \{[\s\S]{0,400}?lockClip\(clip, clockName, ok\);[\s\S]{0,400}?continue;/.test(dr)) problems.push('with the engine deciding, the driver no longer only describes each clip');
    if (!/if \(!decides\) \{ audioClient\.stopClip\(id\);/.test(dr)) problems.push('with the engine deciding, the driver still stops clips itself');
    if (!/if \(!live\.has\(id\)\) \{ audioClient\.lockClip\(id, null\);/.test(dr)) problems.push('a clip leaving both containers keeps its lock — the engine would play it on');
    if (!/"op": "playClipAt"/.test(r) || !/"op": "cueClipAt", "args": \[id, pos, s_at, g\]/.test(r)) problems.push('the engine no longer starts (or cues) the clips it decides');
    if (!/clocks_at_wall\(wall \+ 0\.05\)/.test(r)) problems.push('the engine no longer tells a parked clock from a running one — it would play against a frozen clock');
    if (!/is_some_and\(\|l\| l\.decide\)/.test(r)) problems.push('a clip the engine decides is not stopped when its lock goes');
    if (!/c\.startAt >= 0 && c\.startAt <= \(mixed - n\) \+ n \/ 2/.test(read('native/audio-engine/src/core.h'))) problems.push('a cued start is no longer fired by the mix loop at its sample');
    if (!/if \(ctx\.engineAudio\) engine\.useEngineAudio\(ctx\.engineAudio\);/.test(read('plugins/audio/src/plugin.main.ts'))) problems.push('the audio plugin no longer switches to the engine when the app asks');
    const eh = read('src/main/engineHost.ts');
    if (!/failAudio\('the engine exited'\)/.test(eh)) problems.push('an audio call pending when the engine dies would never settle');
    // E3n: a restarted engine gets its sound back — every call that CHANGES the sound is recorded for the replay.
    if (!/trackAudio\(op, args\);/.test(eh)) problems.push('audioCall no longer records the audio state a restarted engine is given');
    const reads = new Set(['getDevices', 'getMeters', 'getSpectrum', 'offlineBegin', 'offlinePull', 'offlineEnd']);
    for (const op of ops) if (!reads.has(op) && !eh.includes(`case '${op}':`)) problems.push(`the relay sends '${op}' but a restarted engine would not get it back (engineHost trackAudio)`);
    if (!/if \(status\.starts > 1\) \{ replayAudio\(\); return; \}/.test(eh)) problems.push('a restarted engine is no longer given the audio state');
    const pkg = JSON.parse(raw('package.json'));
    const win = pkg.build?.win?.extraResources ?? [];
    if (!win.some((x) => x.from === 'native/audio-engine/artlux_audio.dll' && x.to === 'engine/artlux_audio.dll')) problems.push('the Windows package no longer ships artlux_audio.dll next to the engine');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the automation lanes the native engine evaluates are exactly the ones it applies, and never under a scene fade',
  'E3d: nativeLink.engineLane names the lanes the engine samples itself (a surface\'s content opacity, an effect\'s ' +
  'speed and intensity); the document then carries the surfaces WITHOUT those values (overlay applyExcept). A path ' +
  'named there that runtime.rs does not apply would freeze at its authored value on the wall while it moves in the ' +
  'editor. And a scene fade runs AFTER the curve (it lands on it), so while one runs the engine must get the fully ' +
  'resolved surfaces — frameEngine drops lanesView when a fade is sampled.',
  () => {
    const problems = [];
    const N = 'src/renderer/engine/nativeLink.ts', R = 'engine/artlux-engine/src/runtime.rs', F = 'src/renderer/engine/frameEngine.ts';
    if (![N, R, F].every(exists)) return 'nativeLink.ts / runtime.rs / frameEngine.ts is gone';
    const m = read(N).match(/engineLane = \(path: string\): boolean => \/\^surfaces\\.\[\^\.\]\+\\.content\\.\(([a-z|]+)\)\$\//);
    if (!m) problems.push('nativeLink.engineLane changed shape — update runtime.rs load_lanes and this check');
    else for (const leaf of m[1].split('|')) if (!read(R).includes(`Some(&"${leaf}"), 4) => AutoLeaf::`)) problems.push(`runtime.rs does not apply the ${leaf} lane the app hands it`);
    const f = read(F);
    if (!/if \(fade\) lanesView = null;/.test(f)) problems.push('frameEngine no longer withholds the lanes while a scene fade runs');
    if (!/nativeLink\.frame\([^)]*lanesView[,)]/.test(f)) problems.push('frameEngine no longer passes lanesView to nativeLink');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine evaluates the light show with the app\'s own rules',
  'E3e: the engine evaluates lighting clips and colour lanes (engine light.rs, a port of lightingTake / ' +
  'lightingSequence / lightingPlayback / colorSample / colorPlayback) and checks them against the app\'s players ' +
  'every frame. Two tables are copied, not computed, and nothing else would notice them drift: which roles ' +
  'combine HIGHEST-takes-precedence across clips (lightingOverlay HTP_ROLES — a role moved between HTP and LTP ' +
  'changes which of two overlapping clips wins), and the warm / cold white the temperature colour is made of ' +
  '(fixtureSignal EMITTERS). test:light-eval-parity holds the numbers; this holds the tables.',
  () => {
    const problems = [];
    const O = 'src/renderer/services/lightingOverlay.ts', L = 'engine/artlux-engine/src/light.rs', S = 'src/renderer/services/fixtureSignal.ts';
    if (![O, L, S].every(exists)) return 'lightingOverlay.ts / light.rs / fixtureSignal.ts is gone';
    const list = (s) => [...(s ?? '').matchAll(/'(\w+)'|"(\w+)"/g)].map((m) => m[1] ?? m[2]).sort().join(',');
    const app = list((read(O).match(/HTP_ROLES[^=]*=\s*new Set<ChannelRole>\(\[([\s\S]*?)\]\)/) ?? [])[1]);
    const eng = list((read(L).match(/const HTP_ROLES: &\[&str\] = &\[([^\]]*)\]/) ?? [])[1]);
    if (!app || app !== eng) problems.push(`HTP roles differ — app [${app}], engine [${eng}]`);
    const em = (name) => { const s = read(S), i = s.indexOf(`${name}: [`); return i < 0 ? undefined : s.slice(i + name.length + 3, s.indexOf(']', i)).replace(/\s/g, ''); };
    const lt = read(L);
    const warm = (lt.match(/const WARM: Rgb = \[([\d., ]+)\]/) ?? [])[1]?.replace(/\s/g, '').replace(/\.0(?=,|$)/g, '');
    const cold = (lt.match(/const COLD: Rgb = \[([\d., ]+)\]/) ?? [])[1]?.replace(/\s/g, '').replace(/\.0(?=,|$)/g, '');
    if (!em('warmWhite') || em('warmWhite') !== warm) problems.push(`warm white differs — app ${em('warmWhite')}, engine ${warm}`);
    if (!em('coldWhite') || em('coldWhite') !== cold) problems.push(`cold white differs — app ${em('coldWhite')}, engine ${cold}`);
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a GO fades from the look as it is on stage',
  'A scene recall and a cue fade every fadeable numeric FROM a view. That view used to be the COMMITTED look, ' +
  'so a GO over a running automation lane snapped from the curve (on stage, 0.78) to the outgoing scene\'s ' +
  'authored value (0.6) for a frame and then glided back: a 98-of-255 step on the wire on every crossfade, and ' +
  'a GO landing mid-fade restarted from the committed value the same way. Found 2026-11-24 by the native ' +
  'engine\'s fade-over-lane wire test (test-fade-over-lane-wire.cjs), where the engine reproduced it exactly. ' +
  'Both GO paths now read frameEngine.onStage() (the last frame\'s look with lanes and fades applied), and ' +
  'frameEngine records it after the fade is laid over.',
  () => {
    const problems = [];
    const A = 'src/renderer/App.tsx', F = 'src/renderer/engine/frameEngine.ts';
    if (!exists(A) || !exists(F)) return 'App.tsx / frameEngine.ts is gone';
    const a = read(A), f = read(F);
    if (!a.includes('const fromView = frameEngine.onStage() ?? { surfaces, fixtures, globalBrightness };')) problems.push('the scene recall no longer fades from frameEngine.onStage()');
    if (!a.includes('const fromView: StateView = frameEngine.onStage() ?? { surfaces, fixtures, globalBrightness };')) problems.push('a cue no longer fades from frameEngine.onStage()');
    const fadeAt = f.indexOf('const v = fade.apply('), stageAt = f.indexOf('this.stage = { surfaces: effSurfaces');
    if (fadeAt < 0 || stageAt < 0 || stageAt < fadeAt) problems.push('frameEngine no longer records the stage AFTER the fade is applied');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine solves a light\'s bytes with the app\'s own tables',
  'E3f: the engine packs every light through its profile (engine lightpack.rs, a port of profilePack / ' +
  'colorEngine / frameEngine\'s precedence stack) and checks the bytes against the app\'s every frame. What is ' +
  'COPIED, not computed: the emitter table the colour fit solves against (fixtureSignal EMITTERS — one changed ' +
  'number moves every solved colour), the RGB→CMY bridge (frameEngine CMY_FROM_RGB), the fit\'s 6000-pass cap and ' +
  '1e-7 stop (a looser stop leaves 11765 of 21879 library cases a byte off — measured), and the rule that the ' +
  'solve takes the colour QUANTISED to 1/255 (colorEngine solveCached: solving the first colour to reach a cache ' +
  'bucket made the wire depend on what had played before, which no evaluator from the playhead can follow). ' +
  'test:light-pack-parity holds the numbers on the whole fixture library; this holds the tables.',
  () => {
    const problems = [];
    const S = 'src/renderer/services/fixtureSignal.ts', C = 'src/renderer/services/colorEngine.ts', F = 'src/renderer/engine/frameEngine.ts', P = 'engine/artlux-engine/src/lightpack.rs';
    if (![S, C, F, P].every(exists)) return 'fixtureSignal.ts / colorEngine.ts / frameEngine.ts / lightpack.rs is gone';
    const norm = (x) => x.replace(/\s/g, '').split(',').map(Number).join(',');
    const app = {};
    for (const m of (read(S).match(/export const EMITTERS[^=]*=\s*\{([\s\S]*?)\};/) ?? [])[1]?.matchAll(/(\w+):\s*\[([^\]]*)\]/g) ?? []) app[m[1]] = norm(m[2]);
    const eng = {};
    for (const m of read(P).matchAll(/"(\w+)" => \[([^\]]*)\]/g)) eng[m[1]] = norm(m[2]);
    const a = JSON.stringify(Object.keys(app).sort().map((k) => [k, app[k]])), e = JSON.stringify(Object.keys(eng).sort().map((k) => [k, eng[k]]));
    if (Object.keys(app).length < 10 || a !== e) problems.push(`emitter tables differ — app ${a}, engine ${e}`);
    const bridge = (read(F).match(/CMY_FROM_RGB[^=]*=\s*\{([^}]*)\}/) ?? [])[1]?.replace(/[\s']/g, '');
    const engBridge = (read(P).match(/fn cmy_from_rgb[\s\S]*?match role \{([^}]*)\}/) ?? [])[1];
    const eb = [...(engBridge ?? '').matchAll(/"(\w+)" => Some\("(\w+)"\)/g)].map((m) => `${m[1]}:${m[2]}`).join(',');
    if (!bridge || bridge.replace(/,$/, '') !== eb) problems.push(`the RGB→CMY bridge differs — app ${bridge}, engine ${eb}`);
    const c = read(C), p = read(P);
    if (!/iter < 6000;/.test(c) || !/for _ in 0\.\.6000 \{/.test(p)) problems.push('the fit\'s pass cap is not 6000 on both sides');
    if (!/if \(moved < 1e-7\) break;/.test(c) || !/if moved < 1e-7 \{ break; \}/.test(p)) problems.push('the fit\'s stop is not 1e-7 on both sides');
    if (!/solveEmitters\(colorCapability\(profile, mode\), \[q\(target\[0\]\) \/ 255, q\(target\[1\]\) \/ 255, q\(target\[2\]\) \/ 255\]\)/.test(c)) problems.push('colorEngine.solveCached no longer solves the quantised colour (the wire would depend on history)');
    if (!/jround\(v \* 255\.0\) \/ 255\.0/.test(p)) problems.push('lightpack.rs no longer solves the quantised colour');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a 3-channel fixture keeps full RGB, in the app and in the engine',
  'The RGBW mode defaults to SUBTRACT (W = min(r,g,b), taken out of r, g and b) and the inspector shows the ' +
  'White control on 4-channel fixtures only. So an RGB strip whose mode was never set had the neutral part ' +
  'of every colour moved into a W the packer then dropped: white and grey went BLACK on the wire, with no ' +
  'control to fix it. Found 2026-11-24 by the native engine\'s text wire test (both runs black, identically). ' +
  'The engine ports buildSegParams byte for byte, so both halves carry the rule.',
  () => {
    const problems = [];
    const T = 'src/renderer/gpu/ledLayout.ts', R = 'engine/artlux-engine/src/layout.rs';
    if (!exists(T) || !exists(R)) return 'ledLayout.ts / layout.rs is gone';
    if (!/f\.rgbwMode === RGBWMode\.NONE \|\| f\.channelsPerPixel === 3 \? 1 : 0/.test(read(T))) problems.push('ledLayout.buildSegParams subtracts white on a 3-channel fixture again');
    if (!/f\.channels_per_pixel\.as_f64\(\) == Some\(3\.0\)/.test(read(R))) problems.push('the engine\'s build_seg_params subtracts white on a 3-channel fixture again');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a raster reaches the native engine before the document that names it',
  'E2 text: the app draws the type and ships the picture when it changes (nativeLink → main writes a file → ' +
  'the engine reads it). The document naming a `raster` source must never arrive first, or the engine takes ' +
  'the wire showing BLACK for that surface until the picture lands — and a restarted engine must be given ' +
  'every raster again, before the document, since it knows nothing.',
  () => {
    const problems = [];
    const L = 'src/renderer/engine/nativeLink.ts', H = 'src/main/engineHost.ts';
    if (!exists(L) || !exists(H)) return 'nativeLink.ts / engineHost.ts is gone';
    const l = read(L), h = read(H);
    const ship = l.indexOf('shipRasters(surfaces, sources);'), doc = l.indexOf('nativeEngineDoc?.(');
    if (ship < 0 || doc < 0 || ship > doc) problems.push('nativeLink no longer ships rasters before it sends the document');
    if (!/for \(const r of rasterMsgs\.values\(\)\) write\(r\.msg\);[^\n]*\n\s*if \(lastDoc\)/.test(h)) problems.push('a restarted engine is no longer given the rasters before the document');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine gives a shader every uniform the app does, and holds what the app holds',
  'E2: the engine draws SHADER surfaces itself (engine shader.rs), wrapping the author\'s text the way ' +
  'plugins/shader/src/wrapper.ts does — the ONE list of what a shader gets for free is wrapper.ts UNIFORMS. ' +
  'A uniform added there and not in shader.rs would make every shader reading it fail to compile in the ' +
  'engine, and the app would quietly keep the whole show. And a surface the app\'s guard DISABLES keeps its ' +
  'last picture in the app; it used to be answered "unsupported" to the engine, whose picture then went BLACK ' +
  'where the app\'s froze (measured with the 3D view and the engine window open) — so it is sent as `hold`.',
  () => {
    const problems = [];
    const W = 'plugins/shader/src/wrapper.ts', R = 'engine/artlux-engine/src/shader.rs', D = 'plugins/shader/src/shaderDrawable.ts', RT = 'engine/artlux-engine/src/runtime.rs';
    if (![W, R, D, RT].every(exists)) return 'wrapper.ts / shader.rs / shaderDrawable.ts / runtime.rs is gone';
    const w = read(W), r = read(R);
    const names = [...w.matchAll(/\{ name: '([A-Za-z]+)'/g)].map((m) => m[1]);
    if (names.length < 10) problems.push('could not read wrapper.ts UNIFORMS');
    for (const n of names) if (!new RegExp(`\\b${n}\\b`).test(r)) problems.push(`shader.rs does not provide ${n} (wrapper.ts UNIFORMS)`);
    if (!/hold: true/.test(read(D)) || /why: 'a shader disabled/.test(read(D))) problems.push('a disabled shader is no longer sent to the engine as `hold`');
    if (!/Source::Shader\(spec\) if spec\.hold && self\.pictures\.contains_key\(sid\) => \{\}/.test(read(RT))) problems.push('runtime.rs no longer keeps a held shader\'s last picture');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'projected content lands upright, and is shadowed where the projector cannot see — in every window',
  'Found 2026-11-24 by the engine\'s 3D view, which computes projected UVs from first principles: the ' +
  'editor had been painting both projected modes UPSIDE DOWN since a156d09 (Oct) turned the authored path ' +
  'upright and left the projected V flip — anchored on "match the authored path" — behind; and on the ' +
  'WebGPU renderer it read its projector depth map upside down, so a panel\'s shadow landed mirrored about ' +
  'the projector\'s horizon and a curved screen shadowed its own lower band. Nothing threw; the venue just ' +
  'looked wrong in a way that reads like a bad calibration. The calibration-file bake always had V up.',
  () => {
    const problems = [];
    const M = 'src/renderer/components/Simulator3D/projectedMapping.ts', V = 'engine/artlux-engine/src/view3d.rs';
    const B = 'src/renderer/components/Simulator3D/projectorBake.ts', E = 'src/renderer/components/Simulator3D/engineView.tsx';
    if (![M, V, B, E].every(exists)) return 'projectedMapping.ts / view3d.rs / projectorBake.ts / engineView.tsx is gone';
    const m = read(M), v = read(V);
    if (!/vec2 artluxUv = vec2\(artluxNdc\.x \* 0\.5 \+ 0\.5, artluxNdc\.y \* 0\.5 \+ 0\.5\)/.test(m))
      problems.push('the GLSL projected UV no longer follows NDC in V — the content goes upside down on the venue');
    if (!/const uv = vec2\(ndc\.x\.mul\(0\.5\)\.add\(0\.5\), ndc\.y\.mul\(0\.5\)\.add\(0\.5\)\)/.test(m))
      problems.push('the WebGPU projected UV no longer follows NDC in V — upside down on the default renderer');
    if (!/depthNode = texture\(farDepthTexture\(\), vec2\(ndc\.x\.mul\(0\.5\)\.add\(0\.5\), float\(0\.5\)\.sub\(ndc\.y\.mul\(0\.5\)\)\)\)/.test(m))
      problems.push('the WebGPU depth lookup lost its V turn — shadows land mirrored about the projector\'s horizon');
    if (!/clip\.xy \/ clip\.w \* 0\.5 \+ 0\.5/.test(read(B)))
      problems.push('projectorBake.ts changed its projected UV — the baked file and the preview must agree');
    // The engine samples pictures whose row 0 is the TOP, so its V is the mirror of three's, on purpose.
    if (!/uv = vec2<f32>\(ndc\.x \* 0\.5 \+ 0\.5, 0\.5 - ndc\.y \* 0\.5\)/.test(v))
      problems.push('view3d.rs changed its projected UV (its pictures are top-row-first; three\'s are not)');
    // The engine window's projection preview: what each mesh wears, and the frustums.
    if (!/content: m \? engineContent\(c, m\)/.test(read(E)) || !/lines/.test(read(E)))
      problems.push('engineView.tsx no longer sends what each venue mesh wears / the projector frustums');
    if (!/Mode::Triangles \| Mode::TriangleStrip \| Mode::TriangleFan/.test(v))
      problems.push('view3d.rs no longer counts every primitive three makes a Mesh — content would land on the wrong meshes');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the floor grid scales in X and Z only',
  'Every vertex of the grid sits at y = 0.001 — a 1 mm lift, because the beams draw their ' +
  'illumination boundary AT y = 0 and a coincident line pair z-fights into a dashed mess as the ' +
  'camera moves. The grid is now SCALED to the zoom level rather than rebuilt, and a uniform scale ' +
  'would shrink that lift along with everything else: at section 0.01 it becomes 1e-5, which at ' +
  'close range is inside the depth buffer\'s own quantum, and the z-fight the lift exists to prevent ' +
  'comes straight back — visible only at small scales, which is the hardest place to catch it in ' +
  'review. The grid is FLAT, so scaling Y buys nothing; leaving it at literally 1 removes the whole ' +
  'failure mode. (The gnomon is a different object and DOES scale uniformly — correctly, since its ' +
  'Y arm must grow with the other two.)',
  () => {
    const f = 'src/renderer/components/Simulator3D/GroundGrid.tsx';
    if (!exists(f)) return `${f} is gone`;
    const src = read(f);
    const problems = [];
    if (/scale\.setScalar\(/.test(src)) problems.push('scales uniformly (setScalar) — that shrinks the 1 mm lift into a z-fight at close zoom');
    const m = src.match(/scale\.set\(([^)]*)\)/);
    if (!m) problems.push('never sets a scale — the grid has stopped being a ruler');
    else if (!/^[^,]+,\s*1\s*,/.test(m[1])) problems.push(`scale.set(${m[1].trim()}) scales Y — the middle argument must be literally 1`);
    return problems.length ? problems.join('; ') : null;
  },
);

// ── 3D: a fixture's mounting is composed in ONE place, and the gizmo never bakes it in ────────
check(
  'a mounted fixture keeps its authored trim',
  'A light is rigged on the ceiling (pointing down) or on the floor (pointing up), and that mounting ' +
  'is a base orientation composed UNDER the operator pitch/yaw/roll — so those three fields keep ' +
  'meaning the trim the operator typed rather than becoming -90 plus something. The composition order ' +
  'is authored then mount, and it is load-bearing: it is what makes a WORLD-space gizmo delta d give ' +
  "authored' = d * authored, which is exactly what the gizmo and the arrow-key nudge already compute, " +
  'so neither has to know a mount exists. But both must therefore START from the AUTHORED rotation. ' +
  'Start one of them from the effective rotation instead and the mounting is baked into the fixture ' +
  'the first time it is nudged — it would tip 90 degrees and stay there, and the field it corrupted ' +
  'is the one the operator would look at to work out why.',
  () => {
    const L = 'src/renderer/services/led3dLayout.ts';
    const N = 'src/renderer/components/Simulator3D/nudge.ts';
    const G = 'src/renderer/components/Simulator3D/FixtureGizmo.tsx';
    const problems = [];
    const lay = read(L);
    if (!/export function mountRot\(/.test(lay)) problems.push(L + ' no longer owns the mount rotation');
    if (!/export function authoredRot\(/.test(lay)) problems.push(L + ' no longer exposes the authored rotation the write-back needs');
    if (!/setFromEuler\(authoredRot\(f\)\)\.multiply\(mountRot\(f\)\)/.test(lay))
      problems.push(L + ' no longer composes effectiveRot as authored * mount — the gizmo write-back assumes that order');
    for (const f of [N, G]) {
      const src = read(f);
      if (!/authoredRot\(/.test(src)) problems.push(f + ' writes rotation back from something other than authoredRot — a mount would be baked into the fixture');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Shell: the fixture DOCK does not re-render what the inspector owns ────────────────────────
check(
  'the fixture docks hold only what exists nowhere else',
  'The Fixture Editor was seven cards, five of which were a second rendering of controls the ' +
  'kind-gated inspector already owns — so the same field could be edited in two places with only ' +
  'one of them explaining itself, and a moving head was offered a colour order and a serpentine ' +
  'toggle. It shrank to the two things that exist nowhere else: the LIBRARY (DMX profiles + LED ' +
  'templates) and WIRING & LEDMAP (the physical-order preview + the remap tools). Those two are one ' +
  'dock because the preview shows the pixel order and the ledmap changes it. This check is what ' +
  'stops the removed cards growing back: patching, colour order, channels/pixel, RGBW mode and the ' +
  'matrix shape are AUTHORED in the inspector, and a second editor for them is how they drift.',
  () => {
    const F = 'src/renderer/components/FixtureEditor.tsx';
    const src = read(F);
    for (const sym of ['export const FixtureLibrary', 'export const FixtureWiring']) {
      if (!src.includes(sym)) return `${F} no longer exports ${sym.split(' ').pop()}`;
    }
    // A WRITE to any of these is the dock authoring what the inspector owns. Reads are fine — the
    // wiring preview legitimately reads shape/serpentine/reverse to draw the picture.
    const AUTHORED = ['channelsPerPixel', 'colorOrder', 'rgbwMode', 'universe', 'startAddress', 'matrixWidth', 'matrixHeight'];
    const problems = [];
    for (const field of AUTHORED) {
      if (new RegExp(`up\\(\\s*\\{[^}]*\\b${field}\\b`).test(src) || new RegExp(`\\{\\s*${field}:`).test(src)) {
        problems.push(`${F} writes ${field} — that control belongs to the inspector`);
      }
    }
    const CTX = 'src/renderer/contexts/index.tsx';
    const ctx = read(CTX);
    if (/core\.dock\.fixtureEditor/.test(ctx))
      return `${CTX} still registers core.dock.fixtureEditor — it was replaced by fixtureLibrary + fixtureWiring`;
    // Declared in contexts/detachable.tsx since it may open in a panel window (E5/W5h); either file counts.
    if (!/id: 'core\.dock\.fixtureWiring'[^\n]*appliesTo: \['fixture\.pixel'\]/.test(ctx + read('src/renderer/contexts/detachable.tsx')))
      return 'the wiring/ledmap dock no longer declares appliesTo fixture.pixel — it would show for a moving head';
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Lighting: ONE reader of a role out of a resolved fixture ──────────────────────────────────
check(
  'roleValue and the captured-role list live only in fixtureSignal.ts',
  'The switch that reads a role out of a FixtureState existed THREE times, character-for-character: ' +
  'in the take recorder, in Store Key, and in the pose-cue engine. One question, three answers free ' +
  'to drift — the same shape fixtureKind and fixtureFootprint exist to prevent. It had ALREADY ' +
  'drifted from its own list: both copies of the captured-role list named `white`, and no copy of ' +
  'the switch had a `case \'white\'`, because a white emitter is folded into r/g/b and never reaches ' +
  'FixtureState as its own field — so every consumer silently dropped a role the list promised. The ' +
  'list and the resolver are now adjacent in fixtureSignal.ts precisely so they cannot disagree ' +
  'again, and the effect-driveable list (a DIFFERENT question) is named ROLES_GENERATABLE beside ' +
  'sampleEffect rather than looking like the same list drifting.',
  () => {
    const OWNER = 'src/renderer/services/fixtureSignal.ts';
    const owner = read(OWNER);
    if (!/export function roleValue/.test(owner)) return `${OWNER} no longer exports roleValue`;
    if (!/export const ROLES_CAPTURED/.test(owner)) return `${OWNER} no longer exports ROLES_CAPTURED`;
    // The list must be exactly what the resolver can answer — the drift this check exists for.
    const listed = (/ROLES_CAPTURED[^=]*=\s*\n?\s*\[([^\]]*)\]/.exec(owner) || [, ''])[1]
      .match(/'([a-zA-Z]+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
    const cased = (/export function roleValue[\s\S]*?\n}/.exec(owner) || [''])[0]
      .match(/case '([a-zA-Z]+)'/g)?.map((s) => s.slice(6, -1)) ?? [];
    const promisedNotResolved = listed.filter((r) => !cased.includes(r));
    if (promisedNotResolved.length)
      return `ROLES_CAPTURED promises ${promisedNotResolved.join(', ')} but roleValue cannot resolve it — every consumer would silently drop it`;
    const problems = [];
    for (const f of walk('src/renderer')) {
      if (f === OWNER) continue;
      if (/function roleValue\s*\(/.test(read(f))) problems.push(`${f} re-implements roleValue()`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Lighting: a named emitter is captured as ITSELF, never as the rendered fold ───────────────
check(
  'red/green/blue are captured from the emitters or from the fold, never from both',
  'FixtureState carries colour twice on purpose: r/g/b is the RENDERED tint (emitters summed, ' +
  'dichroic flags applied, peak-normalised) for the 3D scene, and `emit` is the raw per-channel ' +
  'value for CAPTURE. The fold cannot be taken apart again — an RGBW head at red 0.5 + white 1.0 ' +
  'renders r=1.0, so a busk recorded `red` as 1.0 and replaying it lit the wrong emitters at the ' +
  'wrong levels. So roleValue picks ONE model per fixture: `emit` when the mode names its ' +
  'emitters (absent means the fixture genuinely has no red channel), the fold when it cannot (a ' +
  'CMY head reads back through its flags, and frameEngine CMY_FROM_RGB writes it back the same ' +
  'way). Written with `??` instead of the ternary, a CW/WW fixture falls through to the tint and ' +
  'records red/green/blue AS WELL AS cold/warm white — the same colour authored twice, and a ' +
  'replay brighter than the busk. Both halves are load-bearing: drop the fold branch and the CMY ' +
  'round trip breaks (a bug this file has already shipped once); drop the emit branch and a ' +
  'tuneable-white rig records a move with no colour in it.',
  () => {
    const OWNER = 'src/renderer/services/fixtureSignal.ts';
    const owner = read(OWNER);
    if (!/emit\?: Partial<Record<ChannelRole, number>>/.test(owner))
      return `${OWNER}: FixtureState no longer carries the unfolded \`emit\` map — capture would fall back to the rendered tint`;
    if (!/\(out\.emit \?\?= \{\}\)\[c\.role\] = v;/.test(owner))
      return `${OWNER}: resolveFixture no longer records the raw emitter value beside the fold`;
    for (const [role, folded] of [['red', 'r'], ['green', 'g'], ['blue', 'b']]) {
      const wanted = new RegExp(`case '${role}': return st\\.emit \\? st\\.emit\\.${role} : st\\.${folded};`);
      if (!wanted.test(owner)) {
        return `${OWNER}: roleValue must read ${role} as \`st.emit ? st.emit.${role} : st.${folded}\` — `
          + 'a ?? fallback records the rendered tint alongside the named emitters, authoring the same colour twice';
      }
    }
    return null;
  },
);

// ── Colour: the emitter table has ONE owner, and the inverse reads it ─────────────────────────
check(
  'the emitter table is declared once, and colorEngine inverts that copy',
  'EMITTERS says what each emitter role contributes to the rendered colour. fixtureSignal reads ' +
  'the rig through it (channels in, one RGB triple out, which is what the 3D beam is drawn with) ' +
  'and colorEngine writes the rig through its INVERSE (a colour in, per-emitter values out). Those ' +
  'two must be the same numbers or the app contradicts itself in the worst possible way: the solver ' +
  'authors values that resolve back to a different colour than the one asked for, the 3D scene ' +
  'shows one thing and the wire carries another, and every round trip through a take drifts a ' +
  'little further. A copied table would be found the day someone tunes one amber and not the other.',
  () => {
    const OWNER = 'src/renderer/services/fixtureSignal.ts';
    const ENGINE = 'src/renderer/services/colorEngine.ts';
    const owner = read(OWNER);
    if (!/export const EMITTERS/.test(owner)) return `${OWNER} no longer exports EMITTERS — the inverse has nothing to read`;
    const engine = read(ENGINE);
    if (!/import \{[^}]*EMITTERS[^}]*\} from '\.\/fixtureSignal'/.test(engine))
      return `${ENGINE} no longer imports EMITTERS from fixtureSignal — it must invert the shipped table, not its own`;
    // Anyone else declaring a role→RGB table is the drift this check exists for. Matched on the
    // shape rather than the name, because a copy is rarely called EMITTERS.
    const problems = [];
    for (const f of walk('src/renderer')) {
      if (f === OWNER) continue;
      const src = read(f);
      if (/(warmWhite|coldWhite)\s*:\s*\[\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*\]/.test(src)) {
        problems.push(`${f} declares its own emitter→RGB table — import EMITTERS from fixtureSignal instead`);
      }
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Automation: the display unit is DRAWN, never STORED ───────────────────────────────────────
check(
  'a target\'s display map never reaches the clamp or the write path',
  'A profiled fixture\'s channel is STORED 0..1 — that is what lands in `Fixture.dmx` and what the ' +
  'packer treats as a fraction — but AUTHORED in degrees. `AutomationTargetDef.display` carries that ' +
  'second unit so a Pan lane reads 270 deg instead of 0.50, finally agreeing with the pose key for ' +
  'the same channel. It is a DRAWING concern only. `min`/`max` are what compileAutomation clamps ' +
  'every keyframe to before handing the value straight to provider.write(), so publishing the ' +
  'degrees range there instead would let an operator draw a curve to 540, clamp nothing, and pin the ' +
  'head at its end stop for the whole curve — which is exactly why the axis was 0..1 in the first ' +
  'place. The map may be read by the lane UI and by nothing else.',
  () => {
    const SDK = 'packages/sdk/src/renderer.ts';
    const sdk = read(SDK);
    if (!/export const toDisplay/.test(sdk) || !/export const fromDisplay/.test(sdk))
      return `${SDK} no longer exports toDisplay/fromDisplay`;
    // The engine side must never consult it.
    const ENGINE = [
      'src/renderer/services/timeline.ts',
      'src/renderer/services/automationOverlay.ts',
      'src/renderer/services/automation.ts',
      'src/renderer/engine/frameEngine.ts',
    ];
    const problems = [];
    for (const f of ENGINE) {
      if (!exists(f)) continue;
      if (/\btoDisplay\b|\bfromDisplay\b|\.display\b/.test(read(f)))
        problems.push(`${f} reads the display map — it is a drawing concern, not a stored value`);
    }
    // And the provider must still publish 0..1 storage for a profiled channel.
    const P = 'src/renderer/services/automationTargets.core.ts';
    if (!/return \{ min: 0, max: 1, step, display \}/.test(read(P)))
      return `${P} no longer publishes a profiled channel as 0..1 storage with a separate display map`;
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Lighting: a drawn pose key is a SELECTABLE pose key ──────────────────────────────────────
check(
  'a pose key drawn on a clip can be selected and edited',
  'The diamonds, the selection state, the resolver and the per-slot editor are four files deep, ' +
  'and every prop between them is OPTIONAL — so omitting one typechecks perfectly and ships an ' +
  'inert diamond. That shipped: Lane received `sequenceKeys` and drew them, but Timeline never ' +
  'passed `onSelectKey`, so clicking a key did nothing at all and the inspector never appeared. ' +
  'Found by clicking one in the running app; a green typecheck said nothing.',
  () => {
    const T = 'src/renderer/components/timeline/Timeline.tsx';
    const L = 'src/renderer/components/timeline/Lane.tsx';
    const C = 'src/renderer/components/timeline/ClipBlock.tsx';
    const I = 'src/renderer/components/timeline/LightingClipInspector.tsx';
    const t = read(T), l = read(L), c = read(C), i = read(I);
    // The chain, link by link: diamond → Lane → Timeline state → inspector.
    if (!/onSelectKey\?\.\(clip\.id,\s*k\.t[,)]/.test(c))   // (+ index, additive since multi-select)
      return `${C} no longer reports a clicked key — the diamonds are decoration`;
    if (!/onSelectKey=\{onSelectKey\}/.test(l))
      return `${L} no longer forwards onSelectKey to ClipBlock`;
    if (!/onSelectKey=\{selectKey\}/.test(t))
      return `${T} renders <Lane> without onSelectKey — a drawn key would be unclickable`;
    if (!/selectedKey=\{selectedKey\}/.test(t))
      return `${T} no longer tells the lane WHICH key is selected — no highlight, no agreement with the inspector`;
    if (!/selectedKey=\{selectedKeyObj\}/.test(t) || !/onPatchKeySlot=\{/.test(t))
      return `${T} no longer hands the selected key (or its patcher) to the clip inspector`;
    if (!/onPatchKeySlot\?\.\(i,\s*r,\s*undefined\)/.test(i))
      return `${I} can no longer REMOVE a role from a slot — removing and zeroing are different edits`;
    return null;
  },
);

// ── A scene recall restores the LOOK, never the RIG ──────────────────────────────────────────
check(
  'a scene recall never replaces the rig',
  'A Scene snapshots whole Fixture objects, so assigning scene.fixtures made a GO replace the live ' +
  'rig with the rig as it stood when the scene was stored — a head patched since simply vanished ' +
  'and the survivors reverted to the old universe/address/controller. The FSM recalls on entering ' +
  'EVERY state, including its initial one on load, so opening a project did it within seconds, ' +
  'silently. Same class as trackingZones riding the snapshot. sceneLook.ts owns the split, and it ' +
  'is an ALLOW-LIST so a new Fixture field defaults to rig — the safe side. `projectorOutputs` was ' +
  'the same bug one object over: which display a surface is bound to, its warp, its soft edge, its ' +
  'label and its CALIBRATION describe the building, not the show, and a scene carrying a frozen copy ' +
  'meant the first GO on load could revert a venue an operator had set up once. Outputs are ' +
  'project-scope; a scene neither captures nor restores them.',
  () => {
    const A = 'src/renderer/App.tsx';
    const S = 'src/renderer/services/sceneLook.ts';
    if (!exists(S)) return `${S} is gone — nothing owns the look/rig split`;
    const a = read(A);
    if (!/const nextFixtures = mergeFixtureLook\(fixtures, scene\.fixtures\)/.test(a))
      return `${A}'s recall no longer folds the scene through mergeFixtureLook`;
    // The two whole-array assignments this exists to prevent.
    if (/setFixtures\(scene\.fixtures/.test(a))
      return `${A} assigns scene.fixtures wholesale again — the rig is being replaced by a look`;
    if (/setGroups\(scene\.groups/.test(a))
      return `${A} restores scene.groups — a group made after the capture would be deleted by the next GO`;
    if (/setProjectorOutputs\(scene\.projectorOutputs/.test(a))
      return `${A} restores scene.projectorOutputs — a GO would revert display bindings, warps and calibrations the venue was set up with`;
    // …and the capture side, or scenes would quietly start carrying the rig again.
    const snap = fnBody(a, 'buildSceneSnapshot');
    if (!snap) return `${A}'s buildSceneSnapshot not found — this guard has gone blind`;
    if (!/projectorOutputs:\s*undefined/.test(snap))
      return `${A}'s buildSceneSnapshot captures projectorOutputs again — outputs are the building, not the show`;
    // Rig fields must never enter the allow-list. Each of these was observed reverting.
    const list = (read(S).match(/const FIXTURE_LOOK_KEYS = \[[\s\S]*?\] as const/) ?? [''])[0];
    if (!list) return `${S} no longer declares FIXTURE_LOOK_KEYS as one literal list`;
    const banned = ['universe', 'startAddress', 'controllerId', 'profileId', 'profileMode',
      'ledCount', 'position3D', 'rotation3D', 'colorOrder', 'channelsPerPixel', 'ledMap'];
    const leaked = banned.filter((k) => new RegExp(`'${k}'`).test(list));
    if (leaked.length) return `${S} lists rig fields as look: ${leaked.join(', ')}`;
    return null;
  },
);

// ── An output never sits in render mode with nothing to render ────────────────────────────────
check(
  'render-from-projector is decided in ONE place, and needs a venue to render',
  'Render-from-projector is not a look, it is a different SOURCE: the projector\'s base canvas ' +
  'early-returns (it is meant to be covered by calibration\'s overlay) and the frame pump stops ' +
  'streaming that window its own surface. Two sites decide halves of it — the config push picks the ' +
  'mode, the pump decides whether to feed it — so if they disagree the output is BLACK: told to draw ' +
  'its surface while being sent nothing to draw. They must ask ONE predicate. And that predicate must ' +
  'require visible venue geometry, not merely a pose: render mode draws the 3D scene, so with nothing ' +
  'in it the window draws nothing while every other path has already stood down. A project authored ' +
  'with a venue model and opened on a machine without it lands there, as did unloading a calibration ' +
  'while an output still had useCalibration on — which stayed black through a close and reopen, ' +
  'because the flag is persisted on the output and the window was only ever rebuilding it.',
  () => {
    const a = stripComments(read('src/renderer/App.tsx'));
    const problems = [];
    if (!/const rendersVenue = /.test(a)) return 'App no longer defines rendersVenue — the two halves of render mode have nothing holding them together';
    // Visible geometry, not just a pose.
    const pred = (a.match(/const rendersVenue =[\s\S]*?;\n/) ?? [''])[0];
    if (!/models\s*\?\?\s*\[\]\)\.some\(/.test(pred) || !/visible/.test(pred)) {
      problems.push('rendersVenue no longer requires visible venue geometry — a posed output with an empty 3D scene renders nothing and the projector goes black');
    }
    // Both callers must go through it rather than re-deriving the condition.
    // The declaration reads `const rendersVenue = (` — space and equals — so it does not match this,
    // and every hit is a real call site.
    const calls = (a.match(/rendersVenue\(/g) ?? []).length;
    if (calls < 2) problems.push(`rendersVenue is called ${calls} time(s) — the config push AND the frame pump must both use it`);
    if (/renderActive\s*=\s*!!\(out\?\.useCalibration/.test(a)) {
      problems.push('the frame pump re-derives render mode inline again — that second copy is exactly what makes an output black when the two disagree');
    }
    // Unload must switch outputs back, or withdrawing a map drops them into render mode with no map
    // to supersede it — the original black-after-reopen report.
    const imp = stripComments(read('plugins/calibration/src/ImportPanel.tsx'));
    if (!/setUseCalibration\([^)]*false\)/.test(imp)) {
      problems.push('ImportPanel.unload no longer returns outputs to their own warp — without it withdrawing a map leaves a black projector that survives a reopen');
    }
    // …but only an output that cannot draw the venue. Switching EVERY output off threw away the live
    // calibration on the machine that has the venue (the authoring machine, after a re-calibration).
    if (!/venue && o\.calibration\?\.poseRms != null/.test(imp)) {
      problems.push('ImportPanel.unload switches off outputs that could still render the venue — on the authoring machine that discards the live calibration');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── The calibrated render path applies the soft edge, and applies it ONCE ─────────────────────
check(
  'a calibrated output still blends, from the one shared soft-edge ramp',
  'Turning on useCalibration put the projector window in render mode, which mounts calibration\'s ' +
  'ProjectorScene as an opaque overlay ON TOP of the base GL canvas. ProjectorGL\'s soft-edge shader ' +
  'therefore never touched the picture: enabling calibration SILENTLY DISABLED BLENDING, including ' +
  'a soft edge the operator had already set by hand, and two calibrated overlapping projectors ' +
  'doubled up with a hard border. The ramp now lives in blendGlsl.ts and BOTH GPU paths interpolate ' +
  'it, so they cannot drift into two different seams — which would be a step at the overlap that ' +
  'appears only in one render mode.',
  () => {
    const G = 'src/renderer/projector/blendGlsl.ts';
    const P = 'src/renderer/projector/ProjectorGL.ts';
    const S = 'plugins/calibration/src/ProjectorScene.tsx';
    if (!exists(G)) return `${G} is gone — nothing owns the soft-edge ramp`;
    const g = read(G);
    for (const fn of ['softEdgeFeather', 'softEdgeShare', 'blendSignal']) {
      if (!new RegExp(`float ${fn}\\(`).test(g)) return `${G} no longer declares ${fn}()`;
    }
    // The exponent that made every seam a black band. Guarded as text because it is the one line
    // whose SIGN is the whole feature.
    if (!/pow\(max\(share, 0\.0\), 1\.0 \/ max\(g, 0\.1\)\)/.test(g))
      return `${G}'s blendSignal is no longer share^(1/g) — a seam is a black band again`;
    const p = read(P);
    if (!/SOFT_EDGE_GLSL/.test(p)) return `${P} no longer interpolates the shared ramp`;
    if (/float feather\(float d, float w\)/.test(p))
      return `${P} declares its own feather() again — two copies of the ramp will drift`;
    const s = read(S);
    if (!/SOFT_EDGE_GLSL/.test(s))
      return `${S} no longer interpolates the shared ramp — a calibrated output has no blend stage`;
    if (!/softEdgeShare\(suv, uSoft\)/.test(s))
      return `${S} no longer applies the soft edge in its blend pass`;
    // The blend map is indexed by PHYSICAL raster pixels, so it must not ride the distortion effect's
    // remapped uv — see the comment on blendFrag.
    if (!/gl_FragCoord\.x \/ resolution\.x/.test(s))
      return `${S} derives its blend uv from the effect's uv again — that is the DISTORTED lookup ` +
        `coordinate, not the panel pixel the blend map is indexed by`;
    return null;
  },
);

// ── A structured-light pattern is never warped ────────────────────────────────────────────────
check(
  'a calibration pattern reaches the projector unwarped, and the residual warp stays opt-in',
  'A calibrated output can now carry a RESIDUAL WARP: the operator nudges the calibrated 3D render ' +
  'with the ordinary corner-pin/Bezier handles to finish a mapping the solve got close but not exact, ' +
  'and ProjectorApp feeds the panel\'s canvas through ProjectorGL to do it. That makes one thing ' +
  'newly dangerous. If a structured-light PATTERN ever went through the same GL stage, the camera ' +
  'would photograph a warped pattern, the decode would attribute the warp to the projector\'s optics, ' +
  'and calibrateProjector would BAKE IT INTO THE INTRINSICS. The projector then calibrates ' +
  '"successfully" and is wrong, with nothing thrown and nothing logged — and every later solve ' +
  'inherits it. Patterns must keep writing their own raw 2D canvas at native raster. ' +
  'The second half guards the cost: the calib branch must stay gated on a residual-warp predicate, ' +
  'because running it unconditionally puts a full-resolution upload plus a mesh pass on EVERY ' +
  'calibrated output at all times — the exact cost the early return was written to avoid.',
  () => {
    const C = 'plugins/calibration/src/CalibProjector.tsx';
    const P = 'src/renderer/projector/ProjectorApp.tsx';
    const W = 'src/renderer/projector/warp.ts';
    const c = read(C);
    // The pattern path: its own 2D context, raw pixels, no GL.
    if (!/createImageData\(/.test(c) || !/fillPattern\(/.test(c))
      return `${C} no longer draws structured-light patterns as raw ImageData — if they now go ` +
        `through ProjectorGL, the solve will learn the residual warp and bake it into the intrinsics`;
    if (/ProjectorGL/.test(c))
      return `${C} references ProjectorGL — a calibration pattern must never reach the warp stage`;
    // The pattern canvas must stay a plain 2D canvas the panel owns, NOT something offered to the
    // host as a render source (setRenderSource is for the calibrated RENDER only).
    if (/patternCanvasRef[\s\S]{0,400}?setRenderSource/.test(c))
      return `${C} offers the pattern canvas to the host's warp stage — patterns must stay unwarped`;
    const p = read(P);
    if (!/hasResidualWarp\(/.test(p))
      return `${P}'s calibrated-render branch no longer gates on hasResidualWarp — every calibrated ` +
        `output now pays a full-resolution upload and a warp pass per frame for no visible change`;
    // The residual warp is GEOMETRY ONLY. ProjectorScene's composer has already applied the soft
    // edge, the solved blend, the colour gain and the black lift to those pixels, so handing this
    // draw the full `opts` squares the blend alpha — a dark band at every overlap that reads as a
    // mis-set blend gamma. Same hazard hwOwnsGeometry guards on the NVAPI side, one layer down.
    const calibDraw = /gl\.draw\(src,\s*\{([^}]*)\}\)/.exec(p);
    if (!calibDraw)
      return `${P}'s calibrated-render branch no longer draws the panel canvas with an explicit ` +
        `opts literal — spreading the shared opts re-applies the blend the panel already applied`;
    if (/\.\.\.opts/.test(calibDraw[1]))
      return `${P} spreads the shared opts into the calibrated warp draw — the soft edge and solved ` +
        `blend are applied TWICE (alpha squared: a dark seam at every projector overlap)`;
    if (!/softEdge:\s*NO_FEATHER/.test(calibDraw[1]))
      return `${P}'s calibrated warp draw no longer forces an identity feather — the panel's soft ` +
        `edge and this stage's would both apply`;
    const w = read(W);
    if (!/export function hasResidualWarp\(/.test(w))
      return `${W} no longer exports hasResidualWarp — the gate above has nothing to ask`;
    // It must answer for an identity BEZIER net too, not just a null one: converting a corner-pin to
    // a net without dragging anything produces a non-null identity net, and treating that as "warped"
    // silently moves the output onto the expensive path.
    if (!/IDENTITY_NET/.test(w))
      return `${W}'s hasResidualWarp no longer compares against the identity control net — a ` +
        `converted-but-untouched Bezier warp will read as a residual`;
    return null;
  },
);

check(
  'a rig blend is applied by exactly one of the GPU and the scanout',
  'NVAPI SetScanoutIntensity and the GLSL blend pass can both apply the same map. Applied twice, an ' +
  'overlap gets alpha squared — a dark band that reads exactly like a mis-set blend gamma, which is ' +
  'the hardest thing to diagnose on a wall at 2am. hwOwnsGeometry is the single predicate that ' +
  'decides, and it must neutralise the GPU feed on the same branch that neutralises the warp.',
  () => {
    const A = 'src/renderer/App.tsx';
    const a = read(A);
    if (!/blend: hwGeom \? null : \(out\?\.blend \?\? null\)/.test(a))
      return `${A} no longer withholds the blend from the GPU path when the scanout owns it`;
    if (!/outputToNvwarp\(o, display, toBlendMap\(o\.blend\)\)/.test(a))
      return `${A} stopped feeding the solved blend to NVAPI (it passed a hardcoded null for a year)`;
    return null;
  },
);

// ── An unattended recalibration can never prompt, and never trusts a low residual ─────────────
check(
  'an unattended recalibration cannot open a dialog or apply a wrong-but-tidy solve',
  'Two ways a 4am maintenance task destroys a permanent installation. (1) It raises a modal — ' +
  'handleSaveProject falls back to Save-As when there is no path, which is right for Ctrl+S and ' +
  'catastrophic for a venue machine that will then sit on a dialog until someone drives over. ' +
  'host.project.save() must REFUSE without a path. (2) It applies a solve whose numbers are ' +
  'excellent but whose world is wrong: one mis-registered marker gives a projector pose that is ' +
  'metrically superb about the wrong reference, and low RMS is no defence. The pose-jump gate is ' +
  'what catches it, so it must reject regardless of score.',
  () => {
    const A = 'src/renderer/App.tsx';
    const V = 'plugins/calibration/src/validateSolve.ts';
    const R = 'plugins/calibration/src/autoRecal.ts';
    if (!exists(V)) return `${V} is gone — nothing gates an unattended apply`;
    const a = read(A);
    // The save seam must be path-gated, and must not route through the dialog-capable handler.
    const seam = (a.match(/save: async \(\) => \{[\s\S]*?\n {6}\},/) ?? [''])[0];
    if (!seam) return `${A} no longer defines host.project.save as a guarded async function`;
    if (!/if \(!p\) return false;/.test(seam))
      return `${A}'s host.project.save no longer refuses when the project has no path — it can raise a Save dialog on a venue machine`;
    if (/handleSaveProject|handleSaveAs/.test(seam))
      return `${A}'s host.project.save routes through the dialog-capable save handler`;
    const v = read(V);
    if (!/maxPoseJumpM/.test(v) || !/implausible-pose-jump/.test(v))
      return `${V} no longer rejects an implausible pose jump — the classic confident-wrong-answer`;
    // The improvement gate must be a strict inequality against a factor, not "any improvement".
    if (!/scores\.candidate\.rmsMm < scores\.incumbent\.rmsMm \* cfg\.improveFactor/.test(v))
      return `${V} no longer requires a MARGIN of improvement — nightly noise will churn the calibration`;
    const r = read(R);
    if (!/cfg\.autoApply/.test(r))
      return `${R} no longer honours autoApply — a run could write before the thresholds are tuned`;
    if (!/calibrationPrev: previous/.test(r))
      return `${R} applies without keeping the previous calibration — show mode has NO undo and no ` +
        `crash-recovery file, so that slot is the only way back`;
    return null;
  },
);

// ── The white screen: a dead tree in a live process must stay VISIBLE to the watchdog ─────────
//
// A React render throw unmounts the whole root and leaves the process alive, responsive, and still
// turning its event loop — so four of the watchdog's five detectors are structurally blind to it and
// the fifth was gated on a heartbeat a load-path throw never produces. The result was an unattended
// install that was dead, silent, and invisible to every tier, forever: nobody drives to the venue
// because nothing ever alarmed. Each check below holds one link of the chain that fixed it. They are
// all silent failures — the app compiles and boots identically with any of them broken.

check(
  'a renderer fault reaches the watchdog',
  'Containment without REPORTING is worthless in an unattended venue: a tidy recovery card, in a ' +
  'window that is 1x1 at opacity 0, in a room with nobody in it. The reporter → preload → ipc → ' +
  'watchdog chain is what lets a white screen alarm and relaunch at all.',
  () => {
    const bad = [];
    const F = 'src/renderer/services/faultReporter.ts';
    if (!exists(F)) return `${F} is gone — nothing reports a renderer fault`;
    if (!/reportRendererFault/.test(read(F))) bad.push(`${F} no longer calls window.artlux.reportRendererFault`);
    if (!/IPC\.RENDERER_FAULT/.test(read('src/preload/index.ts'))) bad.push('preload no longer bridges RENDERER_FAULT');
    const ipc = read('src/main/ipc.ts');
    if (!/IPC\.RENDERER_FAULT/.test(ipc) || !/watchdog\.noteRendererFault\(/.test(ipc))
      bad.push('main/ipc.ts no longer feeds RENDERER_FAULT to watchdog.noteRendererFault');
    const w = read('src/main/watchdog.ts');
    if (!/export function noteRendererFault/.test(w)) bad.push('watchdog no longer exports noteRendererFault');
    // The audit must happen BEFORE the armed/crashRecovery bail-out: with the watchdog disabled (the
    // default, and every editor install) that JSONL line is the only durable record that the app
    // white-screened at all.
    const body = fnBody(w, 'noteRendererFault');
    if (body && body.indexOf('logEvent(') > body.indexOf('if (!armed'))
      bad.push('noteRendererFault audits AFTER the armed check — an unarmed install records nothing');
    return bad.length ? bad.join('; ') : null;
  },
);

check(
  'the render-stall clock is armed at document load',
  'render-stall is gated on `lastRenderAt > 0`, and that only ever came from a renderer heartbeat. ' +
  'A throw during the FIRST render — a poisoned project file, the class of bug that actually ships ' +
  '— produced no heartbeat, so the one detector that could see it was never armed. Seeding the ' +
  'clock at did-finish-load (which always fires) is what closes that hole, and it MUST be ungated ' +
  'by mode: broadcast is the entire point.',
  () => {
    const w = read('src/main/watchdog.ts');
    if (!/export function noteRendererUp/.test(w)) return 'watchdog no longer exports noteRendererUp';
    if (!/awaitingFirstBeat/.test(fnBody(w, 'healthTick') ?? ''))
      return 'healthTick no longer distinguishes the boot grace from a mid-show stall — a slow cold ' +
        'start will be relaunched into the circuit breaker';
    const idx = read('src/main/index.ts');
    const line = idx.split(/\r?\n/).find((l) => /watchdog\.noteRendererUp\(\)/.test(l));
    if (!line) return 'main/index.ts never calls watchdog.noteRendererUp() — the load-path throw is invisible again';
    if (!/did-finish-load/.test(line)) return 'noteRendererUp() is no longer wired to did-finish-load';
    if (/\bif\s*\(/.test(line) || /HEADLESS|BROADCAST/.test(line))
      return 'the noteRendererUp() wiring is gated by mode — broadcast is the mode that needs it';
    return null;
  },
);

check(
  'every renderer entry contains and reports its own faults',
  'Four separate React roots in four windows. A root with no boundary white-screens; a root with a ' +
  'boundary but no global net still misses every throw in an async effect, a rAF tick or a rejected ' +
  'promise, which is most of what this renderer actually does.',
  () => {
    const bad = [];
    for (const f of ['src/renderer/index.tsx', 'src/renderer/projector.tsx', 'src/renderer/docs.tsx',
                     'src/renderer/splash.tsx']) {
      if (!exists(f)) { bad.push(`${f} (missing)`); continue; }
      const src = read(f);
      if (!/installGlobalNet\(/.test(src)) bad.push(`${f}: no installGlobalNet()`);
      if (!/<ErrorBoundary/.test(src)) bad.push(`${f}: root is not wrapped in an ErrorBoundary`);
    }
    return bad.length ? bad.join('; ') : null;
  },
);

check(
  'a crash fallback never heartbeats',
  'THE most dangerous failure mode in the containment design: a fallback that keeps a rAF alive and ' +
  'keeps pushing reportRenderStats SUPPRESSES render-stall, so the watchdog goes blind again while ' +
  'everything feels safer. In show mode the fallback must render nothing at all — nobody is in the ' +
  'room, and main owns the recovery.',
  () => {
    const F = 'src/renderer/components/ErrorBoundary.tsx';
    const src = read(F);
    if (!/reportFault\(/.test(fnBody(src, 'componentDidCatch') ?? src))
      return `${F} catches without reporting — the watchdog cannot see it`;
    // The EARLY RETURN, not the identifier: a leftover `import { SHOW_ENGINE }` would otherwise
    // satisfy this after the guard itself had been deleted. (It did, first time out.)
    if (!/if\s*\(SHOW_ENGINE[^)]*\)\s*return null;/.test(src))
      return `${F} renders a recovery UI in broadcast/headless, where there is no operator`;
    if (/requestAnimationFrame|reportRenderStats/.test(src))
      return `${F} runs a frame loop in the fallback — that suppresses render-stall and re-blinds the watchdog`;
    return null;
  },
);

check(
  'a projector never shows a frozen frame for a dead show',
  'A projector window has its own root and its own rAF, so it outlives the main window\'s tree — by ' +
  'lying. Streamed surfaces froze on the last ImageBitmap forever and procedural ones went right on ' +
  'animating, so the room saw a plausible picture with no show behind it. Black with a caption is ' +
  'the truth.',
  () => {
    const F = 'src/renderer/projector/ProjectorApp.tsx';
    const src = read(F);
    // The COMPARISON and the blackout, not the constant: a declared-but-unread timeout reads as a
    // working detector while the projector goes right on lying.
    if (!/>\s*PRODUCER_TIMEOUT_MS/.test(src)) return `${F} no longer tests the producer-liveness timeout`;
    if (!/producerLostRef/.test(src)) return `${F} no longer edge-triggers the blackout on producer loss`;
    if (!/scope: 'producer-lost'/.test(src)) return `${F} no longer reports producer loss to the audit log`;
    if (!/lastMsgRef\.current = performance\.now\(\)/.test(src))
      return `${F} no longer stamps inbound port messages — the liveness clock has no source`;
    return null;
  },
);

check(
  'the watchdog logs a repeated refusal once, not once per second',
  'healthTick re-fires its detectors EVERY SECOND, and both refusal paths (pacing, and a tripped ' +
  'breaker) are by definition reached by faults that persist. Logging each one appends a JSONL line ' +
  'per second forever AND pushes a WATCHDOG_EVENT to Preferences + the tablet at the same rate — into ' +
  'a log that is only ever trimmed at BOOT, on an install that has stopped rebooting. Both refusals ' +
  'need a once-per-window guard.',
  () => {
    const body = fnBody(read('src/main/watchdog.ts'), 'maybeRelaunch');
    if (!body) return 'maybeRelaunch is gone';
    if (!/if \(deferTimer\) return;/.test(body))
      return 'the pacing refusal no longer logs once per window — it will flood at 1 Hz while pacing';
    // The GUARD, not the identifier — a surviving `trippedNoted = true` assignment would otherwise
    // satisfy this with the `if` around the log deleted, which is the whole bug.
    if (!/if \(!trippedNoted\)/.test(body))
      return 'the tripped-breaker refusal no longer logs once per process — a tripped install writes ' +
        '1 Hz of skipped-tripped into a log nothing will trim';
    return null;
  },
);

check(
  'window commands act on the window that sent them',
  'This handler resolved getWindow() regardless of sender, so the detached Docs window\'s close ' +
  'button closed the EDITOR. The crash-recovery ladder rides the same channel, which is not a place ' +
  'to keep a sender-blind handler.',
  () => {
    const ipc = read('src/main/ipc.ts');
    const i = ipc.indexOf('IPC.WINDOW_COMMAND');
    if (i < 0) return 'the WINDOW_COMMAND handler is gone';
    const body = ipc.slice(i, i + 600);
    return /BrowserWindow\.fromWebContents\(e\.sender\)/.test(body)
      ? null : 'WINDOW_COMMAND no longer resolves its sender — it acts on the main window whoever asked';
  },
);

check(
  'an unmeasured GPU is absent from the metrics, not zero',
  'A prom-client Gauge is exported the moment it is CONSTRUCTED, carrying the value 0. So declaring ' +
  'the GPU-timing gauges at module scope publishes artlux_gpu_compute_p99_us 0 from every machine — ' +
  'including the ones with no timestamp-query and the ones where the mapper never ran. On a Grafana ' +
  'panel that is a flat line at the bottom, which reads as "the GPU is free": the single conclusion ' +
  'this measurement exists to rule out. Shipped exactly that way first time and caught only by ' +
  'scraping a machine that had taken no measurement at all. The gauges must be created lazily, on ' +
  'the first real value, so absent means absent.',
  () => {
    const F = 'src/main/metrics.ts';
    const src = read(F);
    // A module-scope `new Gauge({ name: 'artlux_gpu_...' })` is the regression. The lazy helper
    // builds its Gauge from a `name` PARAMETER, so the literal never appears in a constructor.
    const ctor = /new Gauge\(\{[^}]*name:\s*['"]artlux_gpu_[^'"]*['"]/s;
    if (ctor.test(src))
      return `${F} constructs a GPU gauge with a literal name — it will export 0 before anything is measured`;
    if (!/setGpuGauge\s*\(/.test(src))
      return `${F} no longer routes GPU timing through the lazy setGpuGauge — check absent still means absent`;
    // And the renderer half: stats() must OMIT the fields rather than defaulting them, or main
    // receives 0 and the laziness above buys nothing.
    const pm = read('src/renderer/services/perfMonitor.ts');
    if (!/gn > 0 \?/.test(pm))
      return 'perfMonitor no longer omits the GPU fields when nothing was measured — 0 would reach main as a real reading';
    return null;
  },
);

// ── Projector occlusion: the depth pass is mounted, and it cannot be poisoned ─────────────────
check(
  'projected mapping occludes in BOTH windows, off a map nothing else can corrupt',
  'Occlusion is a shadow map rendered from the projector, and every way it breaks is silent. If the ' +
  'pass is not mounted in a window, that window alone keeps spraying content through solid geometry ' +
  '— the editor and the wall then disagree, which is unfalsifiable from a screenshot and gets blamed ' +
  'on the solve. If scene.background is left set, three paints it into the depth target and the ' +
  'projector window\'s black background unpacks as "a surface 0 m away", so EVERY fragment tests as ' +
  'occluded and all projected content simply goes dark, with no error. If the map is sampled with ' +
  'the content UV it is read V-flipped and through the texture\'s repeat/offset, so the shadows land ' +
  'on the wrong half of the venue. And LINEAR filtering averages the BYTES of two packed distances, ' +
  'which unpacks to a distance between nonsense and the far plane — a shimmering halo on every edge.',
  () => {
    const D = 'src/renderer/components/Simulator3D/projectorDepth.ts';
    if (!exists(D)) return `${D} is gone — nothing renders the projector depth map`;
    const d = read(D);
    if (!/scene\.background\s*=\s*null/.test(d))
      return `${D} no longer clears scene.background for the pass — the background is painted into ` +
        `the depth map and every fragment reads as occluded`;
    if (!/saved\.background/.test(d))
      return `${D} clears scene.background without restoring it — the viewport loses its background`;
    for (const f of ['NearestFilter'])
      if (!d.includes(f)) return `${D}'s depth target no longer uses ${f} — packed bytes would be interpolated`;
    // The pass must actually run in every window that renders projected content.
    for (const f of ['src/renderer/components/Simulator3D/Simulator3D.tsx', 'plugins/calibration/src/ProjectorScene.tsx']) {
      const src = read(f);
      if (!/<ProjectorDepthPass\s*\/>/.test(src))
        return `${f} renders projected content but does not mount <ProjectorDepthPass /> — occlusion ` +
          `is silently off in that window while the other one shadows correctly`;
    }
    // The depth lookup is its own UV, never the content one.
    const M = 'src/renderer/components/Simulator3D/projectedMapping.ts';
    const m = read(M);
    if (!/texture2D\(uProjDepth,\s*artluxDepthUv\)/.test(m))
      return `${M} no longer samples the depth map with its own NDC-derived UV — sampling it with ` +
        `artluxUv would apply the content's V flip and repeat/offset to a data texture`;
    if (!/uHasDepth/.test(m))
      return `${M} lost the uHasDepth gate — a material with no map bound would test against unit 0`;
    return null;
  },
);

check(
  'a WebGPU renderer reports its own errors',
  'WebGPU FAILS SILENTLY. Validation errors go to the device\'s `uncapturederror` event and device ' +
  'loss to `device.lost`, and neither three nor r3f surfaces either — so an illegal pass just stops ' +
  'producing pixels with a completely clean console. That cost most of a day on the projector depth ' +
  'pass: the 3D view went black, nothing threw, and bisecting from the outside ruled out five wrong ' +
  'suspects before the listeners were attached and named four real bugs in minutes.',
  () => {
    const F = 'src/renderer/components/Simulator3D/renderer3d.ts';
    const src = read(F);
    if (!/new WebGPURenderer\(/.test(src)) return null; // the swap was reverted — nothing to guard
    if (!/uncapturederror/.test(src))
      return `${F} builds a WebGPURenderer without listening for 'uncapturederror' — validation ` +
        'failures will be invisible and the symptom will be "the 3D view is black"';
    if (!/device\.lost|\.lost\.then/.test(src))
      return `${F} builds a WebGPURenderer without listening for device.lost — a lost device will ` +
        'look identical to a frozen scene';
    return null;
  },
);

check(
  'the depth packing has one set of coefficients, whatever the shading language',
  'projectorDepth owns the packing convention that the depth WRITER and the projected-UV READER ' +
  'both depend on, and its own comment is that a second copy drifts — the symptom being content ' +
  'occluding at the wrong distance, which reads as a bad calibration rather than a shader bug. Once ' +
  'one window renders GLSL and the other renders nodes the rule cannot be met literally, so the two ' +
  'expressions must at least share the constants.',
  () => {
    const F = 'src/renderer/components/Simulator3D/projectorDepth.ts';
    const src = read(F);
    if (!/DEPTH_PACK_COEFFS/.test(src)) return null; // node path removed — GLSL is the only definition
    const m = src.match(/DEPTH_PACK_COEFFS\s*=\s*\[([^\]]+)\]/);
    if (!m) return `${F} no longer declares DEPTH_PACK_COEFFS as a literal array`;
    const coeffs = m[1].split(',').map((x) => x.trim());
    // Every coefficient must still appear in the GLSL vec4, or the two halves pack differently.
    const glsl = (src.match(/vec4 artluxEnc = fract\([^;]+;/) || [''])[0];
    for (const c of coeffs) {
      if (!glsl.includes(c)) {
        return `${F}: DEPTH_PACK_COEFFS has ${c} but the GLSL packer does not — the WebGL and ` +
          'WebGPU depth maps now encode distance differently';
      }
    }
    if (!/artluxPackDepthTSL/.test(src))
      return `${F} declares DEPTH_PACK_COEFFS but has no TSL packer using them`;
    return null;
  },
);

check(
  'a material picks its shading language from the RENDERER, not from module state',
  'A NodeMaterial cannot render on a WebGLRenderer and a raw ShaderMaterial cannot render on the ' +
  'node renderer, and this app runs BOTH at once: the editor viewport can be WebGPU while the ' +
  'calibration projector window always builds its own WebGL renderer. Deciding from "are the TSL ' +
  'modules loaded" looked equivalent while they were imported inside the WebGPU factory, and stopped ' +
  'being equivalent the moment they were preloaded at module load — localStorage is shared across ' +
  'windows, so the projector window started getting node materials it cannot draw. THE PROJECTOR ' +
  'OUTPUT WENT BLACK while the editor looked perfect, which is the worst possible split.',
  () => {
    const F = 'src/renderer/components/Simulator3D/projectedMapping.ts';
    const src = read(F);
    if (!/export function makeProjectedMaterial\(\s*useNodes/.test(src)) {
      return `${F}: makeProjectedMaterial no longer takes the renderer's verdict — it must be told ` +
        'whether THIS window is a node renderer, never infer it';
    }
    // Every call site must pass something; a bare call is the regression.
    for (const f of ['src/renderer/components/Simulator3D/ModelObject.tsx',
                     'plugins/calibration/src/ProjectorScene.tsx']) {
      if (/makeProjectedMaterial\(\s*\)/.test(read(f))) {
        return `${f} calls makeProjectedMaterial() with no argument — it would silently take the ` +
          'node path in every window as soon as the WebGPU flag is set anywhere in this origin';
      }
    }
    // Beams carries the same dual-path choice and the same hazard.
    const B = read('src/renderer/components/Simulator3D/Beams.tsx');
    if (/const mods = nodes\(\);/.test(B)) {
      return 'Beams.tsx chooses its material from nodes() alone — it must gate on isWebGPURenderer(gl)';
    }
    return null;
  },
);

// ── The 3D viewport's rate cap only exists if r3f stops driving the canvas itself ────────────
check(
  'a capped 3D viewport hands its clock over instead of gaining a second one',
  'The cap works by putting the Canvas in `frameloop="never"` and letting <FrameRateCap> advance it. ' +
  'Leave frameloop at "always" and BOTH run: r3f keeps redrawing at display rate and the cap becomes a ' +
  'setting that changes nothing — no error, no warning, the viewport simply stays as expensive as it ' +
  'was while the preference claims otherwise. The measurement that would catch it is a WebGPU present ' +
  'count, which nobody takes by accident. The mirror of it is as bad: mount the driver while `paused` ' +
  'and a hidden, parked-offscreen canvas redraws at the cap rate forever.',
  () => {
    const F = 'src/renderer/components/Simulator3D/Simulator3D.tsx';
    const src = stripComments(read(F));
    const problems = [];
    const fl = src.match(/frameloop=\{([^}]*)\}/);
    if (!fl) problems.push('the Canvas no longer sets frameloop at all');
    else if (!/maxFps/.test(fl[1]) || !/'never'/.test(fl[1]))
      problems.push(`frameloop={${fl[1].trim()}} does not go to 'never' on a cap — r3f keeps its own loop and the cap is dead`);
    // The driver itself: present, gated on a cap being set AND on not being paused.
    const mount = src.match(/\{[^{}]*maxFps[^{}]*<FrameRateCap[^}]*\}/);
    if (!mount) problems.push('<FrameRateCap> is not mounted under a maxFps gate — nothing advances a capped canvas');
    else if (!/!paused/.test(mount[0]))
      problems.push('<FrameRateCap> is mounted without a !paused gate — a hidden canvas would redraw at the cap rate');
    // The driver itself lives in its own module now, SHARED with the calibrated projector's scene.
    const CAP = 'src/renderer/components/Simulator3D/FrameRateCap.tsx';
    if (!exists(CAP)) return `${CAP} is gone — nothing advances a capped canvas in either window`;
    const cap = stripComments(read(CAP));
    if (!/requestAnimationFrame/.test(cap))
      problems.push(`${CAP} no longer drives a rAF — a capped canvas would never advance`);
    if (!/advance\(/.test(cap))
      problems.push(`${CAP} never calls advance() — under frameloop='never' nothing would ever render`);
    // Both consumers must import the one implementation. A second copy is how a 30 fps cap silently
    // becomes 20 in one window and not the other (see the vsync-rounding note in that file).
    for (const f of [F, 'plugins/calibration/src/ProjectorScene.tsx']) {
      if (!/FrameRateCap/.test(read(f))) problems.push(`${f} does not use the shared FrameRateCap`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── The launch profile reaches every window, or none ──────────────────────────────────────────
check(
  'a projector window carries the same launch profile as the window that spawned it',
  'Calibration is decided ONCE per window, at load, from the URL — in the editor and in every ' +
  'projector window it opens. If main forgets the profile on one of those URLs the two disagree: an ' +
  'editor that dropped calibration spawns outputs that still load the render-from-projector panel, ' +
  'putting back the exact second venue render the profile exists to remove, or worse, a calibrated ' +
  'SHOW opens outputs that cannot render its calibration and the ' +
  'wall goes dark. Nothing throws either way. The renderer must read it from the query string too — ' +
  'plugin activation runs at module load, long before a prefs round-trip could answer.',
  () => {
    const problems = [];
    const M = 'src/main/runProfile.ts';
    if (!exists(M)) return `${M} is gone — the profile has no single source of truth`;
    const prof = stripComments(read(M));
    // Show modes are shows: their outputs ARE the calibrated ones, so they must never drop it.
    if (!/--headless/.test(prof) || !/--broadcast/.test(prof))
      problems.push(`${M} no longer forces the profile on in headless/broadcast — a show would open outputs it cannot calibrate`);

    // Every window main builds must carry it.
    const idx = stripComments(read('src/main/index.ts'));
    const proj = stripComments(read('src/main/projector.ts'));
    if (!/profileQuery\(\)/.test(proj))
      problems.push('src/main/projector.ts does not put the profile on the projector URL — its windows would disagree with the editor');
    const queries = idx.match(/const query = \{[^}]*\}/g) ?? [];
    for (const q of queries) {
      if (!/profileQuery\(\)/.test(q)) problems.push(`src/main/index.ts builds a renderer query without the profile: ${q.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
    if (!/profileQuery\(\)/.test(idx.match(/function editorQuery[\s\S]*?\n\}/)?.[0] ?? ''))
      problems.push('src/main/index.ts editorQuery() drops the profile — `--calibrate` would not reach the editor');

    // The renderer must read it from the URL, not from prefs (which answer too late).
    const R = 'src/renderer/services/runProfile.ts';
    if (!exists(R)) return `${R} is gone — the renderer cannot see the profile`;
    const rp = stripComments(read(R));
    if (!/URLSearchParams/.test(rp) || !/calibrate/.test(rp))
      problems.push(`${R} no longer reads the profile from the query string`);
    if (/getPrefs|artlux\?\./.test(rp))
      problems.push(`${R} reads prefs — plugin activation happens before IPC can answer`);

    // And the consumers that make it mean anything. The plugin host no longer gates calibration —
    // the gate moved INSIDE the plugin, because only its authoring half is expensive and gating the
    // whole thing took playback down with it (see the playback-split check). So the assertion is that
    // the AUTHORING half is still gated somewhere, not that the host is where.
    if (!/isAuthoringLaunch/.test(read('plugins/calibration/src/plugin.renderer.ts')))
      problems.push('the calibration plugin ignores the profile — wizards, camera and the render-from-projector panel would load in every plain editor launch');
    if (!/CALIBRATION_ENABLED/.test(read('src/renderer/contexts/index.tsx')))
      problems.push('src/renderer/contexts/index.tsx ignores the profile — the Calib rail entry would open an empty workbench');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── The manual flow says whether its picks can see a wrong lens ───────────────────────────────
check(
  'the manual calibration wizard qualifies its RMS with a depth-spread gauge',
  'Pose RMS answers "does the pose fit", never "is the lens right", and the manual flow is the one ' +
  'where the lens is TYPED IN from a spec sheet and can simply be wrong. PnP absorbs a wrong focal ' +
  'into a wrong distance, so with picks at one depth the two are nearly the same error. Measured ' +
  'against ground truth (projector 6 m out, 1920x1080, throw ratio 10% wrong): coplanar picks solved ' +
  'the projector 0.60 m from where it was and reported 0.22 px — deep inside the wizard\'s "ok" band. ' +
  'The operator gets a green light and a pose half a metre out, and the bake inherits it. The gauge ' +
  'flags exactly the cases the RMS misses (6% and 15% spread) and stays quiet on the ones it catches ' +
  '(46%, 107%).',
  () => {
    const L = 'plugins/calibration/src/manualLens.ts';
    const W = 'plugins/calibration/src/ManualWizard.tsx';
    const lens = stripComments(read(L));
    const wiz = stripComments(read(W));
    const problems = [];
    if (!/export function lensConstraint/.test(lens))
      return `${L} no longer exports lensConstraint — nothing measures whether the picks constrain the lens`;
    // Depth in the CAMERA frame is the axis the focal/distance ambiguity lives on; a spread measured
    // in world Z would read healthy for a projector aimed along Z at a flat wall.
    if (!/R\[6\] \* X \+ R\[7\] \* Y \+ R\[8\] \* Z \+ t\[2\]/.test(lens))
      problems.push(`${L} no longer measures depth in the camera frame — world-axis spread does not describe the ambiguity`);
    if (!/far - near\) \/ mean/.test(lens))
      problems.push(`${L} no longer normalizes the spread by distance — 0.5 m is plenty at 2 m and nothing at 20 m`);
    // The CALL, not the identifier: a substring test passed a mutation that renamed it to
    // `lensConstraintUnused`, which is exactly the shape of "imported and never used".
    if (!/\blensConstraint\(/.test(wiz))
      problems.push(`${W} never calls lensConstraint() — its RMS then silently over-promises on a flat pick set`);
    // Computed AND rendered. A gauge nobody can see is the same as no gauge, and "it is in the file"
    // is what the substring test above already failed to distinguish.
    if (!/\{lensGauge && \(/.test(wiz))
      problems.push(`${W} computes the gauge but renders nothing from it — the operator still only sees the RMS`);
    return problems.length ? problems.join('; ') : null;
  },
);

// ── An exported calibration says when it was made ─────────────────────────────────────────────
check(
  'an exported MPCDI is stamped with a real date, not a constant',
  'The date is the one field in the file that says how old a calibration is, and a baked calibration ' +
  'goes stale invisibly: the venue moves, a projector is bumped, the model is re-exported, and the ' +
  'pixels keep claiming to fit. buildMpcdi defaulted to `1970-01-01T00:00:00` and no caller ever ' +
  'passed a date, so every file ArtLux exported claimed the epoch — worse than omitting it, because a ' +
  'consumer cannot tell "unknown" from "stamped 1970". The fixed value stays REACHABLE (byte-identical ' +
  'output is what makes a round-trip test meaningful); it must not be what you get by forgetting.',
  () => {
    const F = 'src/main/mpcdi.ts';
    const src = stripComments(read(F));
    const sig = src.match(/export function buildMpcdi\([^)]*\)/);
    if (!sig) return `${F} no longer exports buildMpcdi`;
    if (/date\s*=\s*['"`]\d{4}-/.test(sig[0]))
      return `${F} defaults the MPCDI date to a constant — every exported calibration would claim the same day`;
    if (!/date\s*=\s*new Date\(\)/.test(sig[0]))
      return `${F} no longer defaults the MPCDI date to now — an unstamped calibration cannot be told from a fresh one`;
    return null;
  },
);

// ── A calibration bakes on the GPU, and something is mounted to service it ────────────────────
check(
  'the projector bake runs on its own renderer, and the export uses it',
  'The bake renders the venue from a projector pose to answer "which point does each of my pixels ' +
  'land on" — the geometry a calibration FILE is made of. It used to be serviced by a component inside ' +
  'the 3D Canvas on its next frame, on the viewport WebGPU renderer: a hidden viewport stops its frame ' +
  'loop, so a bake asked for from elsewhere timed out; and on WebGPU the pass stalled intermittently with ' +
  'nothing logged (compileAsync never settled, the async readback never resolved). It now owns a ' +
  'short-lived WebGL2 renderer: compiled inside render(), read back synchronously, context released.',
  () => {
    const F = 'src/renderer/components/Simulator3D/projectorBake.ts';
    if (!exists(F)) return `${F} is gone — exports have nothing to bake with`;
    const src = stripComments(read(F));
    const problems = [];
    if (/readRenderTargetPixelsAsync|compileAsync|useFrame/.test(src))
      problems.push(`${F} is back on the viewport renderer / frame loop — the path that timed out when hidden and stalled on WebGPU`);
    if (!/new THREE\.WebGLRenderer\(/.test(src) || !/forceContextLoss\(\)/.test(src))
      problems.push(`${F} must own a WebGLRenderer and release its context (Chromium evicts the OLDEST context past its cap)`);
    if (!/registeredCasters\(\)/.test(src))
      problems.push(`${F} no longer bakes the depth pass's caster set — two registries would drift, and the file would disagree with the preview about what occludes what`);
    // And the export must use it — and ONLY it.
    const md = stripComments(read('plugins/calibration/src/mpcdiData.ts'));
    if (!/bakeContentUv\(/.test(md))
      problems.push('mpcdiData no longer bakes on the GPU — nothing would produce geometry for an export');
    // ⚠ NO CPU FALLBACK. The raycast read a DIFFERENT registry (registerVenueMesh, visible-only) from
    // the bake (registerDepthCaster, unconditional, resolved GLB), so it was not a coarser version of
    // the same answer — it was another answer. Measured on one project minutes apart: raycast claimed
    // a 0.46 m patch at 100% coverage, bake reported the real venue at 17%. Both files parsed. A
    // fallback that silently files different geometry as a calibration is worse than a failed export.
    if (/raycastVenueBatch|cameraPixelRayWorld/.test(md))
      problems.push('mpcdiData raycasts again — that reads a different geometry registry than the bake and silently writes a file describing something else');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── An imported baked map beats the live venue render, in the window AND in its panels ────────
check(
  'a baked calibration map supersedes render-from-projector',
  'They are two answers to one question — where this projector\'s content lands on the venue — and ' +
  'the map is that answer already computed. Render mode is TWO cooperating pieces: the frame loop ' +
  'skips its own draw, and the calibration panel mounts an opaque full-window 3D scene on top. So ' +
  'the map drew underneath a scene that covered it, and an imported calibration silently never ' +
  'reached a pixel. It LOOKED right, which is why this is a guard and not a comment: the map is ' +
  'baked from that same scene, so both paths draw the same silhouette — a screenshot agreed to ' +
  '0.25% while the wrong one was on screen. Only usability may take the decision, and only for ' +
  "'render': suppressing the venue scene for a map the context cannot upload leaves a flat warp " +
  'and no calibration at all.',
  () => {
    const F = 'src/renderer/projector/ProjectorApp.tsx';
    const src = stripComments(read(F));
    const problems = [];
    if (!/applyCalibMode\s*=/.test(src))
      problems.push(`${F} has no applyCalibMode — nothing decides between the baked map and the venue render`);
    // The panels must hear the EFFECTIVE mode. If the raw 'calib' branch falls through to the generic
    // fan-out, a panel mounts the venue scene from the raw 'render' and never learns it lost.
    if (/m\.t === 'calib'\)\s*\{\s*calibRenderRef\.current\s*=/.test(src))
      problems.push("the 'calib' handler sets calibRenderRef directly — the panels then never hear the effective mode and the venue scene covers the map");
    // ⚠ Anchored to the DECISION, not to the string. `bakedRef.current?.uploaded` also appears in the
    // draw branch below, so a looser test stays green while the decision itself has been weakened to
    // the map's mere presence — which is precisely the mutation that has to fail here.
    if (!/mode === 'render' && bakedRef\.current\?\.uploaded/.test(src))
      problems.push('the supersede decision does not read `uploaded` — deciding on the map\'s presence suppresses the venue render on a machine that cannot draw the map, leaving a flat warp and no calibration');
    // ⚠ ORDER. The upload is what makes `uploaded` knowable, so it must run BEFORE the branch it
    // releases. Below it, the render branch returns first and the map is never uploaded — the exact
    // deadlock this shape is prone to.
    const up = src.indexOf('gl.setBakedMap(');
    const branch = src.indexOf('if (calibRenderRef.current)');
    if (up < 0) problems.push(`${F} never uploads a baked map`);
    else if (branch >= 0 && up > branch)
      problems.push('the baked map uploads AFTER the render-from-projector branch — that branch returns first, so the map is never uploaded and never supersedes anything');
    // The panel is the half that covers the picture; it must gate on the mode it is told.
    const cp = stripComments(read('plugins/calibration/src/CalibProjector.tsx'));
    if (!/calibMode === 'render' &&/.test(cp))
      problems.push('CalibProjector no longer gates its venue scene on calibMode === render — it would cover a baked map unconditionally');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Playing a calibration is not authoring one, and only one of them is gated ──────────────────
check(
  'calibration PLAYBACK survives a launch profile that drops the authoring half',
  'A baked .mpcdi is played by one fragment shader — no camera, no solve, no OpenCV, no second venue ' +
  'render. The expensive half is the wizards and the render-from-projector scene. Gating the whole ' +
  'plugin on --calibrate therefore took the cheap half down with the dear one, and a plain editor ' +
  'launch could not load or display a calibrated output at all — the launch you would most want it ' +
  'in, since the import IS how a show machine gets a calibrated rig without ever running a wizard. ' +
  'The seam is an early return inside the plugin, so what protects it is ORDER: anything registered ' +
  'after that return is authoring-only, and moving a playback line below it disables it silently in ' +
  'every plain launch while every test on a --calibrate machine still passes.',
  () => {
    const H = 'src/renderer/host/plugins.ts';
    const P = 'plugins/calibration/src/plugin.renderer.ts';
    const problems = [];
    const host = stripComments(read(H));
    // The host must not re-gate the whole plugin — that is the regression this replaced.
    if (/p !== calibration \|\| CALIBRATION_ENABLED|calibration.*CALIBRATION_ENABLED/.test(host))
      problems.push(`${H} gates the calibration plugin wholesale again — that disables the playback half too`);
    const src = stripComments(read(P));
    const gate = src.indexOf('if (!isAuthoringLaunch()) return;');
    if (gate < 0) { problems.push(`${P} no longer gates its authoring half — the wizards, camera and venue render would load in every plain editor launch`); return problems.join('; '); }
    // ⚠ ORDER, not presence. Both of these must be registered BEFORE the early return.
    for (const [needle, what] of [
      ['baked.pushToProjectors()', 'the push to projector windows'],
      ["ctx.contexts.extend('project'", 'the import panel’s door in Projection Outputs'],
    ]) {
      const at = src.indexOf(needle);
      if (at < 0) problems.push(`${P} no longer wires ${what}`);
      else if (at > gate) problems.push(`${what} is registered AFTER the authoring gate — it would vanish from every plain editor launch, silently`);
    }
    // The workbench's copy and the dock's copy must stay one component.
    const v = stripComments(read('plugins/calibration/src/CalibViewport.tsx'));
    if (/importMpcdi/.test(v))
      problems.push('CalibViewport has its own import flow again — two copies drift the first time one learns something');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── A contribution registers ONCE, however many times its plugin activates ─────────────────────
check(
  'list-backed contribution registries replace by id instead of appending',
  'The Map-backed registries key on something and replace by construction; the list-backed ones did ' +
  'not, and only `panels` was ever given the check. So a second register() of the same id APPENDED ' +
  'and every consumer that maps over all() mounted the contribution twice — a projector window grew ' +
  'to eighteen canvases over one session of edits. `activated` in host/plugins.ts keeps a packaged ' +
  'build to one activation, so this is a development-time fault; it is guarded anyway because it ' +
  'corrupts the INSTRUMENT. Canvas count is how you tell which render path a projector window is on, ' +
  'and a registry that silently doubles makes that measurement lie about the thing being measured. ' +
  'Context extends are the same fault one level up: browser/dock/inspector are lists of panel ids, ' +
  'and a repeated extend named the same panel twice.',
  () => {
    const F = 'src/renderer/host/registries.ts';
    const src = stripComments(read(F));
    const problems = [];
    // Anchored on the generic's `<`, not the bare name: `upsertByIdX` contains `upsertById`, and a
    // loose test passes while the helper every registry calls no longer exists.
    if (!/function upsertById</.test(src))
      problems.push(`${F} lost upsertById — the list-backed registries have nothing keeping ids unique`);
    // Every list-backed registry must go through it. A bare push into one of these is the regression.
    for (const [list, what] of [
      ['settingsSections', 'settings sections'],
      ['sceneVizzes', 'scene-viz overlays'],
      ['videoCodecs', 'video codecs'],
      ['projectorPanels', 'projector panels'],
      ['panels', 'panels'],
    ]) {
      if (new RegExp(`${list}\\.push\\(`).test(src))
        problems.push(`${what} register with a bare push — a second activation appends a duplicate instead of replacing`);
    }
    // And the same rule for a context's panel-id lists.
    const ext = src.match(/function applyExtend[\s\S]*?\n\}/)?.[0] ?? '';
    if (!ext) problems.push(`${F} has no applyExtend`);
    else for (const k of ['browser', 'dock', 'inspector']) {
      if (!new RegExp(`${k} = dedupe\\(`).test(ext))
        problems.push(`applyExtend appends to \`${k}\` without dedupe — a repeated extend names the same panel twice and the workbench builds two of it`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── A show machine boots calibrated, with nobody there to load anything ───────────────────────
check(
  'an imported calibration is remembered and restored on boot',
  'The map is venue state, so its PATH lives in prefs (per machine, never in the project - one file ' +
  'serves every show run in that room) and its ~10 MB of pixels are re-read at startup rather than ' +
  'persisted. Without the remembered path the import survived only until the process did, which is ' +
  'fine for an editor and wrong for an install: `--broadcast` renders the Stage and its outputs and ' +
  'NO editor chrome, so there is no panel to import from and no operator to click it. A baked ' +
  'calibration was therefore unreachable in the one mode that exists to run it, and the failure is ' +
  'silent - the show starts, the wall is simply wrong. Two halves, and either alone is useless: ' +
  'writing the path on import, and reading it back when the plugin activates.',
  () => {
    const problems = [];
    if (!/calibrationFile\?: string/.test(read('shared/protocol.ts')))
      problems.push('Prefs has no calibrationFile — there is nowhere to remember a venue calibration');
    // Boot-time restore must not need a dialog: nobody is there to answer one.
    const ipc = stripComments(read('src/main/ipc.ts'));
    if (!/MPCDI_IMPORT, async \(e, path\?: string\)/.test(ipc))
      problems.push('the MPCDI import handler takes no path — a show machine would have to answer a file dialog to be calibrated');
    const panel = stripComments(read('plugins/calibration/src/ImportPanel.tsx'));
    if (!/setPrefs\?\.\(\{ calibrationFile: res\.path[ ,}]/.test(panel))
      problems.push('importing no longer remembers the path — the calibration would be lost on the next start');
    // Unload forgets the extra files and the per-projector choices as well (Projection Outputs ▸
    // Calibration File ▸ Per projector): left behind, they would bring a withdrawn map back at startup.
    if (!/setPrefs\?\.\(\{ calibrationFile: '', calibrationExtraFiles: \[\], calibrationAssign: \{\} \}\)/.test(panel))
      problems.push('unloading no longer forgets the path, the extra files and the per-projector choices — the next start would silently re-load what was just withdrawn');
    const plug = stripComments(read('plugins/calibration/src/plugin.renderer.ts'));
    if (!/prefs\?\.calibrationFile\b/.test(plug) || !/prefs\?\.calibrationExtraFiles/.test(plug) || !/prefs\?\.calibrationAssign/.test(plug))
      problems.push('the plugin no longer reads back the remembered path, extra files and per-projector choices — a broadcast install would boot with the wrong calibration and nothing to say so');
    // ⚠ The restore must sit in the PLAYBACK half. Below the authoring gate it still works under
    // --broadcast (which implies it) and silently does nothing in a plain editor launch.
    const gate = plug.indexOf('if (!isAuthoringLaunch()) return;');
    const restore = plug.indexOf('calibrationFile');
    if (gate >= 0 && restore > gate)
      problems.push('the boot restore sits below the authoring gate — a plain editor launch would never reload its venue calibration');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── The baked map is read UNFILTERED, and its silhouette still gets coverage ───────────────────
check(
  'the baked map is sampled NEAREST, and its edge is antialiased by explicit taps',
  'Two failures meet on this texture. Its texels are COORDINATES: neighbours sit on opposite sides ' +
  'of a silhouette, so interpolating them samples content from halfway between two unrelated parts ' +
  'of the picture. And it is RGBA32F, which a LINEAR sampler cannot filter without ' +
  'OES_texture_float_linear — without that extension the texture is INCOMPLETE and every fetch ' +
  'returns (0,0,0,1), so alpha reads 1 everywhere, every pixel passes the hit test, and the whole ' +
  'output becomes one flat colour with nothing logged. That shipped for exactly one run here. ' +
  'Meanwhile the hit flag is binary, so the outline needs coverage from somewhere: explicit ' +
  'neighbour taps, which need no extension and cannot be silently unfilterable. MSAA is not an ' +
  'option and never was — the edge is made by a branch in a fragment shader, so every sample in a ' +
  'pixel takes the same side of it.',
  () => {
    const F = 'src/renderer/projector/ProjectorGL.ts';
    const src = read(F);
    const problems = [];
    const setter = src.match(/setBakedMap\([\s\S]*?\n  \}/)?.[0] ?? '';
    if (!setter) problems.push(`${F} has no setBakedMap`);
    else {
      if (!/TEXTURE_MIN_FILTER, gl\.NEAREST/.test(setter) || !/TEXTURE_MAG_FILTER, gl\.NEAREST/.test(setter))
        problems.push('the baked map is no longer NEAREST — a filtered uv interpolates across silhouettes, and RGBA32F may not be filterable at all');
      if (!/packed\[i \+ 1\] = sv \/ n/.test(setter))
        problems.push('setBakedMap no longer dilates uv into the fringe — antialiased edge pixels would sample the content’s (0,0) corner');
    }
    // Coverage is MEASURED at bake time by supersampling — the only stage that holds real geometry.
    // A distance field or a blur derived from the finished binary mask cannot recover where inside a
    // pixel the edge fell, because that information was never sampled.
    const bake = stripComments(read('src/renderer/components/Simulator3D/projectorBake.ts'));
    if (!/const SS = [2-9]/.test(bake))
      problems.push('the bake no longer supersamples — the silhouette goes back to a binary hit flag and no downstream filter can recover sub-pixel coverage');
    if (!/out\[d \+ 2\] = n \* inv/.test(bake))
      problems.push('the bake no longer writes coverage into the spare channel — the projector would fall back to blurring a binary mask forever');
    const frag = src.match(/const FRAG_BAKED = `[\s\S]*?`;/)?.[0] ?? '';
    if (!frag) problems.push(`${F} has no FRAG_BAKED`);
    else {
      // Coverage must come from a NEIGHBOURHOOD. One tap is the binary edge again.
      const taps = (frag.match(/texture2D\(uMap,/g) ?? []).length;
      if (taps < 5)
        problems.push(`FRAG_BAKED reads the map ${taps}x — coverage needs a neighbourhood, and one tap is the binary silhouette that stair-cased every slanted edge`);
      if (!/gl_FragColor = vec4\(c\.rgb \* cov, 1\.0\)/.test(frag))
        problems.push('FRAG_BAKED no longer applies coverage to the output — the edge would be binary again');
      if (/sampler2D uMapLin|LINEAR/.test(frag))
        problems.push('FRAG_BAKED reintroduces a LINEAR read of the map — that needs OES_texture_float_linear, and without it every fetch returns alpha 1 and the output goes flat');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Content is minified onto a venue, so it is mipped — through ONE upload door ────────────────
check(
  'projector content uploads through one path that keeps its mip chain complete',
  'Content mapped onto a venue is almost always MINIFIED — a 1080p clip landing on a few hundred ' +
  'projector pixels of an object — and bilinear samples one 2x2 of a footprint covering dozens of ' +
  'texels. What it misses beats against the sampling grid and CRAWLS as the video plays, which on a ' +
  'large projection is a show stopper in a way a static jagged edge is not. ⚠ The improvement is ' +
  'NOT measured: an A/B against a PLAYING video compared different frames, and the same build ' +
  'measured 1.0 and 5.8 on two runs, so content dominates that metric entirely. A clean number ' +
  'needs the transport paused at a fixed playhead. THE TRAP is that MIN_FILTER is now LINEAR_MIPMAP_LINEAR, so a ' +
  'texture whose base level is replaced without regenerating the chain is INCOMPLETE and samples as ' +
  '(0,0,0,1) — an upload site that forgets it does not look slightly wrong, that output goes BLACK. ' +
  'There are two draw paths (mesh warp and baked map) and both fill the same texture, so the upload ' +
  'lives behind one method rather than being repeated.',
  () => {
    const F = 'src/renderer/projector/ProjectorGL.ts';
    const src = stripComments(read(F));
    const problems = [];
    if (!/private uploadContent\(/.test(src))
      problems.push(`${F} has no uploadContent — the two draw paths would each have to remember to regenerate the mip chain`);
    if (!/generateMipmap\(gl\.TEXTURE_2D\)/.test(src))
      problems.push('nothing regenerates the content mip chain — with a mipmap MIN_FILTER the texture is incomplete and the output goes black');
    // Exactly one place may fill THE CONTENT texture, and it must regenerate the chain.
    //
    // Resolved per call site by the texture last bound before it, rather than by counting uploads in
    // the file: the aid overlay legitimately fills a SECOND texture here, and that one is deliberately
    // unmipped (LINEAR), so a flat count would have to be either wrong or disabled. Attributing each
    // fill to its texture keeps the check pointed at the actual hazard — an incomplete `this.tex`.
    let contentFills = 0;
    for (const m of src.matchAll(/texImage2D\(gl\.TEXTURE_2D, 0, gl\.RGBA, gl\.RGBA, gl\.UNSIGNED_BYTE, \w+\)/g)) {
      const bound = [...src.slice(0, m.index).matchAll(/bindTexture\(gl\.TEXTURE_2D, ([\w.]+)\)/g)].pop();
      if (bound?.[1] !== 'this.tex') continue; // another texture, another lifetime, its own filter
      contentFills++;
      if (!/generateMipmap\(gl\.TEXTURE_2D\)/.test(src.slice(m.index, m.index + 400)))
        problems.push('a fill of the content texture does not regenerate the mip chain — that texture is incomplete and the output goes BLACK');
    }
    if (contentFills !== 1)
      problems.push(`the content texture is filled from ${contentFills} places, not 1 — every one of them must regenerate the mip chain, and the one that forgets renders black`);
    if (!/LINEAR_MIPMAP_LINEAR/.test(src))
      problems.push('the content texture is no longer mipped — minified content aliases and crawls as it plays');
    // WebGL1 cannot mip NPOT: mipping there would make the texture incomplete instead of prettier.
    if (!/this\.canMip = !!this\.gl2/.test(src))
      problems.push('mipping is no longer gated on WebGL2 — a WebGL1 fallback cannot mip a non-power-of-two texture and would render black');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── A warped alignment aid must bend with the picture, and must never be the only copy ─────────────
check(
  'the warped alignment aid shares the content geometry and outlives its own failure',
  'An aid is a measuring instrument, and both ways this can break are silent on the machine that ' +
  'built it. (1) IF THE OVERLAY BUILDS ITS OWN GEOMETRY it can bend differently from the content — ' +
  'and a grid that is 4 px off the picture it claims to describe is worse than no grid, because an ' +
  'operator on a ladder will trust it and chase the difference with a lens. One buffer, one cache, ' +
  'one bindGeometry, so the two cannot drift. (2) IF THE DOM COPY IS HIDDEN ON THE INTENT rather ' +
  'than on the texture actually being resident, a rasterisation that fails — an SVG the browser ' +
  'declines to decode, no GL context yet — takes the aid off the wall completely and leaves the ' +
  'operator with nothing, mid-alignment, in a dark venue. `aidWarped` is set only after ' +
  'setOverlay(); `aid.warp` is the request, not the answer. The overlay pass also stays photometric ' +
  'identity on purpose: an aid feathered by the soft edge dims to nothing exactly in the overlap ' +
  'where two of them have to be compared.',
  () => {
    const GL = 'src/renderer/projector/ProjectorGL.ts';
    const APP = 'src/renderer/projector/ProjectorApp.tsx';
    const gl = stripComments(read(GL));
    const app = stripComments(read(APP));
    const problems = [];

    // (1) One geometry for both passes.
    if (!/private bindGeometry\(/.test(gl))
      problems.push(`${GL} has no bindGeometry — the content pass and the aid overlay would each build their own mesh and could bend differently`);
    if (/private drawOverlay\(/.test(gl)) {
      const body = gl.slice(gl.indexOf('private drawOverlay('));
      const end = body.indexOf('\n  }');
      const fn = end > 0 ? body.slice(0, end) : body;
      if (!/this\.bindGeometry\(/.test(fn))
        problems.push('the aid overlay does not draw through bindGeometry — it can bend differently from the picture it is measuring');
      if (/uSoft|uGamma|uBrightness|uColorGain|uBlackLift/.test(fn))
        problems.push('the aid overlay applies a photometric stage — feathering an aid dims it to nothing in the overlap, which is the one place two of them are compared');
    }

    // (2) The DOM aid comes off the wall only once the texture is up.
    if (!/offscreenSvg=\{aidWarped\}/.test(app))
      problems.push(`${APP} hides the DOM aid on something other than aidWarped — a failed rasterisation would leave no aid on the wall at all`);
    if (!/setOverlay\(img\)[\s\S]{0,200}?setAidWarped\(true\)/.test(app))
      problems.push('aidWarped is set without the texture having been uploaded first — the aid can blink out between the two');
    if (!/overlay: aidWarpedRef\.current/.test(app))
      problems.push('the draw no longer gates the overlay pass on aidWarpedRef — the DOM copy and the GL copy can both be on the wall at once');

    return problems.length ? problems.join('; ') : null;
  },
);

// ── A relaunch must not inherit a dev-server URL whose server its own exit kills ───────────────
check(
  'window builders read the renderer URL through runProfile',
  'In dev the app is a child of `electron-vite dev`, which exports ELECTRON_RENDERER_URL. Every ' +
  'relaunch does `app.relaunch(); app.exit(0)`, app.relaunch hands the successor THIS process\'s ' +
  'environment, and the exit(0) is exactly what makes electron-vite tear that dev server down. A ' +
  'builder reading the env var directly therefore points the successor at a dead port for the rest ' +
  'of its life. Nothing throws: main boots, argv is right, metrics answer mode="broadcast" — and ' +
  'the renderer never paints, so no projector output is ever opened and "Launch in Broadcast Mode" ' +
  'silently does nothing while the invisible process holds the ports. rendererDevUrl() is the one ' +
  'sanctioned reader.',
  () => {
    const bad = [];
    for (const f of walk('src/main').concat(walk('plugins'))) {
      if (f === 'src/main/runProfile.ts') continue; // the arbiter itself
      if (read(f).includes("ELECTRON_RENDERER_URL")) bad.push(f);
    }
    return bad.length ? `reads ELECTRON_RENDERER_URL directly instead of runProfile.rendererDevUrl(): ${bad.join(', ')}` : null;
  },
);

check(
  'every relaunch site builds argv with relaunchArgs()',
  'Four sites relaunch the app (broadcast, calibration profile, watchdog self-heal, playlist ' +
  'switch) and each used to hand-roll `app.isPackaged ? [] : [app.getAppPath()]`, every one ' +
  'commented "mirror the proven relaunch pattern". They must also carry --built-renderer so the ' +
  'successor does not chase the dev server this exit killed — and a hand-rolled copy is precisely ' +
  'the one that will not, in the mode where nobody is watching.',
  () => {
    const bad = [];
    for (const f of walk('src/main').concat(walk('plugins'))) {
      if (f === 'src/main/runProfile.ts') continue; // where relaunchArgs() legitimately builds it
      const src = read(f);
      if (!src.includes('app.relaunch(')) continue;
      if (/app\.isPackaged\s*\?\s*\[\]\s*:\s*\[\s*app\.getAppPath\(\)/.test(src) || !src.includes('relaunchArgs('))
        bad.push(f);
    }
    return bad.length ? `relaunches with hand-rolled argv instead of runProfile.relaunchArgs(): ${bad.join(', ')}` : null;
  },
);

check(
  'a show-mode window reports a failed renderer load',
  'ready-to-show and did-finish-load BOTH stay silent when the load itself fails, and the watchdog ' +
  'arms on did-finish-load — so a renderer that never arrives leaves broadcast/headless alive with ' +
  'no window, no output, no log line and nothing armed to notice, holding the metrics port, the ' +
  'Art-Net socket and the audio device. That is the same "process alive, nothing on screen" state ' +
  'the three reveal paths exist to prevent, reached from the other side.',
  () => {
    const src = read('src/main/index.ts');
    const problems = [];
    if (!src.includes("'did-fail-load'")) problems.push('main window has no did-fail-load handler');
    else {
      if (!src.includes('isMainFrame')) problems.push('did-fail-load does not filter subframes, so a subframe 404 would read as a boot failure');
      if (!/code\s*===\s*-3/.test(src)) problems.push('did-fail-load does not ignore ERR_ABORTED (-3), so a superseded navigation would read as a failure');
      if (!/app\.exit\(1\)/.test(src)) problems.push('a failed load in a show mode does not exit non-zero — it would linger invisibly holding ports');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── A runtime path that escapes out/ must have a packaged counterpart ─────────────────────────
check(
  'main-process asset paths survive packaging',
  'electron-builder packs `files: ["out/**/*"]`, so ONLY out/ is inside the asar. A ' +
  '`join(__dirname, "../../x")` therefore resolves in dev and never in a shipped build. The tray ' +
  'icon did exactly this — `../../build/icon.png`, which is where the INSTALLER\'s icon sources ' +
  'live, not the app\'s — and `new Tray()` is wrapped in a try/catch, so packaged broadcast logged ' +
  'one line and ran on with no tray: in the single mode that has no window and no menu, which left ' +
  'Ctrl+Shift+Q as the operator\'s only way to quit a live show. Escape out/ only alongside a ' +
  'process.resourcesPath branch (how every native addon and the docs/fixture-library do it).',
  () => {
    const bad = [];
    for (const f of walk('src/main')) {
      const src = read(f);
      const escapes = src.match(/join\(__dirname,\s*'\.\.\/\.\.\/[^']*'/g);
      if (!escapes) continue;
      if (src.includes('process.resourcesPath')) continue; // has the packaged branch
      bad.push(`${f} (${escapes.join(', ')})`);
    }
    return bad.length ? `runtime path escapes out/ with no process.resourcesPath fallback: ${bad.join('; ')}` : null;
  },
);

// ── A build-time download goes through the one downloader that can tell it failed ─────────────
check(
  'build scripts download through scripts/lib/download.cjs',
  'A hand-rolled `res.pipe(file)` settles its promise on four events — finish, file error, request ' +
  'error, bad status — and a response that stops WITHOUT ending hits none of them. `.pipe()` calls ' +
  'file.end() only on the source\'s "end", so a dropped body leaves the promise unsettled; since ' +
  'await keeps nothing alive, the loop drains and node exits **0** having written no file and said ' +
  'nothing. That is not theory: it killed the v0.25.2 build on 2026-08-07, where fetch-redist ' +
  'printed "downloading…" and the NEXT script\'s output followed it, because `&&` saw success. ' +
  'Only verify:resources stood between that and a Windows installer with no VC++ runtime, which ' +
  'would have made all six .node addons fail to require() on a fresh venue PC — silently, since ' +
  'every one of them degrades gracefully. All three fetch scripts had their own copy of the bug. ' +
  'download.cjs uses stream.pipeline(), which is the thing that detects premature close, plus a ' +
  '.part file, a size check and retries. Do not open a fourth copy.',
  () => {
    // walk() yields .ts/.tsx only — build scripts are .cjs, so this enumerates them itself. Written
    // the other way first, this check inspected ZERO files and reported success, which is the exact
    // trap braceBody()'s header describes: not finding the thing you guard is a failure, not a pass.
    const files = [];
    const collect = (dir) => {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) return;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = path.posix.join(dir, e.name);
        if (e.isDirectory()) collect(rel);
        else if (/\.(cjs|mjs|js)$/.test(e.name)) files.push(rel);
      }
    };
    collect('scripts');
    if (files.length < 10) return `expected to scan the build scripts, found ${files.length} — this check is not looking at anything`;

    const bad = [];
    for (const f of files) {
      if (f.endsWith('scripts/lib/download.cjs')) continue; // the one implementation
      const src = read(f);
      // The pairing is what makes it a download: a CDP harness opens http.get and never saves a body.
      if (!src.includes('createWriteStream')) continue;
      if (/https?\.get\(|https?\.request\(/.test(src)) bad.push(f);
    }
    return bad.length ? `writes a network response to disk without lib/download.cjs: ${bad.join(', ')}` : null;
  },
);

// ── a plugin content type must be CLASSIFIED for projector windows ───────────────────────────
check(
  'every plugin content type is renderable in a projector window',
  'ProjectorApp classifies content into SELF_RENDER (drawn locally) and STREAMED (ImageBitmaps ' +
  'pushed from the main window). A type in NEITHER set renders NOTHING — a black output, in the one ' +
  'mode with no operator watching, while the stage and the fixtures look perfectly correct. SLICE ' +
  'shipped that way once; SHADER did it again the day it was added. The third legitimate path is a ' +
  'projector CHANNEL with renderSource (how MEDIAPIPE and AUGMENTA draw themselves), so a plugin ' +
  'that registers one for its own type is covered too.',
  () => {
    const projSrc = read('src/renderer/projector/ProjectorApp.tsx');
    const setLiterals = (name) => {
      const m = projSrc.match(new RegExp(`${name}\\s*=\\s*new Set<string>\\(\\[([^\\]]*)\\]`));
      if (!m) return null; // the set itself vanished — a problem, not an empty answer
      return new Set([...m[1].matchAll(/'([^']+)'|SourceType\.(\w+)/g)].map((x) => x[1] ?? x[2]));
    };
    const self = setLiterals('SELF_RENDER');
    const streamed = setLiterals('STREAMED');
    if (!self || !streamed) return 'ProjectorApp no longer declares SELF_RENDER / STREAMED as Set<string> literals';

    const bad = [];
    for (const f of walk('plugins')) {
      const src = read(f);
      // The registration call, not the string: a type name in a comment or a type alias must not
      // satisfy this, and a plugin that stopped registering content must stop being asked about.
      const reg = [...src.matchAll(/contentSources\.register\(\s*\{\s*type:\s*'([^']+)'/g)].map((m) => m[1]);
      if (!reg.length) continue;
      const drawsItself = /projectorChannels\.register\(/.test(src) && /renderSource\s*:/.test(src);
      for (const t of reg) {
        // SourceType.X members are matched by their member NAME above, which is also the string value
        // for every core type — they are declared as `X = 'X'`.
        if (self.has(t) || streamed.has(t) || drawsItself) continue;
        bad.push(`${t} (${f})`);
      }
    }
    return bad.length
      ? `content type(s) in neither SELF_RENDER nor STREAMED, and with no projector renderSource — a projector output for one of these is BLACK: ${bad.join(', ')}`
      : null;
  },
);

check(
  'the node canvas keeps React Flow\'s own nodes in state',
  'React Flow MEASURES every node and writes the size back through onNodesChange. Rebuild the node ' +
  'array from our graph on each render and that measurement is discarded — and a node with no ' +
  'measured size is rendered `visibility: hidden`. The canvas then looks EMPTY while the footer ' +
  'correctly reports "14 nodes", every port answers hit-tests, and nothing throws: a panel that is ' +
  'working perfectly and showing nothing. So the React Flow node array must live in state that ' +
  'applyNodeChanges writes into, with our graph reconciled INTO it rather than replacing it.',
  () => {
    const f = 'plugins/shader/src/ShaderNodePanel.tsx';
    const src = read(f);
    if (!/<ReactFlow/.test(src)) return null; // the panel stopped using React Flow — nothing to protect
    if (/const\s+rfNodes[^=]*=\s*useMemo/.test(src)) {
      return `${f} derives rfNodes with useMemo — React Flow's measurements are thrown away and every node renders invisible`;
    }
    if (!/setRfNodes\(\s*\(\s*\w+\s*\)\s*=>\s*applyNodeChanges\(/.test(src)) {
      return `${f} does not feed applyNodeChanges back into rfNodes state — dimension changes are dropped and nodes render invisible`;
    }
    return null;
  },
);

// ── A USB DMX widget that dies must be RETRIED, and its death must be visible ─────────────────
check(
  'a failed USB DMX port recovers and is reported',
  'A write failure used to park the port at alive=false for the life of the process, and nothing ' +
  'ever called outputManager.close() to clear it — so a one-frame USB glitch took the moving ' +
  'lights out for the WHOLE show, recoverable only by relaunching. It was invisible too: Art-Net ' +
  'kept running perfectly and artlux_output_universes still counted the dead widget. Measured ' +
  '2026-09-01 by unplugging a DMX USB Pro mid-show: Art-Net held 60 pkt/s, DMX never came back.',
  () => {
    const f = 'native/output-engine/src/serial.rs';
    if (!exists(f)) return `${f} is missing`;
    const src = read(f);
    const bad = [];
    // The RETRY. spawn_writer must be reachable from more than the first-ever open, on a backoff.
    if (!src.includes('RETRY_INTERVAL')) bad.push('no RETRY_INTERVAL backoff — a dead port is never re-opened');
    if ((src.match(/spawn_writer\(/g) || []).length < 3) {
      bad.push('spawn_writer() is not called from a retry path (definition + first open only)');
    }
    // The REPORT. Counting live/down writers is what tells a lit rig from an unplugged interface.
    if (!src.includes('pub fn status(')) bad.push('SerialPorts::status() is gone — writer health is unreportable');
    // Since E1c the send thread lives in core.rs (shared with the native engine) and lib.rs is the Node
    // front door: the health is READ in the core and must still REACH the addon's Stats.
    const lib = 'native/output-engine/src/lib.rs';
    const core = 'native/output-engine/src/core.rs';
    if (!exists(lib)) return `${lib} is missing`;
    if (!exists(core)) return `${core} is missing`;
    const libsrc = read(lib), coresrc = read(core);
    if (!libsrc.includes('serial_down')) bad.push(`${lib} does not carry serial_down into Stats`);
    if (!coresrc.includes('serial_down')) bad.push(`${core} does not keep serial_down in its stats`);
    if (!coresrc.includes('serial_ports.status()')) bad.push(`${core} never reads serial writer health into stats`);
    // And it has to survive the trip to Prometheus, or the alert nobody can write is the alert
    // nobody has: this is the ONLY series that separates a dead widget from a live one.
    const met = 'src/main/metrics.ts';
    if (!exists(met)) return `${met} is missing`;
    if (!read(met).includes('artlux_output_serial_down')) {
      bad.push(`${met} does not export artlux_output_serial_down`);
    }
    return bad.length ? bad.join('; ') : null;
  },
);

// ── TIMELINE: releasing a layer's content source must clear the per-pool memo ──────────────────
check(
  'contentSource.release(layerKey(...)) clears the pool memo',
  'contentSource is keyed `layer:<id>` GLOBALLY while the "do I already hold this?" memo ' +
  '(lv.content / lv.contentClipId) is PER POOL. Release one without the other and ' +
  'syncContentLayer\'s guard reads "already acquired" forever: the layer never re-acquires and ' +
  'draws NOTHING for the rest of the session. That is the image-on-a-track going black once a ' +
  'show cycles back to its state — the clip id AND clip.content both survive a swap identically ' +
  '(normalizeTimeline shallow-copies a clip), so the guard is true and the acquire never happens.',
  () => {
    const f = 'src/renderer/services/timeline.ts';
    if (!exists(f)) return `${f} is missing`;
    const src = read(f);
    if (!src.includes('function forgetLayerContent(')) {
      return 'forgetLayerContent() is gone — nothing clears the per-pool memo on release';
    }
    // `read` strips comments, so a line index here is NOT the file's line number — report the code.
    const lines = src.split('\n');
    const bad = [];
    lines.forEach((line, i) => {
      if (!/contentSource\.release\(layerKey\(/.test(line)) return;
      // releaseContent() IS the paired form: it holds the one `lv` in hand and clears its memo on
      // the very next line. Every OTHER site frees a GLOBAL key with no lv in scope, so it has to
      // say forgetLayerContent() on the same line.
      if (lines.slice(Math.max(0, i - 3), i + 1).join('\n').includes('function releaseContent')) return;
      if (!line.includes("forgetLayerContent(")) bad.push("`" + line.trim().slice(0, 100) + "`");
    });
    return bad.length ? `releases a layer content key without forgetLayerContent(): ${bad.join(', ')}` : null;
  },
);

// ── A DRAWABLE'S SIZE MUST BE READABLE FROM A VideoFrame ──────────────────────────────────────
check(
  'drawable sizing understands VideoFrame (displayWidth/displayHeight)',
  'CanvasImageSource is a union with three spellings of "how big are you", and the mp4 codec hands ' +
  'back a live VideoFrame — which has NONE of videoWidth / naturalWidth / width, only displayWidth. ' +
  'Miss it and every measurement of an mp4 layer silently returns 0: captureCodecHold bails on its ' +
  '`w > 0` guard so the boundary hold is never captured, and every clip cut goes BLACK on every ' +
  'output anyway. Measured: 18 codec-no-frame-and-no-hold runs in 40 s, one per cut, with the hold ' +
  'code present and correct and doing nothing. Nothing throws and nothing logs.',
  () => {
    const bad = [];
    for (const f of ['src/renderer/services/timeline.ts', 'src/renderer/services/surfaceMedia.ts']) {
      if (!exists(f)) { bad.push(`${f} is missing`); continue; }
      const src = read(f);
      // The union probes are exactly the ones that also reach for `naturalWidth`. A direct
      // `el.videoWidth` on a real HTMLVideoElement (captureHold) is NOT one, and a type annotation
      // is not a probe -- flagging either would make this fire forever and get skimmed past.
      for (const line of src.split('\n')) {
        if (!/naturalWidth/.test(line) || /\?: number/.test(line)) continue;
        if (!/displayWidth/.test(line)) bad.push(f + ': ' + line.trim().slice(0, 80));
      }
    }
    return bad.length ? `size probe cannot measure a VideoFrame: ${bad.join(' | ')}` : null;
  },
);

// ── A HIDDEN TRIGGER ZONE MUST NOT SWALLOW THE POINTER ────────────────────────────────────────
check(
  'the zone map hit-tests only zones the current scene listens to',
  'The Trigger Zones map creates a zone by dragging on space no zone occupies, so the hit-test is ' +
  'the ONLY thing standing between the operator and a dead end: a zone drawn large enough to cover ' +
  'the surface (an entrance zone spanning a whole floor is normal, and the venue rig had one) means ' +
  'every pointerdown resolves to a `move` drag and the `draw` branch is UNREACHABLE. There is then ' +
  'no gesture left anywhere in the panel that can add a zone. Nothing throws, nothing logs, and the ' +
  'hint text still advertises the gesture that cannot happen. Filtering on isLive() is what makes ' +
  'the eye toggle the way out — hide the zone on top, draw underneath, switch it back on — so if ' +
  'either the body test or the corner-handle test drops that filter, the dead end is back. The ' +
  'corner test matters as much as the body one: the paint loop draws handles only for a live zone, ' +
  'so an unfiltered cornerAnchor is four INVISIBLE 9px holes in the drawable area.',
  () => {
    const f = 'plugins/lidar-tracking/src/ZonePanel.tsx';
    if (!exists(f)) return `${f} is missing`;
    const src = read(f);
    const bad = [];
    // The body test. `read` strips comments, so these are real code lines.
    const zoneAt = src.split('\n').find((l) => l.includes('[...list].reverse().find('));
    if (!zoneAt) bad.push('zoneAt() no longer reads as `[...list].reverse().find(` — re-check it by hand');
    else if (!/isLive\(/.test(zoneAt)) bad.push('zoneAt() hit-tests every zone, ignoring the eye');
    // The corner test, gated at its ONE call site rather than inside cornerAnchor (which is also the
    // shape a future second caller would copy).
    const anchor = src.split('\n').find((l) => l.includes('cornerAnchor(sel,'));
    if (!anchor) bad.push('the cornerAnchor(sel, ...) call site is gone — re-check the handle gate by hand');
    else if (!/isLive\(/.test(anchor)) bad.push('corner handles grab on a zone the scene ignores, which the map does not draw');
    return bad.length ? bad.join('; ') : null;
  },
);

// ── THE ENGINE NEVER OPENS A DEVICE NOBODY ASKED FOR ──────────────────────────────────────────
check(
  'Engine::configure scans for device types without opening one',
  "`deviceManager.initialise(0, ch, nullptr, true)` does not merely build the device-type list — it " +
  'OPENS THE PLATFORM DEFAULT DEVICE, before the engine has said one word about the device the operator ' +
  'chose. So every cold start opened a device nobody asked for, threw it away, and opened the right one. ' +
  'Measured in the app with ASIO selected: initialise 5471ms + switch 1817ms + open 54ms = 7342ms, ' +
  'against 62 + 288 + 53 = 403ms once the open is gone; end to end on a 10-scene project, 3 runs, ' +
  '7806ms -> 707ms. It is worst exactly where it is least visible: with the PLATFORM DEFAULT device ' +
  'selected initialise happens to open the one we wanted, so the waste is ~370ms and the bug hides. ' +
  'getAvailableDeviceTypes() does the half that is needed (a 39ms scan) and opens nothing. ' +
  'The `true` it replaced was selectDefaultDeviceOnFailure, so the two guards below are the safety net ' +
  'it silently provided: a named device that will not open must still leave the DEFAULT one live ' +
  '(or a venue with a renamed interface comes up silent), and JUCE reporting no error is NOT the same ' +
  'as a device existing — asked for an empty name it returns success and creates nothing, which is ' +
  'every machine that has never chosen a device.',
  () => {
    const f = 'native/audio-engine/src/core.h';   // the engine's core since E3 (engine.cpp is its N-API front door)
    if (!exists(f)) return `${f} is missing`;
    const src = read(f);
    const bad = [];
    if (/deviceManager\.initialise\s*\(/.test(src)) bad.push('deviceManager.initialise() is back — it opens the platform default before the chosen device');
    if (!/getAvailableDeviceTypes\(\)/.test(src)) bad.push('nothing scans for device types — setCurrentAudioDeviceType has no list to read');
    if (!/defaultOutputName\(\)/.test(src)) bad.push('defaultOutputName() is gone — an empty device name creates NO device in JUCE, it does not mean "the default"');
    if (!/no audio device was opened/.test(src)) bad.push('the "no error but no device" guard is gone — configure would report success over a silent machine');
    return bad.length ? bad.join('; ') : null;
  },
);

// ── THE SOUND CARD IS NOT OPENED ON THE DEFAULTS ──────────────────────────────────────────────
check(
  'the audio plugin waits for the machine settings before opening the device',
  "`native.configure()` is a SYNCHRONOUS napi call into JUCE that opens the sound card, and it runs on " +
  "MAIN's JS thread — so for as long as it takes, main serves nothing: not a byte over " +
  "artlux-media://, not a prefs read, not an audio conform. Measured on this rig (Windows Audio / " +
  "Realtek) it is 5.7 s per call, and the plugin used to make TWO: one at activate() against " +
  "DEFAULT_SETTINGS (no `plugins` key at all) and one when the machine's real setup arrived from prefs " +
  "and the key diff re-opened the right device. A CPU profile of main across a cold open put " +
  "`configure` at 11.0 s of self time out of 18 s, with nothing else within 60 ms. The first call is " +
  "not merely wasted: it blocks the prefs read that would have said it was the wrong device, so it " +
  "delays the project open by its own duration and then the media fetches by the second call's. " +
  "End to end on a 2-scene / 4-mp4 project: 21.1 s to arm, of which 11.3 s was this. Deferring the " +
  "startup open to the first settings notification carrying an audio slice — with a bounded grace for " +
  "a machine that genuinely has none — took it to 6.5 s. Re-wiring activate() straight to " +
  "applyDeviceCfg puts all of it back, silently.",
  () => {
    const f = 'plugins/audio/src/plugin.renderer.ts';
    if (!exists(f)) return `${f} is missing`;
    const src = read(f);
    const bad = [];
    // The old shape, exactly: an unconditional startup open wired straight to the subscription.
    if (/subscribe\(applyDeviceCfg\)/.test(src)) bad.push('host.settings.subscribe(applyDeviceCfg) is back — the startup open is unconditional again');
    if (!/STARTUP_DEVICE_GRACE_MS/.test(src)) bad.push('the startup grace is gone — nothing defers the first device open');
    // …and the grace must be cancellable, or a plugin torn down inside it still opens the card later.
    if (!/clearTimeout\(startupDeviceTimer\)/.test(src)) bad.push('deactivate no longer cancels the pending startup open');
    return bad.length ? bad.join('; ') : null;
  },
);

// ── A PRE-ROLL IS A PROBE, NOT A SEEK ─────────────────────────────────────────────────────────
check(
  "the codec pre-roll never repositions a decoder another consumer is driving",
  'A timeline layer decoder has TWO drivers during a cold start, and only one owns the playhead: the ' +
  'TRANSPORT keeps calling layerFrame at an advancing clip time all through the hold (the gate holds ' +
  'the STATE MACHINE and deliberately never writes `playing`), while the gate polls preRoll ~10x/s at ' +
  'the START CLIP time. mp4 answered the poll by calling frame(atSec), which MOVES wantUs — so asking ' +
  'at 0 while the transport sat at 5 s read as a backward scrub, pump() took its ' +
  '`wentBackward && !havePresentable` branch, seekSegment threw the buffer away, and the transport ' +
  'refilled it before the next poll undid that too. Measured: fedAbs sawtoothing 21->7->3->8->3, the ' +
  'buffer oscillating 1<->9, preRoll false FOREVER — so the gate armed by TIMEOUT and burned the whole ' +
  'bootPreloadSec (15 s) on every open of any project with an mp4 in its opening scene, while the show ' +
  'played blind through it. It also corrupted lastFrameTs, which IS layerGeneration, so every consumer ' +
  'that skips repeated frames on it was told the layer had jumped back to the head of the clip 10x a ' +
  'second. The rule that fixes it is general, not mp4-specific, so the SDK contract has to carry it.',
  () => {
    const bad = [];
    const f = 'plugins/mp4/src/mp4Decoder.ts';
    if (!exists(f)) return `${f} is missing`;
    // ⚠ NOT fnBody(): it matches `function preRoll(` and would find the MODULE-LEVEL registry wrapper,
    // which legitimately mentions none of this — a check that passes by looking at the wrong function.
    // The rule lives in the CLASS METHOD, so slice that one out by hand.
    const srcM = read(f);
    const at = srcM.indexOf('preRoll(atSec');
    const body = at < 0 ? null : srcM.slice(at, srcM.indexOf(String.fromCharCode(10) + '  }', at));
    if (!body) bad.push('mp4Decoder FileDecoder.preRoll(atSec…) not found — re-check the no-seek guard by hand');
    else {
      // The ownership test. `lastWantUs` is the only thing that can say "somebody else is driving".
      if (!/lastWantUs/.test(body)) bad.push('preRoll no longer consults lastWantUs — it cannot tell whether another consumer owns the playhead');
      // …and frame() must be the ELSE of it, never unconditional. One `this.frame(` reachable without
      // passing the guard is the whole bug back.
      const framesAt = body.indexOf('this.frame(');
      const guardAt = body.indexOf('lastWantUs');
      if (framesAt >= 0 && guardAt >= 0 && framesAt < guardAt) bad.push('preRoll calls this.frame() BEFORE testing lastWantUs — the seek is back');
    }
    const sdk = 'packages/sdk/src/renderer.ts';
    if (!exists(sdk)) bad.push(`${sdk} is missing`);
    // raw(), not read(): the contract is a DOC COMMENT, and read() strips comments.
    else if (!/MUST NEVER SEEK/.test(raw(sdk))) bad.push(`${sdk}: the preRoll contract no longer states that a pre-roll must not seek`);
    return bad.length ? bad.join('; ') : null;
  },
);

// ── A 3D MATERIAL THAT WILL BE TEXTURED IS BORN WITH A MAP ────────────────────────────────────
check(
  'every material fed by a timeline/surface texture is constructed with map: blankMap()',
  "three's WebGPU renderer decides whether to re-upload a texture by diffing a SNAPSHOT of the " +
  "material's uniforms (NodeMaterialObserver), and that snapshot is built once per material with " +
  '`if (value === null || value === undefined) continue`. A material created with no `map` and given ' +
  'one a few frames later therefore has `map` UNWATCHED for its whole life: needsRefresh() answers ' +
  'no, bindings.updateForRender never runs, textures.updateTexture is never called, and the mesh ' +
  'freezes on whichever frame happened to land during its first draws. Measured in the 3D viewport ' +
  'with an mp4 on a venue plane: the VideoFrame advanced at 25 fps, texture.version passed 14000, the ' +
  'GPU texture was still the one from version 2 — nothing thrown, nothing logged. It is a RACE (a ' +
  'still image usually wins it, an mp4 decoder never does), and it went from intermittent to ' +
  'permanent when captureCodecHold removed the null-drawable churn that had been forcing a new ' +
  'texture at every cut. Assigning null BACK is worse than a missed refresh: once `map` is watched ' +
  "the observer reads `mtlValue.isTexture` on it and a null throws inside the render loop. See " +
  'src/renderer/components/Simulator3D/blankMap.ts.',
  () => {
    const bad = [];
    const NL = String.fromCharCode(10);
    // Every material that a `mat.map = ...` writes to must be born mapped, and no assignment may
    // hand it a bare, possibly-null texture.
    const files = [
      'src/renderer/components/Simulator3D/PlaneObject.tsx',
      'src/renderer/components/Simulator3D/ModelObject.tsx',
      'src/renderer/components/Simulator3D/projectedMapping.ts',
      'plugins/calibration/src/ProjectorScene.tsx',
    ];
    for (const f of files) {
      if (!exists(f)) { bad.push(`${f} is missing`); continue; }
      const src = read(f);
      if (!/blankMap\(\)/.test(src)) { bad.push(`${f} no longer references blankMap()`); continue; }
      for (const line of src.split(NL)) {
        const m = /(?:^|[^\w.])(?:mat|material)\.map\s*=\s*(.+?);/.exec(line);
        if (!m) continue;
        if (!/blankMap\(\)/.test(m[1])) bad.push(`${f}: \`map = ${m[1].trim()}\` can be null — write \`tex ?? blankMap()\``);
      }
      // The construction half. Only the materials that ACTUALLY get textured — a wireframe overlay
      // beside them is rightly mapless, and demanding a map of every MeshBasicMaterial in the tree
      // would be a rule nobody could satisfy. The three that carry content are named here: the two
      // `layerMatRef` singletons (plane/GLB and the projector window's twin) and projectedMapping's
      // own `material`. The JSX form is the plane's inline one.
      for (const line of src.split(NL)) {
        const textured = /layerMatRef\.current\s*=\s*new THREE\.MeshBasicMaterial/.test(line)
          || /const material\s*=\s*new THREE\.MeshBasicMaterial/.test(line);
        if (textured && !/map:/.test(line)) {
          bad.push(`${f}: a textured MeshBasicMaterial is constructed without \`map: blankMap()\``);
        }
        if (/<meshBasicMaterial /.test(line) && !/map=/.test(line)) {
          bad.push(`${f}: <meshBasicMaterial> is declared without \`map={blankMap()}\``);
        }
      }
    }
    return bad.length ? bad.join('; ') : null;
  },
);

// ── Machine logging: the four properties that keep it from becoming the problem ────────────────
// (plans/machine-logging.md). Each of these is a change that would compile, boot, throw nothing, and
// surface as something else entirely.

check(
  'the frame path never imports the logger',
  'The frame loop runs at 30-60 Hz and touches every surface, fixture and universe. One log line per ' +
  'frame is the FLOOR; per-fixture is tens of thousands a second. These modules exist precisely to ' +
  'keep work off that path (see plans/engine-decoupling.md), and the symptom of breaking it is not an ' +
  'error but "the venue judders" — investigated as a GPU problem. Console calls in these files are ' +
  'fine: shared/consoleTap.ts rate-limits them.',
  () => {
    const bad = [];
    const banned = [
      'src/renderer/engine/frameEngine.ts',
      'src/renderer/services/livePreview.ts',
      'src/renderer/services/dmxSignal.ts',
      'src/renderer/services/fixtureSignal.ts',
      'src/renderer/services/automationOverlay.ts',
    ];
    for (const f of banned) {
      if (!exists(f)) continue; // a deleted module is not a violation
      const src = read(f);
      if (/from\s+['"][^'"]*\/log['"]/.test(src) || /from\s+['"]\.\/log['"]/.test(src)) bad.push(f);
    }
    return bad.length ? `imports services/log: ${bad.join(', ')}` : null;
  },
);

check(
  "the logger's write path is asynchronous",
  'appendFileSync on main\u2019s main thread blocks it. Art-Net survives (the native pacer has its own ' +
  'thread) but IPC, the watchdog health timer and anything the renderer awaits stall behind it \u2014 and a ' +
  'venue project folder can be an SMB share where a write hangs for SECONDS. The ONLY sanctioned sync ' +
  'write is the final flush in the quit path, where blocking is correct.',
  () => {
    const f = 'src/main/logger.ts';
    if (!exists(f)) return null;
    const src = read(f);
    const body = braceBody(src, 'function write(');
    if (!body) return 'could not find write() \u2014 the guard cannot see what it is meant to protect';
    if (/Sync\s*\(/.test(body)) return 'write() performs a SYNCHRONOUS fs call';
    // …and the sync flush must stay behind the `sync` flag rather than becoming the default.
    const flush = braceBody(src, 'export function flush(');
    if (!flush) return 'could not find flush()';
    if (/appendFileSync/.test(flush) && !/if\s*\(sync\)/.test(flush)) {
      return 'flush() calls appendFileSync outside the `if (sync)` branch';
    }
    return null;
  },
);

check(
  'the console tap keeps its re-entrancy guard',
  'The logger calls console.warn when a sink degrades. Without the `inside` flag that warning is ' +
  'tapped, which logs, which warns \u2014 an infinite loop that ends the process, and it would fire for the ' +
  'first time on the machine whose network share just dropped.',
  () => {
    const f = 'shared/consoleTap.ts';
    if (!exists(f)) return null;
    const src = read(f);
    if (!/if\s*\(inside\)\s*return/.test(src)) return 'no `if (inside) return` guard';
    if (!/inside\s*=\s*true/.test(src) || !/inside\s*=\s*false/.test(src)) return 'the guard is never set/cleared';
    return null;
  },
);

check(
  'the renderer log client survives having no window',
  'Several pure services (openTrace, dockTree, lookahead\u2026) are imported by tsc-checked scripts that ' +
  'run under plain node \u2014 DEVELOPMENT.md \u2192 Testing. services/log.ts is imported by openTrace, so a ' +
  'module-scope `window.location` there throws a ReferenceError on import and takes the script down ' +
  'for a reason unrelated to what it was testing.',
  () => {
    const f = 'src/renderer/services/log.ts';
    if (!exists(f)) return null;
    const src = read(f);
    if (!/typeof window !== 'undefined'/.test(src)) return 'no `typeof window` guard at module scope';
    if (/new URLSearchParams\(window\.location/.test(src)) return 'reads window.location unguarded at module scope';
    return null;
  },
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
check(
  'every process-exit path closes the log session',
  'A log file is ONE RUN of the app: it opens with session.start and closes with session.end, and a ' +
  'file whose last line is not session.end means the run died. app.exit() does NOT fire before-quit, ' +
  'so a relaunch path that forgets logger.shutdown() silently produces a truncated session — and an ' +
  'unattended machine takes those paths (watchdog self-heal, playlist switch) far more often than it ' +
  'is ever quit by hand, so the sessions that matter most would be exactly the broken ones.',
  () => {
    const bad = [];
    for (const f of walk('src/main')) {
      const src = read(f);
      if (!/\bapp\.exit\s*\(/.test(src)) continue;
      if (!/logger\.shutdown\s*\(/.test(src)) bad.push(f);
    }
    return bad.length ? `calls app.exit() without logger.shutdown(): ${bad.join(', ')}` : null;
  },
);

check(
  'the log never splits one session across files',
  'One file = one run is the property the whole log is arranged around. Rotating mid-session would ' +
  'produce a second file that looks like a session of its own but carries no session.start, and a ' +
  'reader would have to reassemble runs by timestamp — the very thing this design exists to avoid. ' +
  'Reaching the size ceiling truncates the session with a marker instead.',
  () => {
    const f = 'src/main/logger.ts';
    if (!exists(f)) return null;
    const src = read(f);
    const w = braceBody(src, 'function write(');
    if (!w) return 'could not find write() — the guard cannot see what it is meant to protect';
    if (!/log\.truncated/.test(w)) return 'write() no longer marks a session that hit the ceiling';
    if (/sessionFileName\s*\(/.test(w)) return 'write() mints a new file mid-session (that is a rotation)';
    return null;
  },
);

// ── The zone-trigger memo key covers the WHOLE rule ───────────────────────────────────────────
check(
  'the zone-trigger memo signature covers every field the rule reads',
  'sig() keys the arm-and-hold memo by the RULE, not by the transition — the transition id is not ' +
  'available at the call site, and two identical rules from one state ARE the same question. That is ' +
  'sound only while the key is injective over the rule space. Miss a field and two genuinely different ' +
  'rules share one memo: with ALL[zA] and ALL[zA occupiedFor 60s] out of one state, the 60s rule is ' +
  'false every frame and sets armed = true, the plain rule reads that same armed and FIRES — 60 times ' +
  'a second for as long as somebody stands there. Nothing throws, and the two params objects visibly ' +
  'differ, so it is invisible on inspection. Add the field here the day you add one to ZoneRule.',
  () => {
    const f = 'plugins/lidar-tracking/src/zoneTriggers.ts';
    if (!exists(f)) return null;
    const src = read(f);
    // ⚠ THE TWO HALVES ARE CHECKED SEPARATELY, and that is the whole point. Checking the combined
    // region passes on broken code: the one-zone branch of sig() mentions edge/seconds/n anyway, so a
    // termSig that had dropped the per-term rule still satisfied it. Verified by deleting the fields
    // from termSig and watching the combined check stay green.
    const tm = src.match(/const termSig[\s\S]*?;/);
    const sm = src.match(/const sig = [\s\S]*?;/);
    if (!tm || !sm) return 'termSig/sig are gone — the memo key cannot be checked';
    // Regex LITERALS, not RegExp-from-string: a `\b` built through a template literal is a BACKSPACE
    // character, so such a check silently matches nothing and passes forever. (It did, once.)
    const RULE = [['edge', /\.edge\b/], ['seconds', /\.seconds\b/], ['n', /\.n\s*\?\?/]];
    for (const [field, re] of [...RULE, ['zone', /\.zone\b/], ['not', /\.not\b/]]) {
      if (!re.test(tm[0])) return `termSig no longer includes \`${field}\` — two terms differing only in that share one memo`;
    }
    for (const [field, re] of [...RULE, ['zoneId', /\.zoneId\b/], ['match', /\.match\b/]]) {
      if (!re.test(sm[0])) return `sig no longer includes \`${field}\``;
    }
    if (!/termSig/.test(sm[0])) return 'sig no longer builds the combination key from termSig';
    // …and every rule field zoneLevel actually reads must appear in the per-term key.
    const lvl = src.match(/export function zoneLevel[\s\S]*?\n}/);
    if (lvl) for (const [field, re] of RULE) {
      if (new RegExp('r\.' + field).test(lvl[0]) && !re.test(tm[0]))
        return `zoneLevel reads \`${field}\` but termSig ignores it`;
    }
    return null;
  },
);

// ── The person tracker has exactly one caller ─────────────────────────────────────────────────
check(
  'clusterAndTrack is called only from people.ts',
  'clusterAndTrack owns per-frame velocity state and is documented "call ONCE per frame, from a ' +
  'single caller". A second caller advances every track twice against a ~0 dt, so predictions fling ' +
  'and the projector markers jitter. people.ts is that caller and hands the answer to the zones and ' +
  'the projector channel alike — which is also what stops the SHOW counting people with a weaker ' +
  'algorithm than the 3D scene an operator validates against.',
  () => {
    const hits = [];
    for (const f of walk('plugins/lidar-tracking/src')) {
      if (!/\.tsx?$/.test(f) || /blobClustering\.ts$|people\.ts$/.test(f)) continue;
      if (/\bclusterAndTrack\s*\(/.test(read(f))) hits.push(f);
    }
    return hits.length ? `clusterAndTrack called outside people.ts: ${hits.join(', ')}` : null;
  },
);

// ── Cross-project import knows every reference in the document ─────────────────────────────────
check(
  'every id-bearing field is accounted for by the project importer',
  'services/projectImport.ts re-mints every carried id and rewrites every reference to it. A field it ' +
  'does not know about is carried VERBATIM, so it keeps pointing at an object in the SOURCE project — ' +
  'and every dangling reference in this app is silent BY DESIGN: stateMachine.enter() does ' +
  '`if (s?.sceneId) ctx.recallScene(...)`, so a state whose scene is missing recalls nothing and the ' +
  'show runs on reporting playing:true all night. Nothing downstream would ever raise it, so this ' +
  'turns "someone added a reference and forgot the importer" into a build failure instead. It does ' +
  'NOT ask that a field be remapped — several correctly are not (profileId resolves against a ' +
  'library, shaderId names a built-in, a zone surface is SOL/MUR) — only that the file MENTION it, ' +
  'so the decision was made once and written down. It found two real gaps the day it was written: ' +
  'busId, which left an imported audio track routed to a bus in the source project mix, and shaderId. ' +
  'It scans shared/protocol.ts as well as renderer/types.ts: persisted shapes live in both, and a field ' +
  'declared in the wrong one of the two would otherwise be unguarded.',
  () => {
    // BOTH files that declare persisted shapes. renderer/types.ts holds the domain model, but
    // shared/protocol.ts holds everything that also crosses IPC — AssetEntry, ProjectorOutput,
    // OutputSpan, BakeEntry — and a new id field declared THERE was invisible to this scan, which is
    // precisely the "someone added a reference and forgot the importer" case it exists to catch.
    const types = read('src/renderer/types.ts') + '\n' + read('shared/protocol.ts');
    // raw(), NOT read(): read() strips comments, and for a field that is deliberately NOT remapped
    // the comment explaining why IS the recorded decision. types.ts stays on read() so a
    // commented-out declaration cannot satisfy the scan.
    const imp = raw('src/renderer/services/projectImport.ts');
    if (!imp) return 'services/projectImport.ts is gone — cross-project import cannot be checked';
    // Declarations shaped `<name>Id?: string` / `<name>Ids: string[]` / `<name>Ref?: string`,
    // indented by 2+ so this reads interface FIELDS and not top-level consts or locals.
    const found = new Set();
    for (const m of types.matchAll(/^\s{2,}(\w+(?:Id|Ids|Ref|Refs))\??\s*:\s*(?:string|string\[\])/gm)) {
      found.add(m[1]);
    }
    // A regex that has stopped matching passes forever, so refuse to be silently vacuous.
    if (found.size < 15) return `only ${found.size} id fields matched — the scan has stopped seeing them`;
    const missing = [...found].filter((n) => !imp.includes(n)).sort();
    return missing.length
      ? `services/projectImport.ts never mentions: ${missing.join(', ')} — carried verbatim, they would still point at the SOURCE project`
      : null;
  },
);

check(
  'the served tablet page actually parses',
  'plugins/show-control/src/clientHtml.ts is the ENTIRE Show Control remote — markup, styles and ' +
  'client script — held inside one template literal, so TypeScript checks none of it. Two ways to ' +
  'kill the whole page while the build stays green, both of which happened: a backtick inside a ' +
  'comment ends the literal (`playlist` in prose did it), and an escape that is right in the source ' +
  'collapses wrong on the way out (\\/ inside a regex emitted //, which commented out the rest of the ' +
  'line and took every function after it with it). The failure is total and silent: the tablet serves ' +
  'a blank page, in a venue, with no console anyone is looking at. This evaluates the template and ' +
  'parses the script it produces, which is the only thing that can see either bug.',
  () => {
    const src = raw('plugins/show-control/src/clientHtml.ts');
    if (!src) return 'plugins/show-control/src/clientHtml.ts is gone — the tablet page cannot be checked';
    let html;
    try {
      // Evaluate the module body with its imports stripped and the brand marks stubbed: we are
      // checking the STRING it builds, not what it decorates the string with.
      const body = src.replace(/^import[\s\S]*?from\s+'[^']+';\s*$/m, '').replace(/\bexport const\b/g, 'const');
      // eslint-disable-next-line no-new-func
      html = new Function('WORDMARK', 'ICON_MARK', body + '\nreturn CLIENT_HTML;')(
        { width: 1, height: 1, path: 'M0 0' }, { png180: 'd' });
    } catch (e) {
      return `clientHtml.ts does not evaluate (a stray backtick in the template?): ${e.message}`;
    }
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    if (!m) return 'the served page has no <script> — the whole client is gone';
    if (m[1].length < 5000) return `the served script is only ${m[1].length} chars — it has been truncated`;
    try { new (require('node:vm').Script)(m[1]); }
    catch (e) { return `the served client script does not parse: ${e.message}`; }
    return null;
  },
);

check(
  'a deliberate quit tells the OS supervisor to stand down',
  'The Tier-2 Scheduled Task relaunches ArtLux every minute whenever the process is gone, and it ' +
  'cannot tell "the venue crashed" from "the operator stopped the show" by itself. The two are ' +
  'separated by exactly one file — main writes artlux-stopped.flag on `will-quit` (a crash never ' +
  'reaches that event) and watchdog-check.ps1 stands down when it sees it. Remove either half and ' +
  'every deliberate quit — the tray item, Ctrl+Shift+Q, and the show-control remote\'s Shut down — ' +
  'is silently undone about a minute later, which from an operator\'s chair is the app refusing to ' +
  'close. It is a contract across a .ts and a .ps1, so nothing else can see it: not the typechecker, ' +
  'and not a dev run, because the Scheduled Task is only ever installed on a venue machine.',
  () => {
    const wd = read('src/main/watchdog.ts');
    const idx = read('src/main/index.ts');
    const ps = raw('scripts/watchdog-check.ps1');
    if (!wd || !idx || !ps) return 'watchdog.ts / index.ts / watchdog-check.ps1 — one of the three is gone';
    const problems = [];
    if (!wd.includes('artlux-stopped.flag')) problems.push('watchdog.ts no longer names artlux-stopped.flag');
    if (!/export function noteDeliberateShutdown/.test(wd)) problems.push('watchdog.ts no longer exports noteDeliberateShutdown()');
    if (!/noteDeliberateShutdown\(/.test(idx)) problems.push('main/index.ts never calls noteDeliberateShutdown() — a quit is no longer marked');
    if (!ps.includes('artlux-stopped.flag')) problems.push('watchdog-check.ps1 no longer honours the marker — Tier-2 will resurrect a stopped show');
    // The marker must also be LIFTED, or it suppresses a genuine crash recovery forever after the
    // first deliberate quit. start() is the only correct place: the supervisor checks the marker
    // before launching, so it can never be the thing that clears it.
    if (!/unlinkSync\(stoppedFlag\(\)\)/.test(wd)) problems.push('watchdog.ts never clears the marker on start — one quit would disarm Tier-2 permanently');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the tablet remote does not repaint itself out from under a finger',
  'The show-control client rebuilds <main> wholesale on every render, and the app pushes it a status ' +
  'event twice a second forever. Left unchecked that is 120 DOM rebuilds a minute on a screen nobody ' +
  'is re-rendering FOR — the status payload is mostly the playhead, which the Control tab does not ' +
  'draw — and each rebuild resets the scroll to the top. On a phone that made everything below the ' +
  'fold unreachable: you scrolled, and half a second later you were back at the top, which is exactly ' +
  'how the power buttons shipped unusable. Two halves keep it fixed: every tab repaints through the ' +
  'changed-compare (renderIfChanged) rather than calling render() on a stream event, and shell() ' +
  'restores the scroll it just destroyed. Neither is visible to a typechecker, and neither shows up ' +
  'on a desk monitor where the page happens to fit.',
  () => {
    const src = raw('plugins/show-control/src/clientHtml.ts');
    if (!src) return 'plugins/show-control/src/clientHtml.ts is gone';
    const problems = [];

    // shell() must put the scroll back after replacing <main>.
    const shell = /function shell\(inner\)\{[\s\S]*?\n  \}/.exec(src);
    if (!shell) problems.push('shell(inner) not found — the repaint path has moved');
    else if (!/scrollTop\s*=/.test(shell[0])) problems.push('shell() no longer restores scrollTop — every repaint sends the page back to the top');

    // renderIfDynamic must route through the changed-compare, never straight to render().
    const dyn = /function renderIfDynamic\(t\)\{[\s\S]*?\n  \}/.exec(src);
    if (!dyn) problems.push('renderIfDynamic(t) not found — the stream-repaint path has moved');
    else {
      const body = dyn[0].replace(/\/\/[^\n]*/g, ''); // its own comments mention render()
      if (/(^|[^a-zA-Z.])render\(\)/.test(body)) {
        problems.push('renderIfDynamic calls render() directly — a stream event will repaint a tab whose data did not change');
      }
      if (!/renderIfChanged\(\)/.test(body)) problems.push('renderIfDynamic no longer uses renderIfChanged()');
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── A SURFACE WHOSE SHAPE WAS CHOSEN IS NEVER REFITTED TO ITS CONTENT ─────────────────────────────
check(
  'the content auto-fit skips a surface with a chosen aspect, and Size edits keep it',
  'Transform ▸ Aspect pins a surface to 16:9 / 16:10 / 4:3 / 21:9 / 1:1 so a shader, text or tracking ' +
  'look is drawn at the shape of the screen it goes to. The frame engine refits a surface to its ' +
  "media's aspect the moment the media loads — so without the skip, dropping a square image on a 16:9 " +
  'wall silently turns it square again, the chosen aspect still shows in the inspector, and every ' +
  'circle on it comes out an ellipse. Nothing throws. Likewise a Size field that writes width alone ' +
  'breaks the shape the dropdown still claims. See src/renderer/services/surfaceAspect.ts.',
  () => {
    const bad = [];
    const eng = 'src/renderer/engine/frameEngine.ts';
    if (!exists(eng)) return `${eng} is missing`;
    const src = read(eng);
    const fit = /for \(const s of this\.inputs\.surfaces\) \{([\s\S]*?)getContentAspect\(s\)/.exec(src);
    if (!fit) bad.push(`${eng}: the content auto-fit loop (getContentAspect over this.inputs.surfaces) was not found — re-point this check`);
    else if (!/if \(isLocked\(s\)\) continue;/.test(fit[1])) bad.push(`${eng}: the auto-fit no longer skips a locked surface before measuring its content`);
    const insp = 'src/renderer/contexts/panels/inspector.tsx';
    const panel = /export const SurfaceTransformPanel[\s\S]*?\n\};/.exec(read(insp));
    if (!panel) bad.push(`${insp}: SurfaceTransformPanel not found`);
    else {
      if (!/sizeKeeping\(s, 'width'/.test(panel[0]) || !/sizeKeeping\(s, 'height'/.test(panel[0])) bad.push(`${insp}: the W/H fields no longer go through sizeKeeping()`);
      if (!/reshape\(/.test(panel[0])) bad.push(`${insp}: the Aspect control no longer goes through reshape()`);
    }
    return bad.length ? bad.join('; ') : null;
  },
);

// ── A STILL IMAGE IS SENT TO A PROJECTOR ONCE, AND A STREAM IS HELD UNTIL THE WINDOW HAS IT ─────────
check(
  'a still image reports a generation, and the projector pump holds each stream until its frameAck',
  'Two 4K stills on two tracks, one per projector output, took a venue editor down (2026-10-15): black ' +
  'UI, both outputs on "Waiting for the main window…". IMAGE answered no generation and a LAYER surface ' +
  'answered none either, so the pump re-made a ~33 MB createImageBitmap per output every tick for a ' +
  'picture that never changed, and released its in-flight slot at postMessage — which only proves the ' +
  'bitmap entered the port queue, so a stalled projector let them pile up. Reproduced on the dev PC: ' +
  'editor 30 -> 6 fps, main thread blocked ~1 s of every second, GPU context lost after ~4 min with a ' +
  'video beside it. Nothing threw. See the frame pump in App.tsx (BACK-PRESSURE ENDS AT THE RECEIVER).',
  () => {
    const bad = [];
    const cs = read('src/renderer/services/contentSource.ts');
    if (!/content\.type === SourceType\.IMAGE\)[\s\S]{0,160}e\.type === 'IMAGE' && e\.bmp \? e\.gen : undefined/.test(cs))
      bad.push('contentSource.getDrawableGeneration no longer answers a generation for a decoded IMAGE');
    const sm = read('src/renderer/services/surfaceMedia.ts');
    if (!/SourceType\.LAYER\) \{\s*return stackIdsOf\(s\) \? undefined : timeline\.getLayerGeneration\(/.test(sm))
      bad.push('surfaceMedia.getDrawableGeneration no longer passes a single track\'s generation through for LAYER');
    const app = read('src/renderer/App.tsx');
    if (/\.finally\(\(\) => inFlight\.delete\(/.test(app))
      bad.push('App.tsx frame pump releases an in-flight stream in .finally() again — that is at postMessage, not at receipt');
    if (!/projFrameAckRef\.current = /.test(app) || !/m\.t === 'frameAck'/.test(app))
      bad.push('App.tsx no longer releases a stream on the projector\'s frameAck');
    const proj = read('src/renderer/projector/ProjectorApp.tsx');
    if (!/t: 'frameAck', key: m\.ack/.test(proj))
      bad.push('ProjectorApp no longer acknowledges a received frame (frameAck) — every stream would crawl at the 1 s ack timeout');
    return bad.length ? bad.join('; ') : null;
  },
);

// ── MP4: a decoder that dies cannot spin the feed loop ──────────────────────────────────────────
check(
  'an mp4 decoder that dies is re-seeked, never fed',
  'A VideoDecoder that errored was replaced by an UNCONFIGURED one that a forward-playing surface never ' +
  're-seeked; pump() fed it, every decode() threw into a swallowed catch, and with maxAbs = Infinity ' +
  'nothing ended the loop. Measured on the RTX box (2026-10-23): one core at 100%, renderer memory ' +
  '+6 GB/s, dead of OOM at ~14.8 GB in 4.7 s — from an injected fault and from a real GPU-process crash ' +
  'alike. A timeline layer instead fed the rest of the file in one 235 ms stall and froze. Nothing threw ' +
  'and nothing was logged. The rules: only seekSegment builds a decoder (it configures it first); pump() ' +
  'feeds nothing that is not configured; its loop has a per-call bound that does not depend on decoder ' +
  'progress; and every death (error callback, decode() throw, configure throw) goes through markDead. ' +
  'See plans/mp4-decoder-freeze.md; reproduce with window.__artluxMp4Fault.',
  () => {
    const F = 'plugins/mp4/src/mp4Decoder.ts';
    const src = read(F);
    const bad = [];
    const pump = braceBody(src, 'private pump(');
    const seek = braceBody(src, 'private seekSegment(');
    if (!pump) return F + ': pump() not found — this guard cannot see what it protects';
    if (!seek) return F + ': seekSegment() not found — this guard cannot see what it protects';
    const calls = (src.match(/this\.ensureDecoder\(\)/g) || []).length;
    if (calls !== 1 || !/this\.ensureDecoder\(\)/.test(seek))
      bad.push(`ensureDecoder() must be called from seekSegment only (found ${calls} call site(s)) — anywhere else hands pump() an unconfigured codec`);
    const feed = pump.indexOf('while (this.fedAbs');
    if (feed < 0) bad.push('pump() feed loop not found');
    else {
      const gate = pump.indexOf("state !== 'configured'");
      if (gate < 0 || gate > feed) bad.push("pump() no longer refuses to feed a decoder whose state is not 'configured' before its feed loop");
      const loop = braceBody(pump.slice(feed), 'while (');
      if (!loop || !/budget--\s*<=\s*0/.test(loop))
        bad.push('the pump() feed loop lost its per-call bound — every other exit condition depends on decoder progress, which a dead codec never makes');
      if (loop && /catch\s*\{/.test(loop)) bad.push('the pump() feed loop swallows a decode() throw again — it must markDead and break');
      if (loop && !/markDead\(/.test(loop)) bad.push('a decode() throw in the pump() feed loop no longer reaches markDead');
    }
    if (!/error:\s*\(e\)\s*=>\s*\{[^}]*markDead\(/.test(src)) bad.push('the VideoDecoder error callback no longer reaches markDead');
    if (!/catch\s*\(e\)\s*\{[\s\S]*?markDead\('configure'/.test(seek)) bad.push('a configure() that throws in seekSegment no longer reaches markDead');
    return bad.length ? bad.join('; ') : null;
  },
);

// ── Timeline: a file put on a lane is imported, however it got there ────────────────────────────
check(
  "a file added to a lane by the right-click picker is imported like a drop",
  "A file DROPPED on a lane was copied into the project's assets/ and registered in the Media library; " +
  'the same file PICKED in the lane\'s right-click "Add clip" menu was stored by its original path — no ' +
  'library entry, no copy — so the project silently depended on (say) a Desktop folder and a copied show ' +
  'folder reached the venue with the clip missing. Found 2026-10-23 when a picked video was absent from ' +
  'the Media tab. Both now go through ONE importAndPlace(); ContentEditor stays "pick, don\'t import" for ' +
  'the surface inspector, which is right there.',
  () => {
    const F = 'src/renderer/components/timeline/Timeline.tsx';
    const src = read(F);
    const bad = [];
    // Anchored on the BODY's opening: the first '{' after the name is the opts parameter's type.
    const at = src.indexOf('const importAndPlace = async (');
    const iap = at < 0 ? null : braceBody(src.slice(at), '): Promise<void> => {');
    if (!iap) return F + ': importAndPlace() not found — this guard cannot see what it protects';
    if (!/importAssetFile/.test(iap) || !/onRegisterAsset/.test(iap)) bad.push(F + ': importAndPlace() no longer imports into assets/ and registers the library entry');
    const drop = braceBody(src, 'const onDropFile = (');
    if (!drop || !/importAndPlace\(/.test(drop)) bad.push(F + ': a file dropped on a lane no longer goes through importAndPlace()');
    if (drop && /importAssetFile/.test(drop)) bad.push(F + ': onDropFile imports by itself again — a second copy of the import path will drift from the picker\'s');
    const menu = src.indexOf('<ContentEditor', src.indexOf('Add clip'));
    const menuSrc = menu >= 0 ? src.slice(menu, menu + 1500) : '';
    if (!/importAndPlace\(/.test(menuSrc)) bad.push(F + ': the right-click "Add clip" picker no longer imports a picked file (importAndPlace)');
    return bad.length ? bad.join('; ') : null;
  },
);

// ── Projector outputs: an editor reload re-bridges every open output ────────────────────────────
check(
  'every editor load re-bridges the open projector outputs',
  "bridge() ran only on a PROJECTOR's did-finish-load, so each output got one port pair for its life — " +
  "and the editor's end dies with the editor's page. After any editor reload every open output sat on " +
  '"Waiting for the main window…" for good, and the editor came back with an empty pump. Measured ' +
  '2026-10-23 on a production build: both outputs dead within 10 s, still dead at 60 s. Reachable from ' +
  'View ▸ Reload / Ctrl+R and from the renderer-fault ladder (faultReporter.reloadWindow) — in broadcast, ' +
  'a recovered fault would have left a dark wall. With the re-bridge the longest gap between frames ' +
  'across a reload was 383 ms, no caption. The engine port already followed this rule (openEnginePort).',
  () => {
    const bad = [];
    const P = 'src/main/projector.ts';
    const reb = braceBody(read(P), 'export function rebridgeAllProjectors(');
    if (!reb) return P + ': rebridgeAllProjectors() not found — this guard cannot see what it protects';
    if (!/bridge\(/.test(reb)) bad.push(P + ': rebridgeAllProjectors() no longer calls bridge()');
    const idx = read('src/main/index.ts');
    if (!/on\('did-finish-load',[\s\S]{0,200}?rebridgeAllProjectors\(/.test(idx))
      bad.push("src/main/index.ts: the main window's did-finish-load no longer re-bridges the open outputs — a reload leaves them all waiting forever");
    // bridge() runs from did-finish-load, often while the OTHER window is reloading or closing: a
    // disposed frame makes postMessage throw, and uncaught in main that is a modal error box (2026-10-26).
    const br = braceBody(read(P), 'function bridge(');
    if (!br || !/try\s*\{[\s\S]*(?:postMessage|postToPage)[\s\S]*\}\s*catch/.test(br))
      bad.push(P + ': bridge() posts its ports outside a try/catch — a window frame disposed mid-reload throws an uncaught error in main');
    // A DEAD editor renderer (not a reload — the process gone) is never followed by a load on its own,
    // so the re-bridge above never runs and every output waits forever. 2026-10-26: a GPU reset left
    // the Calibrator dead for 28 minutes with nothing in the log. editorRecovery loads it again.
    const R = 'src/main/editorRecovery.ts';
    const rec = exists(R) ? stripComments(read(R)) : '';
    if (!/on\('render-process-gone'/.test(rec)) bad.push(R + ': no render-process-gone listener — a dead editor stays dead');
    if (!/logger\.log\([^)]*'renderer\.gone'/.test(rec)) bad.push(R + ': a renderer death is no longer logged before anything else');
    if (!/othersOwnIt\(\)\)\s*return/.test(rec)) bad.push(R + ': recovery no longer stands down for broadcast/headless/an armed watchdog — two recoveries would race');
    if (!/safe:\s*'1'/.test(rec) || !/n\s*>=\s*4/.test(rec)) bad.push(R + ': the crash-loop ladder (Safe Mode at 3, stop at 4) is gone — a renderer that dies on load would reload forever');
    if (!/guardEditorRenderer\(mainWindow/.test(stripComments(read('src/main/index.ts')))) bad.push('src/main/index.ts: the editor window is not guarded by guardEditorRenderer()');
    return bad.length ? bad.join('; ') : null;
  },
);

// ── Thumbnails: exact, and never at the show's expense ──────────────────────────────────────────
check(
  'an mp4 thumbnail is the exact frame, and neither it nor its save runs while the show plays',
  "mp4's thumbnail() returned the non-blocking frame(): on a GOP it had only just fed, that is null or " +
  'a frame from an EARLIER request — and the thumbnail cache stores what it gets, on disk beside the ' +
  'project, for good. Measured 2026-10-23: a job that ended in 190 ms with nothing stored. Making it exact ' +
  'made every slot pay two costs during playback, both profiled on the RTX box: the exact decode (up to a ' +
  'GOP on the GPU video decoder the show plays from — ~9 extra dropped frames per ten thumbnails with an ' +
  'idle main thread) and the sidecar WebP encode (~43 ms of main thread each). So: thumbnail() awaits ' +
  'frameExact; mp4 declares thumbnailWhilePlaying:false and the pump holds such jobs while the transport ' +
  'runs; and persistence queues while it runs.',
  () => {
    const bad = [];
    const D = 'plugins/mp4/src/mp4Decoder.ts';
    const thumb = braceBody(read(D), 'export async function thumbnail(');
    if (!thumb) bad.push(D + ': thumbnail() not found — this guard cannot see what it protects');
    else if (!/\.frameExact\(/.test(thumb) || /\.frame\(\s*[^)]*,\s*false\s*\)/.test(thumb))
      bad.push(D + ': thumbnail() no longer awaits frameExact — it would store whatever the buffer happens to hold');
    if (!/thumbnailWhilePlaying:\s*false/.test(read('plugins/mp4/src/mp4Codec.ts')))
      bad.push('plugins/mp4/src/mp4Codec.ts: mp4 no longer declares thumbnailWhilePlaying: false — its exact decode would compete with playback');
    const T = 'src/renderer/services/thumbnailCache.ts';
    const tc = read(T);
    const pump = braceBody(tc, 'async function pumpCodec(');
    if (!pump || !/heldWhilePlaying/.test(pump)) bad.push(T + ': pumpCodec no longer holds a codec that opted out of playing time');
    const flush = braceBody(tc, 'async function flushPersist(');
    const persist = braceBody(tc, 'function persist(');
    if (!flush || !/isPlaying\(\)/.test(flush)) bad.push(T + ': the sidecar flush no longer waits for the transport to stop');
    if (persist && /encodeThumb\(/.test(persist)) bad.push(T + ': persist() encodes immediately again — the encode must queue while the show plays');
    return bad.length ? bad.join('; ') : null;
  },
);

// ── Bake: a render gives the surfaces their clock back ───────────────────────────────────────────
check(
  'a bake restores the surface play state it paused',
  'bakeRunner paused every surface clock (contentSource.setPlaying(false)) and its finally never undid ' +
  "it. Surfaces are only re-set by surfaceMedia's sync, which runs on a surface or play-state change — so " +
  'after any bake every MP4/HAP/<video> SURFACE stayed frozen while the timeline kept playing, until the ' +
  'operator happened to press play/pause. It read as "that surface died". Shipped with the bake ' +
  '(4af847f, 2026-09-12), found 2026-10-23 watching a looping MP4 surface stop after a bake.',
  () => {
    const F = 'plugins/bake/src/bakeRunner.ts';
    const src = read(F);
    const pause = src.indexOf('contentSource.setPlaying(false)');
    if (pause < 0) return null; // nothing paused any more — nothing to restore
    const before = src.slice(Math.max(0, pause - 200), pause);
    if (!/=\s*contentSource\.isPlaying\(\)/.test(before)) return F + ': the render pauses surfaces without first recording whether they were playing';
    const fin = src.lastIndexOf('} finally {');
    if (fin < 0 || !/contentSource\.setPlaying\(resumePlaying\)/.test(braceBody(src.slice(fin), 'finally') ?? ''))
      return F + ": the render's finally no longer restores the surface play state it paused";
    return null;
  },
);

// ── MP4: a probe reads the index, opens nothing, and a bad file is a verdict ────────────────────
check(
  'an mp4 probe opens no decoder, and a refused file fails instead of hanging',
  'probe() was ensureOpen(): a full surface decoder — every encoded sample of the track — that no ' +
  'residency owner held, so nothing ever closed it. The thumbnail pump probes every job and the timeline ' +
  'probes every codec clip it syncs, so each probed file stayed resident for the session: measured on a ' +
  '1.36 GB library clip, +2.3 GB of ArrayBuffer storage from ONE thumbnail. Separately, FileDecoder.open() ' +
  'never checked res.ok: a 404/403 is a resolved fetch with an empty body, mp4box ignores an empty buffer ' +
  'without calling onReady or onError, and the promise never settled — one missing .mp4 held the ' +
  "thumbnail pump's codecBusy forever and every later MP4 thumbnail queued behind it. Both compiled, booted " +
  'and threw nothing. Measured 2026-10-23; the index probe answers in ~7 ms where the full open took ~4 s.',
  () => {
    const C = 'plugins/mp4/src/mp4Codec.ts';
    const D = 'plugins/mp4/src/mp4Decoder.ts';
    const codec = read(C);
    const dec = read(D);
    const bad = [];
    const probeLine = /probe:\s*\(path\)\s*=>\s*([^,\n]+)/.exec(codec);
    if (!probeLine) bad.push(C + ': the codec no longer declares probe — this guard cannot see it');
    else if (/ensureOpen|openSurface|thumbnail\(|layerFrame/.test(probeLine[1]))
      bad.push(C + ': probe opens a decoder again (' + probeLine[1].trim() + ') — nothing owns what it opens');
    const probeIndex = braceBody(dec, 'async function probeIndex(');
    const probeFn = braceBody(dec, 'export function probe(');
    const readIndex = braceBody(dec, 'async function readIndex(');
    if (!probeIndex || !probeFn || !readIndex) bad.push(D + ': probeIndex()/probe()/readIndex() not found — this guard cannot see what it protects');
    else {
      if (/new FileDecoder\(|ensureOpen\(|\.open\(|acquireStore\(/.test(probeIndex + probeFn)) bad.push(D + ': the index probe constructs or opens a decoder/store');
      if (!/readIndex\(/.test(probeIndex)) bad.push(D + ': the index probe no longer goes through the ranged readIndex()');
      if (!/Range:/.test(readIndex)) bad.push(D + ': readIndex() no longer reads by byte range — it would read the whole file');
      if (!/!res\.ok/.test(readIndex)) bad.push(D + ': readIndex() no longer fails on a refused/missing file');
    }
    // Since step 2 the read lives behind acquireStore; since step 3 a normal file is read by GOP and only
    // a file the index cannot describe falls back to loadWholeStore(). FileDecoder.open() must go through
    // acquireStore — a decoder that fetched for itself would bring back one private copy per pool (3×).
    const load = braceBody(dec, 'async function loadStore(');
    const whole = braceBody(dec, 'async function loadWholeStore(');
    const open = braceBody(dec, 'async open(path: string)');
    if (!load || !whole) bad.push(D + ': loadStore()/loadWholeStore() not found — this guard cannot see what it protects');
    else {
      if (!/readIndex\(/.test(load)) bad.push(D + ': loadStore() no longer tries the ranged index first — every open would read the whole file');
      // The older "asks the decoder before claiming a file" check is satisfied by the whole-file path
      // alone, so it cannot see the ranged path drop its gate — which is the path nearly every file takes.
      if (!/isConfigSupported\([\s\S]*?if \(!\w+\.supported\)\s*\{[^}]*return null/.test(load)) bad.push(D + ': the ranged loadStore() path no longer declines a file WebCodecs cannot configure');
      if (!/!res\.ok/.test(whole)) bad.push(D + ': loadWholeStore() no longer checks res.ok — a 404 hangs every opener forever');
      if (!/if \(!readied\) done\(null\)/.test(whole)) bad.push(D + ': loadWholeStore() no longer settles when the file has no moov');
    }
    // Step 3: a sample whose GOP is not resident must STOP the feed, never be skipped — advancing past it
    // would decode every later delta against a missing reference.
    const pump = braceBody(dec, 'private pump(');
    if (pump) {
      // Not just "the check comes first": the block must STOP the feed. A version that only counted the
      // miss and carried on passed an order-only test (mutation-tested 2026-10-23) and would have fed a
      // chunk with no bytes.
      const m = /if \(!data\)\s*\{[^}]*\bbreak;\s*\}/.exec(pump);
      const adv = pump.indexOf('this.fedAbs = next');
      if (!m || adv < 0 || m.index > adv) bad.push(D + ': pump() must stop the feed (if (!data) { … break; }) when a sample\'s bytes are not resident, BEFORE advancing fedAbs');
    }
    if (!open) bad.push(D + ': FileDecoder.open() not found');
    else if (!/acquireStore\(/.test(open) || /fetch\(|createFile\(/.test(open))
      bad.push(D + ': FileDecoder.open() reads/demuxes the file itself again instead of taking the shared store — one private copy per pool');
    return bad.length ? bad.join('; ') : null;
  },
);

// ── MP4: pre-rolling a standby scene never takes the live layer decoder ────────────────────────
check(
  "an mp4 pre-roll never takes over a layer decoder that is on screen",
  'Layer decoders are keyed by layerId alone, and two scenes share layer ids whenever one was captured ' +
  'from another (Capture Scene clones the timeline, ids included). The preloader pre-rolls every standby ' +
  'scene every 250 ms; preRoll(…, layerId) went to ensureLayerOpen, which closed the decoder the LIVE ' +
  'scene was playing because "the file changed", and the live scene reopened its own a frame later. ' +
  'Found 2026-10-24 cycling four states on the RTX box: a dropped picture every 250 ms, painted with the ' +
  "previous state's last frame — the operator saw it as flicker. BOTH warm doors (preWarmLayer and " +
  'preRoll) must leave a recently-read decoder on another file alone, and both readers must stamp readAt.',
  () => {
    const bad = [];
    const D = 'plugins/mp4/src/mp4Decoder.ts';
    const src = read(D);
    // BOTH warm doors — the first fix guarded preRoll only, and preWarmLayer (called just before it on
    // the same 250 ms top-up) kept closing the live decoder: the flicker measured unchanged.
    for (const fn of ['export function preRoll(', 'export function preWarmLayer(']) {
      const body = braceBody(src, fn);
      if (!body) { bad.push(D + `: ${fn.slice(16)}) not found — this guard cannot see what it protects`); continue; }
      const guard = body.search(/layerInUseElsewhere\(/);
      const open = body.indexOf('ensureLayerOpen(');
      if (guard < 0) bad.push(D + `: ${fn.slice(16)}) no longer asks layerInUseElsewhere before opening — it would close the live layer decoder`);
      else if (open >= 0 && open < guard) bad.push(D + `: ${fn.slice(16)}) can reach ensureLayerOpen before its live-decoder guard`);
    }
    const helper = braceBody(src, 'function layerInUseElsewhere(');
    if (!helper || !/cur\.path\s*!==\s*path/.test(helper) || !/readAt/.test(helper)) bad.push(D + ': layerInUseElsewhere() no longer tests "another file, recently read"');
    if (!/preWarmLayer:\s*\([^)]*\)\s*=>\s*dec\.preWarmLayer\(/.test(read('plugins/mp4/src/mp4Codec.ts')))
      bad.push('plugins/mp4/src/mp4Codec.ts: preWarmLayer must go through dec.preWarmLayer (the guarded door), not ensureLayerOpen');
    for (const fn of ['export function layerFrame(', 'export async function layerFrameExact(']) {
      const b = braceBody(src, fn);
      if (!b || !/\.readAt\s*=\s*performance\.now\(\)/.test(b)) bad.push(D + `: ${fn.replace(/^export (async )?function /, '')}) no longer stamps readAt — preRoll would take over the decoder it reads`);
    }
    return bad.length ? bad.join('; ') : null;
  },
);

// ── NDI send follows the same liveness rule as the projector window ───────────────────────────
check(
  'an output that opens a projector window also gets its NDI sender (windowed included)',
  'App reconciles projector windows and NDI senders separately. The window rule accepted ' +
  'WINDOWED_DISPLAY; the NDI rule only accepted a real display, so a windowed output opened, captured ' +
  'frames and never got a sender — "Send as NDI" did nothing and ndi:list stayed empty. Found ' +
  '2026-10-24 by the battle test (ArtLux receiving its own NDI output).',
  () => {
    const F = 'src/renderer/App.tsx';
    const s = stripComments(read(F));
    const i = s.indexOf("'ndi:send-configure'");
    if (i < 0) return F + ': NDI send reconcile not found — this guard cannot see what it protects';
    const block = s.slice(Math.max(0, i - 1200), i);
    if (!/displayId\s*===\s*WINDOWED_DISPLAY/.test(block)) return F + ': the NDI send reconcile no longer treats a windowed output as live';
    return null;
  },
);

// ── A 3D screen reallocates its texture when the source changes size ──────────────────────────
check(
  'a 3D screen shows the whole picture when the surface picture changes size',
  'The WebGPU backend sizes a texture\'s storage at its first upload and copies later images INTO it. ' +
  'A multi-track surface\'s composite starts at 640 px and grows to the video\'s 1920, so a 3D screen ' +
  'showed only the top-left corner of the picture, stretched — and a centred title was simply missing. ' +
  'Reallocating (dispose, or a fresh texture object) froze the screen for good on WebGPU, so a resized ' +
  'source is drawn into a staging canvas of the born size instead. Found 2026-10-24 building the ' +
  'interactive-show template.',
  () => {
    const F = 'src/renderer/components/Simulator3D/surfaceTextureCache.ts';
    const s = stripComments(read(F));
    if (!/\(w\s*!==\s*e\.w\s*\|\|\s*h\s*!==\s*e\.h\)\)\s*\{[\s\S]{0,400}drawImage\([\s\S]{0,60}e\.w,\s*e\.h\)/.test(s)) return F + ': a source at another size is no longer rescaled into the texture\'s born size';
    if (/e\.tex\s*=\s*newCanvasTexture\(\)[\s\S]{0,40}\}\s*\n?\s*e\.w\s*=/.test(s)) return F + ': a size change swaps the texture object again — that froze the screen on WebGPU';
    return null;
  },
);

// ── A 3D plane is sized by scale, never by its geometry args ──────────────────────────────────
check(
  'no 3D plane is sized through planeGeometry args (a geometry swap freezes the WebGPU 3D view)',
  'The LiDAR overlay sized its translucent floor/wall planes with <planeGeometry args={[W, D]}>. The first ' +
  'tracking packet changes W/D (5.825 arrives as float32 5.82499…), r3f then REPLACES the geometry of a ' +
  'mesh that has already drawn, and on WebGPU three keeps the old vertex-buffer bindings: "Vertex buffer ' +
  'slot 1 required by [RenderPipeline MeshBasicMaterial_N] was not set" rejects every frame and the 3D view ' +
  'froze for good the moment somebody walked in (wall screens stuck on the previous state). Found ' +
  '2026-10-24. Use a 1×1 plane and the mesh\'s scale — a transform, never a new geometry.',
  () => {
    const bad = [];
    for (const f of [...walk('src/renderer'), ...walk('plugins')]) {
      if (!f.endsWith('.tsx')) continue;
      const s = stripComments(read(f));
      for (const m of s.matchAll(/<planeGeometry\s+args=\{([^}]*)\}/g)) {
        if (/[A-Za-z_$]/.test(m[1])) bad.push(`${f}: <planeGeometry args={${m[1].trim()}}> — size it with the mesh's scale instead`);
      }
    }
    return bad.length ? bad.join('\n') : null;
  },
);

// ── A 3D polyline is rebuilt only when its shape changes ──────────────────────────────────────
check(
  'a 3D polyline is rebuilt when its points change by VALUE, not on every render',
  'PolyLine memoised on the `points` array, which every caller builds inline — so each render of the ' +
  'tracking overlay (4×/s plus every tracking update) built a new Line + material and WebGPU compiled a ' +
  'new render pipeline: ~40 compiles in 10 s with three zones on screen. Found 2026-10-24.',
  () => {
    const F = 'src/renderer/components/Simulator3D/PolyLine.tsx';
    const s = stripComments(read(F));
    if (/\}\s*,\s*\[\s*points\s*,/.test(s)) return F + ': the line memo depends on the points ARRAY again (new every render)';
    if (!/\}\s*,\s*\[\s*shape\s*,/.test(s)) return F + ': the line memo is no longer keyed on the points\' values (`shape`)';
    return null;
  },
);

// ── A zone nobody has entered yet is empty ─────────────────────────────────────────────────────
check(
  'a trigger zone is empty from the moment it is watched (emptyFor works before anyone has entered it)',
  'A fresh zone state carried emptySinceMs = 0, which emptyFor reads as "not empty at all", so a ' +
  'zone nobody had stepped into could never be "empty for 6 s" — and a room-empty rule over ALL zones ' +
  'held the show until a visitor had crossed every one. Found 2026-10-24 in the interactive-show template.',
  () => {
    const F = 'plugins/lidar-tracking/src/zones.ts';
    const s = stripComments(read(F));
    if (!/states\.get\(z\.id\)\s*\?\?\s*\{\s*\.\.\.blank\(z\.id\),\s*emptySinceMs:\s*nowMs\s*\}/.test(s)) return F + ': a newly watched zone no longer starts its empty clock at nowMs';
    return null;
  },
);

// ── Broadcast never runs a project that is not there ──────────────────────────────────────────
check(
  'broadcast never switches into, or silently runs, a project file that does not exist',
  'A stale playlist entry pointed at a deleted temp show. On every broadcast launch the scheduler ' +
  'relaunched into it within a second, the read failed, and the renderer logged "loaded project" and ran ' +
  'an EMPTY document — no outputs, no screen, and the operator\'s own project gone. Found 2026-10-24 ' +
  '(owner: "no screen appears"). The scheduler now skips a missing target and the loader falls back to ' +
  'the last-opened project.',
  () => {
    const bad = [];
    const S = 'plugins/show-control/src/scheduler.ts';
    const sch = stripComments(read(S));
    const relaunches = sch.match(/relaunchBroadcast\(due\.entry\.projectPath\)/g) || [];
    const guarded = sch.match(/reachable\(due\.entry\.projectPath\)\)\s*\{?\s*relaunchBroadcast\(due\.entry\.projectPath\)/g) || [];
    if (!relaunches.length) bad.push(S + ': the playlist relaunch was not found — this guard cannot see what it protects');
    else if (guarded.length !== relaunches.length) bad.push(S + ': a playlist relaunch into a due entry no longer checks the file exists (reachable)');
    if (!/existsSync\(/.test(sch)) bad.push(S + ': reachable() no longer checks existsSync');
    const A = 'src/renderer/App.tsx';
    const app = stripComments(read(A));
    const i = app.indexOf('loaded project: ${path}');
    if (i < 0) bad.push(A + ': the show-engine project loader was not found');
    else if (!/if\s*\(!data\)\s*\{[\s\S]{0,200}?continue;/.test(app.slice(Math.max(0, i - 800), i))) bad.push(A + ': the show-engine loader no longer skips a project that failed to load');
    return bad.length ? bad.join('\n') : null;
  },
);

// ── GPU crash: the LEDs and the projectors come back on their own ─────────────────────────────
check(
  'a lost GPU device is rebuilt — LEDs and projector outputs recover from a GPU-process crash',
  'A GPU-process crash (driver reset, driver crash, GPU OOM) killed the LED mapper\'s GPUDevice, and ' +
  'nothing listened: every read-back failed into a silent catch, so the output sent ONE FROZEN FRAME ' +
  'forever while render_fps / output_fps / the decoders all read healthy, and every projector output ' +
  'went black for good. Measured 2026-10-24 (plans/battle-test-v0.33.8.md Phase 3): frozen 59 s of 60 ' +
  'in editor and broadcast. After the second crash Chromium also blocked WebGPU+WebGL for the page. ' +
  'Fixed: device.lost -> engine rebuilds the mapper (~0.5 s, twice in a row), 3D-API domain blocking off, ' +
  'projectors reload on webglcontextlost and main re-bridges every load, the loss rides the heartbeat to ' +
  'a metric + an armed watchdog, and relaunches keep --user-data-dir.',
  () => {
    const bad = [];
    const M = 'src/renderer/gpu/WebGPUMapper.ts', E = 'src/renderer/engine/frameEngine.ts';
    const mapper = stripComments(read(M));
    if (!/device\.lost\.then\([\s\S]{0,200}onDeviceLost/.test(mapper)) bad.push(M + ': the constructor no longer forwards device.lost to onDeviceLost');
    const eng = stripComments(read(E));
    if (!/onDeviceLost\s*=\s*\([^)]*\)\s*=>\s*this\.recoverFromDeviceLoss/.test(eng)) bad.push(E + ': initMapper no longer wires onDeviceLost to recoverFromDeviceLoss');
    const rec = braceBody(read(E), 'private recoverFromDeviceLoss(');
    if (!rec || !/this\.initMapper\(/.test(rec)) bad.push(E + ': recoverFromDeviceLoss no longer rebuilds through initMapper');
    if (!/app\.disableDomainBlockingFor3DAPIs\(\)/.test(stripComments(read('src/main/index.ts')))) bad.push('src/main/index.ts: app.disableDomainBlockingFor3DAPIs() is gone — the second GPU crash blocks WebGPU/WebGL for the page');
    const pj = stripComments(read('src/main/projector.ts'));
    // (`=> {` too: since E1f-3 the handler also re-sends the native engine's "covered" state.)
    if (/webContents\.once\(\s*'did-finish-load',\s*\(\)\s*=>\s*(?:\{\s*)?bridge\(/.test(pj) || !/webContents\.on\(\s*'did-finish-load',\s*\(\)\s*=>\s*(?:\{\s*)?bridge\(/.test(pj)) bad.push('src/main/projector.ts: a projector must be bridged on EVERY load (.on), or a reloaded output stays dark');
    const pa = stripComments(read('src/renderer/projector/ProjectorApp.tsx'));
    if (!/addEventListener\(\s*'webglcontextlost'/.test(pa) || !/location\.reload\(\)/.test(pa)) bad.push('src/renderer/projector/ProjectorApp.tsx: a lost WebGL context no longer reloads the output');
    const rp = braceBody(read('src/main/runProfile.ts'), 'export function relaunchArgs(');
    if (!rp || !/--user-data-dir=/.test(rp)) bad.push('src/main/runProfile.ts: relaunchArgs() no longer carries --user-data-dir — a relaunch lands on the default profile');
    const wd = stripComments(read('src/main/watchdog.ts'));
    if (!/gpuDeviceLost/.test(wd) || !/'gpu-device-lost'/.test(wd)) bad.push('src/main/watchdog.ts: the watchdog no longer relaunches on an unrecovered GPU device loss');
    if (/maybeRelaunch\(\s*'gpu-gone'/.test(wd)) bad.push('src/main/watchdog.ts: a GPU crash relaunches immediately again — the app recovers in place in ~0.5 s; relaunch only via gpu-device-lost');
    // The rest of the window's GPU users, measured one by one after the LEDs were fixed (each went
    // black or froze for good after a crash): HAP, the three tracking overlays, text, the 3D view.
    const hap = braceBody(read('plugins/hap/src/hapGL.ts'), 'export function uploadFrame(');
    if (!hap || !/\.isLost\(\)/.test(hap)) bad.push('plugins/hap/src/hapGL.ts: uploadFrame no longer rebuilds a renderer whose WebGL context was lost');
    if (hap && !/RETRY_FAILED_MS/.test(hap)) bad.push('plugins/hap/src/hapGL.ts: a failed renderer construction is cached for ever again — it must be retried');
    for (const f of ['plugins/lidar-tracking/src/trackingDrawable.ts', 'plugins/augmenta/src/augmentaDrawable.ts', 'plugins/mediapipe/src/poseDrawable.ts']) {
      const g = braceBody(read(f), 'function getGL(');
      if (!g || !/isContextLost\(\)/.test(g)) bad.push(f + ': getGL no longer rebuilds a lost WebGL context');
    }
    if (!/onGpuLost\(/.test(stripComments(read('plugins/text/src/textRaster.ts')))) bad.push('plugins/text/src/textRaster.ts: the raster cache no longer drops its GPU-backed bitmaps on GPU loss');
    if (!/dispatchEvent\(new Event\(GPU_LOST_EVENT\)\)/.test(rec ?? '')) bad.push(E + ': recoverFromDeviceLoss no longer announces GPU_LOST_EVENT to the window');
    const s3 = stripComments(read('src/renderer/components/Simulator3D/Simulator3D.tsx'));
    if (!/SCENE3D_LOST_EVENT/.test(s3) || !/key=\{glEpoch\}/.test(s3)) bad.push('src/renderer/components/Simulator3D/Simulator3D.tsx: the 3D canvas no longer remounts after its device is lost');
    return bad.length ? bad.join('; ') : null;
  },
);

// ── NDI: a source that is not on the network yet is retried ───────────────────────────────────
check(
  'an NDI receive that cannot find its source retries instead of giving up',
  'startRecv logged "connect failed ndi source not found" and returned, so a surface whose sender came ' +
  'up after ArtLux stayed dark for the life of the process. Found 2026-10-24 with NDI Tools Test ' +
  'Patterns: sender first worked at once; ArtLux first, sender 15 s later, still dark 20 s after.',
  () => {
    const F = 'plugins/ndi/src/ndiManager.ts';
    const body = braceBody(read(F), 'export function startRecv(');
    if (!body) return F + ': startRecv() not found — this guard cannot see what it protects';
    const c = /catch\s*\(e\)\s*\{([\s\S]*?)\n\s{4}\}/.exec(body);
    if (!c || !/setTimeout\(\s*attempt/.test(c[1])) return F + ': startRecv()\'s connect failure no longer schedules a retry';
    if (!/clearTimeout\(recvRetry\)/.test(braceBody(read(F), 'export function stopRecv(') ?? '')) return F + ': stopRecv() must cancel a pending connect retry';
    return null;
  },
);

// ── Every non-video layer kind is registered as one ───────────────────────────────────────────
check(
  'every non-video LayerKind is registered as a clip kind that skips video sync',
  'The timeline decides "is this lane a picture?" by asking clipKindRegistry. Plugin lanes register ' +
  'themselves; the core LIGHTING lane did not, so its clip (path "") went through the per-frame video ' +
  'sync, warmMedia and the cold-start gate as a video. The gate waited for a <video> that could never ' +
  'load and armed by timeout — every project opening on a lighting take started 15 s late, logging ' +
  '"never became ready: " with an empty name. Found 2026-10-24 by the battle-test examples sweep.',
  () => {
    const kinds = /export type LayerKind\s*=\s*([^;]+);/.exec(read('src/renderer/types.ts'));
    if (!kinds) return 'src/renderer/types.ts: LayerKind not found — this guard cannot see what it protects';
    const all = [...kinds[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]).filter(k => k !== 'video');
    const sources = [stripComments(read('src/renderer/host/registries.ts'))];
    for (const d of fs.readdirSync(path.join(ROOT, 'plugins'))) {
      const f = path.join('plugins', d, 'src', 'plugin.renderer.ts');
      if (fs.existsSync(path.join(ROOT, f))) sources.push(stripComments(read(f)));
    }
    const bad = all.filter(k => !sources.some(s => new RegExp(`kind:\\s*'${k}'[^}]*skipVideoSync:\\s*true`).test(s)));
    return bad.length ? `no clip-kind registration with skipVideoSync: true for LayerKind ${bad.map(k => `'${k}'`).join(', ')}` : null;
  },
);

// ── 3D: named screens inside a GLB are decided in ONE place ───────────────────────────────────
check(
  'GLB renderers assign materials through modelScreens',
  'An object named screen… in Blender takes its own content. The editor (ModelObject) and the wall ' +
  '(calibration ProjectorScene) each paint the same GLB; if either decides on its own which meshes are ' +
  'a screen, or swaps materials with its own traverse, a screen looks right in the 3D view and shows ' +
  'the wrong picture on the projector — the one place nobody is looking while editing. And the frame ' +
  'pump must ask modelBindings(), or a screen bound to a surface is never streamed to the window.',
  () => {
    const bad = [];
    for (const f of ['src/renderer/components/Simulator3D/ModelObject.tsx', 'plugins/calibration/src/ProjectorScene.tsx']) {
      if (!exists(f)) { bad.push(`${f} (missing)`); continue; }
      const src = stripComments(read(f));
      if (!src.includes('findScreens(') || !src.includes('assignContentMaterials(')) bad.push(`${f}: not using findScreens()/assignContentMaterials()`);
      if (/mesh\.material\s*=/.test(src)) bad.push(`${f}: assigns mesh.material itself`);
    }
    const app = stripComments(read('src/renderer/App.tsx'));
    if ((app.match(/modelBindings\(/g) ?? []).length < 3) bad.push('src/renderer/App.tsx: frame pump / program retain no longer read modelBindings()');
    return bad.length ? bad.join('; ') : null;
  },
);

// ── Calibration: what the 2026-10-24 Manual-flow test on the Blender venue found ─────────────────
check(
  'vertex snap only takes a vertex the camera can see',
  'The snap gate was relative (20% deeper than the hit), and a venue wall defeats it: a 0.2 m wall ' +
  'seen from 9 m puts its hidden back corner 2% deeper and ~2 px from the front one. Two such picks ' +
  'moved the solved projector 0.7 m at a "good" 1.4 px RMS, with nothing on screen to say so.',
  () => {
    const src = stripComments(read('src/renderer/components/Simulator3D/vertexSnap.ts'));
    const body = fnBody(src, 'bestVertex');
    if (!body) return 'vertexSnap.ts: bestVertex not found — this guard cannot see what it protects';
    return body.includes('intersectObject(') ? null : 'bestVertex no longer ray-tests the winning vertex for visibility';
  },
);

check(
  'projector verify looks refresh node matrices before baking them',
  'wireClone runs before the first render, when recenterClone has written cloned.position but not ' +
  'cloned.matrix — so the edges/wireframe looks (and the picking underlay) drew the venue offset by ' +
  'its bbox centre: 2 m high on the Blender test venue, right after Apply & finish.',
  () => {
    const src = stripComments(read('plugins/calibration/src/ProjectorScene.tsx'));
    const i = src.indexOf('const walk = (obj: THREE.Object3D');
    if (i < 0) return 'ProjectorScene.tsx: the wireClone walk is gone — this guard cannot see what it protects';
    return /updateMatrix\(\)/.test(src.slice(i, i + 400)) ? null : 'the wireClone walk reads obj.matrix without updateMatrix()';
  },
);

check(
  'host.project.save waits for a commit before serialising',
  'A plugin patch only queues a state update; the save builds the last RENDERED document. Every ' +
  'calibration wizard patches useCalibration then saves, so the file kept render-from-projector OFF ' +
  'and an output fell back to the flat warp after a restart.',
  () => {
    const src = stripComments(read('src/renderer/App.tsx'));
    const i = src.indexOf('save: async () => {');
    if (i < 0) return 'App.tsx: host.project.save not found — this guard cannot see what it protects';
    const body = src.slice(i, i + 400);
    return body.indexOf('await afterCommit()') >= 0 && body.indexOf('await afterCommit()') < body.indexOf('buildProjectDataRef.current()')
      ? null : 'host.project.save serialises without awaiting afterCommit() first';
  },
);

check(
  'a projector starting pose is never a calibration',
  'poseSeeded (a camera named projector… in the venue file) lets PICKING predict from where the ' +
  'modeller put the projector. If anything that means "this output is calibrated" accepted it, an ' +
  'output would render the venue from a guess nobody has checked against the room.',
  () => {
    const bad = [];
    for (const f of ['src/renderer/App.tsx', 'src/renderer/components/OutputsPanel.tsx', 'plugins/calibration/src/blendController.ts', 'plugins/calibration/src/projectedScene.ts']) {
      if (exists(f) && /poseSeeded|hasPickingPose/.test(stripComments(read(f)))) bad.push(f);
    }
    const ws = stripComments(read('plugins/calibration/src/calibWorkspace.ts'));
    if (!ws.includes('hasPickingPose(cal)')) bad.push('calibWorkspace.ts no longer predicts picks from hasPickingPose');
    return bad.length ? `a calibrated-output test reads the starting pose: ${bad.join(', ')}` : null;
  },
);

check(
  'a plugin save rebases the unsaved-changes light',
  'host.project.save wrote the file but never told the dirty check, so after every calibration ' +
  'wizard\'s Apply & finish the title read "Unsaved changes" over a file that was already correct.',
  () => {
    const src = stripComments(read('src/renderer/App.tsx'));
    const i = src.indexOf('save: async () => {');
    if (i < 0) return 'App.tsx: host.project.save not found — this guard cannot see what it protects';
    // Since E5/W3c the rebase is markDocSaved(data): it signs savedDocRef AND rebases the Show Host.
    return /markDocSaved\(data, p\)/.test(src.slice(i, i + 900)) ? null : 'host.project.save no longer rebases the unsaved-changes baselines (markDocSaved(data)) on what it wrote';
  },
);

check(
  'looking through a projector keeps the camera fov honest',
  'ProjectorView writes the projection MATRIX; TransformControls sizes its gizmo from camera.fov. ' +
  'With the orbit fov left behind, a selected model\'s gizmo filled the whole pane.',
  () => {
    const src = stripComments(read('src/renderer/components/Simulator3D/Simulator3D.tsx'));
    const i = src.indexOf('const ProjectorView');
    if (i < 0) return 'Simulator3D.tsx: ProjectorView not found — this guard cannot see what it protects';
    const body = src.slice(i, i + 3000);
    if (!/cam\.fov\s*=/.test(body)) return 'ProjectorView no longer sets camera.fov from the projector';
    if (!/updateProjectionMatrix\(\)/.test(body)) return 'ProjectorView no longer restores the orbit camera on exit';
    return null;
  },
);

check(
  'GLB content is read with glTF\'s v convention, model-wide',
  'glTF puts v = 0 at the top; ArtLux content textures at the bottom. A Blender mesh unwrapped ' +
  'upright showed its content upside down, first on named screens, then on whole-model bindings. ' +
  'Every mesh wearing content must wear the v-flipped twin.',
  () => {
    const src = stripComments(read('src/renderer/components/Simulator3D/modelScreens.ts'));
    const body = fnBody(src, 'assignContentMaterials');
    if (!body) return 'modelScreens.ts: assignContentMaterials not found — this guard cannot see what it protects';
    const w = body.indexOf('if (want)');
    const e = body.indexOf('} else {', w);
    return w >= 0 && e > w && body.slice(w, e).includes('flippedUv(') ? null : 'content is worn without the v-flipped geometry';
  },
);

check(
  'a native .blend import stays live, portable and in place',
  'A .blend is re-exported OVER the same .glb path on every save in Blender, so (1) every window that ' +
  'caches a model by path must drop it on BLEND_UPDATED or keep the old geometry — the projector ' +
  'included; (2) the .blend must travel with the project or a moved show loses what it is edited ' +
  'from; (3) it must keep its file origin, or adding geometry in Blender recentres the model and ' +
  'moves everything — measured: screen_main slid left when a second screen was added.',
  () => {
    const bad = [];
    for (const f of ['src/renderer/components/Simulator3D/useModelUrls.ts', 'plugins/calibration/src/CalibProjector.tsx', 'plugins/calibration/src/venueRegistrar.ts']) {
      if (!stripComments(read(f)).includes('onBlendUpdated')) bad.push(`${f} does not reload on BLEND_UPDATED`);
    }
    const pf = stripComments(read('src/main/projectFolder.ts'));
    if (!/m\?\.source/.test(pf)) bad.push('projectFolder.mapScene3D no longer maps SceneModel.source');
    const app = stripComments(read('src/renderer/App.tsx'));
    const i = app.indexOf('const handleAddModel');
    if (i < 0 || !app.slice(i, i + 2500).includes("origin: 'file'")) bad.push("handleAddModel no longer gives a .blend origin: 'file'");
    const vp = stripComments(read('src/renderer/components/Simulator3D/venuePlacement.ts'));
    if (!/origin === 'file'/.test(vp)) bad.push("recenterClone no longer honours origin: 'file'");
    return bad.length ? bad.join('; ') : null;
  },
);

check(
  'projector edge lines never use a wireframe material',
  'A material with wireframe:true makes three re-index whatever it draws as TRIANGLES. The edges look ' +
  'shared one with its LineSegments, so crease edges were redrawn as phantom triangles — one edge ' +
  'dropped and lines to the model origin — on the overlay operators align the real object against.',
  () => {
    const src = stripComments(read('plugins/calibration/src/ProjectorScene.tsx'));
    return /new THREE\.LineSegments\([^)]*wireMatRef/.test(src) ? 'ProjectorScene draws LineSegments with the wireframe mesh material' : null;
  },
);

check(
  'a render-active projector streams its own surface when a mesh shows it',
  'Image/effect/shader/text surfaces self-render in the projector window and are not streamed. In ' +
  'render-from-projector the window draws the 3D scene instead, so a mesh bound to its OWN surface ' +
  'stayed blank — a shader test card on its own projector\'s screen, measured on the template.',
  () => {
    const src = stripComments(read('src/renderer/App.tsx'));
    return /!STREAMED\.has\(eff\.content\.type\)\s*&&\s*!\(renderActive && ownReferenced\)/.test(src)
      ? null : 'the own-surface pump filters by STREAMED even when a render-active mesh is bound to it';
  },
);

check(
  'the 3D canvas region can shrink with its pane',
  'A flex child\'s min-height defaults to its content, and the content is a canvas r3f sizes in pixels ' +
  'from that box. Without min-h-0, a pane that had once been tall (the Calib context) kept the canvas ' +
  'at that height after it shrank: the view\'s centre sat under the dock, and looking through a ' +
  'projector showed the picture shifted down with its bottom cut off.',
  () => {
    const src = read('src/renderer/components/Simulator3D/Simulator3D.tsx');
    return /<div className="flex-1 min-h-0 relative">/.test(src) ? null : 'the Simulator3D canvas region lost min-h-0';
  },
);

check(
  'projector panels get the window state replayed when they subscribe',
  'Main pushes config / scene / calib to a projector window ONCE, and a panel plugin can subscribe ' +
  'after that (plugins activate asynchronously). A late calibration panel never learned it was in ' +
  'render mode: a calibrated output came up flat after a restart, reproducibly on the curved template.',
  () => {
    const src = stripComments(read('src/renderer/projector/ProjectorApp.tsx'));
    const bad = [];
    if (!/panelStateRef\.current\.set\('calib', eff\)/.test(src)) bad.push('applyCalibMode no longer records the effective calib for replay');
    if (!/panelStateRef\.current\.set\(m\.t, m\)/.test(src)) bad.push('config/scene are no longer recorded for replay');
    if (!/onMessage: \(cb\) => \{[\s\S]{0,200}panelStateRef\.current\.get/.test(src)) bad.push('onMessage no longer replays the recorded state to a new panel');
    return bad.length ? bad.join('; ') : null;
  },
);

check(
  'clearing calibration points returns to the projector starting pose',
  'A solve replaces the starting pose taken from the venue file; with it gone, Clear points (or ' +
  'deleting below 4) fell back to NO pose and threw away the head start. poseSeed keeps it.',
  () => {
    const src = stripComments(read('plugins/calibration/src/calibWorkspace.ts'));
    const body = fnBody(src, 'clearPoses');
    if (!body) return 'calibWorkspace.clearPoses not found — this guard cannot see what it protects';
    return body.includes('unsolvedPose(') && /cal\?\.poseSeed/.test(src) ? null : 'clearPoses no longer restores poseSeed';
  },
);

// ── Multi-projector: what the two-projector curved template found (2026-10-24) ─────────────────
check(
  'the rig blend weighs by distance to the projector IMAGE frame',
  'Weighing by distance to the lit FOOTPRINT let a screen\'s top/bottom silhouette cap every weight, so ' +
  'two side-by-side projectors split the overlap ~50/50 instead of cross-fading: 1.45x the light across ' +
  'it on the curved panorama. scripts/test-blend.ts has the case; this keeps the cause from returning.',
  () => {
    const src = stripComments(read('plugins/calibration/src/blendCompute.ts'));
    return /dist:\s*frameWeight\(/.test(src) ? null : 'computeBlendMaps no longer weighs by frameWeight()';
  },
);

check(
  'the calibrated render applies its blend to the display-encoded signal',
  'The BlendEffect runs in linear light and the composer sRGB-encodes afterwards; multiplying linear ' +
  'colour by the already display-referred share^(1/g) encoded the blend twice (alpha 0.52 → 0.87).',
  () => /blendEncodeSRGB\(inputColor\.rgb\)/.test(read('plugins/calibration/src/ProjectorScene.tsx'))
    ? null : 'ProjectorScene blendFrag multiplies the linear colour by the blend signal again',
);

check(
  'an imported rig file plays its blend',
  'MPCDI import parsed each region\'s alphaMap and then sent the projector only the geometry, so an ' +
  'imported multi-projector rig warped correctly and doubled the light in every overlap.',
  () => {
    const bad = [];
    if (!/alpha: r\.alpha/.test(stripComments(read('plugins/calibration/src/bakedStore.ts')))) bad.push('bakedStore no longer sends the region alpha');
    if (!/setBakedAlpha\(/.test(stripComments(read('src/renderer/projector/ProjectorApp.tsx')))) bad.push('ProjectorApp no longer uploads it');
    if (!/uHasAlpha/.test(read('src/renderer/projector/ProjectorGL.ts'))) bad.push('the baked shader no longer applies it');
    return bad.length ? bad.join('; ') : null;
  },
);

check(
  'finishing a calibration hands the show the shaded look',
  'The projector window keeps the last look it was given; the wizard leaves it on edges, so after ' +
  'Apply & finish an output drew the wireframe instead of the content until its window was reopened.',
  () => /t: 'calib', mode: 'render', calibration: out!\.calibration, meshLook: 'shaded'/.test(read('src/renderer/App.tsx'))
    ? null : 'the show-mode render message no longer sets meshLook: shaded',
);

check(
  'a calibrated output renders in a plain launch, not only under --calibrate',
  'Main switches a calibrated output to render-from-projector from the project alone, in every launch. ' +
  'With the projector panel registered below the authoring gate, a plain launch of a calibrated project ' +
  'gave each projector nothing to render with: black projectors, nothing logged.',
  () => {
    const src = stripComments(read('plugins/calibration/src/plugin.renderer.ts'));
    const reg = src.indexOf("projectorPanels.register({ id: 'calibration'"), gate = src.indexOf('if (!isAuthoringLaunch()) return');
    if (reg < 0 || gate < 0) return 'plugin.renderer.ts: the projector panel or the authoring gate is gone — this guard cannot see what it protects';
    return reg < gate ? null : 'the projector panel is registered after the authoring gate again';
  },
);

check(
  'a calibrated rig blends by projection, not by voxel',
  'A rig whose projectors are all calibrated knows where each point lands on every other projector, so ' +
  'the blend is computed exactly (computeBlendMapsProjected). The voxel path quantised the overlap into ' +
  'blocky patches and ±8% of light; it stays for camera-scanned rigs only.',
  () => /traced \? computeBlendMapsProjected\(/.test(stripComments(read('plugins/calibration/src/blendController.ts')))
    ? null : 'solveRig no longer uses the exact path for a calibrated rig',
);

check(
  'a calibrated rig blend is traced on the GPU at an overlap-sized grid',
  'The CPU trace is a Raycaster with no BVH, held to a fixed 160-wide grid, and that grid IS the blend: ' +
  'an 8% overlap got 13 cells and stepped by ~8% of the light per cell (banding). solveRig renders each ' +
  'projector world map on the GPU (bakeWorld) and sizes the grid from the narrowest overlap ' +
  '(narrowestOverlap -> adaptiveBlendWidth); the CPU trace is only the fallback when no venue is registered.',
  () => {
    const src = stripComments(read('plugins/calibration/src/blendController.ts'));
    if (!/bakeWorld\(/.test(src)) return 'blendController no longer asks the GPU for the world map';
    if (!/narrowestOverlap\(/.test(src) || !/adaptiveBlendWidth\(/.test(src)) return 'the blend grid is no longer sized from the overlap';
    const i = src.indexOf('solveOnGpu(rig)'), j = src.indexOf('traceScan(o)', src.indexOf('export async function solveRig'));
    if (i < 0 || j < 0 || i > j) return 'solveRig must try the GPU world bake before the CPU trace';
    return null;
  },
);

check(
  'the world bake runs on its own short-lived WebGL renderer, not the viewport one',
  'On the viewport WebGPU renderer the world bake stalled intermittently with nothing logged: compileAsync ' +
  'never settled and, raced past, the async readback never resolved, leaving Solve blend on "Solving..." ' +
  'for good. A dedicated WebGL2 renderer compiles inside render() and reads back synchronously. Its ' +
  'context must be released (forceContextLoss): Chromium evicts the OLDEST live context past its cap.',
  () => {
    const src = stripComments(read('src/renderer/components/Simulator3D/projectorBake.ts'));
    const at = src.indexOf('export function bakeWorld(');
    if (at < 0) return 'projectorBake.ts has no synchronous bakeWorld()';
    if (!/offscreenPass\(/.test(src.slice(at))) return 'bakeWorld no longer goes through the own-renderer offscreenPass';
    if (/readRenderTargetPixelsAsync|compileAsync/.test(src)) return 'the bake is back on an async (viewport) path';
    return null;
  },
);

check(
  'the GPU blend grid is indexed by the PHYSICAL pixel under lens distortion',
  'The bake renders the ideal pinhole; the blend runs on gl_FragCoord after the distortion pass, i.e. on ' +
  'the physical panel pixel. With a distorted lens each cell must look up the ideal pixel its physical ' +
  'ray goes through, or the fade lands off the overlap by the distortion.',
  () => /cameraPixelRayWorld\(/.test(stripComments(read('plugins/calibration/src/blendController.ts')).slice(
    stripComments(read('plugins/calibration/src/blendController.ts')).indexOf('function gridFromWorldMap')))
    ? null : 'gridFromWorldMap no longer undistorts the physical pixel before sampling the bake',
);

check(
  'the blend inspector sums light through the venue, not cell by cell',
  'Each projector blend map is indexed by its OWN pixels, so adding maps cell by cell adds two different ' +
  'places on the wall. The inspector did, and painted the whole overlap of a correct side-by-side rig ' +
  '(1.00 measured on the projectors) as "too bright". Its sum comes from blendCoverage → coverageSums.',
  () => {
    const src = stripComments(read('plugins/calibration/src/BlendInspector.tsx'));
    if (!/blendController\.blendCoverage\(\)/.test(src)) return 'BlendInspector no longer takes its sum from blendCoverage';
    if (/sums\[i\] \+= b\.alpha\[i\]/.test(src)) return 'BlendInspector adds alpha maps cell by cell again';
    return null;
  },
);

check(
  'the calibration-file bake keeps GL row order; the world bake reads from the top',
  'ProjectorGL samples the baked uv map at vRaster (GL origin, bottom row first), and every exported file ' +
  'holds that order. WebGL reads back bottom-up, so the uv bake must NOT flip rows: a flipped WebGL bake ' +
  'played the test-card rig upside down. The world bake is the opposite case: blendController indexes it ' +
  'by OpenCV pixel (row 0 = image top), so it MUST flip — measured, its upper rows sit at the screen top.',
  () => {
    const src = stripComments(read('src/renderer/components/Simulator3D/projectorBake.ts'));
    const uv = src.slice(src.indexOf('export function bakeContentUv('), src.indexOf('export function bakeWorld('));
    const world = src.slice(src.indexOf('export function bakeWorld('));
    if (!/const ry = y \* SS \+ sy;/.test(uv)) return 'bakeContentUv no longer keeps GL row order — exported files would play upside down';
    if (!/const ry = h - 1 - y;/.test(world)) return 'bakeWorld no longer flips to a top-row-first map — the blend would weigh mirrored points';
    return null;
  },
);

check(
  'a projector window gets the pictures it really draws (render mode, or a calibration file)',
  'The calibration panel drops the surface pictures it textures the venue with whenever it leaves render ' +
  'mode, and main ships a picture only when it changes. So a STATIC surface (a test card, a paused clip) ' +
  'never came back: unloading an imported calibration returned the venue with every screen blank grey. ' +
  'The window asks for them (needFrames) and main forgets what it last shipped that window.',
  () => {
    const pa = stripComments(read('src/renderer/projector/ProjectorApp.tsx'));
    const app = stripComments(read('src/renderer/App.tsx'));
    if (!/send\(\{ t: 'renderMode', render: calibRenderRef\.current \}\)/.test(pa)) return 'ProjectorApp no longer reports its effective render mode to main';
    if (!/m\.t === 'renderMode'/.test(app) || !/projNeedFramesRef\.current = /.test(app)) return 'App no longer answers renderMode by forgetting what it shipped that window';
    // …and main streams by what the window REALLY draws: a calibration file supersedes render mode
    // inside the window, and ignoring that withheld the own surface from it — black, venue loaded.
    if (!/windowRendersRef\.current\.get\(surfaceId\) !== false/.test(app)) return 'the frame pump no longer asks the window whether a calibration file superseded its render mode';
    return null;
  },
);

check(
  'a Blender save never revokes a model URL that is still on screen',
  'On BLEND_UPDATED the old blob URL used to be cleared from useGLTF and revoked at once, while the mounted ' +
  'scene still held it: its next render fetched the revoked blob and threw. In the 3D view that blanked ' +
  'the model and logged an uncaught error on every save; in a projector window the calibration plugin\'s ' +
  'error boundary took the panel down, and BOTH live-calibrated projectors went black for good (measured ' +
  'on the installed v0.34.0). The old URL must be retired only once the published modelUrls drop it.',
  () => {
    const problems = [];
    for (const F of ['src/renderer/components/Simulator3D/useModelUrls.ts', 'plugins/calibration/src/CalibProjector.tsx']) {
      const src = stripComments(read(F));
      const at = src.indexOf('onBlendUpdated');
      if (at < 0) { problems.push(`${F} no longer reloads on a Blender save`); continue; }
      const handler = src.slice(at, src.indexOf('}), []);', at));
      if (/revokeObjectURL|useGLTF\.clear/.test(handler)) problems.push(`${F} revokes or clears the model URL inside the Blender-update handler again`);
      if (!/new Set\(Object\.values\(modelUrls\)\)/.test(src)) problems.push(`${F} no longer retires old URLs only once modelUrls stops showing them`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

// ── The calibration AUTHORING half is reached only on demand ─────────────────────────────────────
check(
  'the calibration authoring half is never imported statically from the playback side',
  'Suite plan Phase 1 (plans/artlux-suite-show-calibrator.md): the wizards, camera, structured light, ' +
  'the blend solve and unattended recalibration load through authoringLoader\'s dynamic import, so a ' +
  'plain editor launch and every projector window never parse them. ONE static import from the barrel, ' +
  'plugin.renderer.ts or anything they reach merges the whole half back into the shared chunk — and ' +
  'nothing breaks, nothing logs, the app just pays for authoring everywhere again. This walks the ' +
  'static import graph from the playback barrel and the plugin entry and fails if it reaches a module that ' +
  'authoring.ts names. (verify:plugins checks the same thing on the built chunks.)',
  () => {
    const DIR = 'plugins/calibration/src/';
    const resolve = (from, spec) => {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
      for (const ext of ['.ts', '.tsx', '/index.ts']) if (fs.existsSync(path.join(ROOT, base + ext))) return base + ext;
      return null;
    };
    // Value imports and re-exports only: `import type` / `export type` cost nothing at runtime, and a
    // dynamic import() has no `from`, which is exactly the door this check wants left open.
    const edges = (file) => {
      const src = stripComments(read(file));
      const out = [];
      for (const m of src.matchAll(/(?:^|[;\n])\s*(?:import|export)\s+(type\s+)?[^;'"]*?\bfrom\s+'(\.[^']+)'/g)) {
        if (m[1]) continue;
        const r = resolve(file, m[2]);
        if (r) out.push(r);
      }
      return out;
    };
    const authoring = new Set(edges(DIR + 'authoring.ts'));
    if (authoring.size < 5) return `${DIR}authoring.ts names ${authoring.size} modules — the authoring door is gone or unreadable`;
    const seen = new Set(), stack = [DIR + 'playback.ts', DIR + 'plugin.renderer.ts'], problems = [];
    const via = new Map();
    while (stack.length) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      if (f.endsWith('/authoring.ts')) { problems.push(`authoring.ts itself is imported statically (via ${via.get(f)})`); continue; }
      if (authoring.has(f)) { problems.push(`${path.posix.basename(f)} is reached statically via ${via.get(f)}`); continue; }
      for (const e of edges(f)) { if (!via.has(e)) via.set(e, path.posix.basename(f)); stack.push(e); }
    }
    if (!seen.has(DIR + 'authoringLoader.tsx')) problems.push('the barrel / plugin.renderer.ts no longer go through authoringLoader');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the host reaches calibration through its barrels: /playback for values, /authoring for types only',
  'Suite plan Phase 2: the plugin has two renderer barrels, and the line between them is the line ' +
  'ArtLux Show and ArtLux Calibrator will be cut along (Phase 3). /playback is everything that plays a ' +
  'calibration; /authoring is everything that produces one and is loaded on demand. A host VALUE import ' +
  'from /authoring is static, so it would put the wizards back into every launch and every projector ' +
  'window; a deep import past either barrel duplicates singletons (the barrel rule, docs/PLUGINS.md). ' +
  'The old /renderer barrel is gone — anything still naming it would not build, but a doc or a script ' +
  'can, so this says where to go instead.',
  () => {
    const problems = [];
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    } };
    walk('src'); walk('packages');
    for (const d of fs.readdirSync(path.join(ROOT, 'plugins'))) if (d !== 'calibration' && exists(`plugins/${d}/src`)) walk(`plugins/${d}/src`);
    for (const f of files) {
      const src = stripComments(read(f));
      for (const m of src.matchAll(/(import|export)\s+(type\s+)?[^;'"]*?from\s+'@artlux\/plugin-calibration(\/[a-z]+)?'/g)) {
        const sub = m[3] ?? '';
        if (sub === '/renderer' || sub === '') problems.push(`${f} imports @artlux/plugin-calibration${sub} — use /playback (or /main in main)`);
        else if (sub === '/authoring' && !m[2]) problems.push(`${f} VALUE-imports /authoring — that is static; use loadCalibrationAuthoring / useCalibrationAuthoring from /playback`);
      }
      if (/@artlux\/plugin-calibration\/src\/|plugins\/calibration\/src\//.test(src.replace(/import\s+type[^;]*;/g, '')))
        problems.push(`${f} reaches past the calibration barrels into plugins/calibration/src`);
    }
    const pkg = JSON.parse(raw('plugins/calibration/package.json'));
    for (const k of ['./main', './playback', './authoring']) if (!pkg.exports?.[k]) problems.push(`plugins/calibration/package.json lost its ${k} export`);
    if (pkg.exports?.['./renderer']) problems.push('plugins/calibration/package.json still exports ./renderer');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'ArtLux Show carries no calibration authoring; ArtLux Calibrator carries only alignment',
  'Suite plan Phase 3: which app a build is, is a BUILD fact (shared/appIdentity.ts, the __ARTLUX_APP__ ' +
  'literal), so the bundler DROPS what the other app owns. Each rule below is one door: the authoring ' +
  'loader refusing before its import() (or a Show build grows an authoring chunk), the main plugin list ' +
  '(or OpenCV ships in Show), the launch profile (or `--calibrate` from an old shortcut turns a Show ' +
  'into a half-calibrator with nothing behind it), and the Show UI offering no door it cannot open — a ' +
  'Calibrate button or Solve blend that silently does nothing reads as the app being broken. ' +
  'verify:plugins (ARTLUX_APP=show) checks the built result.',
  () => {
    const problems = [];
    const loader = read('plugins/calibration/src/authoringLoader.tsx');
    const g = loader.search(/__ARTLUX_APP__\s*===\s*'show'\)\s*return Promise\.reject/), imp = loader.indexOf("pending ??= import('./authoring')");
    if (g < 0 || imp < 0 || g > imp) problems.push('authoringLoader no longer refuses in ArtLux Show before its import() — a Show build would carry the authoring chunk');
    const mainPlugins = read('src/main/host/plugins.ts');
    const showList = (mainPlugins.match(/__ARTLUX_APP__ === 'show' \? \[([^\]]*)\]/) || [])[1];
    if (showList == null) problems.push('src/main/host/plugins.ts has no Show plugin list');
    else if (/\bcalibration\b/.test(showList)) problems.push('the Show main plugin list includes calibration — OpenCV would ship in ArtLux Show');
    const prof = read('src/main/runProfile.ts');
    if (!/ARTLUX_APP === 'show' \? false/.test(prof)) problems.push('runProfile no longer turns calibration authoring OFF in ArtLux Show');
    if (!/ARTLUX_APP === 'calibrator' \? true/.test(prof)) problems.push('runProfile no longer turns calibration authoring ON in ArtLux Calibrator');
    for (const [f, re, what] of [
      ['src/renderer/components/OutputsPanel.tsx', /HAS_CALIBRATION_AUTHORING && \(\s*<button\s+onClick=\{\(\) => onCalibrate/, 'the Calibrate button'],
      ['src/renderer/components/OutputsPanel.tsx', /HAS_CALIBRATION_AUTHORING && \(\s*<div[^>]*>\s*<button onClick=\{\(\) => onMeasureGamma/, 'the camera gamma measurement'],
      ['src/renderer/components/RigBlendStrip.tsx', /HAS_CALIBRATION_AUTHORING && <>[\s\S]*Solve blend[\s\S]*<\/>\}/, 'Solve / Clear / Inspect blend'],
    ]) if (!re.test(read(f))) problems.push(`${f}: ${what} is no longer hidden in ArtLux Show`);
    const ctx = read('src/renderer/contexts/index.tsx');
    if (!/CALIBRATOR_CONTEXTS = new Set\(\['project', '3d', 'calib', 'settings'\]\)/.test(ctx)) problems.push('the Calibrator context set changed — update the plan (§3) and this check together');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the UV checker is never the default shader, and its regeneration never enters the undo history',
  'Suite plan Phase 3, decision 13: the UV checker\'s code is GENERATED from the project and rewritten ' +
  'when the project changes. Two silent ways to get that wrong: put it first in STARTERS, and every ' +
  'shader surface without a shaderId (the picker\'s and starterSource()\'s fallback is STARTERS[0]) ' +
  'turns into a test card; or route the rewrite through handleUpdateSurface, and every rename, Blender ' +
  'save or project open adds undo entries nobody made — an operator\'s undo would step through "the ' +
  'checker noticed". Also: a pick of any other shader must drop the marker, or that surface is rewritten ' +
  'back into a checker at the next project change.',
  () => {
    const problems = [];
    const st = read('plugins/shader/src/starters.ts');
    const first = (st.match(/export const STARTERS: Starter\[\] = \[\s*\{\s*id:\s*'([^']+)'/) || [])[1];
    if (!first) problems.push('starters.ts: cannot find the first STARTERS entry');
    else if (first === 'uv-checker' || /UV_CHECKER_ID/.test(st.slice(st.indexOf('export const STARTERS'), st.indexOf('];', st.indexOf('export const STARTERS')))))
      problems.push('the UV checker is in the STARTERS literal — it must be pushed last, never be STARTERS[0]');
    const app = read('src/renderer/App.tsx');
    const at = app.indexOf('syncUvCheckers(');
    if (at < 0) problems.push('App no longer runs the UV-checker sync');
    else {
      const body = app.slice(at, app.indexOf('}, [surfaces, scene3D', at));
      if (/handleUpdateSurface|recordHistory/.test(body)) problems.push('the UV-checker sync writes through the undo history');
      if (!/setSurfaces\(\(prev\)/.test(body)) problems.push('the UV-checker sync no longer writes state directly');
    }
    const ed = read('plugins/shader/src/ShaderContentEditor.tsx');
    if (!/uvChecker: undefined/.test(ed)) problems.push('picking another shader no longer drops the uvChecker marker');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a recalibration hand-off can never strand the show',
  'Suite plan Phase 4: ArtLux Show hands a scheduled recalibration to ArtLux Calibrator and gets the ' +
  'machine back. Each rule here is a way for a venue to go dark with nothing logged: Show tearing its ' +
  'outputs down BEFORE finding the Calibrator (no Calibrator, no show); a Calibrator job that never ' +
  'hands back (no timeout); a Show started mid-job left to a dialog on a broadcast Calibrator’s ' +
  'invisible window; the OS supervisor relaunching the show on top of a running job (the shared lock ' +
  'turns that into a fight); and Show with no handler at all, so the scheduler’s command did nothing.',
  () => {
    const problems = [];
    const main = read('src/main/index.ts');
    const h = main.indexOf('IPC.SUITE_RECALIBRATE');
    const body = h < 0 ? '' : main.slice(h, main.indexOf('IPC.SUITE_HAND_BACK', h));
    if (h < 0) problems.push('main no longer handles SUITE_RECALIBRATE');
    else {
      const find = body.indexOf('findOtherAppExe'), down = body.indexOf('shutdownSubsystems');
      if (find < 0 || down < 0 || find > down) problems.push('Show tears its outputs down before checking the Calibrator is installed');
    }
    if (!/if \(RECAL_JOB\)[\s\S]{0,400}setTimeout\(\(\) => handBackToShow\(/.test(main)) problems.push('a Calibrator job has no hard timeout handing the machine back');
    if (!/RECAL_JOB && \(additionalData[^)]*\)\?\.app === 'show'\) \{ handBackToShow/.test(main)) problems.push('Show started mid-job no longer takes the machine back');
    const sup = read('scripts/watchdog-check.ps1');
    const stand = sup.indexOf("Get-Process -Name 'ArtLux Calibrator'"), start = sup.indexOf('Start-Process');
    if (stand < 0 || start < 0 || stand > start) problems.push('the OS supervisor no longer stands down while ArtLux Calibrator holds the machine');
    const plug = read('plugins/calibration/src/plugin.renderer.ts');
    const showAt = plug.indexOf("__ARTLUX_APP__ === 'show' && ctx.window === 'main'");
    const showBlock = showAt < 0 ? '' : plug.slice(showAt, showAt + 2000);
    if (!/suiteRecalibrate/.test(showBlock) || !/registerCommandHandler\('recalibrate'/.test(showBlock))
      problems.push('ArtLux Show no longer turns the recalibrate command into a hand-off');
    if (!/runHandedJob[\s\S]*suiteHandBack/.test(plug)) problems.push('the Calibrator job runner no longer hands back at its end');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'ArtLux Show never opens a project on the Calibrator test card',
  'ArtLux Calibrator opens every project with the UV checker in place of the show content, kept in ' +
  'calibRig.testBackup. Every route back to the show ends with ArtLux Show OPENING the file, so the ' +
  'restore lives there: before it did, only the sign-off hand-off button restored, and a show opened ' +
  'after File > Open in ArtLux Show, or after a plain save and quit, played the grid on the wall. A ' +
  'handed recalibration job must not put the card up either, or it hands the show back a test card.',
  () => {
    const problems = [];
    const app = read('src/renderer/App.tsx');
    const at = app.indexOf('const applyProjectData = (');
    const head = at < 0 ? '' : app.slice(at, at + 900);
    if (at < 0) problems.push('applyProjectData is gone — find the one door every open goes through');
    if (!/__ARTLUX_APP__ !== 'calibrator' \? withShowContent\(/.test(head)) problems.push('a non-Calibrator open no longer restores the show content first');
    if (!/has\('recal'\) \? opened : withTestSource\(/.test(head)) problems.push('a handed recalibration job now opens on the test card');
    const ts = read('src/renderer/services/testSource.ts');
    if (!/testBackup: _dropped/.test(ts)) problems.push('withShowContent no longer drops the backup after restoring');
    if (/modelBindings/.test(read('plugins/calibration/src/SignoffPanel.tsx'))) problems.push('SignoffPanel grew its own copy of testTargets');
    return problems.length ? problems.join('; ') : null;
  },
);
check(
  'both hand-off doors run the hand-off checks, and a replace writes only the remembered file',
  'ArtLux Calibrator asks, before a hand-off, whether the calibration file the show plays is older than ' +
  'the calibration (plugins/calibration/src/fileFreshness.ts). There are two doors — File > Open in ' +
  'ArtLux Show (App) and the sign-off button (SignoffPanel) — and a check behind one of them is a check ' +
  'the other skips: the show then plays the old aim with nothing to say so. The replace itself must ' +
  'take its path from prefs in main, never from the renderer, or it is a write-anywhere door.',
  () => {
    const problems = [];
    const app = read('src/renderer/App.tsx');
    const h = app.indexOf('const handleOpenInOtherApp');
    const body = h < 0 ? '' : app.slice(h, app.indexOf('openInOtherApp?.(', h));
    if (!/await beforeHandOff\(/.test(body)) problems.push('File > Open in ArtLux Show no longer runs beforeHandOff before it saves and hands over');
    const so = read('plugins/calibration/src/SignoffPanel.tsx');
    const ho = so.indexOf('const handOff');
    if (ho < 0 || !/await beforeHandOff\(/.test(so.slice(ho, so.indexOf('openInOtherApp', ho)))) problems.push('the sign-off hand-off button no longer runs beforeHandOff');
    if (!/registerFileFreshnessCheck\(\)/.test(read('plugins/calibration/src/plugin.renderer.ts'))) problems.push('the Calibrator no longer registers the calibration-file freshness check');
    const ipc = read('src/main/ipc.ts');
    if (!/if \(how\?\.replaceRemembered\) \{\s*const target = persistence\.getPrefs\(\)\.calibrationFile;/.test(ipc)) problems.push('the MPCDI replace no longer takes its target from prefs in main');
    return problems.length ? problems.join('; ') : null;
  },
);
check(
  'the close backstop never closes a window under its own save dialog',
  'Closing with unsaved changes is a round trip: main holds the window and the renderer asks "Save ' +
  'before closing?". Main also has a 4 s backstop so a crashed renderer cannot make the app ' +
  'unquittable - and it fired under the dialog, because a renderer waiting on a PERSON had not ' +
  'answered either. The window vanished with the dialog on screen and the work was discarded ' +
  '(2026-10-25, log: "renderer did not answer in time"). The renderer now says it is asking before the ' +
  'dialog opens, and the backstop stands down for a window that is asking.',
  () => {
    const problems = [];
    const guard = read('src/main/closeGuard.ts');
    if (!/asking\.has\(win\)/.test(guard.slice(guard.indexOf('setTimeout('), guard.indexOf('ANSWER_MS);'))))
      problems.push('the close backstop no longer stands down for a window that is asking the operator');
    if (!/export function closeAsking\(/.test(guard)) problems.push('closeGuard lost closeAsking');
    if (!/case 'close-asking': closeAsking\(win\)/.test(read('src/main/ipc.ts'))) problems.push("main no longer routes the renderer's 'close-asking'");
    const app = read('src/renderer/App.tsx');
    const h = app.indexOf("case 'close-request'");
    const body = h < 0 ? '' : app.slice(h, app.indexOf('confirmRef.current(', h));
    if (!/cmd\?\.\('close-asking'\)/.test(body)) problems.push('the renderer opens the save dialog without telling main it is asking');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'OpenCV loads when calibration is used, never at import or for the splash',
  'calib.node maps the 65 MB opencv_world4110.dll, and the calibration MAIN plugin activates in every ' +
  'launch — so loading it at import made every show pay for OpenCV from the first second, calibrating ' +
  'or not (measured 2026-10-25; suite plan Phase 1). The status line on the splash is the other ' +
  'trap: it is asked at every boot, so a status() that calls isAvailable() loads the DLL just to say ' +
  'it could. And a quit must not load it to close a camera that was never opened.',
  () => {
    const M = 'plugins/calibration/src/calibManager.ts', P = 'plugins/calibration/src/plugin.main.ts';
    const m = read(M), p = read(P), problems = [];
    // A top-level statement that calls the loader = loading at import.
    if (/^(?:const|let|var)\s+\w+\s*=\s*(?:loadNative|native)\(\)/m.test(m) || /^(?:loadNative|native)\(\);?/m.test(m))
      problems.push(`${M} loads the addon at import again`);
    if (!/export function addonState\(\)/.test(m)) problems.push(`${M} lost addonState() — the splash has no way to ask without loading`);
    const status = p.slice(p.indexOf('status:'));
    if (!/addonState\(\)/.test(status) || /isAvailable\(\)/.test(status)) problems.push(`${P} status() must use addonState(), not isAvailable() — the splash would load OpenCV`);
    const c0 = m.indexOf('export function cameraClose'), c1 = m.indexOf('export function', c0 + 1);
    const close = m.slice(c0, c1 < 0 ? undefined : c1);
    if (/native\(\)/.test(close)) problems.push('cameraClose() loads the addon — every quit would map OpenCV to close nothing');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'macOS ships a real NDI: built in CI, libndi beside it, and the Local Network declaration',
  'Until v0.35.0 the only ndi.node was a committed WINDOWS prebuilt, packaged for Windows only, so NDI ' +
  'was "unavailable" on every Mac and nothing said so (found 2026-11-02). Each link below fails ' +
  'silently on its own: no mac extraResources = no addon; no libndi.dylib beside it or no @loader_path ' +
  'rpath = the addon will not load on a Mac without NDI Tools; and on macOS 15+ an app that does not ' +
  'declare NSLocalNetworkUsageDescription + NSBonjourServices (_ndi._tcp) is quietly handed NO sources ' +
  'by Bonjour — NDI looks loaded and finds nothing.',
  () => {
    const problems = [];
    // raw(), not read(): read() strips comments, and package.json's "out/**/*" glob opens a block comment.
    const pkg = JSON.parse(raw('package.json'));
    const mac = pkg.build?.mac ?? {};
    const froms = (mac.extraResources ?? []).map((r) => (typeof r === 'string' ? r : r.from));
    for (const f of ['native/ndi/macos/ndi.node', 'native/ndi/macos/libndi.dylib'])
      if (!froms.includes(f)) problems.push(`package.json build.mac.extraResources does not ship ${f}`);
    if (!mac.extendInfo?.NSLocalNetworkUsageDescription) problems.push('build.mac.extendInfo lacks NSLocalNetworkUsageDescription — macOS 15 hides every NDI source');
    if (!(mac.extendInfo?.NSBonjourServices ?? []).includes('_ndi._tcp')) problems.push('build.mac.extendInfo.NSBonjourServices does not list _ndi._tcp — NDI discovery is blocked on macOS 15');
    if (!/rpath,@loader_path/.test(read('native/ndi/build.rs'))) problems.push('native/ndi/build.rs no longer adds the @loader_path rpath — ndi.node cannot find the libndi.dylib shipped beside it');
    const ci = read('.github/workflows/build.yml');
    if (!/cargo build --release --features ndi --manifest-path native\/ndi\/Cargo\.toml/.test(ci) || !/node scripts\/stage-ndi-macos\.cjs/.test(ci))
      problems.push('.github/workflows/build.yml no longer builds + stages the macOS NDI addon');
    const pa = read('scripts/package-app.cjs');
    if (!/mac:\s*\{\s*\.\.\.base\.mac,\s*extraResources:\s*keep\(/.test(pa)) problems.push('scripts/package-app.cjs does not filter mac.extraResources per product');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── The document store (plans/native-engine.md §9a, E5/W1) ──────────────────────────────────────
// Slices move out of App.tsx's useState into state/docStore.ts one at a time, so that panels can later
// subscribe to one slice and other windows can hold a replica. Two ways this silently comes undone:
// a merge or a hurried fix re-adds `const [x, setX] = useState` for a migrated slice (App compiles, the
// app runs, and the store and App now hold two diverging copies of the show); or the core store grows
// a React/DOM/renderer import, which breaks W3 — moving the same module into the Show Host process,
// where none of those exist.
check(
  'migrated document and session slices live in their stores, never in App useState; the core store stays dependency-free',
  'Two copies of a slice diverge without an error: one window edits the store, App renders its own ' +
  'stale useState. And shared/docStore.ts must run unchanged in a utilityProcess with no DOM or React.',
  () => {
    const problems = [];
    const core = read('shared/docStore.ts');
    if (/^\s*import\s/m.test(core)) problems.push('shared/docStore.ts imports something — the core store must depend on nothing');
    if (/\b(window|document|React|useSyncExternalStore)\b/.test(core)) problems.push('shared/docStore.ts references window/document/React');
    const binding = read('src/renderer/state/docStore.ts');
    const app = read('src/renderer/App.tsx');
    // Two stores, same rule: the document (DocSlices / useDocSlice) and the session (SessionSlices /
    // useSessionSlice). A slice in either must not come back as an App useState.
    for (const [iname, hook] of [['DocSlices', 'useDocSlice'], ['SessionSlices', 'useSessionSlice']]) {
      const iface = binding.match(new RegExp(`export interface ${iname}\\s*\\{([\\s\\S]*?)\\n\\}`));
      if (!iface) { problems.push(`could not find \`export interface ${iname}\` in src/renderer/state/docStore.ts`); continue; }
      const keys = [...iface[1].matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
      if (!keys.length) { problems.push(`${iname} declares no slices`); continue; }
      for (const k of keys) {
        const setter = 'set' + k[0].toUpperCase() + k.slice(1);
        if (new RegExp(`\\[\\s*${k}\\s*,\\s*${setter}\\s*\\]\\s*=\\s*useState`).test(app))
          problems.push(`App.tsx declares \`${k}\` with useState again — it is a migrated ${iname} slice`);
        if (!new RegExp(`${hook}\\(\\s*'${k}'\\s*\\)`).test(app))
          problems.push(`App.tsx does not read \`${k}\` through ${hook}('${k}')`);
      }
    }
    // One store per window bundle: a second createDocStore call is a second, empty document.
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name).replace(/\\/g, '/');
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); }
        else if (/\.(ts|tsx)$/.test(e.name) && rel !== 'shared/docStore.ts' && rel !== 'src/renderer/state/docStore.ts'
          && /\bcreateDocStore\s*\(/.test(read(rel))) offenders.push(rel);
      }
    };
    walk('src'); walk('plugins'); walk('shared');
    if (offenders.length) problems.push(`createDocStore() is called outside state/docStore.ts: ${offenders.join(', ')}`);
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Panels re-render for their own data only (plans/native-engine.md §9a, E5/W2) ─────────────────
// Two halves, both needed, both silent when broken: (1) the shell must render every registry panel
// through the PanelBody memo boundary — an inline <x.Component …/> puts the panel back on App's render
// cadence; (2) a panel must name the fields it reads with useEditorPick — a whole-object useEditor()
// re-renders it on every EditorData change, boundary or not. Proven by scripts/test-panel-renders.cjs
// (a fixture edit: unrelated panels 2 renders → 0).
check(
  'registry panels render through PanelBody and read EditorData with useEditorPick',
  'Without the memo boundary, or with a whole-object useEditor(), every App render re-renders the panel ' +
  'again — the W2 gain disappears without a single error, and a panel cannot later move to its own window.',
  () => {
    const problems = [];
    for (const f of ['src/renderer/components/shell/WorkspaceShell.tsx', 'src/renderer/components/shell/DockRenderer.tsx']) {
      const src = read(f);
      const inline = src.match(/<[\w.]+\.Component\s+contextId=/g);
      if (inline) problems.push(`${f} renders a registry panel inline (${inline.join(', ')}) — use <PanelBody Component={…} …/>`);
      if (!/<PanelBody\b/.test(src)) problems.push(`${f} no longer renders panels through <PanelBody>`);
    }
    if (!/React\.memo\(/.test(read('src/renderer/components/shell/PanelBody.tsx'))) problems.push('PanelBody is no longer React.memo — it is the boundary');
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name).replace(/\\/g, '/');
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); }
        else if (/\.tsx?$/.test(e.name) && rel !== 'src/renderer/state/EditorStore.tsx' && /=\s*useEditor\(\)/.test(read(rel))) offenders.push(rel);
      }
    };
    walk('src/renderer'); walk('plugins');
    if (offenders.length) problems.push(`whole-object useEditor() in: ${offenders.join(', ')} — name the fields with useEditorPick(...)`);
    return problems.length ? problems.join('; ') : null;
  },
);

// ── The collapsed timeline strip must stay clickable ───────────────────────────────────────────────
// The drawer's ViewportSlot is `absolute inset-0`. If #workspace-bottom is not a positioned box, the
// slot resolves against the outer drawer box (strip included), PersistentLayer draws the timeline over
// the strip, and its toolbar eats every click on the "Show Timeline" toggle — collapsed, the drawer
// opens with Ctrl+T only. Nothing throws and the strip even looks populated. Reported 2026-11-20.
check(
  'the timeline drawer slot is positioned, so the collapsed strip stays clickable',
  'Without `relative` on #workspace-bottom the timeline is drawn over the strip and the toggle cannot be ' +
  'clicked: a collapsed drawer can then only be opened with Ctrl+T.',
  () => {
    const src = read('src/renderer/components/shell/WorkspaceShell.tsx');
    const m = src.match(/id="workspace-bottom"\s+className="([^"]*)"/);
    if (!m) return 'could not find the #workspace-bottom element in WorkspaceShell.tsx';
    return /(^|\s)(relative|absolute|fixed|sticky)(\s|$)/.test(m[1]) ? null
      : `#workspace-bottom is not a positioned box (className="${m[1]}") — the absolute ViewportSlot will cover the strip`;
  },
);

// ── The timeline and the 3D view hold still across unrelated App renders (E5/W2) ──────────────────
// They are not registry panels: App renders them with props, so PanelBody does nothing for them. Each is
// React.memo'd, and App hands them handlers through useStableHandlers and derived lists through useMemo.
// One inline `() => …` or `.map(…)` in their JSX is enough to make the memo compare fail on every App
// render: the whole timeline (≈22 ms) and the whole r3f tree reconciled again, silently. Measured by
// scripts/test-panel-renders.cjs step 2 (before: timeline ×3, 3D ×1 per brightness edit; after: 0, 0).
//
// The timeline's automation-target poll is part of the same property: `def` is a target's CURRENT value,
// so in defsSignature it made every value edit anywhere re-render the timeline within the second.
check(
  'the timeline and the 3D view are memoized and get stable props; the target poll ignores values',
  'An inline lambda or list in their JSX, a dropped React.memo, or `def` back in defsSignature makes the ' +
  'timeline and the 3D view re-render on App renders that change nothing they show — no error, just cost.',
  () => {
    const problems = [];
    const app = read('src/renderer/App.tsx');
    for (const [tag, src, file] of [['TimelineDock', app, 'App.tsx'], ['Simulator3D', app, 'App.tsx'], ['Timeline', read('src/renderer/components/timeline/TimelineDock.tsx'), 'TimelineDock.tsx']]) {
      const els = src.match(new RegExp(`<${tag}\\b[\\s\\S]*?\\/>`, 'g')) || [];
      if (!els.length) problems.push(`${file} renders no <${tag}> — this check is looking at the wrong file`);
      for (const el of els) {
        const props = [...el.matchAll(/(\w+)=\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)];
        for (const [, name, value] of props) {
          if (/=>/.test(value)) problems.push(`<${tag} ${name}> is an inline function — route it through useStableHandlers`);
          else if (/\.(map|flatMap|filter|concat|slice)\(/.test(value)) problems.push(`<${tag} ${name}> builds a list inline — useMemo it`);
          else if (/^\s*[[{]/.test(value)) problems.push(`<${tag} ${name}> is an inline object/array literal — useMemo it`);
        }
      }
    }
    if (!/export const Timeline = React\.memo\(/.test(read('src/renderer/components/timeline/Timeline.tsx'))) problems.push('Timeline is no longer exported as React.memo(...)');
    if (!/export default React\.memo\(Simulator3D\)/.test(read('src/renderer/components/Simulator3D/Simulator3D.tsx'))) problems.push('Simulator3D is no longer exported as React.memo(Simulator3D)');
    const tl = read('src/renderer/components/timeline/Timeline.tsx');
    const sig = tl.match(/function defsSignature\([\s\S]*?\n\}/);
    if (!sig) problems.push('could not find defsSignature in Timeline.tsx');
    else if (/\.def\b/.test(sig[0])) problems.push('defsSignature reads `def` (a target\'s current value) — every value edit would re-render the timeline');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── The Show Host stays a document authority, and the editor stays a full replica (E5/W3) ─────────
// src/showhost is forked as a utilityProcess (main/showHost.ts) and holds the authoritative stores.
// Two failures would compile, boot and look fine:
//   • the host growing a dependency on renderer/main code (or React, or a decoder): it would then be a
//     second runtime, and "one producer per datum" (plans/native-engine.md §9a rule 1) would be gone;
//   • the editor losing its link (the import dropped from App, or the entry dropped from the main build):
//     everything keeps working on the replica, the host sits empty, and a detached panel window (W5)
//     would read a blank show.
check(
  'the Show Host imports only the store core and its wire; the editor links to it; it is a main build entry',
  'A host that imports app code becomes a second runtime; an editor without hostLink leaves the host ' +
  'empty while everything still looks fine; a missing build entry means main forks a file that is not there.',
  () => {
    const problems = [];
    const hostDir = 'src/showhost';
    for (const f of fs.readdirSync(path.join(ROOT, hostDir)).filter((n) => /\.tsx?$/.test(n))) {
      const src = read(`${hostDir}/${f}`);
      // Every way a module can be pulled in: `import … from`, a bare side-effect `import '…'`,
      // `export … from`, a dynamic `import('…')` and `require('…')`. (A bare import slipped past the
      // first version of this check when it was mutation-tested.)
      const specs = /(?:^\s*(?:import|export)\s[^;]*?from\s+|^\s*import\s+|\bimport\(\s*|\brequire\(\s*)['"]([^'"]+)['"]/gm;
      for (const m of src.matchAll(specs)) {
        const spec = m[1];
        const okSpec = ['../../shared/docStore', '../../shared/showHostProtocol', '../../shared/shareEqual'].includes(spec) || spec.startsWith('./') || spec.startsWith('node:');
        if (!okSpec) problems.push(`${hostDir}/${f} imports '${spec}' — the host may import only the store core, its wire, shareEqual, its own files and node: builtins`);
      }
    }
    const app = read('src/renderer/App.tsx');
    if (!/^import (?:\{[^}]*\} from )?'\.\/state\/hostLink';/m.test(app)) problems.push("App.tsx no longer imports './state/hostLink' — the host would sit empty");
    const cfg = read('electron.vite.config.ts');
    if (!/showHost:\s*resolve\(__dirname,\s*'src\/showhost\/index\.ts'\)/.test(cfg)) problems.push('electron.vite.config.ts does not build src/showhost/index.ts as the main entry `showHost`');
    if (!/path\.join\(__dirname,\s*'showHost\.js'\)/.test(read('src/main/showHost.ts'))) problems.push("main/showHost.ts no longer forks out/main/showHost.js");
    const link = read('src/renderer/state/hostLink.ts');
    if (!/queueMicrotask\(flushToHost\)/.test(link)) problems.push('hostLink no longer coalesces writes per task (queueMicrotask(flushToHost)) — every set would be cloned and sent');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Undo lives in the Show Host; the in-process stacks are only the no-host fallback (E5/W3b) ──────
// Three ways this goes wrong silently:
//   • a history verb that skips historyOp: the editor would undo its own stack while a detached panel
//     (W5) undoes the host's, two histories of one document that disagree;
//   • a restored slice applied without shareEqual: every fixture/surface/scene becomes a new object on
//     each undo, re-firing whatever effect keys on identity (the old in-process undo restored the same
//     references) — no error, just a show that re-initialises things on Ctrl+Z;
//   • the undoable list forked: DocSnapshot and the host's stacks covering different slices.
check(
  'undo, redo, record and reset go through the Show Host first; restored slices keep identity; one undoable list',
  'A verb that bypasses historyOp gives the editor and the host two histories; a patch applied without ' +
  'shareEqual re-creates every item on each undo; a second undoable list drifts from DocSnapshot.',
  () => {
    const problems = [];
    const app = read('src/renderer/App.tsx');
    for (const verb of ['record', 'undo', 'redo']) {
      const name = verb === 'record' ? 'recordHistory' : verb;
      const m = app.match(new RegExp(`const ${name} = useCallback\\(\\(\\) => \\{([\\s\\S]*?)\\n  \\}, \\[`));
      if (!m) { problems.push(`could not find App's ${name}`); continue; }
      const body = m[1];
      const host = body.indexOf(`historyOp('${verb}'`);
      const local = body.search(/history(Record|Undo|Redo)\(/);
      if (host < 0) problems.push(`${name} does not call historyOp('${verb}', …)`);
      else if (local >= 0 && local < host) problems.push(`${name} uses the in-process stack BEFORE asking the host`);
      else if (!new RegExp(`if \\(historyOp\\('${verb}'[^)]*\\)\\) return;`).test(body)) problems.push(`${name} must return when the host took the op (if (historyOp(...)) return;) — otherwise both stacks record`);
    }
    if (!/const resetHistory = useCallback\(\(\) => \{[\s\S]*?historyOp\('reset'/.test(app)) problems.push("resetHistory does not reset the host's stacks (historyOp('reset', …))");
    if (!/type DocSnapshot = UndoableDoc;/.test(app)) problems.push('DocSnapshot is no longer UndoableDoc — the undoable list is defined twice');
    const link = read('src/renderer/state/hostLink.ts');
    if (!/const next = shareEqual\(store\.getSlice\(m\.key\), m\.value\);/.test(link)) problems.push('hostLink applies host patches without shareEqual — an undo would re-create every item of the slice');
    if (!/undoable: \[\.\.\.UNDOABLE_SLICES\]/.test(link)) problems.push("hostLink's hello no longer names UNDOABLE_SLICES — the host would keep stacks over the wrong slices");
    return problems.length ? problems.join('; ') : null;
  },
);

// ── "Unsaved changes" is the Show Host's answer; the UI thread stops stringifying the show (E5/W3c) ─
// The editor used to JSON.stringify the whole project once a second on the UI thread to answer "does
// the document differ from the file?". The host now answers from per-slice digests after a write. Four
// silent failures this guards:
//   • the poll computing the signature while a host is connected (the cost comes back, nothing breaks);
//   • a save path that rebases only the in-process signature: the host keeps calling a saved show
//     dirty — or, the other way round, a host baseline the fallback never hears of;
//   • the host never re-evaluating after a write (the flag would freeze);
//   • the project-file list forked from the store's.
check(
  "unsaved changes come from the Show Host; every save rebases both baselines; one project-file list",
  'A signature computed while the host is connected brings the 1 Hz stringify back; a save that rebases ' +
  'one baseline leaves the other calling a saved show dirty; a host that does not re-evaluate freezes the flag.',
  () => {
    const problems = [];
    const app = read('src/renderer/App.tsx');
    const poll = app.match(/const viaHost = hostConnected\(\);([\s\S]*?)const sig = docSignatureRef\.current\(\);/);
    if (!poll) problems.push('the dirty poll no longer decides on hostConnected() BEFORE computing the signature');
    else if (!/if \(viaHost && !settlingRef\.current\) \{[^}]*return; \}/.test(poll[1])) problems.push('the dirty poll computes the signature while a host is connected and the project has settled');
    const direct = app.match(/savedDocRef\.current = signatureOf\(/g) || [];
    if (direct.length !== 1) problems.push(`savedDocRef is signed in ${direct.length} places — every save must go through markDocSaved (which signs once and rebases the host)`);
    if (!/const markDocSaved = [\s\S]*?markSaved\(writtenSlices\(data\), false, \{ projectPath: path, save: true \}\)/.test(app)) problems.push('markDocSaved no longer rebases the Show Host as a real save (markSaved(writtenSlices(data), false, { projectPath: path, save: true }))');
    if (/setDocDirty\(false\);\s*\n\s*}\s*\n\s*return path/.test(app)) problems.push('handleSaveProject clears the flag without markDocSaved');
    const link = read('src/renderer/state/hostLink.ts');
    if (!/projectFile: \[\.\.\.PROJECT_FILE_SLICES\]/.test(link)) problems.push("hostLink's hello no longer names PROJECT_FILE_SLICES");
    const host = read('src/showhost/index.ts');
    if (!/if \(m\.store === 'doc'\) scheduleDirty\(\);/.test(host)) problems.push('the host no longer re-evaluates "unsaved" after a doc write');
    if (!/function restore[\s\S]*?scheduleDirty\(\);\n\}/.test(host.replace(/\r\n/g, '\n'))) problems.push('the host no longer re-evaluates "unsaved" after an undo/redo restore');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Autosave writes a RECOVERY copy, never the project, never in a show mode (E5/W3c) ───────────────
// Each of these would be silent until it cost someone a show:
//   • the host writing anywhere but <userData>/autosave (an autosave over the operator's .artlux would
//     save work they never chose to keep);
//   • autosave enabled in broadcast/headless (an unattended machine growing recovery files forever);
//   • Restore applied without first baselining the opened file: answered before the first settling
//     tick, the host has no baseline and calls the restored work "saved" (measured, then fixed);
//   • "Close without saving" leaving the autosave behind (the next open offers back discarded work);
//   • a load path that never offers the autosave back.
check(
  'autosave writes only recovery files, only in the editor; Restore baselines first; discards retire it',
  'An autosave over the project, in a show mode, a Restore with no baseline, or a discard that leaves ' +
  'the file behind all compile, boot and look fine — until a show depends on it.',
  () => {
    const problems = [];
    const host = read('src/showhost/index.ts');
    const writes = [...host.matchAll(/fs\.(writeFileSync|renameSync|unlinkSync|appendFileSync|copyFileSync)\(([^,)]*)/g)].map((m) => m[2].trim());
    for (const target of writes) {
      if (!/^(`\$\{file\}\.tmp`|file)$/.test(target)) problems.push(`the host writes to ${target} — only the autosave file (autosaveFile()) may be written`);
    }
    if (!/return path\.join\(AUTOSAVE_DIR, `\$\{id\}\.json`\);/.test(host)) problems.push('autosaveFile() no longer resolves inside AUTOSAVE_DIR');
    // A harness run (ARTLUX_CDP_PORT) must never autosave into the owner's userData: a suite run left four
    // recovery files of throwaway projects there before this rule existed.
    if (!/if \(process\.env\.ARTLUX_CDP_PORT\) return path\.join\(os\.tmpdir\(\), 'artlux-autosave-harness'\);/.test(read('src/main/showHost.ts'))) problems.push('main/showHost.ts no longer sends a CDP (harness) run\'s autosaves to a temp folder — harnesses would litter the owner\'s userData');
    if (!/if \(!file \|\| !autosaveOn \|\| autosaveSuspended/.test(host)) problems.push('writeAutosave no longer checks autosaveOn and autosaveSuspended first');
    const app = read('src/renderer/App.tsx');
    if (!/^setAutosaveEnabled\(!SHOW_ENGINE\);/m.test(app)) problems.push('App no longer turns autosave off in show modes (setAutosaveEnabled(!SHOW_ENGINE))');
    const restore = app.match(/const restoreAutosave = \(slices: Record<string, unknown>\) => \{([\s\S]*?)\n  \};/);
    if (!restore) problems.push('restoreAutosave not found');
    else {
      const b = restore[1];
      const base = b.indexOf('markSaved({}, false');
      const apply = b.indexOf('shareEqual(prev, slices[k])');
      if (base < 0 || apply < 0 || base > apply) problems.push('restoreAutosave must baseline the opened file (markSaved) BEFORE applying the autosaved slices');
      if (!/recordHistory\(\);/.test(b)) problems.push('restoreAutosave is no longer one undoable step (recordHistory)');
    }
    if (!/if \(answer === 'alt'\) discardAutosave\(currentProjectPathRef\.current\);/.test(app)) problems.push('"Close without saving" no longer retires the autosave');
    if (!/const applyProjectData = \(opened: any\) => \{\s*\n\s*projectLoading\(\);/.test(app.replace(/\r\n/g, '\n'))) problems.push('applyProjectData no longer suspends autosave first (projectLoading()) — a half-loaded show could be written under the previous name');
    const offers = (app.match(/checkAutosaveRef\.current\(/g) || []).length;
    // Five editor load paths, and each must offer (mutation-tested: dropping one was missed at "≥ 4").
    if (offers < 5) problems.push(`only ${offers} load path(s) offer the autosave back (expected 5: open, open recent / --project=, open folder, last project at boot, untitled boot)`);
    return problems.length ? problems.join('; ') : null;
  },
);

// ── The live channel: pull-based streams, the clock as an anchor, one owner (E5/W4) ─────────────────
// renderer/live/broker.ts is the editor's end of every live channel (shared/liveProtocol.ts). Its rules
// are plans/native-engine.md §9a "no drop" rules 1, 3 and 4, and each break compiles, boots and works —
// a panel window would just cost the editor a message per frame per stream, forever.
check(
  'live streams are pull-based, attached only while watched, and produced only by the owner',
  'A push-based stream floods a hidden or slow window at the producer\'s rate; a producer hook left ' +
  'attached costs every frame for nobody; a client that imports a producer duplicates the work the ' +
  'owner already does (decode twice, sample twice).',
  () => {
    const problems = [];
    const b = read('src/renderer/live/broker.ts').replace(/\r\n/g, '\n');
    const deliver = b.match(/\nfunction deliver\(sub: Sub\): void \{([\s\S]*?)\n\}/);
    if (!deliver) problems.push('broker.ts: deliver() not found');
    else {
      const d = deliver[1];
      if (!/^\s*if \(!sub\.waiting\) return;/.test(d)) problems.push('deliver() no longer starts with `if (!sub.waiting) return;` — samples would be pushed, not pulled');
      const clear = d.indexOf('sub.waiting = false;');
      const send = d.indexOf("t: 'data'");
      if (clear < 0 || send < 0 || clear > send) problems.push('deliver() must clear `waiting` before it posts the sample');
    }
    if ((b.match(/t: 'data'/g) || []).length !== 1) problems.push("broker.ts posts `t: 'data'` outside deliver() — every sample must pass the waiting gate");
    if (!/function detachIfIdle\(name: string\): void \{\s*\n\s*const e = streams\.get\(name\);\s*\n\s*if \(!e \|\| e\.subs\.size \|\| e\.locals\.size \|\| !e\.stop\) return;/.test(b)) problems.push('detachIfIdle() no longer detaches exactly when the last subscription goes');
    const unsub = b.match(/case 'unsub': \{([\s\S]*?)\n    \}/);
    if (!unsub || !/detachIfIdle\(sub\.stream\)/.test(unsub[1])) problems.push("'unsub' no longer detaches an idle producer");
    if (/\b(setInterval|requestAnimationFrame)\(/.test(b)) problems.push('broker.ts runs its own timer or rAF — the owner side is driven by producers and pulls only');
    const c = read('src/renderer/live/client.ts').replace(/\r\n/g, '\n');
    const pulls = [...c.matchAll(/t: 'pull'/g)].length;
    const raf = c.match(/requestAnimationFrame\(\(\) => \{([\s\S]*?)\n  \}\);/);
    if (pulls !== 1 || !raf || !/t: 'pull'/.test(raf[1])) problems.push("client.ts must send `pull` only from its requestAnimationFrame callback (the window's own refresh)");
    // Every way a module comes in, bare side-effect imports included (one slipped past a from-only regex).
    for (const m of c.matchAll(/(?:^\s*(?:import|export)\s[^;]*?from\s+|^\s*import\s+|\bimport\(\s*|\brequire\(\s*)['"]([^'"]+)['"]/gm)) {
      if (m[1] !== '../../../shared/liveProtocol') problems.push(`live/client.ts imports '${m[1]}' — a client produces nothing; it may import only the wire`);
    }
    if (/^\s*import\s/m.test(read('shared/liveProtocol.ts'))) problems.push('shared/liveProtocol.ts imports something — it is the contract every side reads and must stay dependency-free');
    // Panel pixels are COPIES: the cache's own bitmap transferred away would vanish from every filmstrip.
    if (!/const copy = bmp \? await createImageBitmap\(bmp\)/.test(b)) problems.push('the thumbnail answer no longer sends a copy (createImageBitmap(bmp)) — transferring the cached bitmap detaches it');
    if (!/const copy = p \? p\.slice\(\) : null;/.test(b)) problems.push('the peaks answer no longer sends a copy (p.slice()) — transferring the cached array empties it');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the clock travels as an anchor, checked only while a client asks for it',
  'A playhead sent per frame is per-frame traffic to every window for as long as the show plays; a ' +
  'check left on the transport for no client costs every frame; an anchor stamped with "now" instead ' +
  'of the frame time reads the frame\'s own work as drift and re-sends constantly.',
  () => {
    const problems = [];
    const b = read('src/renderer/live/broker.ts').replace(/\r\n/g, '\n');
    const fn = b.match(/\nfunction checkClock\(\): void \{([\s\S]*?)\n\}/);
    if (!fn || !/^\s*const next = sampleClock\(\);\s*\n\s*if \(anchor && agrees\(anchor, next\)\) return;/.test(fn[1])) problems.push('checkClock() no longer returns early while the transport agrees with the last anchor');
    if ((b.match(/t: 'clock'/g) || []).length !== 2) problems.push("broker.ts posts `t: 'clock'` somewhere other than checkClock() and the clock-on answer");
    const sync = b.match(/\nfunction syncClockWatch\(\): void \{([\s\S]*?)\n\}/);
    if (!sync || !/const wanted = \[\.\.\.clients\.values\(\)\]\.some\(\(c\) => c\.clock\);/.test(sync[1]) || !/clockStop\(\);/.test(sync[1])) problems.push('syncClockWatch() no longer attaches the transport check only while some client asks for the clock (and detaches it after)');
    if ((b.match(/timeline\.subscribe\(/g) || []).length !== 1 || !sync || !/timeline\.subscribe\(/.test(sync[1])) problems.push('the broker subscribes to the transport outside syncClockWatch()');
    const sample = b.match(/\nfunction sampleClock\(\): ClockAnchor \{([\s\S]*?)\n\}/);
    if (!sample || !/at: performance\.timeOrigin \+ timeline\.getFrameTimeMs\(\)/.test(sample[1])) problems.push('the anchor is no longer stamped with the frame time (performance.timeOrigin + timeline.getFrameTimeMs())');
    const tl = read('src/renderer/services/timeline.ts').replace(/\r\n/g, '\n');
    if (!/function runFrame\(now: number\): void \{\s*\n\s*frameMs = now;/.test(tl)) problems.push('timeline.runFrame() no longer records the frame time first (frameMs = now)');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  "a live client's drags die with the client, and the editor is the one live owner",
  'A panel window that crashes mid-drag would leave a live override above the show — pinning a ' +
  'channel or the master until the app restarts; a second broker would be a second producer.',
  () => {
    const problems = [];
    const b = read('src/renderer/live/broker.ts').replace(/\r\n/g, '\n');
    const rm = b.match(/\nfunction removeClient\(clientId: number\): void \{([\s\S]*?)\n\}/);
    if (!rm || !/for \(const d of c\.held\.values\(\)\)[\s\S]*?\.abandon\(d\)/.test(rm[1])) problems.push('removeClient() no longer abandons every drag the client held');
    if (!rm || !/detachIfIdle\(sub\.stream\)/.test(rm[1])) problems.push('removeClient() no longer detaches the producers only that client watched');
    if (!rm || !/syncClockWatch\(\)/.test(rm[1])) problems.push('removeClient() no longer re-checks whether anyone still wants the clock');
    const hub = read('src/main/liveHub.ts');
    if (!/wc\.once\('destroyed', \(\) => \{ clients\.delete\(wc\); drop\(id\); \}\);/.test(hub)) problems.push("liveHub no longer tells the owner when a client's window is destroyed");
    if (!/wc\.on\('render-process-gone', \(\) => drop\(id\)\);/.test(hub)) problems.push('liveHub no longer tells the owner when a client page crashes');
    if (!/if \(entry\) \{[\s\S]*?drop\(entry\.clientId\);/.test(hub)) problems.push("liveHub no longer retires a reloaded client's old pair before pairing the new page");
    const core = read('src/renderer/live/coreStreams.ts');
    if (!/abandon: \(\) => livePreview\.setBrightness\(docStore\.getSlice\('globalBrightness'\)\)/.test(core)) problems.push('an abandoned LED-brightness drag no longer returns to the committed value');
    if (!/abandon: \(d\) => livePreview\.releaseFixtureChannel\(d\.fixtureId, d\.key\)/.test(core)) problems.push('an abandoned fixture-channel drag no longer releases the channel');
    const app = read('src/renderer/App.tsx');
    if (!/^startLiveBroker\(\);/m.test(app) || !/^installCoreLiveStreams\(\);/m.test(app)) problems.push('App.tsx no longer starts the broker and the core streams at module scope');
    if (!/abandon: \(\) => pushProjectorBrightnessRef\.current\(docStore\.getSlice\('projectorBrightness'\)\)/.test(app)) problems.push('an abandoned projector-brightness drag no longer returns the projectors to the committed value');
    for (const f of ['src/renderer/projector.tsx', 'src/renderer/docs.tsx', 'src/renderer/splash.tsx']) {
      if (/live\/broker/.test(read(f))) problems.push(`${f} imports the live broker — only the editor owns the live data`);
    }
    if (!/initLiveHub\(mainWindow\);/.test(read('src/main/index.ts'))) problems.push('main/index.ts no longer registers the editor as the live owner (initLiveHub(mainWindow))');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Panel windows: a client that produces nothing, on a read-only replica (E5/W5) ───────────────────
// renderer/panel.tsx is a detachable panel in its own window. It must PRODUCE NOTHING (plans/native-
// engine.md §9a rule 1) and it must never write the authority directly. Both breaks compile and boot:
// a panel window that imports the transport reads its own idle copy (a playhead stuck at 0) or runs a
// second one; a panel replica that sends its stores on connect overwrites the show with built-in
// defaults the moment the window opens.
check(
  "a panel window's import graph holds no transport, engine, decoder, GPU, broker or App code",
  'Checked on the BUNDLER\'S graph, not by reading import lines: a producer arrives through a chain ' +
  '(panel → some panel file → a helper → services/timeline), and the only thing that sees the whole ' +
  'chain is the bundler. The list of panels allowed out (contexts/detachable.tsx) is part of that graph.',
  () => {
    let esbuild;
    try { esbuild = require(path.join(ROOT, 'node_modules', 'esbuild')); } catch { return 'esbuild is not installed (npm install) — the panel-window graph cannot be checked'; }
    let meta;
    try {
      meta = esbuild.buildSync({
        entryPoints: [path.join(ROOT, 'src/renderer/panel.tsx')], absWorkingDir: ROOT, bundle: true, write: false, metafile: true,
        platform: 'browser', format: 'esm', jsx: 'automatic', logLevel: 'silent', external: ['electron'],
        loader: { '.svg': 'empty', '.png': 'empty', '.css': 'empty', '.wgsl': 'text', '.glsl': 'text', '.woff2': 'empty', '.wasm': 'empty' },
        alias: { '@artlux/sdk/renderer': './packages/sdk/src/renderer.ts', '@artlux/sdk': './packages/sdk/src/index.ts' },
      }).metafile;
    } catch (e) { return `bundling src/renderer/panel.tsx failed: ${(e.errors || []).slice(0, 2).map((x) => x.text).join(' | ') || e.message}`; }
    const norm = (i) => i.replace(/\\/g, '/');
    const inputs = Object.keys(meta.inputs).map(norm);
    const importsOf = new Map(Object.entries(meta.inputs).map(([k, v]) => [norm(k), v.imports.map((x) => norm(x.path))]));
    // Two files under gpu/ are NAME CATALOGS the content editor lists (effect and palette names), with
    // no GPU code. They pass only while they import nothing at all, so neither can grow a device into
    // the panel window's graph.
    const CATALOGS = ['src/renderer/gpu/effects.ts', 'src/renderer/gpu/palettes.ts'];
    const BANNED = [
      [/^src\/renderer\/engine\//, 'the frame engine'],
      [/^src\/renderer\/services\/timeline\.ts$/, 'the transport (services/timeline)'],
      [/^src\/renderer\/services\/(stateMachine|cueBus|surfaceMedia|contentSource|thumbnailCache|timelinePreloader|lightingPlayback|lightingRecorder|takeRecorder|oscController)\.ts$/, 'a runtime service'],
      [/^src\/renderer\/gpu\/(?!(effects|palettes)\.ts$)/, 'GPU code'],
      [/Simulator3D\//, 'the 3D view'],
      [/node_modules\/(three|@react-three)\//, 'three.js'],
      [/audioPeaks\.ts$/, 'the peaks decoder'],
      // Per-window state that only means something in the EDITOR: livePreview is the render-free layer
      // the frame engine reads, autoKey the arm the editor's commit path reads. A detachable panel that
      // called either directly would drive its own idle copy — a fader that moves nothing, an arm that
      // records nothing. Panels go through editor actions (pushFixtureChannels, setAutoKeyArmed, …).
      [/^src\/renderer\/services\/(livePreview|autoKey)\.ts$/, 'a per-window editor service (use the editor action instead)'],
      // The output bus and the health monitors are per window too: in a panel window they are an idle
      // copy — a DMX monitor gone black over a lit rig, a performance panel describing a window that
      // renders nothing. The monitors read through services/dmxFeed and services/editorHealth.
      [/^src\/renderer\/services\/(dmxSignal|perfMonitor|uiPerfMonitor)\.ts$/, 'a per-window output bus or health monitor (use services/dmxFeed / services/editorHealth)'],
      [/^src\/renderer\/live\/(broker|coreStreams)\.ts$/, 'the live broker (the editor is the one owner)'],
      [/^src\/renderer\/App\.tsx$/, 'App'],
      [/^src\/renderer\/host\/plugins\.ts$/, 'plugin activation'],
      // A PLUGIN only through its UI half (host/pluginUi.ts → `@artlux/plugin-x/ui`), and never a module
      // that runs: its activation or barrels, or a file named for runtime work. The names are the
      // plugins' own convention (ndiReceiver, poseEngine, trackingStore, trackingHost, shaderContext,
      // audioTap, PoseViz, poseCamera …); a UI half that needs one of them is not a UI half.
      [/^plugins\/[^/]+\/src\/(plugin\.renderer|plugin\.main|index|renderer|main|playback|authoring)\.tsx?$/, "a plugin's activation or barrel"],
      [/^plugins\/[^/]+\/src\/.*(Receiver|Drawable|Engine|Projector|Raster|Store|Manager|Context|Host|Tap|Viz|Camera|Recorder|Playback)\.tsx?$/i, "a plugin's runtime module"],
      // …and the runtime modules whose names do not say so. Each holds state only the editor fills: the
      // shader library store + its GL thumbnails, the live parameter overrides, the zone engine and the
      // people counter. A UI half asks for them through `live` (libraryView.ts, zoneView.ts).
      [/^plugins\/shader\/src\/(libraryClient|shaderParams)\.ts$/, "the shader runtime's library store or live parameters (use libraryView.ts)"],
      [/^plugins\/lidar-tracking\/src\/(zones|people|zoneViewSource)\.ts$/, "the zone engine or the people counter (use the zoneView stream)"],
    ];
    const problems = [];
    for (const [re, what] of BANNED) {
      const hit = inputs.find((i) => re.test(i));
      if (hit) problems.push(`panel.tsx reaches ${what}: ${hit}`);
    }
    for (const c of CATALOGS) {
      if ((importsOf.get(c) ?? []).length) problems.push(`${c} is let into the panel window as a pure name catalog, and it now imports ${importsOf.get(c).join(', ')}`);
    }
    // services/mediaCache is, despite its name, only the media URL helpers now (its blob cache was
    // deleted — see its header). It is let in ONLY while that stays true: it may import nothing but the
    // shared URL table. A cache, a decoder or an IPC read growing back into it is caught here (E5/W5j).
    const mc = 'src/renderer/services/mediaCache.ts';
    const mcImports = (importsOf.get(mc) ?? []).filter((i) => i !== 'shared/mediaUrl.ts');
    if (mcImports.length) problems.push(`${mc} is let into the panel window as pure URL helpers, and it now imports ${mcImports.join(', ')}`);
    // The door into a plugin: only src/renderer/host/pluginUi.ts, and only a plugin's ui.ts behind it.
    for (const [from, to] of importsOf) {
      if (from.startsWith('plugins/')) continue;
      for (const t of to) {
        if (!t.startsWith('plugins/')) continue;
        if (from !== 'src/renderer/host/pluginUi.ts') problems.push(`${from} imports plugin code (${t}) — a panel window reaches a plugin only through host/pluginUi.ts`);
        else if (!/^plugins\/[^/]+\/src\/ui\.ts$/.test(t)) problems.push(`host/pluginUi.ts imports ${t} — only a plugin's UI half (src/ui.ts) may be listed there`);
      }
    }
    if (!inputs.includes('src/renderer/contexts/detachable.tsx')) problems.push('panel.tsx no longer mounts its panels from contexts/detachable.tsx — the one list the editor registers too');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  "a plugin's UI half is activated in every window from one list, and registered nowhere else",
  'A content-source fragment registered from the UI half AND kept on the runtime provider is two copies ' +
  'that drift; a UI list the editor did not activate would show the panel window settings the editor ' +
  'lacks; a camera inspector that imported the content source directly would, in a panel window, read ' +
  'that window\'s idle copy and call a live camera "off".',
  () => {
    const problems = [];
    const list = read('src/renderer/host/pluginUi.ts');
    const halves = [...list.matchAll(/from '@artlux\/plugin-([a-z0-9-]+)\/ui'/g)].map((m) => m[1]);
    if (!halves.length) problems.push('host/pluginUi.ts lists no UI halves');
    if (/from '@artlux\/plugin-[a-z0-9-]+(?!\/ui)'|from '@artlux\/plugin-[a-z0-9-]+\/(?!ui')/.test(list)) problems.push('host/pluginUi.ts imports a plugin entry other than /ui');
    for (const name of halves) {
      const dir = path.join(ROOT, 'plugins', name, 'src');
      if (!fs.existsSync(path.join(dir, 'ui.ts'))) { problems.push(`plugins/${name}/src/ui.ts is listed but missing`); continue; }
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', name, 'package.json'), 'utf8'));
      if (pkg.exports?.['./ui'] !== './src/ui.ts') problems.push(`plugins/${name}/package.json does not export ./ui (the panel window's bundler would not find it)`);
      for (const f of fs.readdirSync(dir)) {
        if (f === 'ui.ts' || !/\.tsx?$/.test(f)) continue;
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        if (/^\s*editor\s*:/m.test(src) && /contentSources\.register|ContentSourceProvider/.test(src)) problems.push(`plugins/${name}/src/${f} still puts an editor on the runtime provider — the UI half (ui.ts) owns it`);
      }
    }
    const plugins = read('src/renderer/host/plugins.ts');
    if (!/activated = true;[\s\S]{0,400}?activatePluginUi\(win, live\.view, uiHostOf\(host\)\);[\s\S]*?for \(const p of FIRST_PARTY/.test(plugins)) problems.push('activateRendererPlugins no longer activates the UI halves (host/pluginUi.ts) before the runtimes');
    if (!/^activatePluginUi\('panel', remotePluginLive, remoteUiHost\);/m.test(read('src/renderer/panel.tsx'))) problems.push("panel.tsx no longer activates the plugins' UI halves with the live channel and the remote UI host (remotePluginLive, remoteUiHost)");
    const ce = read('src/renderer/components/ContentEditor.tsx');
    if (!/contentSourceUiRegistry\.get\(c\.type\)/.test(ce)) problems.push('ContentEditor no longer reads the UI registry (a panel window would show no plugin settings)');
    if (/services\/contentSource'/.test(read('src/renderer/components/CameraSettings.tsx'))) problems.push('CameraSettings imports services/contentSource — it must ask services/cameraAccess');
    if (!/^setCameraAccess\(\{ list: listCameras, info: getCameraInfo, retry: retryCamera, preview: previewCameraControl \}\);/m.test(read('src/renderer/services/contentSource.ts'))) problems.push('services/contentSource no longer installs itself as the camera access');
    if (!/^setCameraAccess\(remoteCameraAccess\);/m.test(read('src/renderer/panel.tsx'))) problems.push('panel.tsx no longer sends its camera questions to the editor');
    // What only a runtime knows reaches a UI half through `live`: published on the editor's broker, read
    // locally there and over the live channel in a panel window. Wired wrong, a panel window's fragment
    // waits forever on an answer nobody sends — or the editor's own fragment does.
    if (!/<FeedbackProvider>[\s\S]*<PanelEditorStore/.test(read('src/renderer/panel.tsx'))) problems.push("panel.tsx no longer mounts its panels inside <FeedbackProvider> — a panel calling useConfirm()/useToast() throws and takes the window down");
    if (!/activateRendererPlugins\('main', pluginHost, \{ owner: ownerPluginLive, view: localPluginLive \}\)/.test(read('src/renderer/App.tsx'))) problems.push("App no longer hands the plugins the editor's live owner and local view");
    if (!/activatePluginUi\(win, live\.view, uiHostOf\(host\)\);/.test(plugins)) problems.push('activateRendererPlugins no longer hands the UI halves its live view and its host');
    if (!/p\.activate\(\{ \.\.\.ctx, live: scopedLiveOwner\(live\.owner, p\.manifest\.id\) \}/.test(plugins)) problems.push("a plugin's runtime is no longer handed a live owner scoped to its own id");
    // A UI half reads its runtime only through the live view: never by importing a receiver, drawable or
    // context (the panel-graph check bans those by name) — and never the SDK hook on anything but it.
    for (const name of halves) {
      const dir = path.join(ROOT, 'plugins', name, 'src');
      const uiSrc = fs.existsSync(path.join(dir, 'ui.ts')) ? fs.readFileSync(path.join(dir, 'ui.ts'), 'utf8') : '';
      const others = fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && f !== 'ui.ts' && f !== 'uiLink.ts').map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
      const usesLive = others.some((s) => /\bliveView\(\)/.test(s));
      if (usesLive && !/setLiveView\(ctx\.live\);/.test(uiSrc)) problems.push(`plugins/${name}: its UI reads the live view, but ui.ts never sets it (setLiveView(ctx.live)) — every value would stay at its initial`);
      // …and the UI host the same way: a panel that reads settings or the scene through uiLink, from a
      // ui.ts that never handed it the host, shows empty settings and drops every edit — silently.
      const link = fs.existsSync(path.join(dir, 'uiLink.ts')) ? fs.readFileSync(path.join(dir, 'uiLink.ts'), 'utf8') : '';
      if (/export function setUiHost\(/.test(link) && !/setUiHost\(ctx\.host\);/.test(uiSrc)) problems.push(`plugins/${name}: uiLink.ts reads the UI host, but ui.ts never sets it (setUiHost(ctx.host))`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  "a panel in its own window gets everything it shows from the editor — UI halves, one seam per editor service, OSC, drags",
  'Every rule below is a panel window that LOOKS right and is quietly wrong, the shape that ships. ' +
  'A panel registered from a runtime cannot be in a panel window (the runtime never runs there), and one ' +
  'registered from both halves is two copies that drift. A UI panel that read the host captured by ' +
  'activate() would, in a window, read nothing and drop every edit; an OSC monitor in a window that main ' +
  'never sent OSC to would show a silent wire that is in fact busy — the most misleading thing a ' +
  'diagnostic can say.',
  () => {
    const problems = [];
    const pluginDirs = fs.readdirSync(path.join(ROOT, 'plugins')).filter((d) => fs.existsSync(path.join(ROOT, 'plugins', d, 'src')));
    const uiOf = (name) => { const f = path.join(ROOT, 'plugins', name, 'src', 'ui.ts'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
    const uiIds = new Set();
    for (const name of pluginDirs) for (const m of uiOf(name).matchAll(/ctx\.panels\.register\(\{ id: '([^']+)'/g)) uiIds.add(m[1]);
    for (const name of pluginDirs) {
      const dir = path.join(ROOT, 'plugins', name, 'src');
      const ui = uiOf(name);
      for (const f of fs.readdirSync(dir)) {
        if (f === 'ui.ts' || !/\.tsx?$/.test(f)) continue;
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const m of src.matchAll(/panels\.register\(\{([^}]*)/g)) {
          const id = (m[1].match(/id: '([^']+)'/) || [])[1];
          if (/detachable:\s*true/.test(m[1])) problems.push(`plugins/${name}/src/${f} registers a DETACHABLE panel '${id}' from the runtime — only a UI half's panel can open in a window`);
          if (id && uiIds.has(id)) problems.push(`plugins/${name}/src/${f} registers '${id}', which a UI half registers too`);
        }
        // A UI half's panel reaches the host through uiLink's UI host, never the runtime's captured one.
        const comp = f.replace(/\.tsx?$/, '');
        if (/\.tsx$/.test(f) && new RegExp(`Component: ${comp}\\b`).test(ui) && /from '\.\/[a-zA-Z]*Host'/.test(src)) {
          problems.push(`plugins/${name}/src/${f} is a UI half's panel but imports the runtime's host module — it must use uiLink's UI host`);
        }
      }
    }
    for (const id of ['osc-monitor', 'zone-editor', 'augmenta-monitor', 'pose-monitor', 'shader-editor', 'shader-nodes', 'shader-library']) {
      if (!uiIds.has(id)) problems.push(`the '${id}' panel is no longer registered from a UI half`);
    }
    // EVERY LIVE NAME A UI HALF ASKS FOR IS ONE ITS RUNTIME PUBLISHES. A name nobody registered is not an
    // error anywhere at run time: a subscription waits on its initial value forever, a call is refused
    // and the panel shows its fallback ("the editor did not answer") — a compile that never compiles.
    for (const name of pluginDirs) {
      const dir = path.join(ROOT, 'plugins', name, 'src');
      const id = (uiOf(name).match(/id: '([^']+)'/) || [])[1];
      const rtFile = path.join(dir, 'plugin.renderer.ts');
      if (!id || !fs.existsSync(rtFile)) continue;
      const rt = fs.readFileSync(rtFile, 'utf8');
      const published = new Set([...rt.matchAll(/ctx\.live\.(?:stream|call)\('([^']+)'/g)].map((m) => m[1]));
      const esc = id.replace(/[-]/g, '\\-');
      const ask = new RegExp(`(?:\\b(?:ask|call|subscribe|peek)\\(|liveView\\(\\), )'(${esc}\\.[A-Za-z]+)'`, 'g');
      for (const f of fs.readdirSync(dir)) {
        if (f === 'plugin.renderer.ts' || !/\.tsx?$/.test(f)) continue;
        for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(ask)) {
          if (!published.has(m[1])) problems.push(`plugins/${name}/src/${f} asks the runtime for '${m[1]}', which plugin.renderer.ts never publishes`);
        }
      }
    }
    // THE CORE MONITORS' SEAMS, both sides: the editor installs the services, a panel window the live
    // channel. Either missing and the monitor reads the inert default — a blank, silent panel.
    const streams = read('src/renderer/live/coreStreams.ts');
    if (!/installed = true;\s*\n[\s\S]{0,300}?installEditorAccess\(\);/.test(streams.replace(/\r\n/g, '\n'))) problems.push('installCoreLiveStreams no longer installs the editor side of the monitor seams (installEditorAccess)');
    for (const s of ['dmx.universes', 'sm.state']) if (!streams.includes(`registerLiveStream('${s}'`)) problems.push(`the editor no longer publishes '${s}' (a monitor in a window reads it)`);
    const access = read('src/renderer/live/editorAccess.ts');
    if (!/setDmxFeed\(\{ subscribe: \(_needs, cb\) => dmxSignal\.subscribe\(\(d\) => cb\(viewOf\(d\)\)\) \}\);/.test(access) || !/\n\s*pixels: d\.pixels,\n/.test(access.replace(/\r\n/g, '\n'))) problems.push("the editor's DMX feed is no longer the bus itself (the docked monitor must stay zero-copy)");
    const panelSrc = read('src/renderer/panel.tsx');
    if (!/^setDmxFeed\(remoteDmxFeed\);/m.test(panelSrc) || !/^setEditorHealth\(remoteEditorHealth\);/m.test(panelSrc)) problems.push('panel.tsx no longer installs the remote DMX feed and editor health');
    const det = read('src/renderer/contexts/detachable.tsx');
    for (const id of ['core.browser.timing', 'core.dock.monitor', 'core.dock.perf',
      'core.dock.fixtureLibrary', 'core.dock.fixtureWiring', 'core.dock.routing',
      'core.browser.models', 'core.browser.scene3dFixtures', 'core.inspector.model.transform',
      'core.inspector.fixture.arrange', 'core.inspector.scene.lighting', 'core.inspector.scene.tracking']) {
      if (!det.includes(`id: '${id}'`)) problems.push(`'${id}' is no longer detachable`);
    }
    // The 3D VIEW's part of the scene panels (W5h): a model's named screens and the viewer camera. The
    // editor publishes them; a window mirrors the screens and asks for the camera. Missing, a window's
    // Model card lists no screens for a model that has them, and its UV bake does nothing.
    for (const s of ["registerLiveStream('scene3d.screens'", "registerLiveCall('scene3d.captureView'", "registerLiveCall('scene3d.focusScreen'"]) {
      if (!streams.includes(s)) problems.push(`the editor no longer has ${s.split("'")[1]} (the scene panels in a window read it)`);
    }
    if (!/setViewerCapture\(async \(\) => captureViewerViewProj\(\)\);/.test(access)) problems.push("the editor no longer installs its 3D viewer camera as the capture (services/viewerView)");
    if (!/^installSceneRemote\(\);/m.test(read('src/renderer/panel.tsx'))) problems.push('panel.tsx no longer mirrors the 3D view (installSceneRemote)');
    // THE SHOW MACHINE in a window (W5i): its running state, fired edges and two nudges, its OSC learn and
    // sender list, and the editor's timeline drawer. Each missing half leaves a graph that looks fine and
    // does nothing — a ring that never moves, a Learn button that waits forever.
    if (!det.includes("id: 'core.viewport.machine'")) problems.push("'core.viewport.machine' is no longer detachable");
    for (const s of ["registerLiveStream('osc.learn'", "registerLiveStream('sm.fired'", "registerLiveCall('sm.trigger'", "registerLiveCall('sm.enter'", "registerLiveCall('shell.revealBottom'"]) {
      if (!streams.includes(s)) problems.push(`the editor no longer has ${s.split("'")[1]} (the Show Machine in a window reads it)`);
    }
    if (!/setShowMachineLive\(\{\s*subscribeState: \(cb\) => timeline\.subscribeSmState\(cb\)/.test(access)) problems.push('the editor no longer installs the transport as the running show machine (services/showMachineLive)');
    if (!/setRevealBottom\(\(\) => revealBottom\(\)\);/.test(access)) problems.push("the editor no longer installs its timeline drawer (services/editorShell)");
    if (!/^installOscRemote\(\);/m.test(read('src/renderer/panel.tsx'))) problems.push('panel.tsx no longer wires the Show Machine to the editor (installOscRemote)');
    if (!/export function learn\(cb[^\n]*\n\s*if \(remoteLearn\) return remoteLearn\(cb\);/.test(read('src/renderer/services/smOscInbox.ts').replace(/\r\n/g, '\n'))) problems.push('smOscInbox.learn no longer hands a panel window\'s learn to the editor');
    if (/services\/timeline'/.test(read('src/renderer/components/timeline/StateGraphEditor.tsx'))) problems.push('StateGraphEditor imports the transport — the running machine comes through services/showMachineLive');
    // THE TAKES DOCKS AND THE MEDIA LIBRARY (W5j): the recorder, a take's density and a video's still
    // are the editor's. Either half missing, a window shows a Record button that never turns red, empty
    // sparklines, grey tiles — all silently.
    for (const id of ['core.dock.lightingTakes', 'core.dock.trackingTakes', 'core.browser.media', 'core.dock.media']) {
      if (!det.includes(`id: '${id}'`)) problems.push(`'${id}' is no longer detachable`);
    }
    for (const s of ["registerLiveStream('takes.state'", "registerLiveCall('takes.toggle'", "registerLiveCall('takes.density'"]) {
      if (!streams.includes(s)) problems.push(`the editor no longer has ${s.split("'")[1]} (the takes docks in a window use it)`);
    }
    for (const [fn, what] of [['setTakesAccess(', 'the take recorder'], ['setTakeDensitySource(', "a take's density"], ['setThumbView({ getThumb, onThumb })', 'the thumbnail cache']]) {
      if (!access.includes(fn)) problems.push(`the editor no longer installs ${what} (live/editorAccess.ts)`);
    }
    if (!/^installTakesRemote\(\);/m.test(read('src/renderer/panel.tsx'))) problems.push('panel.tsx no longer wires the takes docks and the media stills to the editor (installTakesRemote)');
    // ⚠ THE EDITOR'S LAYOUT IS THE EDITOR'S TO WRITE. A window's layoutStore starts from the defaults, and
    // one write from it (the media library's view toggle) replaced the operator's whole saved workbench.
    if (!/^disableLayoutPersistence\(\);/m.test(read('src/renderer/panel.tsx'))) problems.push('panel.tsx no longer turns layout persistence off — a panel window would write its default layout over the editor\'s');
    if (!/function persistSoon\(\): void \{\s*\n\s*if \(!persist\) return;/.test(read('src/renderer/services/layoutStore.ts').replace(/\r\n/g, '\n'))) problems.push('layoutStore.persistSoon no longer honours disableLayoutPersistence()');
    // PREFERENCES IN A WINDOW (W5k): a plugin with a UI half registers its section THERE (a window shows
    // only what UI halves registered — a section left on the runtime silently vanishes from it); the
    // settings of the editor's own window are disabled there with a pointer, never live-looking no-ops.
    if (!det.includes("id: 'core.viewport.preferences'")) problems.push("'core.viewport.preferences' is no longer detachable");
    // EVERY UI HALF IS ACTIVATED. One left out of the list is not an error anywhere — its sections, panels
    // and content editors just vanish from every window, the editor included.
    const uiList = read('src/renderer/host/pluginUi.ts');
    const imported = [...uiList.matchAll(/import \{ ui as (\w+) \} from '@artlux\/plugin-([a-z0-9-]+)\/ui'/g)];
    const editorList = (uiList.match(/:\s*\[([^\]]*)\];/) || [])[1] ?? '';
    for (const [, v, plugin] of imported) if (!new RegExp(`\\b${v}\\b`).test(editorList)) problems.push(`host/pluginUi.ts imports the ${plugin} UI half but never activates it in the editor's list`);
    for (const name of pluginDirs) if (uiOf(name) && !imported.some(([, , p]) => p === name)) problems.push(`plugins/${name} has a UI half (ui.ts) that host/pluginUi.ts does not list`);
    for (const name of pluginDirs) {
      const rt = path.join(ROOT, 'plugins', name, 'src', 'plugin.renderer.ts');
      if (!uiOf(name) || !fs.existsSync(rt)) continue;
      if (/ctx\.settings\.register\(/.test(fs.readFileSync(rt, 'utf8'))) problems.push(`plugins/${name}: its runtime registers a Preferences section, but it has a UI half — register it in ui.ts (a Preferences window would not have it)`);
    }
    const uiSections = new Set(pluginDirs.flatMap((n) => [...uiOf(n).matchAll(/ctx\.settings\.register\(\{ id: '([^']+)'/g)].map((m) => m[1])));
    for (const id of ['audio', 'augmenta', 'mediapipe', 'video', 'shader', 'show-control']) {
      if (!uiSections.has(id)) problems.push(`the '${id}' Preferences section is no longer registered from a UI half`);
    }
    if (!/^markPanelWindow\(\);/m.test(read('src/renderer/panel.tsx'))) problems.push('panel.tsx no longer marks itself a panel window (services/windowRole) — Preferences would offer the editor window\'s settings as if it could change them');
    const prefs = read('src/renderer/components/Preferences.tsx');
    if (!/<EditorOnly>\s*<Toggle label="Dockable workspace"/.test(prefs)) problems.push('Preferences: "Dockable workspace" is no longer EditorOnly');
    if (!/<EditorOnly><WorkspacesSection \/><\/EditorOnly>/.test(prefs)) problems.push('Preferences: the named-workspace manager is no longer EditorOnly');
    if (!/<EditorOnly>\s*<Slider label="3D render scale"/.test(prefs)) problems.push("Preferences: the 3D view's quality settings are no longer EditorOnly");
    if (!streams.includes("registerLiveStream('prefs.sections'")) problems.push("the editor no longer publishes 'prefs.sections' (Preferences in a window says which sections it lacks)");
    // A TAB DRAGGED BETWEEN WINDOWS (W5l). Each rule is a way the drag silently loses or duplicates a
    // panel: the source letting go before the target took it, a non-detachable panel landing in a window
    // that cannot run it, a drop routed to the window UNDER the one the operator sees, a page's own
    // screen coordinates (scaled per window by the UI zoom) used as the cursor, a window kept open on a
    // last tab it just sent away.
    const dd = read('src/renderer/components/shell/DockDrag.tsx');
    if (!/dockDrag\('drop', panelId\)\.then\(\(r\) => \{\s*\n?\s*if \(!r\?\.ok\) return;\s*\n?\s*const next = closePanel\(/.test(dd.replace(/\r\n/g, '\n'))) problems.push('DockDrag no longer removes a dragged-out tab ONLY after the other window took it');
    if (!/const crossable = \(panelId: string\): boolean => !!panelRegistry\.get\(panelId\)\?\.detachable/.test(dd)) problems.push('DockDrag no longer lets only detachable panels leave a window');
    if (!/if \(!p \|\| \(isPanelWindow\(\) && !p\.detachable\)\) return false;/.test(dd)) problems.push('a panel window no longer refuses a non-detachable panel dropped from the editor');
    const pwm = read('src/main/panelWindows.ts');
    if (!/function windowUnderCursor[\s\S]{0,200}?screen\.getCursorScreenPoint\(\)/.test(pwm)) problems.push('main no longer reads the cursor itself for a cross-window drag');
    if (!/const candidates = \[\.\.\.focusOrder, \.\.\.rest\];/.test(pwm)) problems.push('main no longer tries windows topmost first (focus order) for a cross-window drop');
    if (!/getZoomFactor\(\)/.test(pwm.match(/function windowUnderCursor[\s\S]*?\n\}/)?.[0] ?? '')) problems.push("main no longer converts the cursor with the target window's zoom factor");
    if (!/const closedYetShown = ids\.filter\(\(id\) => next\.removed\.includes\(id\)\);\s*\n\s*if \(!ids\.length \|\| closedYetShown\.length === ids\.length\) \{ window\.close\(\); return; \}/.test(read('src/renderer/panel.tsx').replace(/\r\n/g, '\n'))) problems.push("a panel window no longer closes when its last tab goes (closePanel keeps a tree's last panel)");
    // ⚠ THE FIRST TAKE ON THE GLOBAL TIMELINE WAS LOST (found W5j, docked just the same): stopTracking's
    // library commit and its lane commit hit ONE document when no scene is bound, and the lane commit read
    // that document from a render ref — the timeline from before the take — and wrote it back.
    const app = read('src/renderer/App.tsx');
    const hostBlock = app.match(/takeRecorder\.setHost\(\{([\s\S]*?)\n\s*selectedFixtureIds:/)?.[1] ?? '';
    if (!/globalTimeline: \(\) => docStore\.getSlice\('timeline'\)/.test(hostBlock)) problems.push("App's take host no longer reads the global timeline from the store (a render ref there loses the take the lane commit overwrites)");
    if (!/timeline: \(\) => \(activeSceneIdRef\.current \? activeTimelineRef\.current : docStore\.getSlice\('timeline'\)\)/.test(hostBlock)) problems.push("App's take host no longer reads the UNBOUND timeline from the store");
    if (/from '\.\.\/\.\.\/components\/Simulator3D\//.test(read('src/renderer/contexts/panels/scene3d.tsx'))) problems.push('contexts/panels/scene3d.tsx imports the 3D view directly — use services/modelScreenNames / services/viewerView');
    // The panel window resolves its panel from the registry the UI halves filled, and only a detachable one.
    const panel = read('src/renderer/panel.tsx');
    if (!/activatePluginUi\('panel'[\s\S]*?const panel = \(\(p\) => \(p\?\.detachable \? p : undefined\)\)\(panelRegistry\.get\(panelId\)\);/.test(panel)) problems.push('panel.tsx no longer resolves its panel from the registry AFTER the UI halves registered theirs (a plugin panel would say it cannot open in a window)');
    // A dock panel is sized h-full against its tab body. In the editor that body is absolute inset-0; in
    // a window the panel sits in Body's wrapper, which must be full height too or the panel is 0 tall
    // (the Trigger Zones map drew nothing at all in a window until this).
    if (!/<div className=\{p\.mount === 'inspector' \? 'p-3 space-y-3' : 'h-full'\}>/.test(panel)) problems.push("panel.tsx's Body wrapper no longer gives a non-inspector panel full height — a dock panel sized h-full draws at 0 height in a window");
    // The UI host: the editor's own services, and in a window the replica with writes sent to the editor.
    const plugins = read('src/renderer/host/plugins.ts');
    if (!/registerLiveCall\('host\.scene3DPatch', \(partial\) => host\.scene3D\.patch\(/.test(plugins)) problems.push("the editor no longer answers 'host.scene3DPatch' on the host's own scene service");
    if (!/registerLiveCall\('host\.menuAction',/.test(plugins)) problems.push("the editor no longer answers 'host.menuAction'");
    const remote = read('src/renderer/live/uiHostRemote.ts');
    if (!/liveClient\.action\('host\.scene3DPatch'/.test(remote)) problems.push('live/uiHostRemote.ts no longer sends a scene patch to the editor');
    if (/docStore\.(set|patch|replace)/.test(remote)) problems.push('live/uiHostRemote.ts writes the replica directly — a panel window edits only through the editor');
    // OSC to the windows that listen: the editor always, any other window while it taps.
    const pre = read('src/preload/index.ts');
    if (!/onOscMessage: \(cb[\s\S]{0,300}?ipcRenderer\.send\(IPC\.OSC_TAP, true\)[\s\S]{0,300}?ipcRenderer\.send\(IPC\.OSC_TAP, false\)/.test(pre)) problems.push('the preload no longer taps OSC per listener (IPC.OSC_TAP on and off)');
    const ipc = read('src/main/ipc.ts');
    if (!/osc\.start\(cfg\.listenPort, sendOsc,/.test(ipc)) problems.push('main no longer receives OSC through sendOsc (the editor + tapped windows)');
    if (!/const sendOsc = [\s\S]{0,200}?getWindow\(\)\?\.webContents\.send\(IPC\.OSC_MESSAGE[\s\S]{0,200}?for \(const \{ wc \} of oscTaps\.values\(\)\) if \(!wc\.isDestroyed\(\)\)/.test(ipc)) problems.push('main.sendOsc no longer sends to the editor AND every live tapped window');
    if (!/wc\.once\('destroyed', \(\) => oscTaps\.delete\(wc\.id\)\)/.test(ipc)) problems.push('a closed window is no longer dropped from the OSC taps');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  "a panel window's replica is read-only, and the host gives it the document",
  'A panel replica that hands the host its state on connect overwrites the show with the built-in ' +
  'defaults; one that renders before the snapshot lands shows a "Main Arch" fixture nobody made; a ' +
  'host that accepted a raw write from a panel would skip every rule App\'s handlers keep.',
  () => {
    const problems = [];
    const panel = read('src/renderer/panel.tsx');
    if (!/^setHostLinkRole\('panel'\);/m.test(panel)) problems.push("panel.tsx no longer sets its Show Host role to 'panel' at module scope");
    const link = read('src/renderer/state/hostLink.ts').replace(/\r\n/g, '\n');
    if (!/function markWritten\(store: StoreName, key: string\): void \{\s*\n\s*if \(applyingRemote \|\| !connected \|\| role === 'panel'\) return;/.test(link)) problems.push("hostLink.markWritten no longer refuses to send from a 'panel' replica");
    const att = link.match(/\nfunction attach\(p: MessagePort\): void \{([\s\S]*?)\n\}/);
    if (!att || !/if \(role === 'panel'\) \{\s*\n\s*post\(\{ t: 'hello', role: 'panel' \}\);/.test(att[1])) problems.push('hostLink.attach no longer greets as a panel without handing over its state');
    if (att && /sendAll\(\)/.test(att[1].split("if (role === 'panel')")[1]?.split('} else {')[0] ?? '')) problems.push('hostLink.attach sends the panel replica\'s state');
    const store = read('src/renderer/live/panelStore.tsx');
    if (!/if \(!extras \|\| !ready\) return null;/.test(store)) problems.push('PanelEditorStore no longer waits for the host snapshot (and the editor extras) before rendering');
    const host = read('src/showhost/index.ts');
    if (!/if \(c\.role === 'panel'\) return;/.test(host)) problems.push("the Show Host no longer refuses a raw 'set' from a panel window");
    if (!/function servePanel\(c: Client\): void \{[\s\S]*?send\(c, \{ t: 'patch', store, key, value: stores\[store\]\.getSlice\(key\), acked: c\.lastSeq \}\)[\s\S]*?send\(c, \{ t: 'historyState'/.test(host)) problems.push('the Show Host no longer sends a joining panel the whole document, then historyState (the end-of-snapshot mark)');
    // A host that has (re)started holds only part of the document until the editor's handover ends:
    // a panel joining then is QUEUED and served on `synced`, never sent a half-filled snapshot.
    if (!/if \(m\.role === 'panel'\) \{\s*\n\s*if \(editorSynced\) servePanel\(c\); else waitingPanels\.add\(c\);/.test(host.replace(/\r\n/g, '\n'))) problems.push('the Show Host serves a joining panel before the editor\'s handover is complete');
    if (!/case 'synced':[\s\S]*?editorSynced = true;[\s\S]*?servePanel\(w\)/.test(host)) problems.push("the Show Host no longer serves waiting panels when the editor says 'synced'");
    if (!/sendAll\(\);\s*\n\s*post\(\{ t: 'synced' \}\);/.test(read('src/renderer/state/hostLink.ts').replace(/\r\n/g, '\n'))) problems.push("the editor no longer tells the host its handover is complete ('synced' after sendAll)");
    // Edits leave the window as actions, with arguments that can cross (a click event cannot).
    if (!/const call = \(name: string, args: unknown\[\]\) => liveClient\.action\(name, args\.map\(sendable\)\);/.test(store)) problems.push('remote actions no longer drop unsendable arguments — `onClick={a.addFixture}` would lose the whole edit');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'panel windows open on a screen, close with the editor, and only in the editor',
  'A window restored to a screen that is gone is a window nobody can see or close; one closed with the ' +
  'editor on "close" vanishes when the unsaved-changes guard then cancels the close; a show machine ' +
  'that reopened panel windows would put editor UI on a venue screen.',
  () => {
    const problems = [];
    const pw = read('src/main/panelWindows.ts').replace(/\r\n/g, '\n');
    const place = pw.match(/\nfunction placement\(panelId: string\): Rectangle \{([\s\S]*?)\n\}/);
    if (!place) problems.push('placement() not found');
    else {
      const returns = [...place[1].matchAll(/\breturn ([^;]+);/g)].map((m) => m[1]);
      if (!returns.length || returns.some((r) => !/^clampInto\(/.test(r))) problems.push('every placement() result must go through clampInto() — a window must never open off-screen');
    }
    if (!/editor\.on\('closed', \(\) => \{\s*\n\s*editorClosing = true;/.test(pw)) problems.push("panel windows must close on the editor's 'closed', not 'close' (the close guard can cancel a 'close')");
    if (!/win\.on\('closed', \(\) => \{\s*\n\s*if \(t\) clearTimeout\(t\);\s*\n\s*remember\(last\);/.test(pw)) problems.push("a panel window's place must be written from its TRACKED bounds on 'closed' (a page-closed window never emits 'close')");
    if (!/win\.webContents\.on\('did-finish-load', \(\) => \{ if \(!win\.isDestroyed\(\)\) connectShowHost\(win\); \}\);/.test(pw)) problems.push('a panel window is no longer given a Show Host port on every load');
    // Keys: a panel window has NO application menu (so no stray Ctrl+R reload, and one owner of Ctrl+S),
    // and forwards the shared ones to the editor's own actions.
    if (!/win\.removeMenu\(\);/.test(pw)) problems.push('a panel window keeps the application menu — its registered accelerators (Ctrl+R reload, Ctrl+S) would fire there');
    const pt = read('src/renderer/panel.tsx');
    for (const [re, what] of [
      [/keymap\.matches\(e, 'global\.undo'\)\) run\('menuAction', \['undo'\]\)/, 'Undo'],
      [/keymap\.matches\(e, 'global\.redo'\)\) run\('menuAction', \['redo'\]\)/, 'Redo'],
      [/keymap\.matches\(e, 'timeline\.togglePlay'\)\) run\('togglePlay'\)/, 'Play / pause'],
      [/e\.key\.toLowerCase\(\) === 's'\) \{ run\('menuAction', \['save'\]\)/, 'Save'],
    ]) if (!re.test(pt)) problems.push(`panel.tsx no longer forwards ${what} to the editor`);
    if (!/keymap\.hydrate\(/.test(pt)) problems.push("panel.tsx no longer loads the operator's rebindings (keymap.hydrate)");
    // No host = no document: say so instead of "Connecting…" forever.
    if (!/fallback=\{<Connecting \/>\}/.test(pt) || !/const NO_HOST_AFTER_MS = /.test(pt)) problems.push('a panel window with no Show Host no longer explains itself (it would say "Connecting…" forever)');
    if (!/if \(!HEADLESS && !BROADCAST\) registerPanelWindows\(mainWindow, \(\) => mainWindow\);/.test(read('src/main/index.ts'))) problems.push('panel windows must be registered in the editor only (never headless / broadcast)');
    // The operator's door: a detachable panel's SECTION HEADER (a stacked section has no tab, so a tab
    // menu alone would never be reached for exactly the panels that can detach).
    if (!/panel\.detachable && window\.artlux\?\.openPanelWindow/.test(read('src/renderer/components/shell/WorkspaceShell.tsx'))) problems.push('the section header no longer offers "Open in new window" for a detachable panel');
    if (!/panel: resolve\(__dirname, 'src\/renderer\/panel\.html'\)/.test(read('electron.vite.config.ts'))) problems.push('electron.vite.config.ts no longer builds panel.html — main would open a window onto nothing');
    return problems.length ? problems.join('; ') : null;
  },
);

// ── Every field App hands the panels is in the memo's dependency list (E5/W5) ────────────────────────
check(
  "every value in App's editorData is in its useMemo deps",
  'editorData is memoized on its fields so that panels re-render only when one of them moves (see the ' +
  'comment above it). A field added to the object but not to the deps is FROZEN at its first value for ' +
  'every panel: it compiles, it boots, and the control simply stops reflecting the state. It happened ' +
  'with autoKeyArmed (E5/W5b): arming auto-key in the channel strip did nothing visible, and the release ' +
  'recorded no key, in the editor only — a panel window read the same value through another path.',
  () => {
    const app = read('src/renderer/App.tsx').replace(/\r\n/g, '\n');
    const m = app.match(/const editorData: EditorData = useMemo\(\(\) => \(\{([\s\S]*?)\}\), \[([\s\S]*?)\]\);/);
    if (!m) return "App.tsx: `const editorData: EditorData = useMemo(() => ({ … }), [ … ]);` not found";
    const values = m[1].split(',').map((p) => p.trim()).filter(Boolean).map((p) => (p.includes(':') ? p.split(':')[1].trim() : p));
    const deps = new Set(m[2].split(',').map((d) => d.trim()).filter(Boolean));
    if (values.length < 20) return `only ${values.length} editorData fields parsed — the scan has stopped seeing them`;
    const missing = values.filter((v) => /^[A-Za-z_$][\w$]*$/.test(v) && !deps.has(v));
    return missing.length ? `editorData reads ${missing.join(', ')} but its useMemo does not depend on ${missing.length > 1 ? 'them' : 'it'} — panels would see the first value forever` : null;
  },
);

// ── Main never posts a port to a crashed page (E5/W5b-2) ─────────────────────────────────────────────
check(
  'main hands pages ports only through postToPage (never to a crashed page)',
  '`webContents.postMessage` to a page whose renderer has crashed BLOCKS the main process. Found by ' +
  'test-panel-window: a panel window\'s page crashed, the Show Host was killed, main\'s restart path ' +
  'reconnected every window, and main froze for good (CDP, IPC, every window — the show). Reproduced ' +
  'with a control: same steps without the crash stayed responsive. Every port post goes through ' +
  'src/main/postToPage.ts, which skips a crashed or destroyed page and closes its ports.',
  () => {
    const problems = [];
    for (const f of walk('src/main').filter((x) => /\.ts$/.test(x) && !/postToPage\.ts$/.test(x))) {
      const src = read(f);
      for (const m of src.matchAll(/(\w+(?:\.webContents)?)\.postMessage\(/g)) {
        // child.postMessage (the utility process) and port.postMessage (a MessagePortMain) are not pages.
        if (/^(child|proc|port|port1|port2|p|c)$/.test(m[1])) continue;
        if (/webContents$|^wc$|^sender$/.test(m[1])) problems.push(`${f.replace(ROOT, '').replace(/\\/g, '/')}: ${m[1]}.postMessage( — use postToPage()`);
      }
    }
    const pp = read('src/main/postToPage.ts');
    if (!/if \(wc\.isDestroyed\(\) \|\| wc\.isCrashed\(\)\)/.test(pp)) problems.push('postToPage no longer refuses a crashed or destroyed page');
    if (!/if \(win\.webContents\.isCrashed\(\)\) return;/.test(read('src/main/showHost.ts'))) problems.push('showHost.connect no longer skips a crashed page before telling the host about it');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a panel fits a narrow panel window (no fixed side column, no toolbar that runs off the edge)',
  'A panel window opens 380 px wide and goes down to 240, and panels laid out for the editor\'s docks did ' +
  'not fit: Trigger Zones printed "Zones 1" on top of its surface picker (seen in the PACKAGED app), the ' +
  'Show Machine left its graph ~90 px with its toolbar cut off, the OSC/Augmenta monitors\' filter ran ' +
  'off the edge, and Routing crushed its name and IP fields to slivers. The rule is measured by ' +
  'scripts/test-panel-narrow.cjs (every detachable panel at 380 and 280 px); these are the fixes it ' +
  'found, held in place: a side column goes UNDER below a width, a toolbar wraps, a data grid gets a ' +
  'floor width and scrolls.',
  () => {
    const problems = [];
    const zp = read('plugins/lidar-tracking/src/ZonePanel.tsx');
    if (!/setNarrow\(el\.clientWidth > 0 && el\.clientWidth < \d+\)/.test(zp) || !/narrow \? 'max-h-\[45%\] border-t' : 'w-64 border-l'/.test(zp)) problems.push('Trigger Zones: the zone list no longer goes under the map when narrow');
    if (!/<div className="flex flex-wrap items-center gap-x-2 gap-y-1">\s*<span className="text-fg-3 text-micro">Surface<\/span>/.test(zp)) problems.push('Trigger Zones: the map header row no longer wraps');
    const sg = read('src/renderer/components/timeline/StateGraphEditor.tsx');
    if (!/setNarrow\(el\.clientWidth > 0 && el\.clientWidth < \d+\)/.test(sg) || !/narrow \? 'h-\[45%\] border-t' : 'w-72 border-l'/.test(sg)) problems.push('Show Machine: the inspector no longer goes under the graph when narrow');
    if (!/className="min-h-9 shrink-0 flex flex-wrap items-center/.test(sg)) problems.push('Show Machine: the toolbar no longer wraps');
    for (const f of ['plugins/lidar-tracking/src/OscMonitor.tsx', 'plugins/augmenta/src/AugmentaMonitor.tsx']) {
      const s = read(f);
      if (!/<div className="px-3 py-2 flex flex-wrap items-center[^"]*">\s*<Button variant="tonal" size="sm" onClick=\{\(\) => setPaused/.test(s)) problems.push(`${f}: the controls row no longer wraps`);
      if (/placeholder="filter address…"\s*className="[^"]*\bw-48\b/.test(s)) problems.push(`${f}: the filter is a fixed width again`);
    }
    const rt = read('src/renderer/components/RoutingModal.tsx');
    if ((rt.match(/className="(?:mt-1\.5 )?min-w-\[\d+px\] border border-line-1 rounded-md divide-y divide-line-1"/g) || []).length !== 2) problems.push('Routing: the controller and fixture grids lost their floor width (they crush instead of scrolling)');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine is a supervised child: flag-gated, restarted after a crash or a hang, never after a refusal, shipped in the Windows package',
  'plans/native-engine.md E1a. A child process with no supervisor is a show that goes dark and stays dark; ' +
  'a supervisor that restarts a REFUSING engine (no hardware adapter: exit 2) forks it in a loop for ' +
  'nothing; a hung engine looks alive, so silence on the ping must kill it; and an engine that is not in ' +
  'the package is a feature that works in dev only (electron-builder skips a missing extraResources file ' +
  'silently — verify:resources catches it only if it is DECLARED). Until it carries output it runs only ' +
  'behind --native-engine / ARTLUX_NATIVE_ENGINE=1.',
  () => {
    const problems = [];
    const eh = read('src/main/engineHost.ts');
    if (!/const FLAG = process\.argv\.includes\('--native-engine'\) \|\| process\.env\.ARTLUX_NATIVE_ENGINE === '1';/.test(eh)) problems.push('engineHost: the flag gate changed');
    if (!/export function startEngine\(\): void \{\s*if \(!FLAG\) return;/.test(eh)) problems.push('engineHost: startEngine no longer returns early without the flag');
    if (!/if \(code === EXIT_REFUSED\) \{[\s\S]{0,400}?return;\s*\}\s*onDeath\(/.test(eh)) problems.push('engineHost: a refusing engine (exit 2) is no longer left stopped');
    if (!/if \(now - lastPong > PONG_TIMEOUT_MS\) \{[\s\S]{0,400}?proc\.kill\(\);/.test(eh)) problems.push('engineHost: a hung engine (no pong) is no longer killed');
    if (!/const late = now - lastTick > 2 \* PING_MS;\s*lastTick = now;\s*if \(late\) lastPong = now;/.test(eh)) problems.push('engineHost: a late ping tick (main stalled) would judge the engine hung — it must restart the clock instead');
    if (!/if \(deaths\.length > RESTART_LIMIT\) \{[\s\S]{0,300}?return;/.test(eh)) problems.push('engineHost: no give-up after RESTART_LIMIT deaths in a minute');
    if (!/setTimeout\(\(\) => \{ if \(!stopping && !child\) spawnEngine\(\); \}, RESTART_DELAY_MS\);/.test(eh)) problems.push('engineHost: a dead engine is no longer restarted');
    const idx = read('src/main/index.ts');
    if (!/\n\s*startEngine\(\);/.test(idx)) problems.push('index.ts no longer starts the engine host');
    if (!/stopShowHost\(\);[^\n]*\n\s*stopEngine\(\);/.test(idx)) problems.push('index.ts no longer stops the engine with the Show Host at shutdown');
    const pkg = JSON.parse(raw('package.json'));   // raw: read() strips `//` comments, and URLs have them
    if (!(pkg.build?.win?.extraResources || []).some((r) => r.from === 'engine/target/release/artlux-engine.exe' && r.to === 'engine/artlux-engine.exe')) problems.push('package.json: the engine is not in build.win.extraResources');
    if (!/- name: Build the native render engine \(Windows\)\s*\n\s*if: runner\.os == 'Windows'\s*\n\s*run: npm run build:engine/.test(raw('.github/workflows/build.yml'))) problems.push('build.yml: the Windows package job no longer builds the engine');
    const sv = read('engine/artlux-engine/src/serve.rs');
    if (!/Err\(e\) => \{\s*eprintln!\("artlux-engine: \{e\}"\);\s*return ExitCode::from\(2\);/.test(sv)) problems.push('serve.rs: a refused device no longer exits 2');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'universe packing has ONE TypeScript implementation (engine/packUniverses.ts), the one the native engine is held to',
  'plans/native-engine.md E1b: the engine\'s Rust packer (engine/artlux-engine/src/pack.rs) is proven byte ' +
  'for byte against packUniverses.ts by scripts/test-pack-parity.cjs. That proof is worth nothing the day ' +
  'the frame engine grows a second packing loop of its own — the wire would follow the copy, the parity ' +
  'harness the original. So the frame engine packs ONLY by calling packUniverses, and the light fixtures\' ' +
  'half (the precedence stack) stays a callback into it.',
  () => {
    const problems = [];
    const fe = read('src/renderer/engine/frameEngine.ts');
    if (!/const destinations = packUniverses\(rawBytes, currentFixtures, \{/.test(fe)) problems.push('frameEngine no longer packs through packUniverses()');
    if (/const writeCh = \(val: number\)/.test(fe) || /COLOR_ORDER\[/.test(fe) || /function buildGammaLut/.test(fe)) problems.push('frameEngine has its own packing code again (writeCh / COLOR_ORDER / buildGammaLut) — pack only in engine/packUniverses.ts');
    // (writeChRaw since E1f-2: the callback records what it writes for the native engine, then writes it.)
    if (!/packLight: \(f, writeCh(?:Raw)?\) => \{[\s\S]{0,1400}?profilePack\.packProfiled\(f, profile, mode, writeCh, roleOverride, liveOverride\);/.test(fe)) problems.push('the light fixtures no longer pack through the packLight callback with their overrides');
    const pu = read('src/renderer/engine/packUniverses.ts');
    if (!/export function packUniverses\(/.test(pu) || !/if \(isLight\(f\)\) \{\s*ctx\.packLight\(f, writeCh\);/.test(pu)) problems.push('packUniverses.ts lost its entry point or its light hand-off');
    if (!fs.existsSync(path.join(ROOT, 'engine/artlux-engine/src/pack.rs'))) problems.push('the Rust packer engine/artlux-engine/src/pack.rs is gone');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the LED layout has ONE TypeScript implementation (gpu/ledLayout.ts), the one the native engine is held to',
  'plans/native-engine.md E1b-2: the engine\'s layout (engine/artlux-engine/src/layout.rs) is proven BIT FOR ' +
  'BIT against ledLayout.ts, and its sampling shader byte for byte against WebGPUMapper on the same atlas, by ' +
  'scripts/test-sampling-parity.cjs. A second copy of the UV / segment / atlas math growing back inside ' +
  'WebGPUMapper would make that proof about code the wire no longer runs.',
  () => {
    const problems = [];
    const wm = read('src/renderer/gpu/WebGPUMapper.ts');
    for (const fn of ['buildLedData', 'buildSegParams', 'countSegments', 'surfaceOrderOf', 'planAtlas', 'atlasRectData']) {
      if (!new RegExp(`\\b${fn}\\(`).test(wm)) problems.push(`WebGPUMapper no longer calls ledLayout.${fn}()`);
    }
    if (/private (buildSegParams|countSegments|cellSizes|packAtlas)\(/.test(wm) || /relX = \(col \+ 0\.5\)/.test(wm) || /function fixtureSegments/.test(wm)) problems.push('WebGPUMapper has its own layout code again — it belongs in gpu/ledLayout.ts');
    if (!fs.existsSync(path.join(ROOT, 'engine/artlux-engine/src/layout.rs')) || !fs.existsSync(path.join(ROOT, 'engine/artlux-engine/src/sample.rs'))) problems.push('the Rust layout / sampling port is gone');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the wire has ONE sender: the output core is shared by the Node addon (napi, default) and the native engine (no Node)',
  'plans/native-engine.md E1c. native/output-engine was split into core.rs (the send thread, packet builders, ' +
  'USB writers) and a Node front door behind the "napi" feature, so the engine links the SAME packet code — ' +
  'scripts/test-wire-parity.cjs proves the shipped addon, the rebuilt addon and the engine put identical ' +
  'packets on the wire. Two ways to break it silently: the addon built WITHOUT its napi feature loads as ' +
  '"Module did not self-register" (it happened during the split: a --no-default-features build overwrote ' +
  'the same DLL) — so napi stays the DEFAULT; and a second packet builder appearing in the engine would make ' +
  'the parity about code the engine no longer runs.',
  () => {
    const problems = [];
    const ct = raw('native/output-engine/Cargo.toml');
    if (!/\[features\]\s*\ndefault = \["napi"\]/.test(ct)) problems.push('output-engine: "napi" is no longer the default feature — the shipped addon would not register');
    if (!/crate-type = \["cdylib", "rlib"\]/.test(ct)) problems.push('output-engine: no longer both the addon (cdylib) and a library (rlib)');
    const lib = read('native/output-engine/src/lib.rs');
    for (const fn of ['configure', 'get_stats', 'is_ready', 'push_frame', 'list_serial_devices', 'close']) {
      if (!new RegExp(`#\\[napi\\]\\s*pub fn ${fn}\\(`).test(lib)) problems.push(`output-engine: the addon no longer exports ${fn}`);
    }
    if (/fn build_artnet|fn build_sacn|fn sender_loop/.test(lib)) problems.push('output-engine: packet code is back in lib.rs — it belongs in core.rs, shared');
    if (!/napi_build::setup\(\)/.test(raw('native/output-engine/build.rs'))) problems.push('output-engine build.rs no longer sets napi up');
    const ec = raw('engine/artlux-engine/Cargo.toml');
    if (!/artlux-output-engine = \{ path = "\.\.\/\.\.\/native\/output-engine", default-features = false \}/.test(ec)) problems.push('the engine no longer links the output core without Node');
    for (const x of fs.readdirSync(path.join(ROOT, 'engine/artlux-engine/src')).filter((n) => n.endsWith('.rs'))) {
      const rel = `engine/artlux-engine/src/${x}`;
      if (/fn build_artnet|fn build_sacn|ARTNET_HEADER/.test(raw(rel))) problems.push(`${rel}: a second Art-Net/sACN packet builder in the engine`);
    }
    return problems.length ? [...new Set(problems)].join('; ') : null;
  },
);

check(
  'a HAP frame uploads as WHOLE 4×4 blocks (a size that is not a multiple of 4 is not black)',
  'Found by the native engine\'s parity test (plans/native-engine.md E1d-2): WebGL refuses an S3TC upload ' +
  'whose width or height is not a multiple of 4 (INVALID_OPERATION, no exception), so plugins/hap/src/hapGL.ts ' +
  'uploaded a 1002×562 — or a 1080×1350 portrait — clip NOWHERE and the surface drew black, silently. The ' +
  'texture is the block-padded size and the canvas reads only the picture\'s share (uScale). The engine ' +
  '(compose.rs hap_picture) is held byte for byte to this path by scripts/test-image-parity.cjs.',
  () => {
    const problems = [];
    const gl = read('plugins/hap/src/hapGL.ts');
    if (!/const pw = Math\.ceil\(f\.width \/ 4\) \* 4, ph = Math\.ceil\(f\.height \/ 4\) \* 4;/.test(gl)) problems.push('hapGL no longer rounds the texture size up to whole blocks');
    if (!/compressedTexImage2D\(gl\.TEXTURE_2D, 0, fmt, pw, ph, 0, f\.data\)/.test(gl) || !/compressedTexSubImage2D\(gl\.TEXTURE_2D, 0, 0, 0, pw, ph, fmt, f\.data\)/.test(gl)) problems.push('hapGL uploads at the picture size again — WebGL rejects it for a size that is not a multiple of 4');
    if (!/gl\.uniform2f\(this\.uScale, f\.width \/ pw, f\.height \/ ph\)/.test(gl) || !/\* uScale;/.test(gl)) problems.push('hapGL no longer reads only the picture\'s share of the padded texture');
    const cp = read('engine/artlux-engine/src/compose.rs');
    if (!/pub fn hap_picture\(/.test(cp)) problems.push('the engine\'s HAP source (compose.rs hap_picture) is gone');
    if (!/pub fn canvas\([^)]*\) -> Self \{ premultiply\(&mut rgba\); Picture \{ w, h, rgba, mips: false, crop: None, tex: None \} \}/.test(cp)) problems.push('the engine draws a canvas source (HAP) with mips or without premultiplying — not what drawImage does, and no longer byte-identical');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the engine reads a Spout frame as today\'s app draws it: opaque, no mips, both paths (zero copy + GPU copy)',
  'plans/native-engine.md E1d-3, measured by scripts/test-image-parity.cjs against the app\'s real Spout path ' +
  '(addon → the plugin\'s deliver → the preload\'s VideoFrame → WebGPUMapper): the app IGNORES a sender\'s ' +
  'alpha (18.7 levels apart when the engine honoured it, identical once it did not) and draws the frame ' +
  'without mips. The fallback copy is what a driver that refuses the zero-copy open runs — the test forces it ' +
  'with ARTLUX_SPOUT_COPY, so losing that switch would leave the fallback unproven.',
  () => {
    const problems = [];
    const sp = read('engine/artlux-engine/src/spout.rs');
    // (SpoutIn since "2a": the direct texture and the copy slot, each read with texels mode 2.)
    if ((sp.match(/crate::compose::texels\(gpu, &?(tex|slot\.texture), o\.w, o\.h, 2\)\?/g) || []).length !== 2) problems.push('spout.rs SpoutIn no longer reads BOTH paths opaque (texels mode 2)');
    if (!/ARTLUX_SPOUT_COPY/.test(sp)) problems.push('the switch that lets the parity test force the copy path is gone');
    if (!/pub fn video_frame\([^)]*\) -> Self \{ premultiply\(&mut rgba\); Picture \{ w, h, rgba, mips: false, crop: None, tex: None \} \}/.test(read('engine/artlux-engine/src/compose.rs'))) problems.push('compose.rs draws a VideoFrame (Spout) with mips — not what drawImage does');
    if (!/ARTLUX_SPOUT_COPY: '1'/.test(read('scripts/test-image-parity.cjs'))) problems.push('test-image-parity no longer runs the Spout copy path');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the engine\'s effects port (effects.rs) was proven against the app\'s CURRENT surfaceFx.ts + palettes.ts',
  'plans/native-engine.md E1d-4: engine/artlux-engine/src/effects.rs is a line-for-line port of the app\'s ' +
  'generative effects, byte-identical by scripts/test-image-parity.cjs. A port is a COPY, and a copy drifts the ' +
  'first time the original changes — silently, because nothing runs the parity test on every commit. So the ' +
  'port records a fingerprint of the two files it was proven against. When this fails: change effects.rs to ' +
  'match, run `npm run test:image-parity`, and only then update the fingerprint it prints.',
  () => {
    const crypto = require('node:crypto');
    const fp = ['src/renderer/gpu/surfaceFx.ts', 'src/renderer/gpu/palettes.ts']
      .map((f) => crypto.createHash('sha256').update(raw(f).replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)).join(' ');
    const m = /proven against: ([0-9a-f]{16} [0-9a-f]{16})/.exec(raw('engine/artlux-engine/src/effects.rs'));
    if (!m) return 'effects.rs records no "proven against:" fingerprint';
    return m[1] === fp ? null : `surfaceFx.ts / palettes.ts changed since the engine port was proven (recorded ${m[1]}, now ${fp})`;
  },
);

check(
  'the engine\'s projector renderer (projector.rs) matches the app\'s uncalibrated warp path it was proven against',
  'plans/native-engine.md E1e-1: engine/artlux-engine/src/projector.rs ports ProjectorGL\'s 2D warp path and is ' +
  'IDENTICAL pixel for pixel by scripts/test-projector-parity.cjs. It is a copy, so: (1) the geometry and blend ' +
  'files it ports are fingerprinted — when one changes, re-port, re-run the test, then update the fingerprint; ' +
  '(2) the sampling constants ProjectorGL sets (TEXTURE_MAX_LEVEL 4, anisotropy 8, trilinear, 4× MSAA, the Bézier ' +
  'tessellation 24) must still be the engine\'s; (3) the engine keeps rasterising BOTTOM-UP like the app\'s GL ' +
  'canvas — top-down, an MSAA sample flips on every warped outline (measured: 64 levels on ~0.05% of pixels).',
  () => {
    const problems = [];
    const crypto = require('node:crypto');
    const fp = ['src/renderer/projector/homography.ts', 'src/renderer/projector/warp.ts', 'src/renderer/projector/blendGlsl.ts']
      .map((f) => crypto.createHash('sha256').update(raw(f).replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)).join(' ');
    const pr = raw('engine/artlux-engine/src/projector.rs');
    const m = /proven against: ([0-9a-f]{16} [0-9a-f]{16} [0-9a-f]{16})/.exec(pr);
    if (!m) problems.push('projector.rs records no "proven against:" fingerprint');
    else if (m[1] !== fp) problems.push(`homography.ts / warp.ts / blendGlsl.ts changed since the engine port was proven (recorded ${m[1]}, now ${fp})`);
    const gl = read('src/renderer/projector/ProjectorGL.ts'), pa = read('src/renderer/projector/ProjectorApp.tsx');
    if (!/TEXTURE_MAX_LEVEL, 4\)/.test(gl) || !/lod_max_clamp: 4\.0/.test(pr)) problems.push('the mip-level cap is no longer 4 on both sides');
    if (!/Math\.min\(8, gl\.getParameter\(aniso\.MAX_TEXTURE_MAX_ANISOTROPY_EXT\)/.test(gl) || !/anisotropy_clamp: 8/.test(pr)) problems.push('the anisotropy is no longer 8 on both sides');
    if (!/LINEAR_MIPMAP_LINEAR/.test(gl) || !/mipmap_filter: wgpu::MipmapFilterMode::Linear/.test(pr)) problems.push('trilinear filtering is no longer on both sides');
    if (!/const AA_SAMPLES = 4;/.test(pa) || !/let samples = if o\.aa > 1 \{ 4 \} else \{ 1 \};/.test(pr)) problems.push('the MSAA sample count is no longer 4 on both sides');
    if (!/const RENDER_TESS = 24;/.test(pa) || !/pub const RENDER_TESS: usize = 24;/.test(pr)) problems.push('the Bézier tessellation is no longer 24 on both sides');
    if (!/vec4<f32>\(pos\.x, -pos\.y, 0\.0, 1\.0\)/.test(pr)) problems.push('projector.rs no longer rasterises bottom-up like the app\'s GL canvas');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'an engine projector window shows exactly the projector raster, on the display it names or on NONE',
  'plans/native-engine.md E1e-2, proven from the SCREEN by scripts/test-projector-windows.cjs (the pixels on ' +
  'screen = the offscreen render, windowed and fullscreen). Three ways to break it silently: an sRGB swapchain ' +
  're-encodes the signal (every value shifts); a flip pass that does not undo the bottom-up raster shows the ' +
  'picture upside down; and an output whose display is missing must be REFUSED — falling back to "some other ' +
  'screen" would put a show on the operator\'s monitor.',
  () => {
    const problems = [];
    const w = raw('engine/artlux-engine/src/windows.rs');
    const loop = w.slice(w.indexOf('fn projector_loop('));
    if (!/find\(\|f\| !f\.is_srgb\(\)\)/.test(loop)) problems.push('the projector window no longer asks for a non-sRGB swapchain');
    if (!/i32\(d\.y\) - 1 - i32\(pos\.y\)/.test(w)) problems.push('the flip pass no longer undoes the bottom-up raster');
    if (!/present_mode: wgpu::PresentMode::Fifo/.test(loop)) problems.push('the projector window no longer presents FIFO (its display\'s refresh)');
    const md = w.slice(w.indexOf('pub fn match_display('), w.indexOf('pub fn match_display(') + 1200);
    if (!/return Err\(format!\("no display at/.test(md) || /Ok\(0\)/.test(md)) problems.push('match_display no longer refuses an output whose display is missing');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine takes the wire with ONE sender and gives it back at once (E1f)',
  'plans/native-engine.md E1f-1, proven in the real app by scripts/test-native-takeover.cjs (who sends each ' +
  'packet, and the bytes). Each rule here was a measured failure: muting the app\'s pushes left its send ' +
  'thread\'s KEEP-ALIVE repeating the last frame beside the engine\'s (two senders) — it must be handed an ' +
  'empty frame on the way into muting, as the engine is when it hands the wire back; the app is muted only ' +
  'while the engine\'s per-frame "sent" reports are fresh (a stalled render thread still answers pings); and ' +
  'the engine must quit on the quit MESSAGE, not on the word "quit" inside a document.',
  () => {
    const problems = [];
    const om = read('src/main/transport/outputManager.ts');
    if (!/if \(wireOwner\?\.\(\)\) \{/.test(om)) problems.push('outputManager.sendFrame no longer asks who owns the wire');
    if (!/if \(!muted\) \{[\s\S]{0,400}native\.pushFrame\(toBuffer\(empty\)\)/.test(om)) problems.push('muting no longer empties the app\'s send thread (its keep-alive would repeat the last frame)');
    if (!/lastFrame = toArrayBuffer\(frame\);\s*\n\s*if \(wireOwner/.test(om)) problems.push('a muted frame is no longer RECORDED first (blackout() needs the last frame\'s shape)');
    const eh = read('src/main/engineHost.ts');
    if (!/Date\.now\(\) - lastSentAt < SENT_FRESH_MS/.test(eh)) problems.push('engineOwnsWire no longer requires fresh "sent" reports');
    if (!/output\.setWireOwner\(engineOwnsWire\)/.test(eh)) problems.push('engineHost no longer registers the wire owner');
    if (!/proc\.on\('exit'[\s\S]{0,300}setOwns\(null, 'the engine exited'\)/.test(eh)) problems.push('an engine exit no longer hands the wire back first');
    const rt = raw('engine/artlux-engine/src/runtime.rs');
    if (!/if was_owning && !owns \{[\s\S]{0,300}self\.send\(&0u32\.to_le_bytes\(\)\)/.test(rt)) problems.push('the engine no longer empties its send thread when it loses the wire');
    const sv = raw('engine/artlux-engine/src/serve.rs');
    if (!/line\.starts_with\("\{\\"quit\\""\)/.test(sv) || /line\.contains\("\\"quit\\""\)/.test(sv)) problems.push('serve.rs quits on the word "quit" anywhere in a line again');
    if (!/"type":"sent"/.test(sv)) problems.push('the render thread no longer reports the frames it sent');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine places light fixtures\' bytes from THIS frame\'s precedence stack, never its own (E1f-2)',
  'plans/native-engine.md E1f-2, proven in the real app by scripts/test-native-takeover.cjs (two washes — one ' +
  'spilling past channel 512 — and a dimmer, byte-identical). The host evaluates a light (profile default < ' +
  'authored < lighting clip < pose cue < automation < live override — frameEngine.packAndPublish); the engine ' +
  'only places the bytes. So the tick must be sent AFTER packing (else it carries the previous frame\'s values), ' +
  'every value packLight writes must be recorded, and the engine must take the host\'s list of lights.',
  () => {
    const problems = [];
    const fe = read('src/renderer/engine/frameEngine.ts');
    const pack = fe.indexOf('this.packAndPublish(rawBytes, effFixtures);'), link = fe.indexOf('nativeLink.frame(');
    if (pack < 0 || link < 0 || link < pack) problems.push('nativeLink.frame is no longer called AFTER packAndPublish (the tick would carry the previous frame\'s lights)');
    if (!/nativeLink\.frame\(this\.inputs, effSurfaces, effFixtures, effBrightness, this\.lightBytes[,)]/.test(fe)) problems.push('the tick no longer carries the recorded light bytes');
    if (!/const writeCh = \(v: number\) => \{ rec\.push\(v\); writeChRaw\(v\); \};/.test(fe)) problems.push('packLight no longer records every value it writes');
    const nl = read('src/renderer/engine/nativeLink.ts');
    if (!/lights: fixtures\.filter\(\(f\) => isLight\(f\)\)/.test(nl)) problems.push('the document no longer lists the lights by services/fixtureKind');
    const rt = raw('engine/artlux-engine/src/runtime.rs');
    if (!/doc\.pfix\[i\]\.light_channels = v\["lights"\]/.test(rt)) problems.push('the engine no longer takes each light\'s bytes from the tick');
    if (/is a light — the engine does not drive lights/.test(rt)) problems.push('the engine refuses lights again');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine takes the projector outputs on top of the app\'s, and gives them back at once (E1f-3)',
  'plans/native-engine.md E1f-3, proven from the SCREEN by scripts/test-native-projectors.cjs (the engine\'s ' +
  'window = the app\'s, pixel for pixel, in one session; a kill uncovers the app\'s window in ~55 ms). Rules ' +
  'learned the hard way: a window created ALWAYS-ON-TOP and borderless-fullscreen could not configure its ' +
  'swapchain ("Invalid surface") and the presenter panicked — so the level is raised AFTER the first configure; ' +
  'the app\'s windows stay open underneath and are only COVERED (they stop drawing), which is what makes the ' +
  'fallback instant; and an output the engine cannot draw exactly must be listed with its reason, never ' +
  'silently drawn the engine\'s way.',
  () => {
    const problems = [];
    const o = raw('engine/artlux-engine/src/outputs.rs');
    if (/\.with_window_level\(WindowLevel::AlwaysOnTop\)/.test(o)) problems.push('outputs.rs creates the window always-on-top again (its surface then cannot be configured)');
    if (!/configured = Some\(size\);[\s\S]{0,600}window\.set_window_level\(WindowLevel::AlwaysOnTop\)/.test(o)) problems.push('outputs.rs no longer raises the window to topmost after configuring it');
    const pa = read('src/renderer/projector/ProjectorApp.tsx');
    if (!/raf = requestAnimationFrame\(frame\);\s*\n\s*if \(coveredRef\.current\) return;/.test(pa)) problems.push('a covered projector window draws again (twice the GPU work for a hidden picture)');
    const eh = read('src/main/engineHost.ts');
    if (!/proc\.on\('exit'[\s\S]{0,500}setProjOwns\(null, 'the engine exited'\)/.test(eh)) problems.push('an engine exit no longer uncovers the app\'s projector windows');
    if (!/p\.bounds = process\.platform === 'win32' \? screen\.dipToScreenRect\(null, d\.bounds\)/.test(eh)) problems.push('main no longer gives the engine PHYSICAL display bounds');
    const nl = read('src/renderer/engine/nativeLink.ts');
    // (A projection mask and a blend map are no longer refused — E6f: the app's window applies neither; see the
    // 'masked or blend-mapped projector output' check, which fails the day it does. Nor a WINDOWED output, nor an NDI
    // SEND, nor an NVIDIA HARDWARE WARP, nor the live RENDER-FROM-PROJECTOR — see the 'windowed projector output', 'NDI
    // send', 'hardware warp' and 'render-from-projector' checks. What the engine still cannot draw is listed WITH ITS
    // REASON by calibFor / venueLink, which the 'render-from-projector' check holds.)
    if (!/: calib && 'why' in calib \? calib\.why/.test(nl)) problems.push('nativeLink no longer lists a calibrated output it cannot draw with its reason');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine reads Spout at runtime with ONE receiver per surface, and never two senders the app would merge',
  'plans/native-engine.md E1f "2a", proven in the real app by scripts/test-native-takeover.cjs (a real Spout ' +
  'sender, universe byte-identical). A receiver per FRAME (the old one-shot grab) reconnects 44 times a second; ' +
  'and the app has ONE Spout receiver for every Spout surface — the latest sender wins on all of them — so a show ' +
  'naming two senders must stay with the app, or the engine would show a different picture than today.',
  () => {
    const problems = [];
    const sp = raw('engine/artlux-engine/src/spout.rs');
    if (!/pub struct SpoutIn/.test(sp) || !/pub fn grab\([\s\S]{0,200}SpoutIn::new\(name\)/.test(sp)) problems.push('spout.rs: grab is no longer the SpoutIn the runtime uses (the parity test would prove other code)');
    if (!/spouts: HashMap<String, \(String, crate::spout::SpoutIn\)>/.test(raw('engine/artlux-engine/src/runtime.rs'))) problems.push('runtime.rs no longer keeps one Spout receiver per surface');
    if (!/spoutSenders\.size > 1/.test(read('src/renderer/engine/nativeLink.ts'))) problems.push('nativeLink no longer keeps a two-sender show with the app');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a calibrated output that plays an imported map is drawn through THAT map by the engine, never flat (item 3)',
  'plans/native-engine.md item 3, proven by scripts/test-projector-parity.cjs (15 baked cases, pixel-identical ' +
  'to ProjectorGL.drawBaked) and scripts/test-native-projectors.cjs --baked (a real .mpcdi from Prefs, screen ' +
  'identical). Before this, an imported map was invisible to what the engine may take — the output would have ' +
  'been taken and drawn as a plain warp. The map is recorded at THE ONE DOOR it reaches a window through ' +
  '(App.sendToProjector); and the map texture is read through a hardware POINT sampler — an exact floor() ' +
  'picked the other texel on boundaries (2–5% of pixels on a smaller map).',
  () => {
    const problems = [];
    if (!/if \(msg\.t === 'bakedMap'\) nativeLink\.setProjectorBaked\(surfaceId, msg\.map\);/.test(read('src/renderer/App.tsx'))) problems.push('App.sendToProjector no longer records the calibration maps it hands to windows');
    const nl = read('src/renderer/engine/nativeLink.ts');
    if (!/if \(!venueRender\.has\(o\.surfaceId\) \|\| baked\.has\(o\.surfaceId\)/.test(nl)) problems.push('nativeLink no longer tells a mapped output from a live render-from-projector one (calibFor)');
    const pr = raw('engine/artlux-engine/src/projector.rs');
    if (!/textureSampleLevel\(bmap, msamp, p, 0\.0\)/.test(pr) || !/mag_filter: wgpu::FilterMode::Nearest, min_filter: wgpu::FilterMode::Nearest/.test(pr)) problems.push('projector.rs no longer reads the baked map through a point sampler');
    if (!/Some\(b\) => projector::draw_baked\(/.test(raw('engine/artlux-engine/src/outputs.rs'))) problems.push('an engine output with a map no longer draws through it');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'an auto-fit of a surface to its picture rebuilds the LED mapping',
  'Found by the native engine\'s takeover test (E1f-1): frameEngine fits a surface to its content\'s aspect by ' +
  'replacing this.inputs.surfaces itself, so when App commits the same array back the setInputs diff sees no ' +
  'change — and the LEDs kept sampling the PRE-FIT rectangle (389 of 512 channels off) while the preview showed ' +
  'the fitted surface. The fit must count as a geometry change.',
  () => {
    const fe = read('src/renderer/engine/frameEngine.ts');
    if (!/fitted = true;/.test(fe) || !/let geomDirty = automationOverlay\.geometryAnimating\(\) \|\| fitted;/.test(fe)) return 'frameEngine no longer marks an auto-fit as a geometry change';
    return null;
  },
);

check(
  'the audio engine never runs on main\'s JS thread (Windows): its calls go to the addon\'s control thread',
  'Measured 2026-11-22: configure() opened the audio device SYNCHRONOUSLY on Electron main\'s JS thread — a ' +
  'cold WASAPI-shared open of this rig\'s Realtek is 5.5 s — so for seconds after every start-up main served ' +
  'nothing: no frame reached the DMX wire (an event-loop probe: main blocked 7.4 s), no prefs, no media, no ' +
  'tablet request. native/audio-engine/src/engine.cpp now posts every engine call to ONE audio control thread ' +
  '(also JUCE\'s message thread, pumping like an STA) and answers with promises; main\'s worst start-up gap ' +
  'became 397 ms and a handback during start-up 59 ms (scripts/test-native-takeover.cjs). A call that slips ' +
  'back onto the JS thread compiles, runs and stalls the show again.',
  () => {
    const problems = [];
    // The control thread lives in core.h since E3 (shared with the C library); the N-API surface in engine.cpp.
    const c = raw('native/audio-engine/src/core.h') + '\n' + raw('native/audio-engine/src/engine.cpp');
    if (!/#if defined\(_WIN32\)\s*\n#define ARTLUX_AUDIO_CONTROL_THREAD 1/.test(c)) problems.push('engine.cpp no longer enables the audio control thread on Windows');
    if (!/control::start\(\);/.test(c)) problems.push('Init no longer starts the control thread');
    if (!/juce::MessageManager::getInstance\(\);\s+\/\/ THIS thread is JUCE's message thread/.test(c)) problems.push('the control thread is no longer JUCE\'s message thread (driver messages would race the engine)');
    for (const fn of ['Configure', 'GetDevices', 'LoadClip', 'GetMeters', 'GetSpectrum', 'OfflineBegin', 'OfflinePull', 'OfflineEnd']) {
      const i = c.indexOf(`static Napi::Value ${fn}(`);
      const body = i < 0 ? '' : c.slice(i, c.indexOf('\nstatic ', i + 10));
      if (!/runAsync\(/.test(body)) problems.push(`${fn} no longer runs on the control thread`);
      if (/ensureEngine\(\)/.test(body.slice(0, body.indexOf('runAsync(')))) problems.push(`${fn} touches the engine on the JS thread before posting`);
    }
    for (const fn of ['PlayClip', 'StopClip', 'UnloadClip', 'SetClipGain', 'SetMasterGain', 'SetTestTone', 'SetClipEffects', 'SetMasterEffects']) {
      const i = c.indexOf(`static Napi::Value ${fn}(`);
      const body = i < 0 ? '' : c.slice(i, c.indexOf('\nstatic ', i + 10));
      if (!/runVoid\(/.test(body)) problems.push(`${fn} no longer posts to the control thread`);
    }
    if (!/if \(gPending\+\+ == 0\) gTsfn\.Ref\(env\);/.test(c)) problems.push('a pending call no longer holds the event loop open (Node could exit under it)');
    const am = read('plugins/audio/src/audioManager.ts');
    if (!/export function configure\(cfg: DeviceCfg\): Promise<OpenedCfg>/.test(am)) problems.push('audioManager.configure is synchronous again');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine receives NDI with the APP arithmetic, and an NDI build still starts on a machine without NDI',
  'plans/native-engine.md E1f "2b", proven in the real app by scripts/test-native-takeover.cjs (a real NDI ' +
  'sender, universe 5 byte-identical). Two ways it breaks silently. (1) ndi.rs carries a VERBATIM copy of ' +
  'fit + downscale_rgba from native/ndi/src/lib.rs (that addon ships prebuilt, so it cannot share them): if ' +
  'one copy changes alone, the engine scales NDI pictures differently and the LEDs differ with no error. ' +
  '(2) the ndi feature links Processing.NDI.Lib.x64.dll; linked normally, the engine EXE does not start at ' +
  'all (0xC0000135) on a machine without the NDI runtime on PATH, taking the LED wire and the projectors ' +
  'with it (measured on the first NDI build). It is delay-loaded and loaded by full path before any NDI call.',
  () => {
    const problems = [];
    const fnText = (src, name) => {
      const i = src.indexOf(`fn ${name}(`);
      if (i < 0) return null;
      const open = src.indexOf('{', i);
      let depth = 0;
      for (let j = open; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1).replace(/\s+/g, ' ');
      }
      return null;
    };
    const eng = raw('engine/artlux-engine/src/ndi.rs');
    const app = raw('native/ndi/src/lib.rs');
    for (const f of ['fit', 'downscale_rgba']) {
      const a = fnText(eng, f), b = fnText(app, f);
      if (!a || !b) problems.push(`${f} is missing from ${a ? 'native/ndi/src/lib.rs' : 'ndi.rs'}`);
      else if (a !== b) problems.push(`ndi.rs ${f} is no longer the copy of native/ndi/src/lib.rs`);
    }
    const build = raw('engine/artlux-engine/build.rs');
    if (!/\/DELAYLOAD:Processing\.NDI\.Lib\.x64\.dll/.test(build) || !/delayimp\.lib/.test(build)) problems.push('build.rs no longer delay-loads the NDI runtime (the engine would not start without it)');
    if (!/if runtime\(\)\.is_err\(\) \{ return; \}/.test(eng)) problems.push('the NDI receive thread no longer checks the runtime before its first NDI call');
    if (!/crate::ndi::runtime\(\)\.map_err/.test(raw('engine/artlux-engine/src/runtime.rs'))) problems.push('the runtime no longer refuses an NDI show when the NDI runtime is missing');
    if (!/NDI_SDK_DIR/.test(raw('scripts/build-engine.cjs'))) problems.push('build:engine no longer turns NDI on where the SDK is installed');
    const nl = raw('src/renderer/engine/nativeLink.ts');
    if (!/two NDI sources at once/.test(nl)) problems.push('nativeLink no longer refuses two NDI sources (the app shows one of them on every NDI surface)');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine converts an MP4 frame as Chromium does: coded planes, centre-sited chroma, the visible rect drawn',
  'plans/native-engine.md E1f "2c-1", proven by scripts/test-mp4-parity.cjs on the app own decoded frames ' +
  '(the conversion within 1 of Chromium, the LEDs within 1). Each rule below was found by measurement and ' +
  'each one, lost, still compiles and still draws a picture: chroma clamped at the VISIBLE edge (Chromium ' +
  'reads the encoder padding: the last row and an odd last column were off by up to 106); the visible rect ' +
  'stretched as a picture of its own instead of out of the coded frame (the sampler reads past its edge); ' +
  'left-sited chroma (off by up to 171). And a colour space nobody measured must stay with the app.',
  () => {
    const problems = [];
    const y = raw('engine/artlux-engine/src/yuv.rs');
    if (!/let \(w, h\) = f\.coded;/.test(y) || !/let \(cw, ch\) = \(\(w \/ 2\) as i64, \(h \/ 2\) as i64\);/.test(y)) problems.push('yuv.rs no longer clamps chroma at the CODED edge');
    if (!/if x % 2 == 0 \{ \(x \/ 2 - 1, 3u32\) \} else \{ \(\(x - 1\) \/ 2, 1u32\) \}/.test(y) || !/if y % 2 == 0 \{ \(y \/ 2 - 1, 3u32\) \} else \{ \(\(y - 1\) \/ 2, 1u32\) \}/.test(y)) problems.push('yuv.rs chroma is no longer centre-sited');
    if (!/Picture::coded_frame\(w, h, out, f\.visible\)/.test(y)) problems.push('yuv.rs no longer hands the WHOLE coded frame with its visible rect');
    if (!/matrix == Some\("bt709"\) && full_range == Some\(false\) && primaries == Some\("bt709"\)/.test(y)) problems.push('yuv.rs accepts colour spaces beyond the measured BT.709 limited range');
    const c = raw('engine/artlux-engine/src/compose.rs');
    if (!/let uv = cell\.src\.xy \+ \(pos\.xy - cell\.rect\.xy\) \/ cell\.rect\.zw \* cell\.src\.zw;/.test(c) || !/let src = pic\.crop\.map_or\(/.test(c)) problems.push('compose.rs no longer draws a coded frame from its visible rect');
    const page = raw('engine/spikes/mp4-parity/page.ts');
    if (!/const rect = \{ x: 0, y: 0, width: vf\.codedWidth, height: vf\.codedHeight \};/.test(page)) problems.push('the mp4 parity page no longer dumps the CODED planes (the gate would test a different input)');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine decodes an MP4 by the APP timestamps: its own demux, the decoder fed by hand',
  'plans/native-engine.md E1f "2c-2", proven by scripts/test-mp4-parity.cjs (every visible picture byte-' +
  'identical to the app WebCodecs decode, seeks included). Media Foundation source reader was tried first ' +
  'and is WRONG here: its clock named the wrong frames (frames 0 and 1 both at 0 us on WebCodecs H.264) and ' +
  'it blanked the padding rows yuv.rs reads. A sample time is the app own: (cts / timescale) x 1e6, cts = ' +
  'dts + the ctts offset, TRUNCATED as an EncodedVideoChunk long long is (rounding gave 66667 for 66666). ' +
  'The synthetic files have no B-frames, so the ctts rule is proven only with a real clip - hence this check.',
  () => {
    const problems = [];
    const d = raw('engine/artlux-engine/src/mp4demux.rs');
    if (!/pub fn ts_us\(&self, s: &Sample\) -> i64 \{ \(\(s\.cts as f64 \/ self\.timescale as f64\) \* 1e6\) as i64 \}/.test(d)) problems.push('mp4demux.rs no longer times a sample as the app does (cts / timescale x 1e6, truncated)');
    if (!/cts: dts\[k\]\.0 \+ ctts\[k\]/.test(d)) problems.push('mp4demux.rs no longer adds the composition offset (B-frame files would show the wrong frames)');
    if (!/if s\.key \{ for p in &self\.params/.test(d)) problems.push('mp4demux.rs no longer sends the parameter sets with a key frame');
    const m = raw('engine/artlux-engine/src/mf.rs');
    if (/MFCreateSourceReaderFromURL/.test(m)) problems.push('mf.rs uses the source reader again (its clock names the wrong frames)');
    if (!/sample\.SetSampleTime\(ts \* 10\)/.test(m) || !/const EPS_US: i64 = 2;/.test(m)) problems.push('mf.rs no longer carries the app timestamps through the decoder, matched within 2 us');
    if (!/visible pictures identical/.test(raw('scripts/test-mp4-parity.cjs'))) problems.push('test-mp4-parity no longer holds the engine decode to the app');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine converts MP4 frames ON THE GPU, rounding by the GPU store as Chromium does',
  'plans/native-engine.md E1f "2c-3a", proven by scripts/test-mp4-parity.cjs: the GPU conversion within 1 of ' +
  'Chromium on all but 0.009-0.015% of channels, and most LED surfaces byte-identical to the app. The one ' +
  'rule nobody would guess: NO explicit rounding in the shader. The value / 255 goes to the RGBA8 store and ' +
  'the GPU own float-to-UNORM conversion rounds it, as it does for Chromium shader on the same GPU; ' +
  'rounding half up (the CPU rule, and what anyone tidying this would write) left 0.21-0.27% of channels ' +
  'off by one. The chroma weights stay exact integers (sixteenths), clamped at the coded edge.',
  () => {
    const problems = [];
    const y = raw('engine/artlux-engine/src/yuv.rs');
    if (!/let q = clamp\(rgb \/ 255\.0, vec3<f32>\(0\.0\), vec3<f32>\(1\.0\)\);/.test(y)) problems.push('the GPU conversion no longer leaves the rounding to the store');
    if (!/if \(x % 2 == 0\) \{ x0 = x \/ 2 - 1; fx = 3; \}/.test(y) || !/if \(y % 2 == 0\) \{ y0 = y \/ 2 - 1; fy = 3; \}/.test(y)) problems.push('the GPU conversion chroma is no longer centre-sited');
    if (!/let q = clamp\(p, vec2<i32>\(0, 0\), cs - vec2<i32>\(1, 1\)\);/.test(y)) problems.push('the GPU conversion no longer clamps chroma at the coded edge');
    const c = raw('engine/artlux-engine/src/compose.rs');
    if (!/\(None, Some\(t\)\) => \{/.test(c)) problems.push('compose.rs no longer draws a GPU picture without re-uploading it');
    if (!/let conv = \(!has\("--cpu-convert"\)\)\.then/.test(raw('engine/artlux-engine/src/main.rs'))) problems.push('--frame-once no longer converts on the GPU by default (the parity test would prove the CPU path only)');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine decodes MP4 on the GPU one frame at a time, into a D3D11-made shared NV12 texture',
  'plans/native-engine.md E1f "2c-3b", proven by scripts/test-mp4-parity.cjs (the hardware decode identical ' +
  'to the app including the padding; the LEDs of the GPU path within 1, mostly identical). Three rules found ' +
  'by running it: (1) ONE frame at a time - a hardware decoder writes into a small texture pool, and ' +
  'collecting every ready frame exhausted it while draining the end of a file: ProcessOutput then WAITED ' +
  'FOREVER (the engine hung; no test catches that but a timeout). (2) The shared NV12 texture is made by ' +
  'D3D11 and opened by D3D12 - the other way round D3D11 refused it (E_INVALIDARG). (3) A software frame ' +
  'padding is filled with the edge - Media Foundation software decoder leaves it unwritten on some frames, ' +
  'and the conversion reads it at the last row.',
  () => {
    const problems = [];
    const m = raw('engine/artlux-engine/src/mf.rs');
    if (!/fn pull_one\(&mut self\)/.test(m) || /fn pull\(&mut self\)/.test(m)) problems.push('mf.rs collects more than one frame at a time again (a hardware decoder pool runs dry: the engine hangs)');
    if (!/if self\.pull_one\(\)\? \{ return Ok\(true\); \}/.test(m)) problems.push('mf.rs step no longer takes a ready frame before feeding');
    if (!/D3D11_RESOURCE_MISC_SHARED_NTHANDLE/.test(m) || !/OpenSharedHandle\(handle, &mut res\)/.test(m)) problems.push('the NV12 slot is no longer made by D3D11 and opened by D3D12');
    if (!/hw\.ctx\.End\(&hw\.query\)/.test(m) || !/gpu\.device\.poll\(wgpu::PollType::Wait/.test(m)) problems.push('the slot copy or its read is no longer waited for (two devices share one texture)');
    if (!/replicate_padding\(&mut data, self\.coded, self\.visible\);/.test(m)) problems.push('a software frame padding is no longer made deterministic');
    if (!/Mp4In::open_with\(&p\.to_string_lossy\(\), \(!has\("--sw-decode"\)\)\.then_some\(&gpu\)\)/.test(raw('engine/artlux-engine/src/main.rs'))) problems.push('--frame-once no longer decodes on the GPU by default');
    if (!/decoding ON THE GPU/.test(raw('scripts/test-mp4-parity.cjs'))) problems.push('test-mp4-parity no longer checks that the hardware pass decoded on the GPU');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine plays MP4 at runtime ON THE FRAME THE APP SHOWS, and only what was proven',
  'plans/native-engine.md E1f "2c-4", proven in the real app by scripts/test-native-takeover.cjs (a looping ' +
  'clip on universe 6: all 8 frames from the engine, each within 1 of the app). The host decides on the ' +
  'APP OWN VideoFrame - 8-bit NV12, BT.709 limited, the BT.709 or sRGB transfer - because that is all ' +
  'test:mp4-parity measured; the tick carries the app frame timestamp (absolute: a looping surface adds ' +
  'the file duration per loop) and the engine folds it back into the file - without the fold the engine ' +
  'froze after the first loop (6 of 8 frames).',
  () => {
    const problems = [];
    // SDK v2 (E6d): the MP4 rule is the mp4 codec's own (VideoCodecContribution.nativeSource), no longer core's.
    const c = raw('plugins/mp4/src/mp4Codec.ts');
    if (!/if \(vf\.format !== 'NV12'\)/.test(c) || !/cs\?\.matrix === 'bt709' && cs\?\.fullRange === false && cs\?\.primaries === 'bt709'/.test(c)) problems.push('the mp4 codec no longer limits the engine to the proven MP4 frames (8-bit NV12, BT.709 limited)');
    if (!/durUs: info\.durationSec \* 1e6/.test(c)) problems.push('the MP4 source no longer carries the file duration the engine folds the loop with');
    const n = raw('src/renderer/engine/nativeLink.ts');
    if (!/mp4\[s\.id\] = g;/.test(n) || !/hap, mp4, ndi, (camfp, )?(shader, )?(blobs, )?(comp, times, )?lights/.test(n)) problems.push('the tick no longer carries each MP4 surface frame timestamp');
    if (/an MP4 on a projector/.test(n)) problems.push('an MP4 on a projector is refused again (the engine draws it: one device, outputs.rs content_texture_from)');
    const r = raw('engine/artlux-engine/src/runtime.rs');
    if (!/let local = if \*dur_us > 0 \{ abs - abs\.div_euclid\(\*dur_us\) \* dur_us \} else \{ abs \};/.test(r)) problems.push('runtime.rs no longer folds a looping surface timestamp back into the file');
    if (!/Mp4In::open_with\(p, Some\(&self\.gpu\)\)/.test(r)) problems.push('the runtime no longer decodes MP4 on the GPU');
    if (!/eng\.length >= 8 && worst <= 1/.test(raw('scripts/test-native-takeover.cjs'))) problems.push('test-native-takeover no longer requires every frame of the MP4 clip from the engine');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'an MP4 reaches the engine projector windows on the GPU, and the projector test judges against the APP window',
  'plans/native-engine.md E1f "2c-4 projectors", proven by scripts/test-native-projectors.cjs --mp4 (the engine ' +
  'window within 1 of the app on 0.064% of pixels). The render thread and the presenters share ONE device ' +
  '(serve.rs), so the frame is copied GPU to GPU, its visible rect - what createImageBitmap(VideoFrame) gives ' +
  'the app window (test:mp4-parity gate 1b). AND the harness: it once judged the engine against a capture ' +
  'taken just after killing it, which was the RESTARTED engine window (a capture takes ~1 s to start) - so ' +
  '"the engine = the app" compared the engine with itself, and a copy shifted by a pixel passed. The engine ' +
  'is judged against run A (the app alone), and A2 shows the app equals itself across launches.',
  () => {
    const problems = [];
    const o = raw('engine/artlux-engine/src/outputs.rs');
    if (!/Some\(t\) => projector::content_texture_from\(&gpu, t, p\.crop/.test(o)) problems.push('outputs.rs no longer draws a GPU picture (an MP4) on a projector');
    const pr = raw('engine/artlux-engine/src/projector.rs');
    if (!/pub fn content_texture_from\(gpu: &Gpu, src: &wgpu::Texture, crop: \[u32; 4\]\)/.test(pr) || !/enc\.copy_texture_to_texture\(/.test(pr)) problems.push('projector.rs no longer copies an MP4 frame visible rect on the GPU');
    if (!/a surface only a\s+\/\/ PROJECTOR shows is opened on first use/.test(raw('engine/artlux-engine/src/runtime.rs'))) problems.push('runtime.rs no longer opens the decoder of a surface only a projector shows (its window would be black)');
    const t = raw('scripts/test-native-projectors.cjs');
    if (!/const dAB = diff\(A, B\);/.test(t) || !/const dD = diff\(A, D\);/.test(t)) problems.push('test-native-projectors no longer judges the engine window against the APP window (run A)');
    if (!/capture\('A2-app'[,)]/.test(t)) problems.push('test-native-projectors no longer shows that its reference (run A) is stable across launches');
    if (/capture\('C-app-again'\)/.test(t)) problems.push('test-native-projectors captures the screen just after the kill again - that is the restarted ENGINE window, not the app');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the native engine reads a camera SHARED beside the app, whatever its format, draws it as the app does, and finds WHICH camera',
  'plans/native-engine.md "2d", owner decision 2026-11-22: the app keeps its cameras, the engine reads them ' +
  'shared (scripts/test-camera-shared.cjs). Two ways it breaks silently. (1) a plain Media Foundation open is ' +
  'EXCLUSIVE: an engine that opened the camera that way would take it from the app, or fail beside it with ' +
  '0xC00D3704 (measured). (2) beside an MJPEG holder - Chromium picks MJPEG on some opens - Windows refuses ' +
  'every conversion to a shared reader (OutputFormatNotSupported, measured for NV12/YUY2/BGRA8/ARGB32/RGB32): ' +
  'without the MJPEG fallback the camera is black in the engine only on those opens (the mutation failed A and E).',
  () => {
    const problems = [];
    const c = raw('engine/artlux-engine/src/camshared.rs');
    if (!/SetSharingMode\(MediaCaptureSharingMode::SharedReadOnly\)/.test(c)) problems.push('camshared.rs no longer opens the camera SharedReadOnly (it would take it from the app)');
    if (!/for mjpg in \[false, true\]/.test(c) || !/OutputFormatNotSupported/.test(c) || !/fn copy_mjpg\(/.test(c)) problems.push('camshared.rs no longer falls back to the MJPEG frames beside an MJPEG holder');
    const t = raw('scripts/test-camera-shared.cjs');
    for (const g of ['PASS A', 'PASS D', 'PASS E', 'PASS F', 'PASS G']) if (!t.includes(g)) problems.push(`test-camera-shared lost gate ${g.slice(5)}`);
    // Step 4: WHICH camera. Two cameras of one model share name and vid:pid; the picture decides, and only
    // when it is clearly one of them - else REFUSED (the mutation without the margin picked a camera that
    // could not be told apart). The fingerprint grid is the SAME on both sides (app TS, engine Rust).
    const cam4 = raw('engine/artlux-engine/src/cam.rs');
    if (!/\*d >= FP_ALIKE && rest\.first\(\)\.is_none_or\(\|\(d2, _\)\| d - d2 >= FP_MARGIN\)/.test(cam4)) problems.push('cam.rs resolve no longer refuses identical cameras whose pictures do not settle which is which');
    const fpTs = raw('src/renderer/engine/cameraFingerprint.ts');
    const tsGrid = [/FP_COLS = (\d+)/.exec(fpTs)?.[1], /FP_ROWS = (\d+)/.exec(fpTs)?.[1]].join('x');
    const rsGrid = [/pub const FP_COLS: usize = (\d+)/.exec(cam4)?.[1], /pub const FP_ROWS: usize = (\d+)/.exec(cam4)?.[1]].join('x');
    if (tsGrid !== rsGrid) problems.push(`the camera fingerprint grid differs: app ${tsGrid}, engine ${rsGrid}`);
    // Step 5: the runtime. The engine takes only what was MEASURED: the host sends a camera only with an
    // I420/NV12 BT.601 limited frame, and the engine refuses a holder streaming MJPEG (its MJPEG decode is
    // not measured against Chromium's - and the real app opens the C270 as MJPEG, measured 3/3).
    const cs = raw('src/renderer/services/contentSource.ts');
    if (!/case SourceType\.CAMERA: return cameraNativeSource\(content\);/.test(cs) || !/the engine is measured on BT\.601 limited/.test(cs)) problems.push('contentSource no longer describes a camera surface to the engine only when its frames are what was measured');
    if (!/fn mjpeg_check\(/.test(raw('engine/artlux-engine/src/runtime.rs'))) problems.push('runtime.rs no longer refuses a camera whose holder streams MJPEG (unmeasured)');
    // Step 3: the picture. A full-range frame drawn for a limited-range app is requantised EXACTLY as the app's
    // frame was made (measured: Y' = ((Y*3517 + b) >> 12) + 16, C' = round(128 + (C-128)*224/255)); without it
    // the camera differs from the app by up to 8 (mutation), with BT.709 by up to 11 (mutation).
    const cam = raw('engine/artlux-engine/src/cam.rs');
    if (!/let requant = r\.space\.full_range && !app\.full_range;/.test(cam) || !/\(v as u32 \* 3517 \+ 2048\) >> 12\) \+ 16/.test(cam)) problems.push('cam.rs no longer requantises a full-range camera frame the way the app frame was made');
    if (!/fn space_of\(/.test(c) || !/Space \{ bt709: get\(&MATRIX\) == Some\(1\), full_range: get\(&RANGE\) == Some\(1\) \}/.test(c)) problems.push('camshared.rs no longer reads the colour space of each frame from its attributes (the C270 sends FULL range beside Chromium)');
    // The MP4 shader keeps its constants as LITERALS: passed as a uniform they moved the MP4 picture (measured).
    const y = raw('engine/artlux-engine/src/yuv.rs');
    if (!/CONVERT_WGSL\.replace\("__KR__", kr\)/.test(y) || /var<uniform>/.test(y)) problems.push('yuv.rs no longer writes the colour space into the shader as literals (a uniform moved MP4 pictures by 1-90 channels)');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the timeline panel reaches the transport, waveforms, stills and the OSC sender ONLY through their seams',
  'The detached timeline (plans/native-engine.md, E5): the timeline UI may be mounted in a panel window, where ' +
  'services/timeline (the transport), audioPeaks (the decoder), thumbnailCache, oscOut (the sender) and ' +
  'colorPlayback (the colour player) are an idle copy - a playhead stuck at 0, a sender that never sent. Each ' +
  'is reached through services/transportView, peaksView, thumbView, oscTrackView (installed by the editor ' +
  'with the real thing, by a window with the live channel); the pure helpers moved to services/colorSample ' +
  'and services/oscLanes. One direct import puts a window back on its idle copy, silently.',
  () => {
    const dir = path.join(ROOT, 'src/renderer/components/timeline');
    const bad = /from '(\.\.\/\.\.\/services\/(timeline|thumbnailCache|oscOut|colorPlayback)|\.\/audioPeaks)'/;
    const problems = [];
    const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f) && f !== 'audioPeaks.ts') { const m = bad.exec(fs.readFileSync(p, 'utf8')); if (m) problems.push(`${path.relative(ROOT, p).split(path.sep).join('/')} imports ${m[1]}`); } } };
    walk(dir);
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a test harness stops ITS OWN process tree, never every electron.exe / ArtLux.exe by name',
  'The harnesses run beside the owner\'s own dev session. `taskkill /IM electron.exe` closed that session ' +
  'with every run (and with it any unsaved work); the panel-window harness also killed the npm shell ' +
  'before the tree, which orphaned the app so the tree walk found nothing and a relaunch hit the ' +
  'single-instance lock. Kill `taskkill /PID <child.pid> /T` first, then the child.',
  () => {
    const problems = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'scripts'))) {
      if (!/^test-.*\.cjs$/.test(f)) continue;
      const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
      if (/taskkill \/IM (electron|ArtLux|artlux-engine)\.exe/i.test(src)) problems.push(`${f} kills by image name`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the engine\'s 3D view draws the beams the editor draws',
  'E4b: the engine window throws every lit head\'s beam (engine beams.rs) from the light state the ENGINE ' +
  'resolves (lightpack.rs Head::resolve, held to fixtureSignal.resolveFixture by test:light-pack-parity) and ' +
  'each light\'s fixed half the editor sends (engineView.tsx: lens apex, base rotation, pan / tilt mid-points, ' +
  'lens half-angle). What is COPIED from Beams.tsx, not computed: the beam length, the 48-cone fill-rate budget, ' +
  'the ring / ray counts, the throw limits — change one in Beams.tsx and the two windows draw different beams ' +
  'with nothing failing. They are compared here. The editor must also keep sending the look (haze, cones, ' +
  'Rendered, the selection), or the engine window silently falls back to its defaults.',
  () => {
    const problems = [];
    const B = 'src/renderer/components/Simulator3D/Beams.tsx', R = 'engine/artlux-engine/src/beams.rs';
    const E = 'src/renderer/components/Simulator3D/engineView.tsx', S = 'src/renderer/components/Simulator3D/Simulator3D.tsx';
    const L = 'engine/artlux-engine/src/lightpack.rs', T = 'engine/artlux-engine/src/runtime.rs';
    for (const f of [B, R, E, S, L, T]) if (!exists(f)) return `${f} is gone`;
    const b = read(B), r = read(R), e = read(E), s = read(S);
    for (const k of ['BEAM_LENGTH', 'MAX_BEAMS', 'RING', 'RAYS', 'MAX_THROW', 'FLARE', 'RENDERED_THROW']) {
      const ts = new RegExp('const ' + k + ' = ([0-9.]+);').exec(b), rs = new RegExp('const ' + k + ': [a-z0-9]+ = ([0-9.]+);').exec(r);
      if (!ts || !rs) { problems.push(`${k} not found in ${ts ? R : B}`); continue; }
      if (Number(ts[1]) !== Number(rs[1])) problems.push(`${k}: Beams.tsx ${ts[1]}, beams.rs ${rs[1]}`);
    }
    if (!/RENDERED_STRENGTH = 2\.2;/.test(b) || !read('engine/artlux-engine/src/view3d.rs').includes('mix(1.0, 2.2, solid)')) problems.push('the Rendered strength (2.2) no longer matches between Beams.tsx and view3d.rs');
    if (!read(L).includes('pub fn resolve(&self, dmx: &Value, o: &Over) -> Beam')) problems.push('lightpack.rs no longer resolves a light\'s state');
    if (!read(T).includes('sh.beams = Arc::new(self.light_beams.clone());')) problems.push('runtime.rs no longer publishes the resolved states to the 3D view');
    if (!/beams: \{ haze: r4\(beams\.haze\), cones: beams\.cones, rendered: beams\.rendered, selected: beams\.selected, lightGain: /.test(e)) problems.push('engineView no longer sends the beams\' look (and the rig\'s light gain)');
    if (!/<EngineViewLink fixtures=\{fixtures\} beams=\{\{/.test(s)) problems.push('Simulator3D no longer hands the engine view the beams\' look');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a click in the engine\'s 3D view selects in the editor',
  'E4b: the engine window picks the fixture under a click (view3d.rs pick) and writes a view3dPick line; main ' +
  'relays it to the renderer and Simulator3D applies it to the EDITOR\'s selection, which then flows back to the ' +
  'engine with the scene. Each hop is a string match on a message type in another process — drop one and a ' +
  'click does nothing, with nothing failing. The engine must also keep telling a click from an orbit by travel, ' +
  'or every orbit drag ends in a pick that throws the operator\'s selection away.',
  () => {
    const problems = [];
    const O = 'engine/artlux-engine/src/outputs.rs', H = 'src/main/engineHost.ts', P = 'src/preload/index.ts', S = 'src/renderer/components/Simulator3D/Simulator3D.tsx';
    for (const f of [O, H, P, S]) if (!exists(f)) return `${f} is gone`;
    const o = read(O), h = read(H), p = read(P), s = read(S);
    if (!o.includes('"type":"view3dPick"')) problems.push('the engine no longer writes view3dPick');
    if (!/v\.travel <= CLICK_PX/.test(o)) problems.push('the engine no longer tells a click from an orbit drag');
    if (!/m\.type === 'view3dPick'[\s\S]{0,400}IPC\.NATIVE_ENGINE_VIEW3D_PICK/.test(h)) problems.push('main no longer relays view3dPick to the renderer');
    if (!p.includes('IPC.NATIVE_ENGINE_VIEW3D_PICK')) problems.push('the preload no longer exposes the pick');
    if (!s.includes('onNativeEngineView3dPick')) problems.push('Simulator3D no longer applies the pick');
    if (!s.includes('if (!id && model) { p.onSelectModel?.(model); return; }')) problems.push('a picked venue model no longer reaches the editor model selection');
    if (!o.includes('crate::view3d::pick_any(')) problems.push('the engine no longer picks venue models');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the engine\'s floor numbers follow the editor\'s rules',
  'E4b: the engine window numbers its floor (engine labels.rs) with constants COPIED from the editor\'s ' +
  'GridLabels.tsx and gridScale.ts — the label size, the fade-in band, how far each run counts, the fade ' +
  'distance, the run stickiness, the widest a number may be, the reference cap. Change one in the editor and the ' +
  'two windows number the floor differently with nothing failing. They are compared here.',
  () => {
    const problems = [];
    const R = 'engine/artlux-engine/src/labels.rs', G = 'src/renderer/components/Simulator3D/GridLabels.tsx', S = 'src/renderer/components/Simulator3D/gridScale.ts';
    for (const f of [R, G, S]) if (!exists(f)) return `${f} is gone`;
    const r = read(R), ts = read(G) + read(S);
    for (const k of ['LABEL_GONE_PX', 'LABEL_FULL_PX', 'LABEL_PX', 'MAX_REF_M', 'L_EXT', 'L_FADE', 'RUN_STICK', 'MAX_W']) {
      const a = new RegExp('(?:export )?const ' + k + ' = ([0-9.]+);').exec(ts), b = new RegExp('const ' + k + ': [a-z0-9]+ = ([0-9.]+);').exec(r);
      if (!a || !b) { problems.push(`${k} not found in ${a ? R : 'GridLabels.tsx / gridScale.ts'}`); continue; }
      if (Number(a[1]) !== Number(b[1])) problems.push(`${k}: editor ${a[1]}, engine ${b[1]}`);
    }
    const chars = /const CHARS = '([^']+)'/.exec(read(G)), rchars = /pub const CHARS: &str = "([^"]+)"/.exec(r);
    if (!chars || !rchars || chars[1] !== rchars[1]) problems.push('the glyph set differs');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the engine window\'s gizmo transforms through the editor\'s own gizmo maths',
  'E4b: a drag on the engine window\'s handles (Move, Rotate, Scale) reaches the document ONLY through the editor: ' +
  'the engine sends the gesture (view3dGizmo), main relays it, Simulator3D hands it to engineView.applyEngineGizmo, which applies it with ' +
  'the same gizmoDelta FixtureGizmo uses, records undo, previews and commits once. A second implementation of what ' +
  'a drag means would drift from the editor\'s; a broken hop makes a drag in the engine window do nothing at all.',
  () => {
    const problems = [];
    const O = 'engine/artlux-engine/src/outputs.rs', H = 'src/main/engineHost.ts', P = 'src/preload/index.ts', S = 'src/renderer/components/Simulator3D/Simulator3D.tsx', E = 'src/renderer/components/Simulator3D/engineView.tsx';
    for (const f of [O, H, P, S, E]) if (!exists(f)) return `${f} is gone`;
    const o = read(O), h = read(H), p = read(P), s = read(S), e = read(E);
    if (!o.includes('"type":"view3dGizmo","phase":"end"')) problems.push('the engine no longer sends the drag\'s end');
    if (!/m\.type === 'view3dGizmo'[\s\S]{0,900}IPC\.NATIVE_ENGINE_VIEW3D_GIZMO/.test(h)) problems.push('main no longer relays view3dGizmo');
    if (!p.includes('IPC.NATIVE_ENGINE_VIEW3D_GIZMO')) problems.push('the preload no longer exposes the drag');
    if (!s.includes('onNativeEngineView3dGizmo') || !s.includes('applyEngineGizmo(')) problems.push('Simulator3D no longer applies the drag');
    const fn = e.slice(e.indexOf('export function applyEngineGizmo'));
    if (!/ctx\.onCommit\(gizmoDelta\(/.test(fn) || !/setPreview\(gizmoDelta\(/.test(fn)) problems.push('applyEngineGizmo no longer previews and commits through gizmoDelta');
    if (!/onRecordHistory\(\)/.test(fn)) problems.push('applyEngineGizmo no longer records undo');
    if (!s.includes('applyEngineModelGizmo(phase, gesture,') || !/export function applyEngineModelGizmo[\s\S]{0,2500}ctx\.onCommit\(m\.id,/.test(e)) problems.push('a venue model dragged in the engine window no longer commits through the model own commit');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the engine\'s floor grid follows the editor\'s',
  'E4b: the engine window draws the floor grid (engine grid.rs) by the editor\'s GroundGrid / gridScale / ' +
  'OriginGnomon rules, with their constants COPIED: the lattice extent, its fade and step, the line opacity, the ' +
  'pixels at which a decade fades in and is full, the gnomon size. Change one in the editor and the two windows ' +
  'draw a different floor with nothing failing. They are compared here.',
  () => {
    const problems = [];
    const R = 'engine/artlux-engine/src/grid.rs';
    const T = ['src/renderer/components/Simulator3D/GroundGrid.tsx', 'src/renderer/components/Simulator3D/gridScale.ts', 'src/renderer/components/Simulator3D/OriginGnomon.tsx'];
    for (const f of [R, ...T]) if (!exists(f)) return `${f} is gone`;
    const r = read(R), ts = T.map(read).join('\n');
    for (const k of ['EXTENT', 'FADE', 'STEP', 'LINE_OPACITY', 'FAMILY_GONE_PX', 'FAMILY_FULL_PX', 'GNOMON_PX', 'RADIUS_FRAC']) {
      const a = new RegExp('(?:export )?const ' + k + ' = ([0-9.]+);').exec(ts), b = new RegExp('const ' + k + ': [a-z0-9]+ = ([0-9.]+);').exec(r);
      if (!a || !b) { problems.push(`${k} not found in ${a ? R : 'the editor grid files'}`); continue; }
      if (Number(a[1]) !== Number(b[1])) problems.push(`${k}: editor ${a[1]}, engine ${b[1]}`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'the engine\'s Rendered look uses the editor\'s lights and finish',
  'E4b: in Rendered the engine window lights the room with the heads as spotlights (engine beams.rs spots, the ' +
  'editor\'s MoverLights) and finishes the frame with bloom and AgX (engine post.rs, the editor\'s RenderedMode). ' +
  'Their numbers are COPIED: eight spots, penumbra 0.4, range 30 m, decay 1.2, intensity × 14; exposure 1.1; bloom ' +
  'strength 0.8, radius 0.4, threshold 0.6. Change one in the editor and the two windows light the show differently ' +
  'with nothing failing; so are its shadows (1024² maps, bias −0.0005, normal bias 0.02). They are compared here.',
  () => {
    const problems = [];
    const ML = 'src/renderer/components/Simulator3D/MoverLights.tsx', RM = 'src/renderer/components/Simulator3D/RenderedMode.tsx';
    const B = 'engine/artlux-engine/src/beams.rs', P = 'engine/artlux-engine/src/post.rs';
    for (const f of [ML, RM, B, P]) if (!exists(f)) return `${f} is gone`;
    const ml = read(ML), rm = read(RM), b = read(B), p = read(P);
    if (!/const MAX_SPOTS = 8;/.test(ml) || !/pub const MAX_SPOTS: usize = 8;/.test(b)) problems.push('the spot count differs (MoverLights MAX_SPOTS vs beams.rs)');
    if (!/L\.penumbra = 0\.4;/.test(ml) || !/\(angle \* \(1\.0 - 0\.4\)\)\.cos\(\)/.test(b)) problems.push('the penumbra differs');
    if (!/L\.distance = 30;/.test(ml) || !/L\.decay = 1\.2;/.test(ml) || !/b\.apex\[2\], 30\.0, dir\[0\], dir\[1\], dir\[2\], 1\.2,/.test(b)) problems.push('the range or decay differs');
    if (!/st\.intensity \* gain \* 14;/.test(ml) || !/st\.intensity as f32 \* gain \* 14\.0;/.test(b)) problems.push('the intensity scale differs');
    if (!/toneMappingExposure = 1\.1;/.test(rm) || !/const EXPOSURE: f32 = 1\.1;/.test(p)) problems.push('the exposure differs');
    if (!/bloom\(lit as never, 0\.8, 0\.4, 0\.6\)/.test(rm) || !/const STRENGTH: f32 = 0\.8;/.test(p) || !/const RADIUS: f32 = 0\.4;/.test(p) || !/const THRESHOLD: f32 = 0\.6;/.test(p)) problems.push('the bloom differs');
    if (!/AgXToneMapping/.test(rm)) problems.push('the editor no longer tone-maps Rendered with AgX (post.rs ports AgX)');
    const V = read('engine/artlux-engine/src/view3d.rs');
    if (!/l\.shadow\.mapSize\.set\(quality === 'high' \? 1024/.test(rm) || !/const SHADOW_SIZE: u32 = 1024;/.test(V)) problems.push('the shadow map size differs');
    if (!/l\.shadow\.bias = -0\.0005;/.test(rm) || !/p\.z - 0\.0005\)/.test(V)) problems.push('the shadow bias differs');
    if (!/l\.shadow\.normalBias = 0\.02;/.test(rm) || !/w \+ n \* 0\.02/.test(V)) problems.push('the shadow normal bias differs');
    // Ambient occlusion: half resolution, multiplied in BEFORE the bloom (the editor's `lit = color · ao`, then bloom(lit)).
    const AO = read('engine/artlux-engine/src/ao.rs');
    if (!/aoPass\.resolutionScale = 0\.5;/.test(rm) || !/width: \(w \/ 2\)\.max\(1\)/.test(AO)) problems.push('the occlusion resolution differs (half in the editor)');
    if (!/const glow = bloom\(lit/.test(rm) || !/down_binds\.push\(bind\(if i == 0 \{ &lit \}/.test(p)) problems.push('the occlusion is no longer laid in before the bloom');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a bake the native engine draws is drawn at the app\'s stepped clock, never dropped, and never hangs the app',
  'E6a: with the engine on, plugins/bake hands each stepped frame\'s tick to the engine (bakeFrame) and waits until it ' +
  'is drawn and encoded. Each rule here is a bug of that path: a frame drawn at the engine\'s OWN clock (which does not ' +
  'run during a bake) records the wrong picture; a bake frame sent as a TICK is coalesced away; a render thread that ' +
  'panicked while the stdin thread answered pings hung the app on its first frame (test:engine-bake, a texture without ' +
  'COPY_SRC); an abandon that waits on that dead engine without a bound hung it again on the way out; an encoder left to ' +
  'its own B-frames shifted the software encoder\'s file by a frame at every key frame; a frame time accumulated drifts.',
  () => {
    const problems = [];
    const rt = read('engine/artlux-engine/src/runtime.rs');
    if (!/fn bake_frame_with[\s\S]{0,900}?self\.draw_at = Some\(\(ph, st\)\);[\s\S]{0,300}?self\.draw_sources\(/.test(rt)) problems.push('a bake frame is no longer drawn at the app\'s stepped clock (draw_at) before its sources');
    const sv = read('engine/artlux-engine/src/serve.rs');
    if (!/Some\(op @ \("bakeBegin" \| "bakeFrame" \| "bakeEnd" \| "bakeCancel"\)\)/.test(sv)) problems.push('the engine no longer answers each bake message itself (a bake frame would be coalesced as a tick)');
    if (!/std::panic::catch_unwind\(body\)\.is_err\(\)[\s\S]{0,200}?std::process::exit\(70\)/.test(sv)) problems.push('a panicking render thread no longer ends the engine — main would see it alive and wait forever');
    const pr = read('engine/artlux-engine/src/projector.rs');
    if ((pr.match(/TextureUsages::COPY_DST \| wgpu::TextureUsages::COPY_SRC \| wgpu::TextureUsages::RENDER_ATTACHMENT/g) ?? []).length < 2) problems.push('a projector content texture is no longer a copy source — a bake of a single timeline track panics the engine');
    const en = read('engine/artlux-engine/src/encode.rs');
    if (!/\(CODECAPI_AVEncMPVDefaultBPictureCount, 0\)/.test(en) || !/SetInputMediaType\(video, &inp, &enc\)/.test(en)) problems.push('the encoder\'s settings are no longer handed over while it is configured (the software encoder then writes B-frames)');
    if (!/pub fn frame_time\(i: u64, fps: f64\) -> i64 \{ \(\(i as f64\) \* 1e7 \/ fps\)\.round\(\) as i64 \}/.test(en)) problems.push('a frame\'s time is no longer a function of its index');
    const eh = read('src/main/engineHost.ts');
    if (!/failBakes\('the engine exited during the bake'\)/.test(eh)) problems.push('a bake frame pending when the engine dies would never settle');
    const br = read('plugins/bake/src/bakeRunner.ts');
    if (!/if \(viaEngine\) \{ await withTimeout\(engineCall\('bakeCancel', '\{\}'\), 5_000/.test(br)) problems.push('abandoning an engine bake is no longer bounded — a dead engine hangs the app');
    if (!/if \(req\.alpha\) return 'transparency/.test(br)) problems.push('a bake that keeps transparency would go to the engine, which writes no matte');
    // A render draws the CONTENT, never the surface's own previous bake — and the engine choice reads this render's
    // document (the binding set aside), not the last live frame's: a re-bake sent the engine a surface it could not draw.
    if (!/s\.id === rendering\) return \{ state: 'bypassed'/.test(read('src/renderer/services/bakeStore.ts'))) problems.push('the surface being rendered plays its own bake again (a re-bake is a copy of a copy, and black in the engine)');
    if (!/bakeStore\.setRendering\(surface\.id\);[\s\S]{0,200}?frameEngine\.bakeTick\(\);\s*const engineWhy = engineRefusal/.test(br)) problems.push('the engine is chosen before the document says what this render draws');
    if (!/bakeStore\.setRendering\(null\);   \/\/ the surface plays its \(new\) bake again/.test(br)) problems.push('a render no longer gives the surface its bake back when it ends');
    if (!/None \| Some\(Source::None\) => return Err\("the engine no longer draws this surface/.test(rt)) problems.push('an engine bake whose surface it no longer draws would write black frames instead of refusing');
    if (!/frameEngine\.bakeTick\(clock === 'show' \? \{ t \} : \{ ph: t \}\)/.test(br)) problems.push('a bake frame no longer carries its exact time (an effect on a frame boundary draws the previous step)');
    // E6b: frames pipelined — every one drained before the file is closed, the app's decoders left alone only for a
    // timeline surface the engine draws (the engine picks those frames itself), the encoder on its own thread with a
    // cancel that never closes the file.
    if (!/if \(viaEngine\) \{\s*const why = await drainEngine\(0\);/.test(br)) problems.push('an engine bake can close its file with frames still in flight');
    if (!/if \(tracks !== undefined && viaEngine\) \{/.test(br)) problems.push('the app settling of timeline tracks is no longer skipped for an engine bake (or is skipped when the app draws)');
    if (!/if stop\.load\(std::sync::atomic::Ordering::SeqCst\) \{ return Ok\(ms\); \}\s*out\.finish\(\)\?;/.test(en)) problems.push('a cancelled bake would still close its file (the encoder thread finishes a full queue)');
    // E6c: NV12 on the GPU where the width allows, with the CPU's arithmetic — the same rounding on both sides.
    if (!/if nv12 \{ b\.out\.frame_nv12\(px\)\?; \} else \{ b\.out\.frame\(px\)\?; \}/.test(rt)) problems.push('the bake no longer hands the NV12 the GPU converted to the encoder');
    const bs = read('engine/artlux-engine/src/bakescale.rs');
    if (!/fn q\(x: f32\) -> u32 \{ return u32\(clamp\(floor\(x \+ 0\.5\), 0\.0, 255\.0\)\); \}/.test(bs) || (en.match(/\+ 0\.5\)\.floor\(\)/g) ?? []).length !== 3) problems.push('the GPU and CPU NV12 conversions no longer round the same way (WGSL round() is half-to-even)');
    const fe = read('src/renderer/engine/frameEngine.ts');
    const at = fe.indexOf('  bakeTick(at: nativeLink.BakeAt = {}): string | null {');
    const bt = at < 0 ? '' : fe.slice(at, at + 1600);
    if (!bt.includes('nativeLink.bakeTick(') || /packAndPublish|mapper\./.test(bt)) problems.push('frameEngine.bakeTick must build the tick only — no sampling, nothing on the wire');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'SDK v2: the engine sources the SDK names are exactly the ones the engine draws, and a codec answers for its own files',
  'E6d: a render contribution DESCRIBES its picture (`NativeSource`, @artlux/sdk/renderer) and the engine draws it ' +
  '(runtime.rs `doc`). A kind in the SDK the engine does not parse is silently drawn as nothing; a kind the engine ' +
  'parses that the SDK lacks cannot be asked for by a plugin. And the HAP / MP4 rules belong to their codecs: core ' +
  'naming a codec id to decide what the engine draws is the hard-coding SDK v2 removes — a third codec would have ' +
  'had to edit core.',
  () => {
    const problems = [];
    const sdk = read('packages/sdk/src/renderer.ts');
    const a = sdk.indexOf('export type NativeSource ='), b = sdk.indexOf('export type EngineSourceKind', a);
    if (a < 0 || b < 0) return 'the NativeSource contract is gone from the SDK';
    const kinds = new Set();
    for (const m of sdk.slice(a, b).matchAll(/kind: ((?:'[a-z0-9]+'(?: \| )?)+)/g)) for (const k of m[1].matchAll(/'([a-z0-9]+)'/g)) kinds.add(k[1]);
    kinds.delete('unsupported');
    const rt = read('engine/artlux-engine/src/runtime.rs');
    const s0 = rt.indexOf('let source = match src["kind"].as_str().unwrap_or("none") {');
    const s1 = rt.indexOf('\n            };', s0);
    if (s0 < 0 || s1 < 0) return 'the engine document parser moved (runtime.rs doc)';
    const eng = new Set([...rt.slice(s0, s1).matchAll(/^\s+"([a-z0-9]+)" =>/gm)].map((m) => m[1]));
    for (const k of kinds) if (!eng.has(k)) problems.push(`the SDK names '${k}' but the engine does not draw it`);
    for (const k of eng) if (!kinds.has(k)) problems.push(`the engine draws '${k}' but the SDK cannot ask for it`);
    const cs = read('src/renderer/services/contentSource.ts');
    if (/codecId === '(hap|mp4-webcodecs)'|e\.codecId === '/.test(cs)) problems.push('core names a codec id to decide what the engine draws (ask the codec: VideoCodecContribution.nativeSource)');
    if (!/export type \{ NativeSource \} from '@artlux\/sdk\/renderer';/.test(cs)) problems.push('core defines its own NativeSource instead of the SDK one');
    // E6f: a SLICE is cut by the engine as the app's canvas cuts it — level 0, bilinear (Skia's default smoothing);
    // its source passes the verdict like a sampled surface; a source the engine refuses leaves the slice to the app.
    const cr = read('engine/artlux-engine/src/crop.rs');
    if (!/textureSampleLevel\(tex, samp, u\.off \+ v\.uv \* u\.scale, 0\.0\)/.test(cr) || !/mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, \.\.Default::default\(\)/.test(cr)) problems.push('a slice is no longer sampled as the app canvas does (bilinear, full-size level only)');
    if (!/if !sampled\.iter\(\)\.any\(\|x\| x == of\) \{ sampled\.push\(of\.to_string\(\)\); \}/.test(read('engine/artlux-engine/src/runtime.rs'))) problems.push('the source of a slice no longer passes the engine verdict (a source it cannot draw would be drawn black)');
    if (!/if \(inner\.kind === 'unsupported'\) return \{ kind: 'unsupported', why: `a slice of/.test(read('src/renderer/services/surfaceMedia.ts'))) problems.push('a slice of a source the engine does not draw would go to the engine');
    // E6f: a surface playing its bake is the bake's MP4 to the engine, at the bake decoder's own frame; a transparent
    // bake (matte recombined in the browser) stays the app's.
    const sm = read('src/renderer/services/surfaceMedia.ts');
    if (!/const bake = bakeStore\.nativeFor\(s, t, timeline\.activePoolKey\(\)\);\s*if \(bake\) return 'why' in bake\.source/.test(sm)) problems.push('a surface playing its bake is no longer described to the engine as that MP4');
    if (!/const g = surfaceMedia\.nativeGeneration\(s\);/.test(read('src/renderer/engine/nativeLink.ts'))) problems.push('an MP4 surface tick no longer carries a live bake frame (the engine would draw the authored content frame)');
    if (!/if \(e\.mattePath\) return \{ source: \{ why: /.test(read('src/renderer/services/bakeStore.ts'))) problems.push('a transparent bake would go to the engine, which does not recombine a matte');
    for (const [f, id] of [['plugins/hap/src/hapCodec.ts', 'hap'], ['plugins/mp4/src/mp4Codec.ts', 'mp4']]) {
      const t = read(f);
      if (!/nativeSource: /.test(t) || !/nativeSourceAhead: /.test(t)) problems.push(`the ${id} codec no longer says what the engine draws for its files`);
    }
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a masked or blend-mapped projector output is the engine\'s only while the app draws neither — and its test touches nothing of the operator\'s',
  'E6f: the engine takes a projector output with a projection mask or a blend map because the app\'s projector window ' +
  'applies NEITHER (the mask is the NVIDIA scanout path\'s, nvwarpApply; the blend map render-from-projector\'s, ' +
  'ProjectorScene — both refused separately). The day the plain path (ProjectorGL / ProjectorApp) honours one, the ' +
  'engine would show a different picture: this fails first. test:native-projectors used to rewrite the operator\'s ' +
  'prefs in %APPDATA% and taskkill /IM every ArtLux on the machine — it must keep to its scratch profile and its own pids.',
  () => {
    const problems = [];
    for (const f of ['src/renderer/projector/ProjectorGL.ts', 'src/renderer/projector/ProjectorApp.tsx']) {
      const t = read(f);
      if (/projMask/.test(t)) problems.push(`${f} applies the projection mask now — the engine must too, or refuse it again (nativeLink projectorEntry)`);
      if (/\.blend\b(?!Glsl)/.test(t.replace(/blendGlsl|softEdge/g, ''))) problems.push(`${f} reads the blend map now — the engine must too, or refuse it again`);
    }
    const t = read('scripts/test-native-projectors.cjs');
    if (/^[^/\n]*taskkill', \['\/IM'/m.test(t) || /^[^/\n]*process\.env\.APPDATA/m.test(t) || /^[^/\n]*Get-Process artlux-engine/m.test(t)) problems.push('test-native-projectors touches the operator profile or kills processes by image name again');
    if (!/`--user-data-dir=\$\{PROFILE\}`/.test(t)) problems.push('test-native-projectors no longer launches on a scratch profile');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a windowed projector output shown by the engine is ONE window, where the operator left it, with the app\'s own badge',
  'E6f: the engine takes a WINDOWED output (Windowed (this screen)) by opening an ordinary decorated window where the ' +
  'app\'s is, and main HIDES the app\'s (a topmost cover cannot follow a window the operator drags). Each piece is a ' +
  'trap if it goes: the app\'s window left visible is a second, dead copy of the output; the engine\'s reported moves ' +
  'not stored mean the document is rebuilt from the HIDDEN window\'s bounds, which do not read back what was set ' +
  '(measured: a move of (90, 50) came back as (58, 18) and the engine was put there); a re-sent document built from ' +
  'the one main already annotated keeps a stale reason ("not open yet", "still being handed over") and the engine ' +
  'refuses for good; and the badge drawn twice (DOM + canvas) never agrees — it is ONE bitmap (brand/badge.ts) the ' +
  'app draws and the engine composites at Chromium\'s 8-bit opacity. test:native-projectors --windowed: identical.',
  () => {
    const problems = [];
    const nl = read('src/renderer/engine/nativeLink.ts');
    if (/'a windowed output'/.test(nl)) problems.push('nativeLink refuses a windowed output again');
    if (!/badgeBitmap\(/.test(nl) || !/badge:\$\{o\.surfaceId\}/.test(nl)) problems.push('nativeLink no longer ships the windowed output\'s badge to the engine');
    const pa = read('src/renderer/projector/ProjectorApp.tsx');
    if (!/\{windowed && <BadgeCanvas/.test(pa) || !/badgeBitmap\(/.test(pa)) problems.push('the app\'s window no longer draws the badge from the shared bitmap (brand/badge.ts) — the engine cannot match a DOM badge');
    const b = read('src/renderer/components/brand/badge.ts');
    const at = /BADGE = \{ left: (\d+), top: (\d+), opacity: ([\d.]+) \}/.exec(b);
    const o = raw('engine/artlux-engine/src/outputs.rs');
    const eat = /const BADGE_AT: \(f64, f64\) = \(([\d.]+), ([\d.]+)\);/.exec(o);
    const eop = /const BADGE_OPACITY: f32 = (\d+)\.0 \/ 255\.0;/.exec(o);
    if (!at || !eat || +at[1] !== +eat[1] || +at[2] !== +eat[2]) problems.push('the engine\'s BADGE_AT is not the app\'s BADGE place');
    if (!at || !eop || Math.round(+at[3] * 255) !== +eop[1]) problems.push('the engine\'s BADGE_OPACITY is not the app\'s opacity quantised to 8 bits (Chromium\'s)');
    if (!/getImageData\(0, 0, cw, ch\)/.test(b)) problems.push('badge.ts no longer takes the straight-alpha round trip the engine takes');
    const pj = read('src/main/projector.ts');
    if (!/displayId === WINDOWED_DISPLAY && win\.isVisible\(\) === c\) \{ if \(c\) win\.hide\(\); else win\.showInactive\(\); \}/.test(pj)) problems.push('a covered windowed output is no longer hidden (or no longer shown again when uncovered)');
    if (!/if \(!covered\) win\.showInactive\(\)/.test(pj)) problems.push('a windowed output opened while covered is shown anyway');
    if (!/enginePlace\.set\(surfaceId, physical\)/.test(pj) || !/const placed = enginePlace\.get\(surfaceId\)/.test(pj)) problems.push('the document is rebuilt from the hidden window\'s bounds instead of the engine\'s reported place');
    const eh = read('src/main/engineHost.ts');
    if (/noteDoc\(lastDoc,/.test(eh)) problems.push('engineHost re-sends the ANNOTATED document (stale reasons stick) — rebuild from lastDocRaw');
    if (!/m\.type === 'outputClosed'[\s\S]{0,200}closeWindowedByOperator/.test(eh)) problems.push('closing the engine\'s window of a windowed output no longer closes the output');
    if (!/if spec\.window\.is_none\(\) \{ window\.set_window_level\(WindowLevel::AlwaysOnTop\); \}/.test(o)) problems.push('outputs.rs makes a windowed output topmost (it is an ordinary window, like the app\'s)');
    if (!/set_pipeline\(&pipe\);[\s\S]{0,900}pass\.set_pipeline\(bp\)/.test(o)) problems.push('the badge is no longer drawn on the swapchain after the flip — in the output raster it is upside down, and it lands in the NDI frame the app sends without it');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'an NDI send of a projector output the engine shows is the engine\'s, under the app\'s name, and ONE source of it',
  'E6f: with the engine showing the outputs the app\'s windows are covered and stop drawing — so they stop capturing ' +
  'too, and an NDI send would freeze. The engine therefore SENDS it: its own window\'s pixels, captured as the app ' +
  'captures (fitted within the SAME cap, ndiCap.ts; bilinear at pixel centres, flipped — crop.rs), through the same ' +
  'crate with the same sender options and frame format, under the SAME name; and the app\'s sender of that name stands ' +
  'down while it does (plugins/ndi via the SDK\'s nativeEngine.onProjectorsOwned) and comes back when it stops. NDI ' +
  'refuses a second sender of a name, and the engine\'s starts BEFORE main hears it owns the outputs — so it retries ' +
  '(the first start was refused every time). test:native-projectors --ndi (also --editor: the 720p downscale, and ' +
  '--windowed): the received frames identical, one source.',
  () => {
    const problems = [];
    const nl = read('src/renderer/engine/nativeLink.ts');
    if (/'an NDI send'/.test(nl)) problems.push('nativeLink refuses an NDI send again');
    if (!/ndi: \{ name: `ArtLux — \$\{s\.name\}`, maxW: ndiCap\(BROADCAST\)\[0\], maxH: ndiCap\(BROADCAST\)\[1\] \}/.test(nl)) problems.push('nativeLink no longer gives the engine the app\'s NDI name and cap');
    if (!/desired\.set\(o\.surfaceId, `ArtLux — \$\{surface!\.name\}`\)/.test(read('src/renderer/App.tsx'))) problems.push('App names its NDI sender differently from what nativeLink gives the engine — two names, two sources');
    const pa = read('src/renderer/projector/ProjectorApp.tsx');
    if (!/ndiCap\(ndiFullResRef\.current\)/.test(pa) || /const NDI_MAX_W/.test(pa)) problems.push('the projector window has its own NDI cap again (ndiCap.ts is the one both read)');
    const n = raw('engine/artlux-engine/src/ndi.rs');
    const a = raw('native/ndi/src/lib.rs');
    for (const [what, re] of [['clock_video(true)', /SenderOptions::builder\(.*?\)\.clock_video\(true\)/], ['RGBA', /\.pixel_format\(PixelFormat::RGBA\)/], ['60/1', /\.frame_rate\(60, 1\)/]]) {
      if (!re.test(a) || !re.test(n)) problems.push(`the engine's NDI sender and the app's addon differ on ${what}`);
    }
    if (!/let sender = loop \{[\s\S]{0,400}Sender::new\(/.test(n)) problems.push('the engine no longer retries its NDI sender while the app still holds the name');
    const o = raw('engine/artlux-engine/src/outputs.rs');
    if (!/ndi_fit\(size\.width, size\.height, \*max\)/.test(o) || !/\[0\.0, size\.height as f64, size\.width as f64, -\(size\.height as f64\)\]/.test(o)) problems.push('the engine no longer captures its window as the app does (fitted, flipped)');
    if (!/an NDI send — \{w\}/.test(raw('engine/artlux-engine/src/runtime.rs'))) problems.push('an engine without NDI no longer refuses an NDI send (the app must keep it)');
    if (!/ctx\.nativeEngine\?\.onProjectorsOwned\(\(owned\) => ndi\.setSendersSuspended\(owned\)\)/.test(read('plugins/ndi/src/plugin.main.ts'))) problems.push('plugins/ndi no longer stands its senders down while the engine sends');
    if (!/for \(const cb of projOwnsListeners\)/.test(read('src/main/engineHost.ts'))) problems.push('engineHost no longer tells plugins who shows the projector outputs');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'an NVIDIA-hardware-warped projector output is the engine\'s, drawn FLAT exactly when the app\'s window draws it flat',
  'E6f: NVAPI warps and blends the DISPLAY at scanout — whatever window is on it, the engine\'s topmost one too — and ' +
  'App\'s pushProjectorState then hands its own window a FLAT output (identity corner-pin, no warp, no soft edge, unit ' +
  'gain, no lift; gamma kept), or the correction is applied twice. The engine must be handed the same flat output for ' +
  'the same outputs: ONE predicate (App.hwOwnsGeometry) decides both, passed to nativeLink.setProjectors — a second ' +
  'one would drift (it needs the NVAPI answer and the display\'s `internal`). hwWarp on an output NVAPI does not own ' +
  'is ignored by both. test:native-projectors --hwwarp (ARTLUX_NVWARP_PRETEND: main answers available, skips every ' +
  'scanout call) and --hwwarp --no-pretend: the engine\'s window = the app\'s.',
  () => {
    const problems = [];
    const nl = read('src/renderer/engine/nativeLink.ts');
    if (/'NVIDIA hardware warp'/.test(nl)) problems.push('nativeLink refuses an NVIDIA hardware warp again');
    if (!/projHw\.has\(o\.surfaceId\)\s*\?\s*\{ cornerPin: defaultCornerPin\(\), warp: null, softEdge: defaultSoftEdge\(\), gamma: o\.gamma, colorGain: \[1, 1, 1\] as \[number, number, number\], blackLift: \[0, 0, 0\] as \[number, number, number\], blend: null/.test(nl) || !/output: \(\(\{ blend: _b, \.\.\.x \}\) => x\)\(effectiveOutput\(o\)\)/.test(nl)) problems.push('nativeLink no longer hands the engine the FLAT output the app\'s window draws under a scanout warp');
    if (!/projOutputs, projHwKey, venueScene, venueKey, venueLink\.venueGen\(\), bakedSeq/.test(nl)) problems.push('a change of which outputs NVAPI owns no longer re-sends the document');
    const app = read('src/renderer/App.tsx');
    if (!/nativeLink\.setProjectors\(projectorOutputs, projectorBrightness \?\? 1, projectorOutputs\.filter\(o => hwOwnsGeometry\(o\)\)/.test(app)) problems.push('App no longer tells nativeLink which outputs NVAPI owns through hwOwnsGeometry (the one predicate)');
    if (!/cornerPin: hwGeom \? defaultCornerPin\(\)/.test(app) || !/softEdge: hwGeom \? defaultSoftEdge\(\)/.test(app) || !/colorGain: hwGeom \? \[1, 1, 1\]/.test(app) || !/blackLift: hwGeom \? \[0, 0, 0\]/.test(app) || !/warp: hwGeom \? null/.test(app)) problems.push('the app\'s window no longer draws a hardware-owned output flat the way nativeLink tells the engine to');
    const nv = read('src/main/nvwarpManager.ts');
    for (const f of ['setWarp', 'setIntensity', 'clearDisplay']) {
      if (!new RegExp(String.raw`export function ${f}\([^)]*\): boolean \{\s*if \(pretend\) return true;`).test(nv)) problems.push(`ARTLUX_NVWARP_PRETEND no longer skips ${f} — a test run would reach NVAPI`);
    }
    // A GeForce RTX 5090 HAS NVAPI scanout warp (2026-11-25): a test run that reached it warped the operator's primary
    // display at scanout, invisible to captures, and its forced kill skipped the clear. Every run pretends.
    if (!/const pretend = pretendEnv === '1' \|\| pretendEnv === '0';/.test(nv)) problems.push('ARTLUX_NVWARP_PRETEND=0 no longer pretends NVAPI absent (the --no-nvapi run would reach the real scanout)');
    if (!/env0\.ARTLUX_NVWARP_PRETEND = PRETEND \? '1' : '0';/.test(read('scripts/test-native-projectors.cjs'))) problems.push('test-native-projectors no longer sets ARTLUX_NVWARP_PRETEND on EVERY launch — a run could reach the real NVAPI scanout');
    return problems.length ? problems.join('; ') : null;
  },
);

check(
  'a calibrated projector output in render mode is drawn by the engine as three.js draws it, and the rest is refused with a reason',
  'E6f: render-from-projector — the venue drawn from the solved projector (ProjectorScene, three.js in the projector ' +
  'window) — is the engine\'s (calib3d.rs) where it draws the SAME picture: test:native-projectors --calibrated ' +
  '(two screens, one through its UVs, one projected from the projector, at projector brightness 0.9) = the app\'s, ' +
  '2 073 599 / 2 073 600 (one pixel by 1); --calibrated --glb (a venue GLB too): 2 073 600 / 2 073 600. What makes it ' +
  'exact: the host computes every mesh\'s model-view in f64 as three does (venueLink.ts, the editor\'s own placement ' +
  'functions, three\'s own GLTFLoader); the engine runs three\'s vertex maths, ANGLE\'s y flip and depth remap, the ' +
  'streamed-bitmap UV transform and flippedUv\'s 1 − v, a LinearFilter sRGB texture with no mips, three\'s ' +
  'sRGBTransferOETF (0.41666), the projected material FRONT-sided; and path C\'s dim (brightness × opacity) as ' +
  'the compositor applies a layer opacity — 8-bit, AFTER the resolve (in the shader: 289 648 pixels one level off). ' +
  'It found two app bugs, fixed: a projected mesh drew its content UPSIDE DOWN on the real projector (the texture ' +
  'was handed to the material before it was oriented), and a calibrated output without a residual warp ignored ' +
  'projector brightness and the surface\'s opacity (the canvas element was handed over only with a warp).',
  () => {
    const problems = [];
    const nl = read('src/renderer/engine/nativeLink.ts');
    if (/'calibrated \(render-from-projector\)'/.test(nl)) problems.push('nativeLink refuses every calibrated output again');
    for (const [what, re] of [
      ['a lens distortion', /if \(hasDistortion\(o\.calibration\)\) return \{ why:/],
      ['the blend pass', /if \(needsBlendPass\(\{ softEdge: eff\.softEdge, colorGain: eff\.colorGain, blackLift: eff\.blackLift, blend: eff\.blend \}\)\) return \{ why:/],
      ['a residual warp', /if \(hasResidualWarp\(eff\.cornerPin, eff\.warp\)\) return \{ why:/],
      ['an NDI send', /if \(o\.ndiSend\) return \{ why:/],
    ]) if (!re.test(nl)) problems.push(`nativeLink no longer refuses a calibrated output with ${what} (the engine does not draw it)`);
    if (!/\.\.\.\(inRender \? \{ calib: /.test(nl)) problems.push('nativeLink no longer hands the engine the venue');
    const app = read('src/renderer/App.tsx');
    if (!/const render = projectorOutputs\.filter\(o => o\.enabled && rendersVenue\(o, scene3D\)\)[\s\S]{0,200}nativeLink\.setVenue\(render\.length \? resolveProjectedScene\(scene3D, projectorOutputs\) : null, render, calibratingOutputId\)/.test(app)) problems.push('App no longer hands nativeLink the render-mode outputs through rendersVenue and the scene it sends the windows');
    const vl = read('src/renderer/engine/venueLink.ts');
    for (const [what, re] of [
      ['the editor\'s placement (recenterClone + applyModelTransform)', /const cloned = recenterClone\(f\.scene, m\.origin\);[\s\S]{0,120}applyModelTransform\(g, m\);/],
      ['three\'s modelViewMatrix', /new THREE\.Matrix4\(\)\.multiplyMatrices\(cam\.matrixWorldInverse, o\.matrixWorld\)/],
      ['CalibCamera\'s projection', /glProjectionMatrix\(cal\.intrinsics, cal\.imageSize, PROJECTOR_NEAR, PROJECTOR_FAR\)/],
      ['the EXACT projection of a projected mesh', /engineContent\(cloned, m, true\)/],
      ['a refusal of a mesh in its own material', /content\.mesh\.some\(\(i\) => i < 0\)\) return \{ why:/],
      ['a refusal of occlusion', /s\.proj\?\.occlude\) return \{ why:/],
    ]) if (!re.test(vl)) problems.push(`venueLink no longer uses ${what}`);
    if (!/const NEAR = 0\.05|PROJECTOR_NEAR as NEAR/.test(read('plugins/calibration/src/ProjectorScene.tsx'))) problems.push('ProjectorScene no longer takes its clip planes from renderLook (the engine\'s camera reads the same)');
    const c = raw('engine/artlux-engine/src/calib3d.rs');
    for (const [what, re] of [
      ['three\'s sRGBTransferOETF', /pow\(v, vec3<f32>\(0\.41666\)\) \* 1\.055 - vec3<f32>\(0\.055\), v \* 12\.92/],
      ['three\'s vertex maths (P × (MV × p))', /let mvp = obj\.mv \* vec4<f32>\(p, 1\.0\);\s*var c = cam\.p \* mvp;/],
      ['ANGLE\'s y flip and depth remap', /c\.y = -c\.y;\s*c\.z = \(c\.z \+ c\.w\) \* 0\.5;/],
      ['the streamed bitmap\'s UV transform', /mat3x3<f32>\(vec3<f32>\(1\.0, 0\.0, 0\.0\), vec3<f32>\(0\.0, -1\.0, 0\.0\), vec3<f32>\(0\.0, 1\.0, 1\.0\)\)/],
      ['flippedUv\'s 1 − v on a GLB wearing content', /v\[k \+ 7\] = 1\.0 - v\[k \+ 7\];/],
      ['a LinearFilter sRGB texture without mips', /mipmap_filter: wgpu::MipmapFilterMode::Nearest/],
      ['the sRGB view', /format: Some\(wgpu::TextureFormat::Rgba8UnormSrgb\)/],
      ['the clockwise front face (the y flip)', /front_face: wgpu::FrontFace::Cw/],
      ['the projected material\'s front side', /let front = s\.proj\.is_some\(\);/],
      ['path C\'s dim AFTER the resolve', /let resolve = if dimmed \{ &self\.resolved\.as_ref\(\)\.unwrap\(\)\.2 \} else \{ target \};/],
    ]) if (!re.test(c)) problems.push(`calib3d.rs no longer has ${what}`);
    const st = read('plugins/calibration/src/useStreamedSurfaceTexture.ts');
    if (!/matchBitmapOrientation\(t\);\s*t\.needsUpdate = true;[\s\S]{0,900}if \(fresh\) cbRef\.current\(t\);/.test(st)) problems.push('useStreamedSurfaceTexture hands the texture over before orienting it again (projected content upside down on the projector)');
    const lt = read('src/renderer/components/Simulator3D/useLayerTexture.ts');
    if (!/matchBitmapOrientation\(t\);[^\n]*\n\s*t\.needsUpdate = true;[\s\S]{0,300}if \(fresh\) cbRef\.current\(t\);/.test(lt)) problems.push('useLayerTexture hands the texture over before orienting it again');
    if (!/onCanvas=\{publishCanvas\} readPixels=\{warpSource\}/.test(read('plugins/calibration/src/CalibProjector.tsx'))) problems.push('CalibProjector hands its canvas over only with a residual warp again (path C then ignores brightness and opacity)');
    return problems.length ? problems.join('; ') : null;
  },
);

const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.error(`\x1b[31m✗\x1b[0m ${m}`);

let failures = 0;
for (const c of checks) {
  let problem;
  try { problem = c.fn(); } catch (e) { problem = `check threw: ${e.message}`; }
  if (problem) { failures++; bad(`${c.name}\n    ${problem}\n    WHY: ${c.why}`); }
  else ok(c.name);
}
console.log('');
if (failures) {
  console.error(`\x1b[31minvariant verification: ${failures} failure(s)\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32minvariant verification OK (${checks.length} checks)\x1b[0m`);
