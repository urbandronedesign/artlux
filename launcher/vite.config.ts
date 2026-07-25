import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite serves the launcher's web UI; Tauri wraps it. Port fixed at 5173 because
// src-tauri/tauri.conf.json's devUrl names it literally — a "port already in use, using 5174"
// fallback would leave the Tauri window pointed at nothing, so fail instead of drifting.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
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
