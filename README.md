```
      _      ____    _____   _      _   _  __  __
     / \    |  _ \  |_   _| | |    | | | | \ \/ /
    / _ \   | |_) |   | |   | |    | | | |  \  /
   / ___ \  |  _ <    | |   | |___ | |_| |  /  \
  /_/   \_\ |_| \_\   |_|   |_____| \___/  /_/\_\

  GPU-accelerated addressable-LED pixel mapping for Art-Net / sACN
```

# ArtLux

ArtLux is a GPU-accelerated **pixel-mapping tool for addressable RGB/RGBW LEDs**. Sample
colors from video, images, or a live camera, lay out LED fixtures on a 2D stage, and stream
the result to your lighting hardware over **Art-Net / DMX**.

## Features

- **GPU color sampling** — WebGL maps source pixels onto each LED in real time.
- **Interactive stage** — drag, resize, rotate, and snap fixtures on a 2D canvas.
- **Multi-source input** — video files, images, and live camera (`getUserMedia`).
- **RGBW conversion** — automatic white-channel extraction with master brightness.
- **DMX / Art-Net output** — multi-universe with automatic 512-channel spanning.
- **Live DMX monitor** — per-fixture pixel preview of the outgoing data.
- **Undo / redo** and JSON **project save / load**.
- **Dockable panels** — collapsible inspector and scene panels.

## Run locally

**Prerequisites:** [Node.js](https://nodejs.org/)

```bash
npm install
npm run dev
```

Then open the app in your browser (default `http://localhost:3000`).

To build a production bundle:

```bash
npm run build
npm run preview
```

### Art-Net output

Browsers can't send raw UDP, so DMX/Art-Net is forwarded through a small local bridge
(`artlux-bridge.cjs`) that relays packets over UDP to your hardware. Run it alongside the
app:

```bash
node artlux-bridge.cjs
```

> Note: the bridge is being replaced by a native Electron transport — see the roadmap.

## Roadmap

ArtLux is moving to a full **Electron** desktop app with **WebGPU compute**, a **WLED-style
effects/palette/segment engine**, 2D matrix + ledmap support, and a **native Rust output
engine** (Art-Net + sACN/E1.31, per-fixture routing). The complete plan lives in
[docs/ARCHITECTURE_PLAN.md](docs/ARCHITECTURE_PLAN.md).

## Tech stack

React 19 · TypeScript · Vite · Tailwind CSS · WebGL
