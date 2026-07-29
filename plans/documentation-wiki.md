# Plan — a searchable usage wiki for ArtLux

> **Status: Phases 0, 1 and 2 all DONE 2026-07-29 — the gate is OPEN.** Phase 3 (the public site) is
> optional and was never part of it. **⛔ The rule stands for future work:** a net-new feature ships its
> usage documentation with it, and `npm run verify` (11 doc checks) is what says so. Registered in
> [SEQUENCING.md](SEQUENCING.md) ▸ *The documentation gate* (conditions + status tracker),
> [plans/README.md](README.md) ▸ Active plans, and [docs/ROADMAP.md](../docs/ROADMAP.md) ▸ Near-term.
> First thing it holds: **[midi-control](midi-control.md)**.
> **Scope: how to USE the app.** Engine internals, the plugin SDK, build/release and `plans/` are
> explicitly **out** — they stay in the repo for whoever builds ArtLux and never appear in this wiki.

---

## 1. What the usage corpus actually is (audited 2026-07-29)

**Clean, publishable usage prose already exists — and it is much smaller than `docs/`:**

| Source | Size | State |
|---|---|---|
| `docs/user-guide/` — 15 chapters + README | **1 798 lines** | task-oriented, illustrated, **screenshots stale** |
| `examples/**/tuto/` — audio, lidar-tracking, state-machine | **2 537 lines** | walkthrough tutorials, good |
| `src/renderer/help/entries/*.ts` — **226** per-function entries | ~2 400 lines TS | in-app only, EN (FR shape exists, unwritten) |
| **Usage corpus total** | **≈ 4 335 lines prose + 226 entries** | |

Verification that this really is the operator corpus: across those 4 335 lines there are **3** stray
source-code references in total (`examples/audio/tuto/02`, `examples/lidar-tracking/tuto/01`). It is
already written for operators.

### The 41 files in `docs/` are NOT usage docs

Six of them say so in their own title: *"architecture **&** usage"* (AUDIO, SCENES, TIMELINE, ASSETS,
TRACKING_TAKES) and *"design & roadmap"* (SURFACES). Counting source-code references per file separates
them cleanly:

| Class | Files | src-refs |
|---|---|---|
| **Usage — publish as-is** | FEATURES (0), INSTALL (0), MONITORING (0), USER_GUIDE (0), TRACKING_SYNC (3), LEDMAP (4), WATCHDOG (4), CODECS (4), LAUNCHER (5), SPOUT (5) | 0–5 |
| **Hybrid — usage buried inside implementation** | SCENES (9), SCENE-TIMELINES (8), STATE-MACHINE (13), LIGHTING-SHOW (10), FIXTURE-LIBRARY (10), NDI (10), OSC (14), OUTPUTS (14), EFFECTS (15), AUGMENTA (15), SHOW-CONTROL (17), SHORTCUTS (17), AUTO-ALIGN (18), MEDIAPIPE (20), CALIBRATION (21), AUDIO (24), WORKSPACE (27), TIMELINE (36) | 8–36 |
| **Code — never in the wiki** | ARCHITECTURE (59), PLUGINS (57), ROADMAP (54), PROGRESS (87), DEVELOPMENT (27), SDK (8), DESIGN-SYSTEM (11), UI-UX-AUDIT (11), NVWARP (9), CALIB-OPTIMIZATIONS (10), `plans/`, `docs/archive/` | — |

**So the honest picture: ~10 files publish as-is, ~18 need their usage half extracted, ~13 are excluded.**
That extraction is *writing*, not tooling, and it is the bulk of this project.

### Three concrete defects found while auditing

1. **The app already ships developer docs to venue techs.** `src/main/docs.ts`'s curated `REFERENCE_PAGES`
   (32 files reachable from the in-app Docs Browser) includes **`ARCHITECTURE.md`, `DEVELOPMENT.md`,
   `PLUGINS.md`, `SDK.md`**. It correctly excluded PROGRESS/ROADMAP/UI-UX-AUDIT and then let those four in.
2. **The in-app Docs Browser has no search.** It is a two-level tree; Ctrl+F searches the open page only.
   This is the surface a venue tech uses offline at 2am — and it is the one with the worst findability.
3. **Chapter 15 documents a system that changed.** `15-keyboard-reference.md` is a static shortcut list;
   shortcuts became **rebindable** (`docs/SHORTCUTS.md`: *"This replaced the old static list"*). No chapter
   mentions rebinding or *Preferences ▸ Edit shortcuts…* — probe: **0 of 15 chapters**.
   Separately, `scripts/build-docs-html.cjs`'s hand-kept `PAGES` list ends at `'13-keyboard-reference.md'`,
   **a file that no longer exists** — so the built HTML silently drops **Tracking** and
   **Show / state machine** entirely. Its own comment predicted this failure.

---

## 2. Assessment of the goal

**The instinct is right, the framing costs you.** "Turn the documentation into a searchable wiki" reads as
a *publishing* problem. The audit says the usage docs are already written, already in markdown, already
shipped inside the app — they are **unfindable, half-extracted, and stale**. A new wiki site fixes the
first only for people with internet.

Two constraints decide the shape:

- **Offline is non-negotiable.** The primary reader is a venue PC with no internet — the exact failure
  `src/main/docs.ts` was written to fix. A hosted wiki (Notion / Confluence / GitBook / Mintlify) serves
  that reader **zero**. Any website is a *secondary* target, never the source of truth.
- **The docs must stay in git next to the code.** This repo's method is source-derived checks
  (`verify:invariants`). The moment prose moves into a browser editor it stops changing in the same commit
  as the feature — which is precisely how chapter 15 and the HTML page list went stale.

**Reframed goal:** *one operator corpus in git → one search index → three targets (in-app, website, PDF),
with the usage half of the hybrid docs extracted, and machine-checked indexes so nothing drifts silently.*

### Keeping it true while the app moves — the shape that survives churn

**"Wait until it settles" is not available.** 594 commits in 7½ months (~2.6/day), and the last 60 days
alone: `services` **127**, `components/timeline` **60**, `plugins/audio` **50**, `Simulator3D` **32**,
`contexts` **25**, `transport` **21**, `shell` **18**. Nothing here is about to stop moving, and
`plans/lighting-rework-status.md` says outright that a whole shipped subsystem is expected to be reworked.

**But the repo already ran the experiment, and it has an answer.** The shell was rebuilt three times
(fixed shell → workbenches → dockable), and after all three the guide README states: *"The **text** on
every page describes the app as it is now"* — while every screenshot is stale. **Prose survived three
rewrites; pictures survived none.** So the question is not *when* to write, it is *what kind of thing* to
write. The cost of a doc is not writing it — it is **re-verifying it** — so the whole design goal is to
shrink the surface that ever needs re-verification.

**Stratify by half-life, and use a different mechanism per layer:**

| Layer | Half-life | Examples | Mechanism | Re-verify cost |
|---|---|---|---|---|
| **1 · Concepts** | very long | signal flow, what a surface/fixture/scene *is*, the two fixture kinds, one-transport-two-playheads | hand-written prose | ~never |
| **2 · Tasks** | long | "first light in 5 steps", patch a rig, calibrate a projector, author a state | hand-written prose, phrased as **verbs + destinations**, never panel coordinates | rare |
| **3 · Reference data** | **short** | the shortcut tables, effects catalog, OSC addresses, settings lists, fixture-profile counts | **GENERATED from source** into marked blocks | **zero** |
| **4 · Chrome** | **shortest** | 22 screenshots, 21 image refs, **48 hand-written `▸ Menu ▸ Item` paths** | captured + budgeted + version-stamped; paths **grep-checked** against source strings | automated |

**Layer 3 is where the docs actually died.** Chapter 15 is a hand-copied shortcut table — it was edited as
recently as **2026-07-28** and *still* documents a static list that `SHORTCUTS.md` says was replaced, and
still carries the heading `# 13.` in the file named `15-`. It was not neglected; **it was maintained and
still wrong**, because a human re-typing data that exists in a registry loses that race every time. The
answer is not more diligence, it is to stop hand-writing layer 3 at all.

**Three rules that follow, and they are the whole strategy:**

1. **Never hand-write what the source already knows.** Generate layer 3 into `<!-- generated:x -->` blocks;
   `verify-docs` regenerates and fails on a diff. Chapter 15 becomes output, not prose.
2. **Single-source layer 1–2 — mark, don't move.** *(This replaces the "extract into new chapters" design.)*
   Copying the usage half of 18 hybrid docs into guide chapters creates a **second copy of the same claim in
   a repo that changes 2.6×/day** — the exact drift this plan exists to kill. Instead, mark regions **in
   place** and let the build assemble the operator view:
   ```markdown
   <!-- audience:operator -->
   ## Using it …
   <!-- /audience -->
   ```
   One copy, two views. Phase 2 becomes **marking + filling gaps**, not rewriting — and a doc updated by a
   feature commit updates the wiki for free, with no second file to remember.
3. **Cap and stamp layer 4.** 22 screenshots is the ceiling, not a floor. Prefer **hand-authored SVG
   diagrams** for concepts (shell-independent — the tutorial sets already do this) and reserve photos for
   what genuinely cannot be said in words. `capture-docs.cjs` writes a stamp (app version + shell hash) and
   the build **auto-renders the staleness banner**, so nobody has to remember to write one.

**And this is what lets the gate close.** "Documentation is current" stops being a judgement call and
becomes `npm run verify` passing: every generated block regenerates identically, every `▸` path exists in
source, every link resolves, no doc untagged. A gate a human has to *feel* is a gate that gets ticked ✅ and
silently re-broken — which is precisely what happened to Wave 3's gate 2.

---

## 3. State of the art, mid-2026

- **SSG:** Astro **Starlight** has taken docs share from Docusaurus and is the default when you have no
  framework allegiance; VitePress (Vue) and Docusaurus (React) are the ecosystem picks. All ship sidebar,
  TOC, search, dark mode and i18n out of the box — i18n matters here (see §7).
- **Search:** **Pagefind** (Rust, build-time, chunk-loaded index) is the static-site default and is what
  Starlight ships. **Orama** (TypeScript, in-memory) suits small corpora and runs with no server —
  *including inside Electron*. At ~4 300 lines this corpus is small enough that Orama is trivially fast
  and Pagefind's bandwidth advantage is irrelevant offline. Algolia DocSearch needs a crawler + network:
  disqualified.
- **AI-native docs is the 2026 shift** — Mintlify reports roughly half of docs traffic is now agents, not
  browsers; the pattern is `llms.txt` + `llms-full.txt` + an MCP server over the corpus. **For a
  usage-docs goal this is a secondary win** (see §5 Phase 3): your operators are offline with no API key,
  so an "ask the docs" chatbot is not the deliverable. It is still nearly free and it makes *me* stop
  guessing at your docs.
- **Drift detection in CI** is now standard: link-checks and doc-lints block a merge like a failing test.
  You already run this pattern locally in `scripts/verify-invariants.cjs` — it just was never pointed at
  the docs, which is why all three defects in §1 survived.

---

## 4. Options considered

| | Option | Cost | Offline | Verdict |
|---|---|---|---|---|
| **A** | **Search inside the app** — Orama over guide + examples + the 226 help entries, merged into the F1 modal | ~1 day | ✅ | **DO FIRST.** Fixes findability where it is actually felt. |
| **B** | **Extract the usage half of the 18 hybrid docs** into guide chapters | ~3–5 days writing | ✅ | **THE REAL WORK.** Nothing else makes the wiki complete. |
| **C** | **Astro Starlight → GitHub Pages**, operator content only, Pagefind search | ~1–2 days | ❌ | **DO AFTER B.** Repo is public → Pages free. Retires `build-docs-html.cjs`. |
| **D** | Hosted wiki (Notion / Confluence / GitBook / Mintlify) | low setup, high drift | ❌ | **REJECT** — cannot serve the venue PC; breaks docs-in-git. |
| **E** | Self-hosted (Wiki.js / Outline / MediaWiki) | a server forever | ❌ | **REJECT** — nothing here needs write-from-browser. |
| **F** | `llms.txt` + docs MCP server | ~2 h | ✅ | **DO, cheap** — but it serves contributors and agents, not operators. |
| **G** | Fix only the indexes + defects in §1 | ~4 h | — | Insufficient alone; it is **Phase 0** regardless. |

**Recommended order: G → A → B → C, with F whenever convenient.**

---

## 5. The plan

### Phase 0 — classify and stop the drift ✅ **DONE 2026-07-29**

> **Shipped:** `docs/manifest.json` (the one index — **9 usage / 23 hybrid / 9 code**; the earlier "~18
> hybrids" was an estimate, the count is 23 (SPOUT reads as a hybrid, not usage)) · `scripts/verify-docs.cjs` (**9 checks**, wired into
> `npm run verify`) · `scripts/gen-docs-data.cjs` + `npm run docs:gen` · `src/main/docs.ts` derives the
> operator sidebar from the manifest · `build-docs-html.cjs` reads it too, so its dead hand-list is gone.
>
> **Four defects fixed, three of them surfaced by the new checks:**
> 1. the built HTML guide was silently missing **Tracking** and **Show / state machine** — now 16 pages;
> 2. chapter 15 is generated, says shortcuts are rebindable, and no longer heads itself `# 13.`;
> 3. **`/scene/recall` and `/cue/fire`** were handled in `oscController.ts` and documented **nowhere**;
> 4. the four contributor pages left the operator sidebar — and **four operator pages that the hand-kept
>    list had simply forgotten went in**: `INSTALL`, `LAUNCHER`, `USER_GUIDE`, `SHORTCUTS`. A venue tech
>    could not reach the install guide from inside the app.
>
> Net: the sidebar holds 32 pages either way, **zero operator pages lost**.
> ⚠ **Not yet exercised in the running app** — `tsc` + `npm run build` are clean and the derivation was
> checked directly against the manifest, but nobody has opened the in-app Docs Browser since the change.

<details><summary>Original Phase 0 scope</summary>

- One `docs/manifest.json`: every markdown file tagged `usage | hybrid | code`, plus chapter order.
  It replaces **six** hand-maintained lists (`CLAUDE.md` table, guide README table, `examples/README.md`,
  `REFERENCE_PAGES`, `build-docs-html.cjs`'s `PAGES`, the site sidebar later).
- `scripts/verify-docs.cjs` in `npm run verify`, asserting:
  1. every listed file exists and every guide chapter is listed *(catches the dead `13-keyboard-reference`)*;
  2. no file is untagged;
  3. **no `code`-tagged file is reachable from the in-app browser** *(drops ARCHITECTURE / DEVELOPMENT /
     PLUGINS / SDK from an operator's sidebar)*;
  4. every relative `.md` link resolves on disk;
  5. **every generated block regenerates byte-identically** *(layer 3 can never drift again)*;
  6. **every hand-written `▸ Menu ▸ Item` path exists as a literal string in source** — 48 of them today,
     and a rename currently breaks all of them silently.
- `scripts/gen-docs-data.cjs` emits the layer-3 blocks from source: the **keymap registry** (→ chapter 15,
  which stops being prose), the effects catalog, the OSC address table, the settings reference.
- Fix chapter 15 *by generating it*, and have it say shortcuts are rebindable in *Preferences ▸ Edit
  shortcuts…* — plus its heading, which still reads `# 13.` in the file named `15-`.

</details>

### Phase 1 — search in the app ✅ **DONE 2026-07-29** ← *the ask, where it counts*

> **Shipped:** `DocChunk` + `docs:search-index` IPC · `searchIndex()` in `src/main/docs.ts` (heading-split,
> cached, built from the same `listDocs()` sections so search and nav cannot disagree) ·
> `services/docSearch.ts` (**the one scorer**, now shared — `HelpBrowser`'s local copy is gone and
> `verify:docs` fails if either surface grows its own) · a search field in `DocsBrowser` that replaces the
> tree with matching sections · **the F1 modal gained a third tier**, so one query returns the control and
> the chapter.
>
> **Measured in the running app:** **723 chunks from 66 pages, built in 203 ms**, 669 KB, one IPC per
> window. *(A first reading of 13.5 s was startup contention, not the index — worth stating because it
> nearly bought a pointless optimisation.)*
>
> **Two things the live test found that no amount of reading would have:**
> 1. **`"gray code"` returned nothing.** The docs write **"Gray-code"** — 15 times, never with a space.
>    Matching the query as one literal substring meant a reader who typed what they *say* got silence
>    while the answer sat in CALIBRATION.md. Multi-word queries are now tokenised (all tokens must be
>    present, adjacency is a bonus).
> 2. Clicking a result had to land on the **heading**, not the page top — verified: *"phase spread"* → 7
>    hits → click → scrolled to that exact heading.
>
> **Known limit, and it is Phase 2's job:** hybrid pages are indexed whole, so `"gray code"` currently
> surfaces *Building the native addon* and *Key files* — implementation headings from CALIBRATION/
> AUTO-ALIGN. Marking operator regions is what will drop those out of an operator's results.

<details><summary>Original Phase 1 scope</summary>

- Build step emits `docs-index.json`: per-heading chunks (`file`, `anchor`, `title`, `text`) over
  user-guide + examples + `usage`-tagged reference. Shipped as `extraResources` beside the markdown.
- `DocsBrowser` gains a search field backed by **Orama** in-memory.
- **Merge the two in-app search surfaces.** The F1 Help modal already searches 226 per-function entries by
  stable dotted id. One query should return *"the Blade tool"* (control) **and** *"Timeline ▸ editing"*
  (chapter). `HelpBrowser` indexes the doc chunks beside the registry; a doc hit opens the Docs window at
  that anchor through the existing `helpNav.openHelp` path.
  → **The wiki is the search box operators already press F1 for.** No sixth surface.

</details>

### Phase 2 — mark the hybrids in place, then fill the gaps ✅ **DONE 2026-07-29**

> **Shipped:** **68 `<!-- audience:… -->` toggles across all 23 hybrid pages**, read by the chunker into
> `DocChunk.audience` and demoted (not hidden) in search · a `verify:docs` check that fails any hybrid
> marking no contributor region · **three new chapters** — [16 Moving lights & light
> shows](../docs/user-guide/16-moving-lights.md), [17 Installing ArtLux](../docs/user-guide/17-installing.md),
> [18 Running unattended](../docs/user-guide/18-unattended.md). The guide is **19 pages**.
>
> **Toggles, not wrappers.** `<!-- audience:contributor -->` switches everything after it until an
> `<!-- audience:operator -->` switches back. One line per seam instead of an open/close pair per region,
> and an interleaved page still works — STATE-MACHINE alternates **seven** times. A page with no markers
> is entirely operator, which is why the 9 `usage` pages needed no edit at all.
>
> **Demoted, not hidden.** Contributor prose is still true and an integrator sometimes needs it, so it
> sinks below every operator hit rather than disappearing. That is what stops "gray code" answering with
> *Building the native addon*.
>
> **Correction:** the count is **9 usage / 23 hybrid / 9 code**, not the 10/22/9 stated in Phase 0 —
> SPOUT.md carries an *Architecture (brief)* and a *Source map*, so it is a hybrid. The manifest was
> right and the plan's original table was wrong.
>
> ⚠ **The three new chapters have no screenshots**, deliberately — the guide's existing 22 are
> pre-workbench and re-capture is one whole-guide pass (open question §7.1). Prose-only is the honest
> state, not an oversight.

<details><summary>Original Phase 2 scope</summary>

### Phase 2 — mark the hybrids in place, then fill the gaps (~1.5–2.5 days) ⟵ *revised*

**Was: "extract the usage half into new chapters" (3–5 days). That was wrong for a repo moving 2.6
commits/day** — it would have made a second copy of every claim, and the two copies drift the first time a
feature lands. **Now: single-source.** Per hybrid doc, wrap its operator regions in
`<!-- audience:operator -->` and let the build assemble the guide/site/search index from them. The doc stays
one file, the contributor half stays where contributors read it, and **a feature commit that updates the doc
updates the wiki for free.**

- **Mark** (~half a day for all 18): TIMELINE, AUDIO, STATE-MACHINE, OUTPUTS, CALIBRATION, LIGHTING-SHOW,
  FIXTURE-LIBRARY, SHOW-CONTROL, OSC, then the smaller NDI, SPOUT, AUGMENTA, MEDIAPIPE, EFFECTS, LEDMAP,
  SCENES, SCENE-TIMELINES, WORKSPACE. Several already have a clean `## Using it` / `## How it works` seam;
  the rest need one H2 boundary moved.
- **Then write only what marking cannot produce** — the genuine gaps: **moving lights & lighting shows**
  (a whole subsystem behind a 116-line fixtures chapter), **installing & the Launcher**, **unattended /
  watchdog operation**. These are layer 1–2 prose, so they are the durable kind.
- **Deprioritise the churning surfaces.** `plans/lighting-rework-status.md` says the lighting subsystem is
  expected to be reworked — so write its **concepts** (what a take/pose/role *is*, which survives) and leave
  its control-by-control detail to the in-app help layer, which is anchored to the controls themselves.

</details>

### Phase 3 — the public site + machine-readable (~1–2 days) · **optional, not part of the gate**

- Astro **Starlight** in `site/`, sidebar generated from `docs/manifest.json`, **operator content only** —
  contributor docs stay on GitHub where devs already read them, so the audience problem disappears rather
  than being filtered. Pagefind search. GitHub Actions → Pages (public repo → free).
- Emit `llms.txt` / `llms-full.txt` from the same manifest; a small local MCP server over
  `docs-index.json` registered in `.mcp.json`.
- **Retire `scripts/build-docs-html.cjs`** — Starlight's print path replaces the PDF target, and its
  silently-failing hand list dies with it.

---

## 6. What breaks

- `scripts/build-docs-html.cjs` deleted in Phase 3 (`npm run docs:html` removed or aliased).
- `src/main/docs.ts`'s `REFERENCE_PAGES` becomes generated; four dev pages leave the operator sidebar.
- `package` gains one extraResource (`docs-index.json`) → `verify:resources` must learn it.
- No project-file, IPC or SDK change. No migration.

---

## 7. Open questions for a human

1. ~~**Screenshots now block the site.**~~ ✅ **RESOLVED 2026-07-29** — the owner declared feature work
   finished, which was the stated precondition ("deferred until the app is considered stable"), and the
   whole guide was re-captured in one pass against the **dockable workbench** shell. Every "⚠ these are
   outdated" banner and caption is gone from the guide.
   **The harness had rotted with the shell and had to be repaired first** — it drove the old fixed shell
   by clicking text inside hard-coded screen regions, and its very first wait hung forever because the
   app restores the *last used* context. Four traps, each of which cost a run: the restored context; the
   app's own startup navigation destroying the execution context mid-poll; the renderer **target** being
   replaced so the `Page` handle detaches; and three shots pointing at controls that had moved
   (Scenes & Cues and Preferences became workbenches, Media Library became a dock tab) plus one —
   `09-asset-manager` — pointing at **a panel deleted on 2026-07-23**, which was failing silently rather
   than saying the panel had gone.
   **And it published the capturing machine's LAN address and live tablet PIN** into a public repo until
   a redaction step was added — caught by *looking at the picture* rather than at the ✓ beside it. The
   first two redaction rules were themselves wrong, rewriting the port field's caption to "default 0000"
   when the real default is 8788: *a redaction that invents a wrong fact is worse than the exposure it
   prevents.*
2. **French.** The help layer is already `{en, fr}`-shaped with FR written for only 5 guides, and Starlight
   has first-class i18n. For an operator audience this is a real decision, not a nicety — is FR a goal?
3. **Phase 2 depth.** Extract all 18 hybrids, or start with the nine high-value ones and leave the rest
   as "How it works" links into the repo?
