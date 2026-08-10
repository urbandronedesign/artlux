import { join } from 'path';

// THE WINDOW ICON, IN ONE PLACE.
//
// Only the editor window ever set `icon:`, so every other window ArtLux opens — the projector
// outputs, the Docs window — fell back to Electron's own default mark in its title bar, its taskbar
// button and Alt-Tab. Nothing fails: it compiles, boots, throws nothing, and simply brands half the
// app as somebody else's, which is invisible until someone looks at a title bar. It is the same
// failure the renderer's AppMark invariant exists to stop, one process over.
//
// `out/renderer/icon.png` is the Vite public asset every HTML entry already uses as its favicon, so
// it is rebuilt on every `npm run build`, is inside `out/**/*` for packaging, and sits at the same
// relative path in dev and packaged alike. All of main is bundled into `out/main/index.js`, so
// `__dirname` is the same for every importer of this module.
//
// ⚠ On Windows a PACKAGED build takes the title-bar icon from the .exe's embedded resource, so this
// is what you see in dev and what a non-Windows build uses. Both need to be the mark, and the
// electron-builder side is configured separately in package.json → build.win.icon.
export const APP_ICON = join(__dirname, '../renderer/icon.png');
