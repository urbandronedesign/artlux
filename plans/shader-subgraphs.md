# Reusable subpatches — collapse a selection into one node

**Branch:** `shader-content` · **Written:** 2026-08-11 · **Status: FEASIBILITY + PLAN. No code.**

> ## The verdict in one paragraph
>
> **Feasible, and cheaper than it looks: the generator is already an inliner.** Every node in this
> catalogue emits one GLSL *expression*, and `generateGlsl` walks a graph substituting expressions into
> each other — which is exactly what expanding a subpatch is. A subpatch needs no GLSL function, no
> calling convention and no new compiler: it is a graph with typed boundary nodes, generated with the
> outer graph's expressions substituted for its inputs. The work is **not** in the compiler. It is in
> three places the current design does not reach: the catalogue is a **static** table, the panel edits
> **one** graph with no notion of going inside anything, and a parameter's name is a **uniform's name**,
> which two instances of the same subpatch would collide on. Estimate: **2–3 days** for a usable
> version, of which perhaps four hours is the generator.

---

## 1 · What is being asked for

Select several nodes on the canvas, collapse them into a single node with the inputs and outputs the
selection had, use that node like any other, and save it for the next show. Unreal calls this a
**Material Function**, Blender a **node group**, Houdini a **subnet** (and, packaged, an HDA), Nuke a
**Group**/**Gizmo**. It is the single most-requested feature in every node editor that lacks it, and the
reason is always the same: the twelfth time you build the same five-node fade, you want a Fade node.

## 2 · Why the hard half is already built

`nodeGraph.ts` topologically sorts the graph and emits one SSA temporary per node output, substituting
each node's inputs with the expressions of whatever feeds them. Expanding a subpatch is the same
operation one level down:

```
outer:  UV ──▶ [ Swirl ] ──▶ Palette ──▶ Output
                  │
inner:  (in.uv) ──▶ Rotate ──▶ Scale ──▶ (out.uv)
```

Generate the inner graph with `in.uv`'s expression **bound to whatever the outer graph wired into the
subpatch's `uv` port**, and the result drops into the outer graph's temporaries as if the five nodes had
been there all along. No function call, no parameter passing, no ABI. Three consequences worth stating:

- **Zero runtime cost.** The generated shader is identical to the hand-built one. A subpatch is an
  authoring convenience that leaves no trace in the GLSL — which also means no new failure mode on the
  wall at 21:00.
- **`requires` and `feedback` already union.** The generator collects helper functions per graph and
  emits each once; the subpatch walker just has to contribute the inner nodes' `requires` and
  `feedback: true` to the outer collection. That is a `for` loop, not a design.
- **The existing lint, budget, compile-cache and library all keep working**, because they only ever see
  the finished GLSL string. Nothing downstream learns that subpatches exist.

## 3 · The five decisions that are not obvious

### a. Copy or link? — **copy, and embed in the project**

Unreal links: *"Edits to a single function propagate throughout all Material networks which use it."*
That is right for a game studio with one asset database, and wrong here for the reason ArtLux already
settled once, for the effects library: **a venue machine has a different `userData`.** A project whose
graph referenced a subpatch stored only in the library would fail to generate on the machine that has
to run the show, and nothing on the authoring machine would say so.

So: **the subpatch's definition travels inside the project's graph JSON**, exactly as shader text does.
The library is a palette you pick FROM, and picking copies. The cost is the honest one, and it is the
same cost the effects library pays: editing a library subpatch does not retro-change shows that already
used it. Two mitigations worth having later — a "used by" list, and an explicit "update instances of
this subpatch" command — but neither is needed for v1.

### b. Parameters inside a subpatch — **prefix per instance**

A `Float parameter` node's name is *both* the GLSL uniform's name and the tail of the automation path
(`shader.<surface>.swirl`). Two instances of one subpatch would declare the same uniform twice, which
does not compile — the exact fault that paste already re-mints names to avoid, except here it would
happen automatically and invisibly.

Three options, in increasing order of usefulness:

1. **Forbid parameters inside subpatches.** One line, poorest outcome: the interesting subpatches are
   precisely the ones with knobs.
2. **Hoist to the instance, prefixed.** `swirl` inside instance `sub_3` becomes `sub_3_swirl`, labelled
   *"Swirl (Ribbons)"* in the inspector. Each instance gets its own knob, its own lane, its own OSC
   address. **Recommended.**
3. Share one uniform across instances (a "global" parameter). Genuinely wanted sometimes — one Speed for
   four copies — but it needs a per-parameter choice in the UI, and that is v2.

Note that option 2 makes the automation path depend on the instance id, so **instance ids must be
stable across saves** — they already are, since node ids are persisted.

### c. Recursion — refuse at insert, cap at generate

A subpatch that contains itself is an infinite inline. Refuse it when the node is added (the id is known
at that moment), and keep a depth cap in the generator as the backstop, because a hand-edited project
file can always produce what the UI would not.

### d. The catalogue is a **static** table — this is the real code change

`NODES` is a `Record<string, NodeDef>` built once at module load, and the menu, the inspector,
`nodeSuggest`, the layout estimator and the generator all index it directly. Subpatches are per-project
node types, so this must become a **registry**: built-ins plus whatever the open project defines, with a
change signal so the menu updates when a subpatch is created. Every `NODES[type]` call site then has to
behave when the type is *unknown* — a project made on another machine, a subpatch deleted, a future
version. The inspector already does the right thing ("this node's type is not in the catalogue"); the
generator currently errors, which is correct but must name the missing subpatch rather than the node id.

### e. The panel edits **one** graph — it needs a stack

Entering a subpatch to edit it means the panel holds a *path*, not a graph: `[surface graph, sub_3]`,
with a breadcrumb, and every commit writing back up the chain. This is the second real change, and it
touches the load/commit/`wrote.current` logic that took two bugs to get right (the stale-panel reload
and the echo-suppression). Worth doing carefully rather than quickly.

## 4 · The cheaper thing that might be enough

**Saved selections — "snippets" — are 80% of the value for 10% of the work.** The clipboard already
copies a selection with its internal wires and re-mints parameter names; saving that JSON to the library
under a name and pasting it back is *one panel and no compiler, registry or stack changes at all*. What
you lose is the collapse: the graph stays flat, so a twelve-node patch pasted four times is a
forty-eight-node canvas. What you keep is reuse, which is the part people actually ask for first.

**Recommendation: ship snippets first** (half a day), see whether the flat canvas becomes the complaint,
and build true subpatches when it does. If the answer is already "no, I want them collapsed", skip to
the phasing below.

## 5 · Phasing, if we build the real thing

| Phase | What | Done when |
|---|---|---|
| **0 · Registry** | `NODES` becomes a registry of built-ins + project subpatches, with a change signal; every call site survives an unknown type | Deleting a subpatch a graph uses names it in the footer instead of throwing |
| **1 · Generate** | Inline expansion in `generateGlsl`, `requires`/`feedback` union, depth cap, per-instance parameter prefixing | A hand-written subpatch graph compiles to byte-identical GLSL to the flattened version |
| **2 · Collapse** | Select → **Collapse to node**: boundary detection (which wires cross the selection), auto-created input/output pins, the new node in place of the selection | Collapsing then expanding a selection is a no-op on the generated GLSL |
| **3 · Edit inside** | The panel's graph stack, breadcrumb, enter/exit, write-back | Editing inside a subpatch updates every instance in that project |
| **4 · Library** | Save/load subpatches as library entries, copied in on use | A subpatch saved on one machine opens in a project on another with no library at all |

**Effort:** phase 1 is a few hours. Phases 0 and 3 are the day each. Phase 2 is where the fiddly cases
live (a selection with a wire crossing it twice, a selection containing Output, a selection containing a
feedback node whose uv comes from outside).

## 6 · What would make me say no

Nothing yet — but two things would change the shape:

- **If the catalogue keeps growing at this rate**, subpatches become less urgent: the reason people
  build a Fade node is usually that Fade is missing. Twenty-two nodes went in today for exactly that
  reason.
- **If subpatches are used to work around a missing node**, we get forty near-duplicate private nodes
  and no catalogue improvement. Worth watching what people collapse, and promoting the common ones into
  the catalogue proper.
