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

// ── Shell: the single-instance global overlays ─────────────────────────────────────────────────
check(
  'HelpBrowser is mounted exactly once',
  'HelpBrowser self-owns its open state via a global Shift+F1 keydown and a helpNav subscription. Two ' +
  'mounts double the shortcut and the subscription, so a single openHelp() opens two overlays and a ' +
  'deep-link scrolls the wrong one. It is a centered modal — mount it once beside CommandPalette in ' +
  'WorkspaceShell, never per-context.',
  () => {
    const hb = walk('src/renderer').filter((f) => /<HelpBrowser[\s/>]/.test(read(f)));
    return hb.length === 1 ? null : `<HelpBrowser> appears in ${hb.length} files: ${hb.join(', ')}`;
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
  'no blocking native dialogs in the renderer',
  'window.confirm / window.alert steal focus, are unthemed (a white box over the OLED console), block the ' +
  'JS thread and expose no aria. Every confirmation/notice must route through the in-app substrate ' +
  '(useConfirm / useToast in components/ui/feedback). A native dialog behind a fullscreen projector can ' +
  'hang the operator mid-show.',
  () => {
    const bad = [];
    for (const f of [...walk('src/renderer'), ...walk('plugins')]) {
      const src = read(f);
      if (/window\.(confirm|alert)\s*\(/.test(src) || /(^|[^.\w])alert\s*\(/.test(src)) bad.push(f);
    }
    return bad.length ? `native window.confirm/alert/alert() found: ${bad.join(', ')}` : null;
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
  () => {
    const problems = [];
    for (const f of ['src/main/splashWindow.ts', 'src/main/index.ts']) {
      const src = read(f);
      if (!/ready-to-show/.test(src)) continue; // this file doesn't reveal a window
      if (!/did-finish-load/.test(src)) problems.push(`${f} reveals on ready-to-show with no did-finish-load path`);
      if (!/setTimeout\(\s*reveal|setTimeout\(\s*revealEditor|setTimeout\(revealEditor|setTimeout\(reveal/.test(src)) {
        problems.push(`${f} has no backstop timer for the case ready-to-show never fires`);
      }
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
