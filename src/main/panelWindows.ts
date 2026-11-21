import { app, BrowserWindow, ipcMain, screen, type Rectangle } from 'electron';
import { join } from 'node:path';
import { IPC, type SavedPanelWindow } from '../../shared/protocol';
import { rendererDevUrl } from './runProfile';
import { APP_ICON } from './appIcon';
import { getPrefs, setPrefs } from './persistence';
import { connectShowHost } from './showHost';

// PANEL WINDOWS (E5/W5): any detachable panel in its own window, on any screen.
//
// Each one is its own BrowserWindow, so its own renderer process and its own main thread: a heavy edit in
// it cannot stutter the editor, and the editor's frame loop cannot stutter it. It is a CLIENT — it loads
// panel.html, which produces nothing (renderer/panel.tsx): the document reaches it from the Show Host
// (connected here, like the editor), and everything else from the editor over the live channel (it asks
// main for that pair itself, main/liveHub.ts).
//
// WHERE IT GOES. Remembered per panel in the prefs, which live in userData, so it is PER MACHINE: a venue
// PC and the laptop it was programmed on keep their own arrangements. A remembered screen is found by
// id first; Windows renumbers displays across reboots and docks, so then by label + size; and when the
// screen is simply not there (the projector box is unplugged) the window comes back on the screen the
// editor is on. Whatever happens it is clamped into that screen's work area: NEVER OFF-SCREEN, because
// a window you cannot see is a window you cannot close.
//
// Which windows were open when the editor closed is remembered too, and they reopen with it.

const APP_PRELOAD = join(__dirname, '../preload/index.js');
const DEFAULT_SIZE = { width: 380, height: 620 };
const MIN_SIZE = { width: 240, height: 160 };
const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

// A window is keyed by its ANCHOR: the panel it was first opened for. Since a window holds a dock tree
// of its own (W5b-2), it may hold more panels than that; `members` is what it reported last, so a
// panel already out in a window is FOCUSED there instead of opened twice.
const windows = new Map<string, BrowserWindow>();
const members = new Map<string, string[]>();

/** The panel ids in a saved/reported tree (structural walk: main does not import the renderer's model). */
function treePanels(tree: unknown): string[] {
  const out: string[] = [];
  const go = (n: unknown, depth: number): void => {
    if (!n || typeof n !== 'object' || depth > 10) return;
    const node = n as { kind?: string; panelIds?: unknown; children?: unknown };
    if (node.kind === 'group' && Array.isArray(node.panelIds)) for (const id of node.panelIds) if (typeof id === 'string') out.push(id);
    if (node.kind === 'split' && Array.isArray(node.children)) for (const c of node.children) go(c, depth + 1);
  };
  go((tree as { root?: unknown } | null)?.root, 0);
  return out;
}
const savedTree = (anchor: string): unknown => getPrefs().panelWindowTrees?.[anchor] ?? null;
function anchorOf(wc: Electron.WebContents): string | null {
  for (const [a, w] of windows) if (!w.isDestroyed() && w.webContents === wc) return a;
  return null;
}
let getEditor: () => BrowserWindow | null = () => null;
/** Set while the editor is closing: its panel windows close with it but STAY on the reopen list. */
let editorClosing = false;

function saved(panelId: string): SavedPanelWindow | undefined {
  return (getPrefs().panelWindows ?? []).find((w) => w.panelId === panelId);
}

/** Where the window is NOW, with its screen — read while it still exists. Null when it cannot be read. */
function where(panelId: string, win: BrowserWindow): SavedPanelWindow | null {
  if (win.isDestroyed() || win.isMinimized()) return null;
  const bounds = win.getNormalBounds();
  const d = screen.getDisplayMatching(bounds);
  return { panelId, bounds, displayId: d.id, displayLabel: d.label, displaySize: { width: d.bounds.width, height: d.bounds.height } };
}

function remember(entry: SavedPanelWindow | null): void {
  if (!entry) return;
  const rest = (getPrefs().panelWindows ?? []).filter((w) => w.panelId !== entry.panelId);
  setPrefs({ panelWindows: [...rest, entry] });
}

function setOpenList(update: (ids: string[]) => string[]): void {
  setPrefs({ openPanelWindows: update(getPrefs().openPanelWindows ?? []) });
}

/** Clamp a rectangle into a work area: shrink it to fit, then slide it inside. */
export function clampInto(b: Rectangle, area: Rectangle): Rectangle {
  const width = Math.max(MIN_SIZE.width, Math.min(b.width, area.width));
  const height = Math.max(MIN_SIZE.height, Math.min(b.height, area.height));
  const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(b.y, area.y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** Where a panel window should open: its remembered screen if that is still attached, else the editor's. */
function placement(panelId: string): Rectangle {
  const displays = screen.getAllDisplays();
  const editor = getEditor();
  const home = editor && !editor.isDestroyed() ? screen.getDisplayMatching(editor.getBounds()) : screen.getPrimaryDisplay();
  const s = saved(panelId);
  if (s) {
    const d = displays.find((x) => x.id === s.displayId)
      ?? displays.find((x) => !!s.displayLabel && x.label === s.displayLabel
        && (!s.displaySize || (x.bounds.width === s.displaySize.width && x.bounds.height === s.displaySize.height)));
    if (d) return clampInto(s.bounds, d.workArea);
    // The remembered screen is gone: same size, on the editor's screen, placed where it fits.
    return clampInto({ ...s.bounds, x: home.workArea.x + 40, y: home.workArea.y + 40 }, home.workArea);
  }
  const a = home.workArea;
  return clampInto({ x: a.x + a.width - DEFAULT_SIZE.width - 40, y: a.y + 80, ...DEFAULT_SIZE }, a);
}

export function openPanelWindow(panelId: string): void {
  if (!ID_RE.test(panelId)) return;
  // Already out — as a window of its own, or as a tab in another one: bring THAT window up, on that tab.
  for (const [anchor, w] of windows) {
    if (w.isDestroyed()) continue;
    if (anchor === panelId || (members.get(anchor) ?? []).includes(panelId)) {
      if (w.isMinimized()) w.restore();
      w.focus();
      w.webContents.send(IPC.PANEL_WINDOW_REVEAL, panelId);
      return;
    }
  }
  const b = placement(panelId);
  const win = new BrowserWindow({
    ...b, minWidth: MIN_SIZE.width, minHeight: MIN_SIZE.height,
    title: 'ARTLux',
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: '#16181c',
    webPreferences: {
      preload: APP_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A panel on another screen is often not the focused window, and it must keep updating.
      backgroundThrottling: false,
    },
  });
  trackStacking(win);
  // NO APPLICATION MENU in a panel window. On Windows the app menu is attached to every window, hidden
  // or not, and its REGISTERED accelerators fire there: Ctrl+R would reload the panel, and Ctrl+S would
  // save through a path that may or may not also see the panel's own key handling. The panel window
  // forwards the keys that mean something there itself (renderer/panel.tsx), so there is one owner.
  win.removeMenu();
  windows.set(panelId, win);
  members.set(panelId, treePanels(savedTree(panelId)).length ? treePanels(savedTree(panelId)) : [panelId]);
  setOpenList((ids) => (ids.includes(panelId) ? ids : [...ids, panelId]));

  // Its document comes from the Show Host, like the editor's (a reload needs a fresh port: every load).
  win.webContents.on('did-finish-load', () => { if (!win.isDestroyed()) connectShowHost(win); });
  // The place is TRACKED as it changes and WRITTEN when the window goes. Not read at close time: a
  // window closed from its own page (window.close()) never emits 'close' (measured — the harness's
  // close left nothing in the prefs), and by 'closed' the window can no longer be asked.
  let last = where(panelId, win);
  let t: NodeJS.Timeout | null = null;
  const track = () => {
    last = where(panelId, win) ?? last;
    if (t) clearTimeout(t);
    t = setTimeout(() => remember(last), 400);   // a drag across a screen is one write, not hundreds
  };
  win.on('moved', track);
  win.on('resized', track);
  win.on('closed', () => {
    if (t) clearTimeout(t);
    remember(last);
    if (windows.get(panelId) === win) { windows.delete(panelId); members.delete(panelId); }
    // Closed by the operator: it should not come back next time. Closed with the editor: it should.
    if (!editorClosing) setOpenList((ids) => ids.filter((x) => x !== panelId));
  });

  const devUrl = rendererDevUrl();
  const q = `?panel=${encodeURIComponent(panelId)}`;
  if (devUrl) void win.loadURL(`${devUrl}/panel.html${q}`);
  else void win.loadFile(join(__dirname, '../renderer/panel.html'), { query: { panel: panelId } });
}

/** The editor window only (never in a show mode). */
export function registerPanelWindows(editor: BrowserWindow, getEditorWindow: () => BrowserWindow | null): void {
  getEditor = getEditorWindow;
  trackStacking(editor);
  registerDockDrag();
  ipcMain.on(IPC.PANEL_WINDOW_OPEN, (_e, panelId: unknown) => { if (typeof panelId === 'string') openPanelWindow(panelId); });
  // A panel window's own arrangement (W5b-2): asked for on load, reported on every change. Kept per
  // anchor in the prefs, so reopening the window brings back its tabs and splits, not just its place.
  ipcMain.handle(IPC.PANEL_WINDOW_STATE, (e) => {
    const anchor = anchorOf(e.sender);
    return anchor ? { anchor, tree: savedTree(anchor) } : null;
  });
  ipcMain.on(IPC.PANEL_WINDOW_TREE, (e, tree: unknown) => {
    const anchor = anchorOf(e.sender);
    if (!anchor || !tree || typeof tree !== 'object') return;
    const ids = treePanels(tree).filter((id) => ID_RE.test(id));
    members.set(anchor, ids);
    // A tree is a few hundred bytes; a corrupt or hostile one is capped rather than trusted.
    if (JSON.stringify(tree).length > 32_000) return;
    setPrefs({ panelWindowTrees: { ...(getPrefs().panelWindowTrees ?? {}), [anchor]: tree } });
  });
  // The editor closing takes its panel windows with it — they are clients of it and of nothing else —
  // but leaves them on the list, so they come back where they were when it opens again. On 'closed',
  // not 'close': the editor's unsaved-changes guard can still cancel a 'close'. A quit closes windows
  // in whatever order it likes, so it marks the list as kept first.
  app.on('before-quit', () => { editorClosing = true; });
  editor.on('closed', () => {
    editorClosing = true;
    for (const w of windows.values()) if (!w.isDestroyed()) w.close();
  });
  // Reopen what was open last time, once the editor (their engine owner) has loaded.
  editor.webContents.once('did-finish-load', () => {
    for (const id of getPrefs().openPanelWindows ?? []) openPanelWindow(id);
  });
}

/** For the harness and the logs. */
export function panelWindowIds(): string[] { return [...windows.keys()]; }

// ── A TAB DRAGGED BETWEEN WINDOWS (E5/W5l) ───────────────────────────────────────────────────────────
// A tab drag is pointer events inside one page (components/shell/DockDrag.tsx), and a page never sees the
// pointer over ANOTHER window. So once a drag leaves its window, the source reports 'move' / 'drop' /
// 'end' here and main does the part only main can: which window is under the cursor, and where.
//
//   · The CURSOR IS READ HERE (screen.getCursorScreenPoint, DIP), never taken from the page: a page's
//     screenX is in its own CSS pixels, which the UI scale (the zoom factor) makes differ per window.
//     Converted into the target's client px with the target's content bounds and its own zoom factor.
//   · Windows are tried TOPMOST FIRST (focus order, see trackStacking): where windows overlap, the one
//     the operator sees under the cursor is the one that takes the drop.
//   · A drop is a question to the target ("take it?"), answered with DOCK_DRAG_DONE; the source removes
//     its tab only on yes, so a drop nobody accepts loses nothing. No answer in 2 s counts as no.
// WHICH WINDOW IS ON TOP. Electron has no z-order query, and windows overlap (several panel windows
// opened at the same remembered place, all over the editor). Focusing a window raises it, so the order
// of focus — most recent first — is the stacking order an operator sees. Every window this file knows
// (the panel windows and the editor) is touched on 'focus', and on creation (a new window opens on top).
const focusOrder: BrowserWindow[] = [];
function raise(win: BrowserWindow): void {
  const i = focusOrder.indexOf(win);
  if (i >= 0) focusOrder.splice(i, 1);
  focusOrder.unshift(win);
}
export function trackStacking(win: BrowserWindow): void {
  raise(win);
  win.on('focus', () => raise(win));
  win.on('closed', () => { const i = focusOrder.indexOf(win); if (i >= 0) focusOrder.splice(i, 1); });
}

let hoverWc: Electron.WebContents | null = null;
let dropSeq = 0;
const drops = new Map<number, (ok: boolean) => void>();

function windowUnderCursor(exclude: Electron.WebContents): { win: BrowserWindow; x: number; y: number } | null {
  const p = screen.getCursorScreenPoint();
  const editor = getEditor();
  // Topmost first (focus order); anything not tracked yet after it, panel windows before the editor.
  const rest = [...windows.values(), ...(editor ? [editor] : [])].filter((w) => !focusOrder.includes(w));
  const candidates = [...focusOrder, ...rest];
  for (const win of candidates) {
    if (win.isDestroyed() || win.webContents === exclude || !win.isVisible() || win.isMinimized()) continue;
    if (win.webContents.isCrashed()) continue;
    const b = win.getContentBounds();
    if (p.x < b.x || p.y < b.y || p.x >= b.x + b.width || p.y >= b.y + b.height) continue;
    const z = win.webContents.getZoomFactor() || 1;
    return { win, x: (p.x - b.x) / z, y: (p.y - b.y) / z };
  }
  return null;
}
function hoverTo(wc: Electron.WebContents | null, msg: { panelId: string; x: number; y: number } | null): void {
  if (hoverWc && hoverWc !== wc && !hoverWc.isDestroyed()) hoverWc.send(IPC.DOCK_DRAG_HOVER, null);
  hoverWc = wc;
  if (wc && !wc.isDestroyed()) wc.send(IPC.DOCK_DRAG_HOVER, msg);
}

/** The cross-window half of the tab drag. Registered once, with the editor (see registerPanelWindows). */
function registerDockDrag(): void {
  ipcMain.handle(IPC.DOCK_DRAG, async (e, phase: unknown, panelId: unknown) => {
    if (typeof panelId !== 'string' || !ID_RE.test(panelId)) return { ok: false };
    if (phase === 'end') { hoverTo(null, null); return { ok: false }; }
    const at = windowUnderCursor(e.sender);
    if (phase === 'move') { hoverTo(at?.win.webContents ?? null, at ? { panelId, x: at.x, y: at.y } : null); return { ok: false }; }
    if (phase !== 'drop') return { ok: false };
    hoverTo(null, null);
    if (!at) return { ok: false };
    const req = ++dropSeq;
    const answer = new Promise<boolean>((resolve) => {
      drops.set(req, resolve);
      setTimeout(() => { if (drops.delete(req)) resolve(false); }, 2000);
    });
    at.win.webContents.send(IPC.DOCK_DRAG_DROP, { req, panelId, x: at.x, y: at.y });
    const ok = await answer;
    if (ok) at.win.focus();
    return { ok };
  });
  ipcMain.on(IPC.DOCK_DRAG_DONE, (_e, req: unknown, ok: unknown) => {
    const r = typeof req === 'number' ? drops.get(req) : undefined;
    if (r) { drops.delete(req as number); r(ok === true); }
  });
}
