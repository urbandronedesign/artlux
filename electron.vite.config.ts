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
  { find: '@artlux/plugin-calibration/playback', replacement: resolve(__dirname, 'plugins/calibration/src/playback.ts') },
  { find: '@artlux/plugin-calibration/authoring', replacement: resolve(__dirname, 'plugins/calibration/src/authoring.ts') },
  { find: '@artlux/plugin-spout/main', replacement: resolve(__dirname, 'plugins/spout/src/main.ts') },
  { find: '@artlux/plugin-spout/renderer', replacement: resolve(__dirname, 'plugins/spout/src/renderer.ts') },
  { find: '@artlux/plugin-hap/main', replacement: resolve(__dirname, 'plugins/hap/src/main.ts') },
  { find: '@artlux/plugin-hap/renderer', replacement: resolve(__dirname, 'plugins/hap/src/renderer.ts') },
  { find: '@artlux/plugin-mp4', replacement: resolve(__dirname, 'plugins/mp4/src') }, // renderer-only, single barrel
  { find: '@artlux/plugin-mediapipe', replacement: resolve(__dirname, 'plugins/mediapipe/src') }, // renderer-only, single barrel
  { find: '@artlux/plugin-augmenta', replacement: resolve(__dirname, 'plugins/augmenta/src') }, // renderer-only, single barrel
  { find: '@artlux/plugin-text', replacement: resolve(__dirname, 'plugins/text/src') }, // renderer-only, single barrel
  // Shader spans both processes (the effect library is files, and only main has a filesystem).
  { find: '@artlux/plugin-shader/main', replacement: resolve(__dirname, 'plugins/shader/src/main.ts') },
  { find: '@artlux/plugin-shader/renderer', replacement: resolve(__dirname, 'plugins/shader/src/renderer.ts') },
  // Bake spans both processes (the render + muxer in the renderer, the file writer in main).
  { find: '@artlux/plugin-bake/main', replacement: resolve(__dirname, 'plugins/bake/src/main.ts') },
  { find: '@artlux/plugin-bake/renderer', replacement: resolve(__dirname, 'plugins/bake/src/renderer.ts') },
  // Show-control spans both processes (HTTP/SSE server in main + UI in renderer) → explicit subpaths.
  { find: '@artlux/plugin-show-control/main', replacement: resolve(__dirname, 'plugins/show-control/src/main.ts') },
  { find: '@artlux/plugin-show-control/renderer', replacement: resolve(__dirname, 'plugins/show-control/src/renderer.ts') },
  // Audio spans both processes (native JUCE engine in main + settings/driver in renderer) → explicit subpaths.
  { find: '@artlux/plugin-audio/main', replacement: resolve(__dirname, 'plugins/audio/src/main.ts') },
  { find: '@artlux/plugin-audio/renderer', replacement: resolve(__dirname, 'plugins/audio/src/renderer.ts') },
];

// WHICH APP THIS BUILD IS (shared/appIdentity.ts): `ARTLUX_APP=show|calibrator npm run build`, default
// the combined app. Written into every bundle as a literal so a condition on it folds and the other
// app's code is dropped, not merely skipped. An unknown value fails the build rather than shipping a
// third kind of app nobody designed.
const ARTLUX_APP = process.env.ARTLUX_APP ?? 'suite';
if (!['suite', 'show', 'calibrator'].includes(ARTLUX_APP)) {
  throw new Error(`ARTLUX_APP must be suite, show or calibrator — got "${ARTLUX_APP}"`);
}
const define = { __ARTLUX_APP__: JSON.stringify(ARTLUX_APP) };

export default defineConfig({
  main: {
    define,
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
    resolve: {
      alias: [...sdkAliases],
    },
  },
  preload: {
    define,
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
    resolve: {
      alias: [...sdkAliases],
    },
  },
  renderer: {
    define,
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
