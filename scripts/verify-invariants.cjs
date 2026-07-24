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

/** The body of `const <name> = (…) => { … }` — brace-matched, good enough for our handlers. */
function fnBody(src, name) {
  const i = src.indexOf(`const ${name} = `);
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
  'Stage and TimelinePanel are mounted exactly once',
  'Stage publishes dmx:frame — unmounting it stops Art-Net mid-show. Two TimelinePanels double its ' +
  'keyboard hook and engine subscription. Both are passed to the shell as persistent elements.',
  () => {
    const problems = [];
    const stage = walk('src/renderer').filter((f) => /<Stage[\s\n]/.test(read(f)));
    // App renders Stage twice on purpose: the editor shell AND the headless/broadcast branch.
    if (stage.length !== 1) problems.push(`<Stage> appears in ${stage.length} files: ${stage.join(', ')}`);
    const tl = walk('src/renderer').filter((f) => /<TimelinePanel[\s/>]/.test(read(f)));
    if (tl.length !== 1) problems.push(`<TimelinePanel> appears in ${tl.length} files: ${tl.join(', ')}`);
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
