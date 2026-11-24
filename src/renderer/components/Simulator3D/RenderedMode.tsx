import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { nodes, isWebGPURenderer } from './renderer3d';

// THE "RENDERED" DISPLAY MODE — a look for LIGHTING SIMULATION, not for judging content (owner,
// 2026-11-24: "a good rendering for lighting simulations; it will not be used for the final show").
//
// Shaded stays exactly what it is: no tone mapping, unlit LEDs and screens at the colour they are sent,
// so an operator can judge whether the picture matches the wall (Simulator3D's `flat`). Rendered trades
// that honesty for atmosphere, Blender-EEVEE style, on three's WebGPU renderer:
//   - a filmic tone curve (AgX), so bright LEDs and beams roll off instead of clipping;
//   - BLOOM — LEDs and beams glow;
//   - GTAO ambient occlusion — corners, trusses and the floor under things darken;
//   - THE RIG LIGHTS THE ROOM: the moving heads' spotlights on even at a scene Light gain of 0, and
//     RENDERED_LIGHT_GAIN brighter; the flat fill (Lighting.tsx) drops to a trace;
//   - an environment light (RoomEnvironment through PMREM) so the venue's PBR materials have
//     something to reflect;
//   - SHADOWS from the moving-head spotlights (MoverLights), cast by the venue and the fixture bodies;
//   - A STAGE FLOOR: a dark, slightly glossy plane just under the grid. The grid is lines, and a rig
//     with no venue model (the lighting examples) had nothing to catch a beam — no pool of light, no
//     shadow, which is most of what a lighting simulation is for.
//
// SPIKE (plans/3d-workbench.md → Rendered mode): one view only — the four-view renderer draws its own
// passes — and WebGPU only (the WebGL fallback keeps Shaded's look). Everything it changes on the
// renderer, the scene and the lights it puts back on the way out, so leaving the mode is exactly Shaded.
// Its parameters are what E4's native engine would implement; the three.js wiring is what E4 deletes.

/** How much brighter the moving heads' spotlights are in Rendered than in Shaded. Shaded's are a
 *  hint on the venue under flat fill light; here they are the only real light in a dark room. */
export const RENDERED_LIGHT_GAIN = 6;

type Saved = {
  toneMapping: THREE.ToneMapping; exposure: number;
  shadows: boolean; shadowType: THREE.ShadowMapType;
  env: THREE.Texture | null; envIntensity: number;
  casts: Map<THREE.Object3D, [boolean, boolean]>;
};

export const RenderedMode: React.FC<{ quality: 'high' | 'low' }> = ({ quality }) => {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const pipeRef = useRef<{ render(): void; dispose?(): void } | null>(null);
  const saved = useRef<Saved | null>(null);

  // ── Renderer, environment, shadows: on while mounted, restored on unmount ─────────────────────
  useEffect(() => {
    if (!isWebGPURenderer(gl) || !nodes()) return;
    const r = gl as unknown as THREE.WebGLRenderer;   // the fields used here exist on both renderers
    const s: Saved = {
      toneMapping: r.toneMapping, exposure: r.toneMappingExposure,
      shadows: r.shadowMap.enabled, shadowType: r.shadowMap.type,
      env: scene.environment, envIntensity: scene.environmentIntensity,
      casts: new Map(),
    };
    saved.current = s;
    r.toneMapping = THREE.AgXToneMapping;
    r.toneMappingExposure = 1.1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;

    let disposed = false;
    let envTex: THREE.Texture | null = null;
    void (async () => {
      const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');
      const { PMREMGenerator } = nodes()!.webgpu;
      if (disposed) return;
      const pm = new PMREMGenerator(gl as never);
      envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      pm.dispose();
      if (disposed) { envTex.dispose(); return; }
      scene.environment = envTex;
      scene.environmentIntensity = 0.08;   // a trace: enough for PBR materials to read, not enough to light the floor (0.35 turned it flat grey at a grazing angle)
    })();

    return () => {
      disposed = true;
      r.toneMapping = s.toneMapping; r.toneMappingExposure = s.exposure;
      r.shadowMap.enabled = s.shadows; r.shadowMap.type = s.shadowType;
      if (scene.environment === envTex) { scene.environment = s.env; scene.environmentIntensity = s.envIntensity; }
      envTex?.dispose();
      for (const [o, [c, rcv]] of s.casts) { o.castShadow = c; o.receiveShadow = rcv; }
      scene.traverse((o) => { const l = o as THREE.SpotLight; if (l.isSpotLight) l.castShadow = false; });
      saved.current = null;
    };
  }, [gl, scene]);

  // ── The post chain: scene (colour + normals) → AO → bloom. Rebuilt when the camera changes ──────
  useEffect(() => {
    if (!isWebGPURenderer(gl) || !nodes()) return;
    let cancelled = false;
    void (async () => {
      const [{ bloom }, { ao }, { smaa }] = await Promise.all([
        import('three/examples/jsm/tsl/display/BloomNode.js'),
        import('three/examples/jsm/tsl/display/GTAONode.js'),
        import('three/examples/jsm/tsl/display/SMAANode.js'),
      ]);
      if (cancelled) return;
      const { RenderPipeline } = nodes()!.webgpu;
      const { pass, vec3, vec4, renderOutput } = nodes()!.tsl;
      const pipe = new RenderPipeline(gl as never);
      // NO MSAA on the scene pass: depth-reconstructed AO cannot read a multisampled depth texture
      // (measured: the GTAO shader failed to compile — textureDimensions on texture_depth_multisampled_2d).
      // Anti-aliasing is SMAA at the end instead, after the tone curve, which is where it belongs.
      const scenePass = pass(scene, camera, { samples: 0 });
      const color = scenePass.getTextureNode('output');
      let lit = color as unknown as ReturnType<typeof vec4>;
      if (quality === 'high') {
        // NORMALS FROM DEPTH, not a normal MRT: the grid's lines (and the beam diagrams) are transparent
        // and write no depth, but they DID write their garbage normals into an MRT target, and the AO
        // read them as creases — measured as black speckles along every grid line. Depth-only is also
        // one render target less.
        const aoPass = ao(scenePass.getTextureNode('depth'), null, camera);
        aoPass.resolutionScale = 0.5;   // half-res AO: most of the look for a quarter of the cost
        lit = color.mul(vec4(vec3(aoPass.getTextureNode().r), 1)) as never;
      }
      // Bloom on the HDR colour: strength, radius, threshold. LEDs and beams sit near or above 1.
      const glow = bloom(lit as never, 0.8, 0.4, 0.6);
      pipe.outputColorTransform = false;   // the tone curve + sRGB happen in renderOutput, BEFORE the AA
      pipe.outputNode = smaa(renderOutput(lit.add(glow) as never)) as never;
      pipeRef.current = pipe as never;
    })();
    return () => { cancelled = true; pipeRef.current?.dispose?.(); pipeRef.current = null; };
  }, [gl, scene, camera, quality]);

  // ── Shadows: the moving heads' spotlights cast, the venue and fixture bodies cast and receive ───
  // Re-applied every half second, cheaply: models load late and the spot count changes with the rig.
  const tick = useRef(0);
  useFrame((_, dt) => {
    tick.current -= dt;
    if (tick.current > 0 || !saved.current) return;
    tick.current = 0.5;
    const casts = saved.current.casts;
    scene.traverse((o) => {
      const l = o as THREE.SpotLight;
      if (l.isSpotLight) {
        if (!l.castShadow) {
          l.castShadow = true;
          l.shadow.mapSize.set(quality === 'high' ? 1024 : 512, quality === 'high' ? 1024 : 512);
          l.shadow.bias = -0.0005;
          l.shadow.normalBias = 0.02;
        }
        return;
      }
      const m = o as THREE.Mesh;
      if (!m.isMesh || casts.has(m) || m.userData.renderedFloor) return;
      // Lit geometry only: unlit (Basic) materials — LEDs, screens' content, beams — neither need nor
      // take shadows, and beams casting would black out the very cones they draw.
      const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material & { isMeshBasicMaterial?: boolean; transparent: boolean };
      if (!mat || mat.isMeshBasicMaterial || mat.transparent) return;
      casts.set(m, [m.castShadow, m.receiveShadow]);
      m.castShadow = true;
      m.receiveShadow = true;
    });
  });

  const floor = React.useMemo(() => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: '#1c1c1c', roughness: 0.8, metalness: 0 }),   // a matte stage floor
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = -0.003;          // under the grid (1 mm) and the beam boundary (0)
    m.receiveShadow = true;
    m.raycast = () => {};           // never a pick, never a snap — it is atmosphere
    m.userData.renderedFloor = true;
    return m;
  }, []);
  useEffect(() => () => { floor.geometry.dispose(); (floor.material as THREE.Material).dispose(); }, [floor]);

  // Draw through the chain instead of r3f's plain render (priority 1 hands r3f's render to us).
  useFrame(() => {
    const p = pipeRef.current;
    if (p) p.render(); else gl.render(scene, camera);
  }, 1);

  return <primitive object={floor} />;
};
