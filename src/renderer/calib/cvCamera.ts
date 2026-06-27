// OpenCV camera model → world-space geometry for the virtual projector. OpenCV projects a world
// point X (venue metres) to a projector pixel via Xc = R·X + t (R: world→cam 3×3, t: translation),
// normalize by z, apply radial+tangential distortion, then K. OpenCV camera axes are x-right/y-down/
// z-forward. These helpers recover the projector's world pose (center + rays) for the frustum overlay
// and reproject points (for residual checks + tests). Pure math — no three.js — so it unit-tests in
// plain node; the frustum component converts the tuples to THREE.Vector3.

export type Vec3 = [number, number, number];
export type Mat3 = number[]; // row-major length 9

const matT = (R: Mat3): Mat3 => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
const mul3v = (R: Mat3, v: Vec3): Vec3 => [
  R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
  R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
  R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
];
const normalize = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// Projector optical center in world coords: C = -Rᵀ·t.
export function cameraCenter(R: Mat3, t: Vec3): Vec3 {
  const x = mul3v(matT(R), t);
  return [-x[0], -x[1], -x[2]];
}

// Normalized world-space ray direction for projector pixel (u,v). Ignores lens distortion (fine for
// the frustum outline): dir_cam = [(u-cx)/fx, (v-cy)/fy, 1]; dir_world = Rᵀ·dir_cam.
export function pixelRayWorld(K: Mat3, R: Mat3, u: number, v: number): Vec3 {
  const fx = K[0], fy = K[4], cx = K[2], cy = K[5];
  const dirCam: Vec3 = [(u - cx) / fx, (v - cy) / fy, 1];
  return normalize(mul3v(matT(R), dirCam));
}

// Projector frustum: optical center + the four image-corner points pushed `depth` metres along their
// rays (TL, TR, BR, BL in projector raster order).
export function frustumCorners(K: Mat3, R: Mat3, t: Vec3, imageSize: [number, number], depth: number): { center: Vec3; corners: Vec3[] } {
  const C = cameraCenter(R, t);
  const [W, H] = imageSize;
  const px: [number, number][] = [[0, 0], [W, 0], [W, H], [0, H]];
  const corners = px.map(([u, v]) => {
    const d = pixelRayWorld(K, R, u, v);
    return [C[0] + d[0] * depth, C[1] + d[1] * depth, C[2] + d[2] * depth] as Vec3;
  });
  return { center: C, corners };
}

// Project a world point to a projector pixel with radial+tangential distortion (OpenCV projectPoints
// model). Used for the residual overlay and round-trip tests. Returns null if behind the projector.
export function reproject(K: Mat3, dist: number[], R: Mat3, t: Vec3, X: Vec3): [number, number] | null {
  const Xc = mul3v(R, X);
  Xc[0] += t[0]; Xc[1] += t[1]; Xc[2] += t[2];
  if (Xc[2] <= 1e-6) return null;
  const x = Xc[0] / Xc[2], y = Xc[1] / Xc[2];
  const r2 = x * x + y * y;
  const k1 = dist[0] || 0, k2 = dist[1] || 0, p1 = dist[2] || 0, p2 = dist[3] || 0, k3 = dist[4] || 0;
  const radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
  const xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
  const yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
  const fx = K[0], fy = K[4], cx = K[2], cy = K[5];
  return [fx * xd + cx, fy * yd + cy];
}

// Vertical field of view (radians) for a THREE.PerspectiveCamera matching fy over the raster height.
export function verticalFov(K: Mat3, imageH: number): number {
  return 2 * Math.atan(imageH / (2 * K[4]));
}

// Camera-to-world basis (right, up, back) for orienting a THREE camera at the projector: world→GL-cam
// rotation = diag(1,-1,-1)·R, so camera-to-world = Rᵀ·diag(1,-1,-1). Columns are the camera axes in
// world space (THREE looks down -Z). Returned row-major so callers can build a Matrix4/quaternion.
export function cameraToWorldRot(R: Mat3): Mat3 {
  const Rt = matT(R);
  // multiply Rt * diag(1,-1,-1): negate columns 1 and 2.
  return [
    Rt[0], -Rt[1], -Rt[2],
    Rt[3], -Rt[4], -Rt[5],
    Rt[6], -Rt[7], -Rt[8],
  ];
}

// Row-major 3×3 rotation matrix → quaternion [x,y,z,w] (THREE order). m columns are the basis axes.
export function matToQuat(m: Mat3): [number, number, number, number] {
  const m00 = m[0], m01 = m[1], m02 = m[2], m10 = m[3], m11 = m[4], m12 = m[5], m20 = m[6], m21 = m[7], m22 = m[8];
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2; // s = 4w
    w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2; // 4x
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2; // 4y
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2; // 4z
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  return [x, y, z, w];
}

// World pose for a THREE camera placed at the projector: position + orientation quaternion.
export function cameraPose(R: Mat3, t: Vec3): { position: Vec3; quaternion: [number, number, number, number] } {
  return { position: cameraCenter(R, t), quaternion: matToQuat(cameraToWorldRot(R)) };
}

// Exact OpenGL projection matrix (column-major, for THREE.Matrix4.fromArray) from the pinhole
// intrinsics — encodes fx, fy AND the principal point (cx,cy), which a fov/aspect PerspectiveCamera
// can't (it forces fx==fy and a centred principal point). Clip space is GL (y-up, looking down -Z);
// the y/z flips vs OpenCV's y-down/z-forward are folded in. Distortion is applied separately (post-pass).
export function glProjectionMatrix(K: Mat3, imageSize: [number, number], near: number, far: number): number[] {
  const fx = K[0], fy = K[4], cx = K[2], cy = K[5];
  const [W, H] = imageSize;
  const te = new Array(16).fill(0);
  te[0] = 2 * fx / W;           // P00
  te[5] = 2 * fy / H;           // P11
  te[8] = 1 - 2 * cx / W;       // P02 (principal x)
  te[9] = 2 * cy / H - 1;       // P12 (principal y)
  te[10] = -(far + near) / (far - near); // P22
  te[11] = -1;                  // P32 (w = -z)
  te[14] = -2 * far * near / (far - near); // P23
  return te;
}
