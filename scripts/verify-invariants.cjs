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
    const adapters = read('src/renderer/contexts/panels/adapters.tsx');
    // The PROP WIRING, not just the identifier: the adapter must hand recordHistory to the editor.
    if (!/onRecordHistory=\{a\.recordHistory\}/.test(adapters))
      problems.push('adapters.tsx does not pass onRecordHistory={a.recordHistory} to StateGraphEditor');
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
    const cf = fnBody(src, 'handleCommitFixture3D');
    if (!cf) problems.push('could not find handleCommitFixture3D in App.tsx');
    else if (cf.includes('recordHistory(')) problems.push('handleCommitFixture3D records — double-record with the gizmo latch');
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
  'TimelinePanel is mounted exactly once',
  'Two TimelinePanels double its keyboard hook and its engine subscription, so one keypress seeks twice ' +
  'and one engine event is handled twice. ' +
  'NOTE: this guard used to cover <Stage> as well, on the grounds that unmounting it stopped Art-Net ' +
  'mid-show. That was true while the frame loop lived inside the component; it moved to ' +
  'engine/frameEngine.ts and lost its DOM gates, so the Stage is now an ordinary view and the ' +
  'assertion was DELIBERATELY DROPPED rather than kept as decoration. Free-form docking may legitimately ' +
  'want to place the 2D stage in more than one pane — see plans/engine-decoupling.md.',
  () => {
    const tl = walk('src/renderer').filter((f) => /<TimelinePanel[\s/>]/.test(read(f)));
    return tl.length === 1 ? null : `<TimelinePanel> appears in ${tl.length} files: ${tl.join(', ')}`;
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
  'by frame() while playing. It reverts silently — the app still runs, the show still plays, and only ' +
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
    if (!fnBody(src, 'frame')?.includes('warmWindow(')) problems.push('frame() no longer advances the warm window — clips past the opening window warm only once they are on screen');
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
  'a scene snapshot never carries the trigger zones',
  'A trigger zone is a rectangle taped to a real floor — it does not change shape because the lighting ' +
  'did. Zones live on Scene3D, Scene3D rides in the look snapshot, and recall assigns the whole object: ' +
  'so every scene silently carried a COPY, and the first GO onto a scene captured BEFORE the zones were ' +
  'drawn replaced the live list with nothing. Every zone vanished and every zone-driven transition went ' +
  'inert, with nothing logged and nothing on screen to explain it.',
  () => {
    const src = read('src/renderer/App.tsx');
    const snap = fnBody(src, 'buildSceneSnapshot');
    const problems = [];
    if (!snap) problems.push('could not find buildSceneSnapshot in App.tsx');
    else if (!/trackingZones:\s*undefined/.test(snap)) problems.push('buildSceneSnapshot does not strip `trackingZones` — a scene would capture the room');
    // …and the other half: the recall must not assign a scene's (possibly older) scene3D wholesale.
    const recall = fnBody(src, 'handleRecallScene');
    if (!recall) problems.push('could not find handleRecallScene in App.tsx');
    else if (!/trackingZones:\s*prev\.trackingZones/.test(recall)) problems.push('handleRecallScene does not preserve the live `trackingZones` — an old scene would still wipe them');
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
    for (const f of ['src/main/index.ts', 'src/main/projector.ts', 'src/main/docsWindow.ts']) {
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
    const DEEP = /from ['"]@artlux\/plugin-lidar-tracking\/[^'"]+['"]/;
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
    const F = 'src/renderer/contexts/index.tsx';
    const src = read(F);
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
      // The wrapper is the element immediately preceding the <CameraViewport mount.
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
    const m = /const roleOverride[\s\S]{0,700}?\n      : undefined;/.exec(src);
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
    if (!/id: 'core\.dock\.fixtureWiring'[^\n]*appliesTo: \['fixture\.pixel'\]/.test(ctx))
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
    if (!/onSelectKey\?\.\(clip\.id,\s*k\.t\)/.test(c))
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
      problems.push('ImportPanel.unload no longer returns outputs to their own warp — its own tooltip promises it, and without it withdrawing a map leaves a black projector that survives a reopen');
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
  'the projector bake is serviced inside a Canvas, and reads back with the right signature',
  'The bake renders the venue from a projector pose to answer "which point does each of my pixels ' +
  'land on" — the geometry a calibration FILE is made of. It can only run inside a Canvas, so if ' +
  'ProjectorBakePass is not mounted every request times out into the CPU raycast fallback: a usable ' +
  'file at a fortieth of the resolution (2,176 samples against 860,784), silently, showing up only as ' +
  'soft silhouettes on a wall. The readback is the other trap: WebGL fills a buffer you pass, WebGPU ' +
  'RETURNS one and takes a texture index in that argument slot. Passing the WebGL shape threw ' +
  '"Invalid value used as weak map key" from deep inside three, naming nothing in our code.',
  () => {
    const F = 'src/renderer/components/Simulator3D/projectorBake.ts';
    if (!exists(F)) return `${F} is gone — exports fall back to the coarse raycast grid`;
    const src = stripComments(read(F));
    const problems = [];
    // The SHAPE of the call, not the identifiers — the target is supersampled now, so the size args
    // are named rw/rh. What must never come back is a buffer in that last slot.
    if (!/readRenderTargetPixelsAsync\(rt, 0, 0, \w+, \w+\)/.test(src))
      problems.push('the WebGPU readback is not called with (rt,x,y,w,h) — passing a buffer where it wants a texture index throws inside three, from a stack that names nothing here');
    if (!/registeredCasters\(\)/.test(src))
      problems.push(`${F} no longer bakes the depth pass's caster set — two registries would drift, and the file would disagree with the preview about what occludes what`);
    // Mounted, or nothing ever services a request.
    const sim = read('src/renderer/components/Simulator3D/Simulator3D.tsx');
    if (!/<ProjectorBakePass \/>/.test(sim))
      problems.push('Simulator3D does not mount <ProjectorBakePass /> — every bake silently times out into the coarse fallback');
    // And the export must use it — and ONLY it.
    const md = stripComments(read('plugins/calibration/src/mpcdiData.ts'));
    if (!/requestBake\(/.test(md))
      problems.push('mpcdiData no longer requests a GPU bake — nothing would produce geometry for an export');
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
    if (!/setPrefs\?\.\(\{ calibrationFile: res\.path \}\)/.test(panel))
      problems.push('importing no longer remembers the path — the calibration would be lost on the next start');
    if (!/setPrefs\?\.\(\{ calibrationFile: '' \}\)/.test(panel))
      problems.push('unloading no longer forgets the path — the next start would silently re-load what was just withdrawn');
    const plug = stripComments(read('plugins/calibration/src/plugin.renderer.ts'));
    if (!/getPrefs\?\.\(\)\)\?\.calibrationFile/.test(plug))
      problems.push('the plugin never reads the remembered path — a broadcast install would boot uncalibrated with nothing to say so');
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
    // Exactly one place may fill the content texture. A second is the regression.
    const fills = (src.match(/texImage2D\(gl\.TEXTURE_2D, 0, gl\.RGBA, gl\.RGBA, gl\.UNSIGNED_BYTE, src\)/g) ?? []).length;
    if (fills > 1)
      problems.push(`the content texture is filled from ${fills} places — every one of them must regenerate the mip chain, and the one that forgets renders black`);
    if (!/LINEAR_MIPMAP_LINEAR/.test(src))
      problems.push('the content texture is no longer mipped — minified content aliases and crawls as it plays');
    // WebGL1 cannot mip NPOT: mipping there would make the texture incomplete instead of prettier.
    if (!/this\.canMip = !!this\.gl2/.test(src))
      problems.push('mipping is no longer gated on WebGL2 — a WebGL1 fallback cannot mip a non-power-of-two texture and would render black');
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
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
