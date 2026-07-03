import React, { useEffect, useRef, useState } from 'react';
import { Minus, X, ChevronRight } from 'lucide-react';
import type { WindowCommand } from '../../../shared/protocol';

// Custom window title bar (VSCode-style) for the frameless editor window: the ArtLux mark, the
// File/Edit/View/Window/Help menus as app-styled dropdowns, a draggable spacer, and the
// minimize / maximize / close controls. The native application menu stays registered in main, so
// keyboard accelerators (Ctrl+S, Ctrl+Shift+M, …) keep working — this bar only handles the mouse.
//
// Items carry one of: `action` (an App menu action, dispatched via onMenuAction, same strings the
// native menu sends), `cmd` (a window/role command sent straight to main), or `href` (open external).

const REPO = 'https://github.com/urbandronedesign/artlux';
const DOCS = `${REPO}/blob/main/docs/FEATURES.md`;

const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
// Render the platform-correct accelerator hint from a Ctrl/Shift/Alt spelling.
const acc = (s: string): string =>
  isMac ? s.replace('CmdOrCtrl', '⌘').replace('Ctrl', '⌘').replace('Shift', '⇧').replace('Alt', '⌥').replace(/\+/g, '') : s;

// Drag-region helpers (Electron honours -webkit-app-region on the frameless window).
const DRAG = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const NODRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

type Item =
  | { sep: true }
  | { label: string; accel?: string; action?: string; cmd?: WindowCommand; href?: string; submenu?: Item[]; disabled?: boolean };

interface Menu { label: string; items: Item[]; }

// Mirror of src/main/menu.ts. `recents` is injected into File ▸ Open Recent.
function buildMenus(recents: string[]): Menu[] {
  const recentItems: Item[] = recents.length
    ? recents.slice(0, 10).map((p) => ({ label: p, action: `open-recent:${p}` }))
    : [{ label: 'No recent files', disabled: true }];
  return [
    {
      label: 'File',
      items: [
        { label: 'New Project…', accel: 'Ctrl+N', action: 'new' },
        { label: 'Open…', accel: 'Ctrl+O', action: 'open' },
        { label: 'Open Project Folder…', accel: 'Ctrl+Shift+O', action: 'open-project-folder' },
        { label: 'Open Recent', submenu: recentItems },
        { sep: true },
        { label: 'Save', accel: 'Ctrl+S', action: 'save' },
        { label: 'Save As…', accel: 'Ctrl+Shift+S', action: 'save-as' },
        { label: 'Collect Assets…', action: 'collect-assets' },
        { sep: true },
        { label: 'Export Rig…', action: 'export-rig' },
        { label: 'Import Rig…', action: 'import-rig' },
        { sep: true },
        { label: 'Routing…', action: 'routing' },
        { label: 'Preferences…', accel: 'Ctrl+,', action: 'preferences' },
        { sep: true },
        { label: 'Launch in Broadcast Mode', action: 'broadcast' },
        { sep: true },
        { label: 'Quit', accel: 'Ctrl+Shift+Q', cmd: 'quit' },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', accel: 'Ctrl+Z', action: 'undo' },
        { label: 'Redo', accel: 'Ctrl+Shift+Z', action: 'redo' },
        { sep: true },
        { label: 'Cut', accel: 'Ctrl+X', cmd: 'cut' },
        { label: 'Copy', accel: 'Ctrl+C', cmd: 'copy' },
        { label: 'Paste', accel: 'Ctrl+V', cmd: 'paste' },
        { label: 'Select All', accel: 'Ctrl+A', cmd: 'select-all' },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Reload', accel: 'Ctrl+R', cmd: 'reload' },
        { label: 'Toggle Developer Tools', accel: 'Ctrl+Shift+I', cmd: 'devtools' },
        { sep: true },
        { label: 'OSC Monitor…', accel: 'Ctrl+Shift+M', action: 'osc-monitor' },
        { label: 'Pose Monitor…', action: 'pose-monitor' },
        { label: 'Pose Floor Calibration…', action: 'pose-calibrate' },
        { sep: true },
        { label: 'Reset Zoom', accel: 'Ctrl+0', cmd: 'zoom-reset' },
        { label: 'Zoom In', accel: 'Ctrl++', cmd: 'zoom-in' },
        { label: 'Zoom Out', accel: 'Ctrl+-', cmd: 'zoom-out' },
        { sep: true },
        { label: 'Toggle Full Screen', accel: 'F11', cmd: 'fullscreen' },
      ],
    },
    {
      label: 'Window',
      items: [
        { label: 'Minimize', cmd: 'minimize' },
        { label: 'Close', cmd: 'close' },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Help Panel', accel: 'F1', action: 'help-panel' },
        { sep: true },
        { label: 'Check for Updates…', action: 'check-updates' },
        { sep: true },
        { label: 'Documentation', href: DOCS },
        { label: 'GitHub Repository', href: REPO },
        { sep: true },
        { label: 'About ArtLux', action: 'about' },
      ],
    },
  ];
}

interface Props {
  onMenuAction: (action: string) => void;
  /** Toolbar action icons rendered inline on the right, before the window controls. */
  actions?: React.ReactNode;
}

export const MenuBar: React.FC<Props> = ({ onMenuAction, actions }) => {
  const [open, setOpen] = useState<string | null>(null); // open top-level menu label
  const [recents, setRecents] = useState<string[]>([]);
  const [maximized, setMaximized] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const menus = buildMenus(recents);

  // Track maximized state to swap the maximize/restore glyph.
  useEffect(() => {
    window.artlux?.isWindowMaximized?.().then((m) => setMaximized(!!m));
    const unsub = window.artlux?.onWindowMaximizeChanged?.((m) => setMaximized(m));
    return () => unsub?.();
  }, []);

  // Refresh the recent-files list whenever the File menu opens (it changes on save/open).
  useEffect(() => {
    if (open === 'File') window.artlux?.getPrefs?.().then((p) => setRecents(p?.recentFiles ?? []));
  }, [open]);

  // Close on outside click or Escape while a menu is open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!barRef.current?.contains(e.target as Node)) setOpen(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const run = (item: Extract<Item, { label: string }>) => {
    if (item.disabled || item.submenu) return;
    if (item.action) onMenuAction(item.action);
    else if (item.cmd) window.artlux?.windowCommand?.(item.cmd);
    else if (item.href) window.artlux?.openExternal?.(item.href);
    setOpen(null);
  };

  const cmd = (c: WindowCommand) => window.artlux?.windowCommand?.(c);

  return (
    <div
      ref={barRef}
      style={DRAG}
      className="relative z-menubar flex h-8 shrink-0 items-stretch bg-surface-2 border-b border-line-1 select-none"
    >
      {/* Logo */}
      <div className="flex items-center pl-2 pr-1" style={NODRAG}>
        <div className="w-[18px] h-[18px] rounded-md bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center text-white font-bold text-xs leading-none shadow-e1">A</div>
      </div>

      {/* Menus */}
      <div className="flex items-stretch" style={NODRAG}>
        {menus.map((m) => (
          <div key={m.label} className="relative flex">
            <button
              className={`px-2 h-full text-md leading-none flex items-center transition-colors ${open === m.label ? 'bg-white/10 text-fg-1' : 'text-fg-2 hover:bg-white/5 hover:text-fg-1'}`}
              onClick={() => setOpen(open === m.label ? null : m.label)}
              onMouseEnter={() => { if (open) setOpen(m.label); }} // hover-switch once the bar is active
            >
              {m.label}
            </button>
            {open === m.label && <Dropdown items={m.items} onRun={run} />}
          </div>
        ))}
      </div>

      {/* Draggable spacer */}
      <div className="flex-1" />

      {/* Toolbar action icons (inline, before the window controls) */}
      {actions && <div className="flex items-center pr-1" style={NODRAG}>{actions}</div>}
      <div className="self-center mx-1 h-5 w-px bg-line-1" />

      {/* Window controls */}
      <div className="flex items-stretch" style={NODRAG}>
        <button title="Minimize" aria-label="Minimize" onClick={() => cmd('minimize')}
          className="w-[44px] flex items-center justify-center text-fg-2 hover:bg-white/10 hover:text-fg-1">
          <Minus size={15} />
        </button>
        <button title={maximized ? 'Restore' : 'Maximize'} aria-label={maximized ? 'Restore' : 'Maximize'} onClick={() => cmd('maximize-toggle')}
          className="w-[44px] flex items-center justify-center text-fg-2 hover:bg-white/10 hover:text-fg-1">
          {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
        </button>
        <button title="Close" aria-label="Close" onClick={() => cmd('close')}
          className="w-[44px] flex items-center justify-center text-fg-2 hover:bg-danger hover:text-white">
          <X size={16} />
        </button>
      </div>
    </div>
  );
};

// One dropdown panel (top-level or a submenu flyout).
const Dropdown: React.FC<{ items: Item[]; onRun: (i: Extract<Item, { label: string }>) => void; flyout?: boolean }> = ({ items, onRun, flyout }) => {
  const [subOpen, setSubOpen] = useState<string | null>(null);
  return (
    <div className={`absolute ${flyout ? 'left-full -top-1' : 'left-0 top-full'} min-w-[220px] py-1 bg-surface-1 border border-line-2 rounded-md shadow-e3 z-menu-flyout animate-overlay-in`}>
      {items.map((it, i) => {
        if ('sep' in it) return <div key={i} className="my-1 h-px bg-line-1" />;
        const item = it;
        const hasSub = !!item.submenu;
        return (
          <div key={item.label} className="relative" onMouseEnter={() => setSubOpen(hasSub ? item.label : null)}>
            <button
              disabled={item.disabled}
              onClick={() => onRun(item)}
              className={`w-full flex items-center gap-6 px-3 h-7 text-[12.5px] text-left ${item.disabled ? 'text-fg-3 cursor-default' : 'text-fg-1 hover:bg-accent/20'}`}
            >
              <span className="flex-1 truncate">{item.label}</span>
              {item.accel && <span className="num text-mini text-fg-3">{acc(item.accel)}</span>}
              {hasSub && <ChevronRight size={13} className="text-fg-3 -mr-1" />}
            </button>
            {hasSub && subOpen === item.label && <Dropdown items={item.submenu!} onRun={onRun} flyout />}
          </div>
        );
      })}
    </div>
  );
};

// Crisp 10px window-control glyphs (lucide's Square is too heavy at this size).
const MaximizeGlyph: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="0.5" y="0.5" width="9" height="9" rx="1" stroke="currentColor" /></svg>
);
const RestoreGlyph: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <rect x="0.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" />
    <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" stroke="currentColor" />
  </svg>
);
