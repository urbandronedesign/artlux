import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { nodes, isWebGPURenderer } from './renderer3d';
import { Fixture, FixtureProfile } from '../../types';
import { effectivePos, effectiveRot, meanScale } from '../../services/led3dLayout';
import * as fixtureSignal from '../../services/fixtureSignal';
import { mountShift, rigMetrics, halfAngle } from '../../services/profileRig';
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

// ── THE CONE, AS A DIAGRAM ──────────────────────────────────────────────────────────────────────
//
// The volumetric shell above is what a beam LOOKS like; it is not what tells you where a head is
// aimed. It is faint by design (it is haze), it fades out long before the beam lands, and on a rig
// of any size the overlapping cones read as one soft wash. Aiming a light needs the other thing —
// the drawing every fixture datasheet prints: an apex at the lens, the BEAM ANGLE, the OPTICAL AXIS,
// and the ILLUMINATION BOUNDARY where the cone meets a surface.
//
// It is drawn as LINES, and that is the whole performance story. The shell is fill-rate bound (see
// MAX_BEAMS); an outline covers a few hundred pixels whatever the throw, so every lit fixture can
// have one with no budget at all — no cap, no ranking. One LineSegments, one draw call, a
// LineBasicMaterial that renders on BOTH backends (three's node renderer rejects the fat-line
// LineMaterial outright — the same trap that made every projector frustum vanish on WebGPU).
//
// THE BOUNDARY IS COMPUTED PER RAY, so it is an ellipse when the beam hits the floor at an angle and
// a circle when it points straight down — for free, and correctly, because each ray is intersected
// with the floor on its own rather than a circle being drawn at the throw distance and skewed.
const RING = 32;              // segments around the illumination boundary
const RAYS = 8;               // cone edges drawn from the apex, evenly spaced around the ring
const SEG_PER_FIXTURE = RING + RAYS + 1;   // + the optical axis
// THE AXIS SETS THE LENGTH, AND EVERY RAY IS MEASURED AGAINST IT.
//
// A ray that grazes the floor meets it at infinity, so the raw intersection is useless on its own: a
// head at tilt 0° threw its lower rim 25 m across the venue while its upper rim stopped at the
// nominal throw, and the "cone" became a pair of lines disappearing to the horizon. So the OPTICAL
// AXIS is resolved first — where the beam actually lands, or the nominal throw when it never does —
// and each rim ray is then allowed to run past it by at most FLARE. That is what keeps the boundary
// a true ellipse on a tilted beam (the far rim IS farther) while keeping the whole figure bounded,
// and it makes a beam aimed at nothing draw a clean cone in the air instead of nothing at all.
const MAX_THROW = 25;
const FLARE = 2;

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
// THE PER-BEAM TINT TRAVELS IN OUR OWN INSTANCED ATTRIBUTE, not in three's `instanceColor`.
//
// It used to use `instanceColor` + `setColorAt`, which is the natural WebGL idiom and is read on the
// node path as `attribute('instanceColor')` — and that reads NOTHING on a WebGPURenderer. three does
// not expose instanceColor as a plain geometry attribute there: `InstanceNode` wraps it into an
// `instancedDynamicBufferAttribute` and hands it to the material as `instanceColorNode`. So every
// beam's colour resolved to 0, and 0 through an ADDITIVE blend is exactly nothing. The beams had been
// invisible on the renderer the 3D scene defaults to since it moved to WebGPU — silently, because a
// material that draws black and a material that does not draw look identical.
//
// One buffer we own, named by us, read the same way in both languages, ends the whole question.
const TINT = 'aTint';

const VERT = /* glsl */`
  attribute vec3 aTint;
  varying vec3 vLocal;
  varying vec3 vTint;
  varying vec3 vNormalV;
  varying vec3 vPosV;
  void main() {
    vLocal = position;
    vTint = aTint;

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
  /**
   * THE FIXTURES BEING AIMED. They get the whole diagram — edge rays and the optical axis on top of
   * the boundary — because that is the one whose numbers you are reading off the channel strip while
   * you drag. Every other lit fixture keeps just its boundary, which is what stops a forty-head rig
   * from becoming a ball of wool.
   */
  selectedIds?: readonly string[];
  /** Draw the cone diagram at all. Absent ⇒ on. */
  cones?: boolean;
}

const DEG = Math.PI / 180;

export const Beams: React.FC<Props> = ({ fixtures, profiles, hazeDensity, selectedIds, cones = true }) => {
  const movers = useMemo(
    () => fixtures.filter((f) => isResolvedLight(f, profiles)),
    [fixtures, profiles],
  );
  const count = movers.length;
  const meshRef = useRef<THREE.InstancedMesh | null>(null);

  // The geometry is cloned per instance count because the tint buffer lives ON it, sized to match.
  // A shared module-level cone cannot carry a per-mount attribute, and the count changes only when
  // the rig does.
  const { geometry, tintAttr } = useMemo(() => {
    const g = UNIT_CONE.clone();
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 3), 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(TINT, attr);
    return { geometry: g, tintAttr: attr };
  }, [count]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // The outline's own buffers. Rebuilt only when the rig changes size; written in place every frame.
  const { lineGeo, linePos, lineCol } = useMemo(() => {
    const verts = Math.max(1, count) * SEG_PER_FIXTURE * 2;
    const pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    const col = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    col.setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', pos);
    g.setAttribute('color', col);
    return { lineGeo: g, linePos: pos, lineCol: col };
  }, [count]);
  useEffect(() => () => lineGeo.dispose(), [lineGeo]);

  // How many outline segments the previous frame wrote, so this one clears only what it vacated.
  const usedSegs = useRef(0);

  // Selection as a Set, so the per-frame loop is a lookup rather than an indexOf per fixture.
  const selected = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);

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
    const { uniform, float, vec3, positionLocal, positionView, normalView, normalize, abs, dot, clamp, smoothstep, Discard, instancedDynamicBufferAttribute } = mods.tsl;
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

    // The same buffer the GLSL reads as `aTint`. `instancedDynamicBufferAttribute` is the node three
    // itself uses for a per-instance colour that changes every frame, and it is the piece a plain
    // `attribute()` was missing: it declares the instance step mode, without which the value is not
    // per-instance at all. Typed as a generic buffer node, so one cast rather than loosening every
    // operator downstream.
    const tint = vec3(instancedDynamicBufferAttribute(tintAttr, 'vec3', 3, 0) as never);
    m.colorNode = tint.mul(a);
    m.opacityNode = a;
    return { material: m as THREE.Material, setHaze: (v: number) => { uHaze.value = v; } };
    // Rebuilt when the tint buffer is replaced: the node path BAKES that attribute into the shader,
    // so a material left pointing at the previous buffer would tint from a stale array.
  }, [useNodes, tintAttr]);

  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => { setHaze(hazeDensity ?? 0.35); }, [setHaze, hazeDensity]);

  // Reused per-frame ranking scratch — see MAX_BEAMS.
  const ranked = useRef<number[]>([]);
  const draw = useRef<Set<number>>(new Set());
  const scratch = useMemo(() => ({
    m: new THREE.Matrix4(), q: new THREE.Quaternion(), qp: new THREE.Quaternion(), qt: new THREE.Quaternion(),
    p: new THREE.Vector3(), s: new THREE.Vector3(), off: new THREE.Vector3(),
    aim: new THREE.Quaternion(),
    up: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(1, 0, 0),
    dir: new THREE.Vector3(), hit: new THREE.Vector3(),
    // Ring points in world space, reused: RING × (x,y,z).
    ring: new Float32Array(RING * 3),
  }), []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh || !count) return;
    const states = fixtureSignal.snapshot();
    const { m, q, qp, qt, p, s, off, up, right, aim, dir, hit, ring } = scratch;
    const tints = tintAttr.array as Float32Array;
    const lp = linePos.array as Float32Array;
    const lc = lineCol.array as Float32Array;
    // One cursor into the line buffers; everything past it is collapsed to a point at the end, so a
    // fixture that goes dark leaves no stranded segment behind.
    let seg = 0;
    const put = (ax: number, ay: number, az: number, bx: number, by: number, bz: number,
                 r: number, g2: number, b: number) => {
      const o = seg * 6;
      lp[o] = ax; lp[o + 1] = ay; lp[o + 2] = az;
      lp[o + 3] = bx; lp[o + 4] = by; lp[o + 5] = bz;
      lc[o] = r; lc[o + 1] = g2; lc[o + 2] = b;
      lc[o + 3] = r; lc[o + 4] = g2; lc[o + 5] = b;
      seg++;
    };

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

      // A fixture that is OUT contributes nothing to either representation. The shell still needs its
      // matrix collapsed — the instance count is fixed, so there is no "skip", and a stale matrix
      // would freeze a beam in mid-air after its fixture went dark.
      const lit = !!st && !st.blackout && st.intensity > 0.001;
      if (!lit) {
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
      // …and the same mounting lift the body gets, or the beam leaves from where the head is not.
      p.copy(effectivePos(f)).add(off);
      p.y += mountShift(f.mount, rm, scale);

      // THE BEAM ANGLE — the fixture's own lens, widened live by its zoom channel. Everything the
      // diagram draws comes off this one number and the aim above, so dragging Zoom, Pan or Tilt on
      // the channel strip opens and swings the cone as you drag: the live layer feeds fixtureSignal,
      // and fixtureSignal is what this reads.
      const half = halfAngle(rm, st!.zoomDeg);
      const tanH = Math.tan(half * DEG);

      // ── THE DIAGRAM ─────────────────────────────────────────────────────────────────────────
      if (cones) {
        const isSel = selected.has(f.id);
        // Bright for what you are aiming, dim for the rest of the rig — a readable hierarchy rather
        // than forty equally-loud outlines. A dim head still draws a visible line: this is a diagram,
        // not a photometric render, so the colour is the fixture's HUE at a legible floor.
        const k = isSel ? 1 : 0.42;
        const peak = Math.max(st!.r, st!.g, st!.b, 0.001);
        const cr = (st!.r / peak) * k, cg = (st!.g / peak) * k, cb = (st!.b / peak) * k;

        // How far `dir` travels before it meets the floor (y = 0), bounded by `limit`. A ray aimed up,
        // or grazing, never meets it and simply runs to the limit.
        const reach = (limit: number): number => {
          if (dir.y < -1e-4 && p.y > 0) {
            const t = p.y / -dir.y;
            if (t > 0) return Math.min(t, limit);
          }
          return limit;
        };

        // The OPTICAL AXIS first: its length is what every rim ray is then measured against.
        dir.set(0, 0, -1).applyQuaternion(aim);
        const axisT = reach(MAX_THROW) < MAX_THROW ? reach(MAX_THROW) : Math.min(BEAM_LENGTH, MAX_THROW);
        hit.copy(dir).multiplyScalar(axisT).add(p);
        if (isSel) put(p.x, p.y, p.z, hit.x, hit.y, hit.z, cr * 0.55, cg * 0.55, cb * 0.55);

        // …then the ILLUMINATION BOUNDARY, one intersection per ray, which is what makes it an
        // ellipse on a tilted beam and a circle on a vertical one without a special case.
        for (let r = 0; r < RING; r++) {
          const a2 = (r / RING) * Math.PI * 2;
          dir.set(Math.cos(a2) * tanH, Math.sin(a2) * tanH, -1).normalize().applyQuaternion(aim);
          const t = reach(axisT * FLARE);
          const o3 = r * 3;
          ring[o3] = p.x + dir.x * t; ring[o3 + 1] = p.y + dir.y * t; ring[o3 + 2] = p.z + dir.z * t;
        }
        for (let r = 0; r < RING; r++) {
          const a3 = r * 3, b3 = ((r + 1) % RING) * 3;
          put(ring[a3], ring[a3 + 1], ring[a3 + 2], ring[b3], ring[b3 + 1], ring[b3 + 2], cr, cg, cb);
        }

        // …and the cone EDGES, only for what is being aimed.
        const step = RING / RAYS;
        for (let r = 0; isSel && r < RAYS; r++) {
          const o3 = Math.round(r * step) * 3;
          put(p.x, p.y, p.z, ring[o3], ring[o3 + 1], ring[o3 + 2], cr * 0.7, cg * 0.7, cb * 0.7);
        }
      }

      // ── THE VOLUME ──────────────────────────────────────────────────────────────────────────
      // Capped, because unlike the outline this one is fill-rate bound. See MAX_BEAMS.
      if (!drawn.has(i)) {
        m.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, m);
        continue;
      }

      const radius = BEAM_LENGTH * tanH;
      s.set(radius, radius, BEAM_LENGTH);

      m.compose(p, aim, s);
      mesh.setMatrixAt(i, m);

      // Brightness rides the colour, because an additive shader has no separate opacity per instance.
      const ti = i * 3;
      tints[ti] = st!.r * st!.intensity;
      tints[ti + 1] = st!.g * st!.intensity;
      tints[ti + 2] = st!.b * st!.intensity;
    }

    // Collapse the segments LAST frame used and this one did not. A degenerate segment rasterises
    // nothing, which is simpler than re-sizing the draw range every time a head goes out — and
    // clearing only the difference keeps it O(what changed) rather than a memset of the whole buffer.
    if (usedSegs.current > seg) lp.fill(0, seg * 6, usedSegs.current * 6);
    usedSegs.current = seg;

    mesh.instanceMatrix.needsUpdate = true;
    tintAttr.needsUpdate = true;
    linePos.needsUpdate = true;
    lineCol.needsUpdate = true;
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
    <group>
    <instancedMesh
      key={count}
      ref={meshRef}
      args={[undefined as unknown as THREE.BufferGeometry, undefined as unknown as THREE.Material, count]}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      // Drawn after the opaque scene so the additive blend lands on top of what it should light.
      renderOrder={10}
    />
    {/* The diagram, over the volume. Never a pick target — you select a head by its body. */}
    <lineSegments geometry={lineGeo} frustumCulled={false} raycast={() => null} renderOrder={11}>
      <lineBasicMaterial vertexColors transparent opacity={0.9} depthWrite={false} toneMapped={false} />
    </lineSegments>
    </group>
  );
};

