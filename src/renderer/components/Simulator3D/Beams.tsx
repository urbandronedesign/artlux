import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { nodes, isWebGPURenderer } from './renderer3d';
import { Fixture, FixtureProfile } from '../../types';
import { effectivePos, effectiveRot, meanScale } from '../../services/led3dLayout';
import * as fixtureSignal from '../../services/fixtureSignal';
import { rigMetrics, halfAngle } from '../../services/profileRig';
import { isResolvedLight } from '../../services/fixtureKind';

// The BEAMS — what turns a rig of dark housings into something you can read as a show.
//
// TIER 1 of the three-tier budget (see docs/FIXTURE-LIBRARY.md and the plan): ONE InstancedMesh of
// additive cones covering every lit fixture, so two hundred beams cost ONE draw call. Real
// illumination (spotlights that actually light geometry) is tier 2 and stays hard-capped, because
// WebGL forward-renders every light per fragment — the same reason FixtureLights caps at 12.
//
// This is not a light. It is the VOLUME the light passes through: additive, depth-write off, soft at
// the edges, fading with distance. That is what haze in a room actually looks like, and it is why the
// cone's opacity scales with `Scene3D.hazeDensity` — a venue with no haze shows a pool on the floor
// and no beam, and the 3D view should be able to tell you that honestly.

// A unit cone with its APEX AT THE ORIGIN opening along -Z, matching the head barrel's aim axis.
// ConeGeometry puts the apex at +Y and centres it, so: translate the apex to the origin, then rotate
// +90° about X to send the base to -Z. Open-ended — a capped cone shows a bright disc floating in
// mid-air where the beam is supposed to fade out.
const UNIT_CONE = new THREE.ConeGeometry(1, 1, 28, 1, true)
  .translate(0, -0.5, 0)
  .rotateX(Math.PI / 2);

// How far a beam is drawn, in metres.
//
// Screen coverage — and therefore cost — grows with the SQUARE of this, and the shader's (1-t)²
// falloff has already taken a beam down to ~9% brightness by three-quarters of its length. So the
// last third of a long cone is thousands of shaded pixels contributing almost nothing visible.
// Shortening it from 12 m to 8 m is close to invisible and removes over half the fill.
const BEAM_LENGTH = 8;

// HOW MANY BEAMS ARE ACTUALLY DRAWN — and this is the real budget, which is NOT the draw count.
//
// One InstancedMesh means 200 beams cost one draw call, and that framing is a trap: draw calls were
// never the limit. Each beam is a 12-metre cone several metres across, drawn additively with depth
// writes off, so it shades every pixel it covers and they all overlap. The limit is FILL RATE.
//
// Measured at 1440×900, camera INSIDE the rig (the worst case — every cone covers the viewport):
//   · 200 movers, dark: no cones, no spots  ......  49 fps
//   · 200 movers, every beam drawn ...............  10 fps
//   · 200 movers, capped to 64, 12 m beams .......  18 fps
//   · 200 movers, capped to 48, 8 m beams ........  27 fps   ← current settings
//   ·  48 movers, all beaming ....................  37 fps
//   ·  24 movers, all beaming ....................  54 fps
// Same ONE draw call in every case. The cost was overdraw, nothing else.
//
// So the beams get the same treatment as the spotlights: a hard cap, spent on the brightest, which
// are the ones an audience reads. A rig larger than this still runs; its dimmest beams are simply
// not drawn, which is far better than a viewport that cannot be navigated. Anyone tuning this should
// re-measure rather than reason about it — the intuition that "one draw call means it is cheap" is
// exactly the mistake these numbers exist to correct.
const MAX_BEAMS = 48;

// THE CONE IS A HOLLOW SHELL, and that governs how brightness is computed.
//
// The obvious approach — fade out as you approach the cone's radius — does not work, because every
// fragment of an open cone lies exactly ON that radius. The first version of this shader did that
// and discarded every pixel: no beams at all, no error, nothing in the console.
//
// What a beam actually looks like is a chord-length problem. Looking through a cone of haze, you
// see the most light where your line of sight passes through the most of it — down the middle — and
// none at the silhouette, where the sight line only grazes the surface. For a shell, the length of
// that chord is well approximated by how directly the surface faces the camera: |n · v| is ~1 in
// the middle of the visible shell and ~0 at the silhouette. That single term is the beam.
const VERT = /* glsl */`
  varying vec3 vLocal;
  varying vec3 vTint;
  varying vec3 vNormalV;
  varying vec3 vPosV;
  void main() {
    vLocal = position;
    #ifdef USE_INSTANCING_COLOR
      vTint = instanceColor;
    #else
      vTint = vec3(1.0);
    #endif

    // USE_INSTANCING is defined for us on an InstancedMesh, but a ShaderMaterial must apply the
    // instance matrix itself — the built-in materials do it in a shader chunk we are not using.
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vPosV = mv.xyz;

    // The instance scale is deliberately NON-UNIFORM (a thin cone is short in x/y and long in z), so
    // a normal pushed through the raw matrix comes out skewed and the bright core drifts off the
    // axis. Recover the scale from the matrix columns and apply the inverse-scale first — the
    // inverse-transpose, done by hand, because three's normalMatrix knows nothing about instances.
    vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    mat3 rot = mat3(instanceMatrix[0].xyz / sc.x, instanceMatrix[1].xyz / sc.y, instanceMatrix[2].xyz / sc.z);
    vNormalV = normalize(mat3(modelViewMatrix) * (rot * (normal / sc)));

    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  varying vec3 vLocal;
  varying vec3 vTint;
  varying vec3 vNormalV;
  varying vec3 vPosV;
  uniform float uHaze;
  void main() {
    // Local space: apex at the origin, the cone opening to z = -1. "t" is the fraction of the way
    // down the beam. (No backticks in this comment — it lives in a template literal.)
    float t = clamp(-vLocal.z, 0.0, 1.0);

    // Chord length through the haze, approximated by how squarely the shell faces the eye. abs()
    // because the cone is drawn double-sided and back faces arrive with flipped normals.
    float facing = abs(dot(normalize(vNormalV), normalize(-vPosV)));

    // Falloff along the beam, plus a short throat so the apex does not read as a hard bright dot.
    float fall = (1.0 - t) * (1.0 - t);
    float throat = smoothstep(0.0, 0.05, t);

    float a = facing * fall * throat * uHaze;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(vTint * a, a);
  }
`;

interface Props {
  fixtures: Fixture[];
  profiles: ReadonlyMap<string, FixtureProfile>;
  /** 0..1 room haze. Absent ⇒ a modest default that reads without drowning the scene. */
  hazeDensity?: number;
}

const DEG = Math.PI / 180;

export const Beams: React.FC<Props> = ({ fixtures, profiles, hazeDensity }) => {
  const movers = useMemo(
    () => fixtures.filter((f) => isResolvedLight(f, profiles)),
    [fixtures, profiles],
  );
  const count = movers.length;
  const meshRef = useRef<THREE.InstancedMesh | null>(null);

  // ONE LOOK, TWO SHADING LANGUAGES. The GLSL above is the definition; the node build below is the
  // same maths for the WebGPU renderer, which rejects a raw ShaderMaterial outright ("NodeBuilder:
  // Material ShaderMaterial is not compatible") and drew no beams at all. Read the comments above
  // VERT/FRAG for WHY any of it is shaped this way — this branch repeats none of that reasoning, so
  // there is one place to change a decision.
  // The RENDERER decides, not module availability — the same trap that blacked out the projector
  // window's output once the TSL modules started preloading. See makeProjectedMaterial.
  const useNodes = isWebGPURenderer(useThree((st) => st.gl));
  const { material, setHaze } = useMemo(() => {
    const mods = useNodes ? nodes() : null;
    if (!mods) {
      const m = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { uHaze: { value: 0.35 } },
        transparent: true,
        blending: THREE.AdditiveBlending,
        // Beams must not occlude one another or the geometry behind them — they are volume, not surface.
        depthWrite: false,
        // …but they DO respect depth, so a beam passing behind a truss is correctly hidden by it.
        depthTest: true,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      return { material: m as THREE.Material, setHaze: (v: number) => { m.uniforms.uHaze.value = v; } };
    }

    const { MeshBasicNodeMaterial } = mods.webgpu;
    const { uniform, float, vec3, positionLocal, positionView, normalView, normalize, abs, dot, clamp, smoothstep, Discard, attribute } = mods.tsl;
    const uHaze = uniform(0.35);
    const m = new MeshBasicNodeMaterial();
    m.transparent = true;
    m.blending = THREE.AdditiveBlending;
    m.depthWrite = false;
    m.depthTest = true;
    m.side = THREE.DoubleSide;
    m.toneMapped = false;

    // The node path needs no hand-written instancing: three applies instanceMatrix itself, and
    // `normalView` is already the correctly un-skewed normal — which is precisely the fiddly part the
    // GLSL has to do by hand (see the inverse-scale comment in VERT).
    const t = clamp(positionLocal.z.negate(), float(0), float(1));
    const facing = abs(dot(normalize(normalView), normalize(positionView.negate())));
    const fall = float(1).sub(t).mul(float(1).sub(t));
    const throat = smoothstep(float(0), float(0.05), t);
    const a = facing.mul(fall).mul(throat).mul(uHaze);
    Discard(a.lessThanEqual(float(0.002)));

    // Per-instance tint read straight off the `instanceColor` attribute that setColorAt writes below —
    // the node equivalent of the GLSL's USE_INSTANCING_COLOR branch. The seeding effect further down
    // is what makes the attribute exist at all; without it this reads garbage rather than white.
    // `attribute()` is typed as AttributeNode<string> whatever type string you pass, so the vec3 ops
    // are not visible on it. One cast here rather than loosening every operator downstream.
    const tint = vec3(attribute('instanceColor', 'vec3') as never);
    m.colorNode = tint.mul(a);
    m.opacityNode = a;
    return { material: m as THREE.Material, setHaze: (v: number) => { uHaze.value = v; } };
  }, []);

  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => { setHaze(hazeDensity ?? 0.35); }, [setHaze, hazeDensity]);

  // Seed instanceColor so three defines USE_INSTANCING_COLOR — without a first setColorAt the
  // attribute does not exist and the shader's tint branch silently compiles to white.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || !count) return;
    const c = new THREE.Color(0, 0, 0);
    for (let i = 0; i < count; i++) mesh.setColorAt(i, c);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [count]);

  // Reused per-frame ranking scratch — see MAX_BEAMS.
  const ranked = useRef<number[]>([]);
  const draw = useRef<Set<number>>(new Set());
  const scratch = useMemo(() => ({
    m: new THREE.Matrix4(), q: new THREE.Quaternion(), qp: new THREE.Quaternion(), qt: new THREE.Quaternion(),
    p: new THREE.Vector3(), s: new THREE.Vector3(), off: new THREE.Vector3(), col: new THREE.Color(),
    aim: new THREE.Quaternion(),
    up: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(1, 0, 0),
  }), []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh || !count) return;
    const states = fixtureSignal.snapshot();
    const { m, q, qp, qt, p, s, off, col, up, right, aim } = scratch;

    // Rank the lit fixtures and keep only the brightest MAX_BEAMS — the fill-rate budget above.
    // Reused arrays: this runs every frame.
    const order = ranked.current;
    order.length = 0;
    for (let i = 0; i < count; i++) {
      const st = states.get(movers[i].id);
      if (st && !st.blackout && st.intensity > 0.001) order.push(i);
    }
    order.sort((a, b) => (states.get(movers[b].id)!.intensity - states.get(movers[a].id)!.intensity));
    const drawn = draw.current;
    drawn.clear();
    for (let k = 0; k < Math.min(order.length, MAX_BEAMS); k++) drawn.add(order[k]);

    for (let i = 0; i < count; i++) {
      const f = movers[i];
      const profile = profiles.get(f.profileId!)!;
      const st = states.get(f.id);
      // ONE number, not three: a beam is a cone whose apex sits at the lens, and there is no honest
      // reading of "stretched twice as wide on X" for the light it throws. The mean equals the old
      // uniform scale for any fixture nobody has stretched. See meanScale.
      const scale = meanScale(f);

      // A dark (or budgeted-out) fixture is collapsed to zero size rather than skipped: the instance
      // count is fixed, so there is no "skip" — leaving a stale matrix would freeze a beam in mid-air
      // after its fixture went out.
      if (!drawn.has(i)) {
        m.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, m);
        continue;
      }

      const rm = rigMetrics(profile);
      q.setFromEuler(effectiveRot(f));
      qp.setFromAxisAngle(up, (st!.pan - rm.panMid) * DEG);
      qt.setFromAxisAngle(right, (st!.tilt - rm.tiltMid) * DEG);
      // Composed in place: `q.clone()` here allocated a quaternion per fixture per frame.
      aim.copy(q).multiply(qp).multiply(qt);

      // The beam leaves the LENS, not the fixture's origin — so it swings with the head instead of
      // pivoting out of the middle of the base. Matches MoverBodies' head pivot.
      off.set(rm.lens.x * scale, rm.lens.y * scale, rm.lens.z * scale).applyQuaternion(q);
      p.copy(effectivePos(f)).add(off);

      // Cone half-angle: the fixture's own lens, widened by a zoom channel when it has one.
      const half = halfAngle(rm, st!.zoomDeg);
      const radius = BEAM_LENGTH * Math.tan(half * DEG);
      s.set(radius, radius, BEAM_LENGTH);

      m.compose(p, aim, s);
      mesh.setMatrixAt(i, m);

      // Brightness rides the colour, because an additive shader has no separate opacity per instance.
      col.setRGB(st!.r * st!.intensity, st!.g * st!.intensity, st!.b * st!.intensity);
      mesh.setColorAt(i, col);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Kept even though this mesh is neither pickable nor frustum-culled, so on paper the sphere it
    // maintains feeds nothing. Two reasons it stays: `verify:invariants` requires every writer of
    // instance matrices to refresh it (the rule encodes a shipped bug where a moved InstancedMesh
    // silently stopped being clickable), and the measurements above show this loop is not where the
    // time goes — the beams are fill-rate bound, and an argument from "this looks like dead work"
    // is exactly the reasoning that already cost one wasted optimisation pass today.
    mesh.computeBoundingSphere();
  });

  if (!count) return null;

  return (
    <instancedMesh
      key={count}
      ref={meshRef}
      args={[undefined as unknown as THREE.BufferGeometry, undefined as unknown as THREE.Material, count]}
      geometry={UNIT_CONE}
      material={material}
      frustumCulled={false}
      // Drawn after the opaque scene so the additive blend lands on top of what it should light.
      renderOrder={10}
    />
  );
};

