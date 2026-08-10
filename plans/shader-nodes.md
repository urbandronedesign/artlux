# A node editor for shaders — feasibility and plan

**Branch:** `shader-content` · **Written:** 2026-08-11 · **Status: RESEARCH + PLAN. No code.**

> ## The verdict in one paragraph
>
> **Feasible, and cheaper than it looks — because the hard half is already built.** A node graph does
> not need a renderer, a parameter system, a library, an automation seam or a projector path: the
> shader plugin has all of those and they are driven by one thing, the text of a `shaderColor`
> function. A node editor is therefore a **producer of that text** and nothing more. The work is a code
> generator, a node catalogue, and a canvas UI — with the catalogue mostly already written, because
> [docs/SHADER-COOKBOOK.md](../docs/SHADER-COOKBOOK.md) and `noiseLib.ts` are 29 GLSL functions that a
> harness already compiles on a real driver. The risk is not technical. It is that a node editor is a
> large, permanent UI surface that must be maintained in step with every future shader feature.

---

## 1 · Why this is not a rewrite

Everything below the text already exists and is verified:

| Already built | What a node graph would otherwise have to solve |
|---|---|
| `buildProgramSource` + the line map | wrapping, uniforms, the Shadertoy adapter, error line numbers |
| The one shared WebGL2 context, program cache, context-loss recovery | running the result at all |
| Loop lint · frame budget · last-good-program | an author's mistake taking the machine down |
| ISF header → inspector controls → `AutomationTargetRegistry` | parameters, timeline lanes, OSC, state machine |
| The effect library (folders, thumbnails, apply) | saving and reusing what you built |
| Projector `SELF_RENDER` at native resolution | getting it on a wall |
| `iAudio` / `iBeat` / `palette()` / `lastFrame` | sound, beats, gradients, feedback |

So the seam is exactly one function:

```
graph (JSON)  →  generateGlsl(graph)  →  the same string an author would have typed  →  everything above
```

Nothing downstream needs to know a graph exists. That is the whole feasibility argument, and it is why
this is worth doing *now* rather than before — the target was not stable until the text pipeline was.

**And the catalogue is largely written.** `plugins/shader/src/cookbook.ts` + `noiseLib.ts` hold 18
documented techniques and every noise generator, each already compiled on a real driver by the release
harness. A node is a function signature plus that body. The library we built for the docs is the node
library.

**One warning from our own code.** `src/renderer/components/timeline/StateGraphEditor.tsx` is a
hand-built node editor — 962 lines, no library, for a graph with ONE node type and ONE edge type. A
shader graph needs typed ports, thirty-odd node types, pan/zoom, multi-select and reroutes. Hand-rolling
that is not a week.

---

## 2 · Prior art, and what is actually usable

Surveyed 2026-08-11. Licence and maintenance are load-bearing here: this repo is public.

### Graph → GLSL compilers

| | What it is | Licence | Health | Verdict |
|---|---|---|---|---|
| **[@shaderfrog/glsl-parser](https://github.com/ShaderFrog/glsl-parser)** | A real GLSL 1.00/3.00 parser + preprocessor in TypeScript, PEG-based, AST-preserving. Described as the most complete GLSL compiler in JavaScript | **ISC** on npm — but the GitHub repo carries **no LICENSE file** GitHub recognises | v7.0.1, 137★, last push 2026-03 | **Useful later, not needed now.** Buys correct renaming/inlining if nodes ever carry arbitrary author GLSL. Resolve the licence discrepancy before depending on it |
| **[@shaderfrog/core](https://github.com/ShaderFrog/core)** | The graph API on top of that parser — compiles a node graph to GLSL, engine-agnostic | ISC on npm, same missing-file caveat | v3.2.0, **12★**, active (2026-08) but README says *"experimental! The API can change at any time!"* | **No.** Its purpose is composing existing ENGINE shaders (three/babylon materials) via source monkey-patching; we want primitive 2D pattern nodes. Big unstable dependency for a fraction of its job |
| **[three.js TSL](https://threejs.org/docs/TSL.html)** | A JS node graph that `NodeBuilder` lowers to **GLSL *or WGSL*** — and three 0.184 is already a dependency | MIT | Core three.js, very active | **The interesting hedge, and a trap today.** TSL is bound to three's material/renderer pipeline; emitting a standalone fragment function is off-label and undocumented, and its node set is material/PBR-oriented, not pattern-oriented. Revisit **only** if the WGSL backend is ever wanted |
| **Own generator** | Topological sort + SSA temporaries + a `requires` set for helper functions | — | — | **Recommended.** ~600–900 lines for a solid v1, no dependency, emits exactly the dialect our wrapper already compiles |

### Canvas / node UI

| | Licence | Health | Verdict |
|---|---|---|---|
| **[React Flow (@xyflow/react)](https://github.com/xyflow/xyflow)** | **MIT** | v12.11.2, **38k★**, pushed yesterday, peer `react >=17` (React 19 fine) | **Recommended.** Pan/zoom, typed handles, selection, minimap out of the box. Brings `zustand` + `classcat` transitively — contained inside the library, but new to this tree |
| Rete.js | MIT | Mature, framework-agnostic, plugin-based | Strong alternative; more machinery to learn, less React-native |
| litegraph.js / Baklava | MIT | litegraph is canvas-drawn and long-lived; Baklava is Vue-first | litegraph's canvas rendering fights our design system; Baklava is the wrong framework |
| Hand-built (StateGraphEditor style) | — | — | Only if a dependency is refused. Weeks, not days, and the result is worse |

### Reference implementations worth reading (not reusing)

- **Godot VisualShader** (MIT) — the closest sane node catalogue to what a 2D generative editor needs.
- **Blender shader nodes** (GPL — read, never copy) — the canonical UX for groups, previews and reroutes.
- **[cables.gl](https://cables.gl)**, **[GSN Composer](https://www.gsn-lib.org/)**,
  **[SHADERed + SpearNode](https://shadered.org/blog?id=10)**,
  **[FNode](https://github.com/victorfisac/FNode)** — whole patching environments or desktop tools;
  useful for node-catalogue ideas, not embeddable here.
- **Unity Shader Graph / TouchDesigner / NodeToy** — closed, but the interaction grammar most operators
  will already expect.

---

## 3 · The design decisions that must be made before any code

### 3.1 The graph is the source of truth. Code generation is one-way.

Graph → GLSL is a compiler. GLSL → graph is decompilation, and nobody sane attempts it: Unity, Blender
and ShaderFrog all refuse. So:

- A surface is **either** a code shader **or** a graph shader.
- **Convert to code** is available and permanent — it detaches, exactly like "unpack prefab".
- There is no "convert to graph".

Getting this wrong is the failure mode that makes node editors hated: an operator edits the code,
returns to the graph, and their edit is silently gone.

### 3.2 Storage rides the existing field

`SurfaceContent.shaderGraph?: string` (JSON) beside `shaderSource`. The **generated** GLSL is written
into `shaderSource` as it is today, so:

- everything downstream keeps working with no changes at all;
- a project opened on a machine whose plugin is older still RENDERS — it just cannot edit the graph;
- the library stores `graph.json` next to `shader.frag` in the effect folder.

That last property is worth the whole design: the graph is an authoring artefact, and the shader is
what the show runs.

### 3.3 Parameters are nodes, and that is the whole automation story

A **Parameter** node emits an ISF header entry and a uniform. Nothing else changes: the inspector draws
the control, `AutomationTargetRegistry` publishes the lane, OSC and the state machine reach it. A graph
gets timeline automation for free because the header is already the contract.

### 3.4 Nodes are cookbook functions

A node is `{ id, label, category, inputs[], outputs[], requires[], emit() }` where `requires` names
helper functions to emit once. The Noise category is `noiseLib.ts` verbatim.

**The release harness already compiles those functions.** Extend it to compile a set of representative
GRAPHS and the node catalogue is verified the same way the docs are — which is the property that stops
a node from silently emitting broken GLSL.

---

## 4 · Node catalogue, v1 (~34)

| Category | Nodes |
|---|---|
| **Input** | UV · Time (show / wall) · Aspect · Resolution · Audio band · Audio level · Beat channel · Beat count · Last frame |
| **Parameter** | Float · Bool · Enum · Colour · Point2D · Palette index |
| **Math** | Add · Multiply · Mix · Clamp · Smoothstep · Sin/Cos · Abs · Fract · Floor · Pow · Remap |
| **Vector** | Split · Combine · Length · Dot · Normalize · Rotate · Polar |
| **Pattern** | Grid · Lines · Checker · Radial |
| **Noise** | Hash · Value · Gradient · Simplex · 3D value · fBm · Turbulence · Ridged · Worley · Curl · Seamless |
| **Shape (SDF)** | Circle · Box · Union/Intersect/Subtract · Outline |
| **Colour** | Palette · Gradient · Mix · Brightness/Contrast |
| **Output** | Colour (the single sink) |

Two rules that keep it honest: **one output node**, and **no cycles** — except the explicit `lastFrame`
input, which is a frame-delayed edge and the only legal loop.

---

## 5 · Risks, stated plainly

- **This is a permanent UI surface.** Every future shader feature has to arrive twice: in the language
  and in the catalogue. A uniform added and not exposed as a node is invisible to graph users.
- **A node editor invites a shell argument.** It wants a lot of screen. It is a dock panel, like the
  code editor — the nine contexts stand, and "so that X and the timeline are visible together" is not
  a reason for a tenth.
- **Generated code must stay readable.** Operators will convert to code and read it. Emit named
  temporaries derived from node labels, not `t17`.
- **Per-node previews are the expensive feature everybody asks for.** Each is a render. Defer; when it
  lands, one shared context and sequential rendering, as the thumbnails already do.
- **React Flow brings zustand.** Contained, but it is a second state library in a tree that has its own
  store. Keep it inside the panel; nothing else may import it.
- **The audience decision from the plan still binds** — "anyone using ArtLux". A graph that emits code
  which then trips the loop lint must explain itself in the graph, not in a GLSL error message.

---

## 6 · Phasing

| Phase | What | Done when |
|---|---|---|
| **0 · Spike, no UI** | `generateGlsl(graph)` for 8 nodes. A hand-written JSON graph in a test compiles through the existing harness and renders on a surface | A graph-generated shader is on the wall, with no editor at all |
| **1 · The generator** | Full catalogue, type checking on connections, `requires` dedup, readable temporaries, cycle detection | Every catalogue node appears in at least one test graph, and all of them compile |
| **2 · The canvas** | React Flow in a dock panel, themed to the design system: add/connect/delete, typed handles, pan/zoom | A shader can be built by mouse and appears on the surface |
| **3 · Parameters + library** | Parameter nodes → ISF header; graph saved on the surface and in library folders; **Convert to code** | A graph parameter drives a timeline lane; an effect saved from a graph re-opens as a graph |
| **4 · Comfort** | Node search, copy/paste, groups/comments, per-node preview, undo integration | It is pleasant rather than merely possible |

**Effort, honestly:** Phase 0 is a day. Phases 1–3 are the real build — a generator with a type system
and thirty-odd nodes is not small, and the UI is a week of its own. Phase 4 is unbounded; stop when it
stops hurting.

---

## 7 · What I need decided

1. **Is the code editor staying?** The answer should be yes — they are different tools for different
   people, and the graph converts *to* code. But if the graph is meant to replace it, the plan changes.
2. **React Flow, or hand-built?** A dependency with 38k stars and an MIT licence against a tree that has
   hand-rolled its one existing graph editor. I recommend the dependency.
3. **How far does v1 go?** Phase 0–2 is "you can build a shader by mouse". Phase 3 is what makes it a
   show tool. Phase 4 is polish that could run forever.
4. **Does anything here justify the second source of truth at all** — or is the cookbook plus an editor
   with good starters already the answer for this audience? Worth asking honestly before building a
   compiler.
