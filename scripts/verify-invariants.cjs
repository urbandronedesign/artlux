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
  'HelpBrowser self-owns its open state via a global Shift+F1 keydown and a helpNav subscription. Two ' +
  'mounts double the shortcut and the subscription, so a single openHelp() opens two overlays and a ' +
  'deep-link scrolls the wrong one. It is a centered modal — mount it once beside CommandPalette in ' +
  'WorkspaceShell, never per-context.',
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
    if (/if\s*\(\s*!?\s*(this\.)?previewCanvas\s*\)\s*return/.test(eng)) {
      problems.push('the engine returns early on a missing preview canvas — the preview is cosmetic, output is not');
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
    if (!/useLayoutEffect/.test(dock) || !/el\.style\.flexGrow = /.test(dock)) {
      problems.push('the dock panes no longer assert their flex after every render — a splitter drag will leave pixel sizes pinned on them and new space will be distributed to nobody');
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

// ── The byte-sources paint somewhere a worker can reach ───────────────────────────────────────
check(
  'DMX-in, Spout and NDI paint into an OffscreenCanvas, and skip the repaint when nothing arrived',
  'These three receive raw RGBA (or DMX channels) over IPC and assemble a picture for the sampler. The ' +
  'canvas they paint into is never displayed — it exists only to be sampled — so a DOM element is the ' +
  'wrong thing twice over: it cannot exist in a worker, which is where the engine is going, and it ties ' +
  'a background data path to the document. They also each get asked for a picture once per consuming ' +
  'surface AND again inside the GPU sampler\'s per-surface closure, so without a "has anything actually ' +
  'arrived" check the same unchanged bytes were re-packed and re-uploaded several times per frame, and ' +
  'on every frame while the sender sat idle. A detached <canvas> stays as the fallback where ' +
  'OffscreenCanvas is missing; it must not be the primary path.',
  () => {
    const files = [
      'src/renderer/services/dmxInput.ts',
      'plugins/spout/src/spoutReceiver.ts',
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
    if (!/cameraFrame\?\.close\(\)/.test(src)) {
      problems.push('the camera frame is never closed — VideoFrames pin decoder buffers and the camera will stall');
    }
    const stop = fnBody(src, 'stopCamera');
    if (stop && !/cameraFrame\?\.close\(\)/.test(stop)) {
      problems.push('stopCamera leaves the last VideoFrame open');
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
  'showing the OLD project and reported success to whoever spawned it.',
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
  'already filters on it and a body guard is invisible from the context manifest. Only four sections ' +
  'legitimately apply to both kinds: `profile` (it is how you CHANGE the kind), `patch` and `routing` ' +
  '(every fixture is on a wire) and `arrange` (rig-building is kind-agnostic). Anything else must ' +
  'name fixture.pixel or fixture.light — this check is what stops the next panel silently ' +
  'reintroducing the LED Count hole.',
  () => {
    const F = 'src/renderer/contexts/index.tsx';
    const src = read(F);
    const BOTH = new Set(['profile', 'patch', 'routing', 'arrange']);
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
    for (const need of ['mapping', 'channels', 'patch'])
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
