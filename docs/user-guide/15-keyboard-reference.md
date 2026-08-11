# 15. Keyboard & mouse reference

Typing in a text field suppresses the keyboard shortcuts. On macOS, **Ctrl** = **Cmd** — the two are one
binding, so a shortcut written `Ctrl+Z` is `Cmd+Z` on a Mac.

> ## ⌨ Every shortcut below is **rebindable**
>
> Open **Preferences ▸ Edit shortcuts…** for the full-page editor: search an action, click its binding and
> press the keys you want. Your changes are saved with your preferences, so they follow you between
> projects. A key can be reused in two different places (a timeline-only key and a global one do not
> collide, because the timeline only listens while it has focus) — the editor blocks a clash only *within*
> the same scope, which is what the **When** heading on each group below tells you.
>
> The one exception is the **native menu accelerators** further down: those belong to the application menu
> and are fixed.

---

## Rebindable shortcuts

<!-- generated:keymap — DO NOT EDIT BY HAND. Regenerate with: npm run docs:gen -->

### Global

Live anywhere in the editor, and suppressed while you are typing in a field.

**Editing**

| Shortcut | Action |
|---|---|
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` or `Ctrl+Y` | Redo |
| `Ctrl+A` | Select all fixtures |

**View**

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+P` | Open Performance dock |
| `Ctrl+T` | Show / hide the timeline drawer |
| `Ctrl+Shift+W` | Clear all NV warp/blend |

**Navigation**

| Shortcut | Action |
|---|---|
| `Ctrl+Tab` | Next workspace |
| `Ctrl+Shift+Tab` | Previous workspace |

**Recording**

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+R` | Record lighting take — Toggles. Captures the SELECTED fixtures — their selection order becomes the take |
| `Ctrl+Alt+R` | Record tracking take — Toggles. Captures the live tracker feed, independent of the transport |

### Timeline

Live only while the timeline drawer is hovered or focused (`Ctrl+T` opens it).

**Transport**

| Shortcut | Action |
|---|---|
| `Space` | Play / pause |
| `L` | Play |
| `Shift+L` | Toggle loop |
| `K` or `J` | Pause |
| `Home` | Seek to start |
| `End` | Seek to end |

**View**

| Shortcut | Action |
|---|---|
| `F` | Maximize timeline |
| `+` or `=` | Zoom in |
| `-` or `_` | Zoom out |

**Tools**

| Shortcut | Action |
|---|---|
| `B` | Blade tool |
| `V` | Select tool |
| `S` or `N` | Toggle snapping |

**Editing**

| Shortcut | Action |
|---|---|
| `C` | Blade at playhead |
| `M` | Add marker |
| `I` | Set in point |
| `O` | Set out point |
| `Delete` or `Backspace` | Delete selected (ripple) — Hold Shift to lift (no ripple) |

### 3D scene

Live only while the pointer is over the 3D viewport.

**Tools**

| Shortcut | Action |
|---|---|
| `W` | Move tool |
| `E` | Rotate tool |
| `R` | Scale tool |
| `Q` | Box select tool — Drag to select fixtures; hold Shift to add to the selection |
| `X` | World / Object axes — Toggles. Object aligns the handles to the selected fixture; the pivot stays on the middle of the selection either way |

### Show state-graph editor

Live only while the Show graph has focus.

**Editing**

| Shortcut | Action |
|---|---|
| `Delete` or `Backspace` | Delete state / transition / region |

**View**

| Shortcut | Action |
|---|---|
| `F` | Fit graph in view — Frames every state and region. The toolbar Fit button does the same; Alt-click it to reset the view to 1:1 |

### Projector window

Live only in a projector window's warp-edit mode.

**Warp**

| Shortcut | Action |
|---|---|
| `R` | Reset warp handle |
| `Up` | Nudge handle up |
| `Down` | Nudge handle down |
| `Left` | Nudge handle left |
| `Right` | Nudge handle right — Hold Shift for a ×10 step |

<!-- /generated:keymap -->

---

## Not rebindable

These live in the **application menu** (or are universal dialog keys), not in the shortcut registry.

| Shortcut | Action | Menu |
|---|---|---|
| `Ctrl+N` | New Project… | File |
| `Ctrl+O` | Open… | File |
| `Ctrl+Shift+O` | Open Project Folder… | File |
| `Ctrl+S` | Save | File |
| `Ctrl+Shift+S` | Save As… | File |
| `Ctrl+,` | Preferences… | File |
| `Ctrl+Shift+Q` | Quit (also quits broadcast mode) | File |
| `Ctrl+R` | Reload | View |
| `Ctrl+Shift+I` | Toggle Developer Tools | View |
| `Ctrl+Shift+M` | OSC Monitor… | View |
| `F1` | Toggle the searchable Help modal | — |
| `Esc` | Close the open dialog | — |

`Ctrl+1`…`Ctrl+9` jump straight to a workbench on the left rail — nine numbered variants of one behaviour
rather than nine separate actions, so they are not listed individually in the editor.

---

## Pointer & gestures

Mouse behaviour is not rebindable.

### 2D stage (surfaces & fixtures)

| Input | Action |
|---|---|
| Drag body | Move surface / fixture |
| Drag corner handle | Resize (corner = both axes; side handles on fixtures = one axis) |
| Drag top handle | Rotate (snaps to 45° with snapping on) |
| Click fixture + `Ctrl` or `Shift` | Add / remove from multi-selection |
| Click empty space | Deselect |
| Mouse wheel | Zoom (toward cursor) |
| `Shift` + wheel | Pan horizontally |
| Middle-drag (or `Shift`+drag) | Pan the view |
| Magnet / grid buttons (stage top-right) | Toggle snapping / grid; reset view |

### Timeline

| Input | Action |
|---|---|
| Wheel | Zoom toward the cursor |
| `Shift` + wheel | Scroll horizontally |
| Middle-drag | Pan both axes |

### 3D scene

| Input | Action |
|---|---|
| Left-drag | Orbit camera |
| Middle / right-drag | Pan camera |
| Wheel | Zoom camera |
| `W` / `E` / `R` | Move / rotate / scale the selected fixture |
| Click empty space | Deselect |

A fixture in 3D is picked by its **body** (the slim housing), not by its individual LEDs — a 12 mm LED
sphere is not a target you can reliably hit.

### Projector alignment (in the projector window)

| Input | Action |
|---|---|
| Drag handle | Move a corner / control point |
| `Esc` | Finish aligning |

Arrow-key nudging and `R` to reset are in the rebindable **Projector window** group above.

---

⬅ Back to the [User Guide index](README.md)
