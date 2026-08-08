import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// In-tree workspace packages are statically imported by the host and BUNDLED into each target
// (no externalizeDepsPlugin in this config — see src/main/transport/oscManager.ts). The `@artlux/sdk`
// subpaths are aliased to source so there is no separate build step. Order matters: the more
// specific subpath aliases must precede the bare one.
const sdkAliases = [
  { find: '@artlux/sdk/main', replacement: resolve(__dirname, 'packages/sdk/src/main.ts') },
  { find: '@artlux/sdk/renderer', replacement: resolve(__dirname, 'packages/sdk/src/renderer.ts') },
  { find: '@artlux/sdk', replacement: resolve(__dirname, 'packages/sdk/src/index.ts') },
  // First-party plugins are bundled in-process. Deep subpath imports (…/trackingStore) resolve under
  // the package's src/ so each window only bundles the modules it uses.
  { find: '@artlux/plugin-lidar-tracking', replacement: resolve(__dirname, 'plugins/lidar-tracking/src') },
  // NDI spans both processes → explicit main/renderer subpath entries (like @artlux/sdk).
  { find: '@artlux/plugin-ndi/main', replacement: resolve(__dirname, 'plugins/ndi/src/main.ts') },
  { find: '@artlux/plugin-ndi/renderer', replacement: resolve(__dirname, 'plugins/ndi/src/renderer.ts') },
  { find: '@artlux/plugin-calibration/main', replacement: resolve(__dirname, 'plugins/calibration/src/main.ts') },
  { find: '@artlux/plugin-calibration/renderer', replacement: resolve(__dirname, 'plugins/calibration/src/renderer.ts') },
  { find: '@artlux/plugin-spout/main', replacement: resolve(__dirname, 'plugins/spout/src/main.ts') },
  { find: '@artlux/plugin-spout/renderer', replacement: resolve(__dirname, 'plugins/spout/src/renderer.ts') },
  // Syphon is Spout's macOS sibling — same cross-process shape, so the same explicit subpaths.
  { find: '@artlux/plugin-syphon/main', replacement: resolve(__dirname, 'plugins/syphon/src/main.ts') },
  { find: '@artlux/plugin-syphon/renderer', replacement: resolve(__dirname, 'plugins/syphon/src/renderer.ts') },
  { find: '@artlux/plugin-hap/main', replacement: resolve(__dirname, 'plugins/hap/src/main.ts') },
  { find: '@artlux/plugin-hap/renderer', replacement: resolve(__dirname, 'plugins/hap/src/renderer.ts') },
  { find: '@artlux/plugin-mp4', replacement: resolve(__dirname, 'plugins/mp4/src') }, // renderer-only, single barrel
  { find: '@artlux/plugin-mediapipe', replacement: resolve(__dirname, 'plugins/mediapipe/src') }, // renderer-only, single barrel
  { find: '@artlux/plugin-augmenta', replacement: resolve(__dirname, 'plugins/augmenta/src') }, // renderer-only, single barrel
  // Show-control spans both processes (HTTP/SSE server in main + UI in renderer) → explicit subpaths.
  { find: '@artlux/plugin-show-control/main', replacement: resolve(__dirname, 'plugins/show-control/src/main.ts') },
  { find: '@artlux/plugin-show-control/renderer', replacement: resolve(__dirname, 'plugins/show-control/src/renderer.ts') },
  // Audio spans both processes (native JUCE engine in main + settings/driver in renderer) → explicit subpaths.
  { find: '@artlux/plugin-audio/main', replacement: resolve(__dirname, 'plugins/audio/src/main.ts') },
  { find: '@artlux/plugin-audio/renderer', replacement: resolve(__dirname, 'plugins/audio/src/renderer.ts') },
];

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
    resolve: {
      alias: [...sdkAliases],
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
    resolve: {
      alias: [...sdkAliases],
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          projector: resolve(__dirname, 'src/renderer/projector.html'),
          docs: resolve(__dirname, 'src/renderer/docs.html'),
          splash: resolve(__dirname, 'src/renderer/splash.html'),
        },
      },
    },
    plugins: [react()],
    resolve: {
      alias: [
        { find: '@', replacement: resolve(__dirname, 'src/renderer') },
        ...sdkAliases,
      ],
    },
    server: { port: 3000 },
  },
});
