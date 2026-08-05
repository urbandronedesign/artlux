import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite serves the launcher's web UI; Tauri wraps it. Port fixed at 5173 because
// src-tauri/tauri.conf.json's devUrl names it literally — a "port already in use, using 5174"
// fallback would leave the Tauri window pointed at nothing, so fail instead of drifting.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // DO NOT WATCH THE RUST BUILD TREE. `tauri dev` starts this server as its beforeDevCommand and
    // *then* runs cargo in the same folder, so chokidar walks into src-tauri/target and opens a
    // watch on the launcher binary while the linker is still writing it. Windows answers EBUSY,
    // chokidar re-emits that as an unhandled 'error' on the FSWatcher, Vite dies — and Tauri then
    // aborts with "The beforeDevCommand terminated with a non-zero status code", which names the
    // wrong culprit entirely. It only bites on a run that actually links, i.e. the first `npm start`
    // after any Rust edit, which is exactly when you need it to work.
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext' },
  // POSTCSS OFF, EXPLICITLY. Vite searches UPWARD for a postcss config and finds the APP's
  // postcss.config.js at the repo root, which requires tailwindcss — a dependency of the app's
  // node_modules, not the launcher's. Locally that resolves, because the root tree exists from
  // working on the app; in CI only `launcher/` gets `npm ci`, so the build died with
  // "Cannot find module 'tailwindcss'" on a config file this product does not own.
  //
  // The launcher styles itself with plain CSS over copied tokens (src/tokens.css) and wants no
  // PostCSS at all. An inline config stops the upward search dead.
  css: { postcss: { plugins: [] } },
});
