// Field names match THREE.Vector3 / Quaternion / Color, so those fit as is
export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }
export interface Rgb { r: number; g: number; b: number }
// Symmetric 3x3 matrix
export interface Cov { xx: number; yy: number; zz: number; xy: number; xz: number; yz: number }

// Quaternion and covariance math of the splat codecs (GpuSplatMath is the
// TSL twin)
export class SplatMath {
  // Unit quaternion (identity for a zero one)
  static normalizeQuat(q: Quat, out: Quat): Quat {
    const length = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    if (!(length > 0)) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      out.w = 1;
      return out;
    }
    out.x = q.x / length;
    out.y = q.y / length;
    out.z = q.z / length;
    out.w = q.w / length;
    return out;
  }

  // Sigma = M M^T with M = R(q) diag(scales)
  static covFromScaleQuat(scales: Vec3, q: Quat, out: Cov): Cov {
    const { x, y, z, w } = SplatMath.normalizeQuat(q, { x: 0, y: 0, z: 0, w: 1 });
    const m = [
      scales.x * (1 - 2 * (y * y + z * z)), scales.x * 2 * (x * y + w * z), scales.x * 2 * (x * z - w * y),
      scales.y * 2 * (x * y - w * z), scales.y * (1 - 2 * (x * x + z * z)), scales.y * 2 * (y * z + w * x),
      scales.z * 2 * (x * z + w * y), scales.z * 2 * (y * z - w * x), scales.z * (1 - 2 * (x * x + y * y)),
    ];
    const dot = (i: number, j: number) => m[i] * m[j] + m[i + 3] * m[j + 3] + m[i + 6] * m[j + 6];

    out.xx = dot(0, 0);
    out.yy = dot(1, 1);
    out.zz = dot(2, 2);
    out.xy = dot(0, 1);
    out.xz = dot(0, 2);
    out.yz = dot(1, 2);
    return out;
  }

  // Eigenvalues (descending) and eigenvectors (columns of `basis`,
  // right-handed) of a symmetric 3x3 matrix, by Jacobi rotations
  static symEigens(c: Cov): { values: Vec3; basis: number[] } {
    // Column-major: element (col, row) at col * 3 + row
    const a = [c.xx, c.xy, c.xz, c.xy, c.yy, c.yz, c.xz, c.yz, c.zz];
    const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const at = (col: number, row: number) => col * 3 + row;
    // Relative, so small splats converge as well as big ones
    const eps = 1e-9 * (Math.abs(c.xx) + Math.abs(c.yy) + Math.abs(c.zz));

    for (let iter = 0; iter < 16; iter += 1) {
      let p = 0;
      let q = 1;
      let max = Math.abs(a[at(0, 1)]);
      if (Math.abs(a[at(0, 2)]) > max) {
        max = Math.abs(a[at(0, 2)]);
        q = 2;
      }
      if (Math.abs(a[at(1, 2)]) > max) {
        max = Math.abs(a[at(1, 2)]);
        p = 1;
        q = 2;
      }
      if (max <= eps) {
        break;
      }

      const phi = 0.5 * Math.atan2(2 * a[at(p, q)], a[at(q, q)] - a[at(p, p)]);
      const cos = Math.cos(phi);
      const sin = Math.sin(phi);
      for (let r = 0; r < 3; r += 1) {
        const arp = a[at(r, p)];
        const arq = a[at(r, q)];
        a[at(r, p)] = cos * arp - sin * arq;
        a[at(r, q)] = sin * arp + cos * arq;
      }
      for (let r = 0; r < 3; r += 1) {
        const apr = a[at(p, r)];
        const aqr = a[at(q, r)];
        a[at(p, r)] = cos * apr - sin * aqr;
        a[at(q, r)] = sin * apr + cos * aqr;
      }
      a[at(p, q)] = 0;
      a[at(q, p)] = 0;
      for (let r = 0; r < 3; r += 1) {
        const vrp = v[at(r, p)];
        const vrq = v[at(r, q)];
        v[at(r, p)] = cos * vrp - sin * vrq;
        v[at(r, q)] = sin * vrp + cos * vrq;
      }
    }

    // Eigenvector j is (v[0][j], v[1][j], v[2][j])
    const pairs = [0, 1, 2].map((j) => {
      const vector = [v[at(0, j)], v[at(1, j)], v[at(2, j)]];
      const length = Math.max(Math.hypot(vector[0], vector[1], vector[2]), 1e-30);
      return { value: a[at(j, j)], vector: vector.map((x) => x / length) };
    });
    pairs.sort((x, y) => y.value - x.value);

    const [v0, v1, v2] = pairs.map((pair) => pair.vector);
    const det = v0[0] * (v1[1] * v2[2] - v1[2] * v2[1]) - v1[0] * (v0[1] * v2[2] - v0[2] * v2[1]) + v2[0] * (v0[1] * v1[2] - v0[2] * v1[1]);
    if (det < 0) {
      v2[0] = -v2[0];
      v2[1] = -v2[1];
      v2[2] = -v2[2];
    }
    return { values: { x: pairs[0].value, y: pairs[1].value, z: pairs[2].value }, basis: [...v0, ...v1, ...v2] };
  }

  // Quaternion (w >= 0) of an orthonormal basis given as columns, after
  // glam's Quat::from_rotation_axes
  static basisToQuat(m: number[], out: Quat): Quat {
    const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
    let x: number;
    let y: number;
    let z: number;
    let w: number;
    if (m22 <= 0) {
      const dif10 = m11 - m00;
      const omm22 = 1 - m22;
      if (dif10 <= 0) {
        const four = omm22 - dif10;
        const inv = 0.5 / Math.sqrt(Math.max(four, 1e-30));
        [x, y, z, w] = [four * inv, (m01 + m10) * inv, (m02 + m20) * inv, (m12 - m21) * inv];
      } else {
        const four = omm22 + dif10;
        const inv = 0.5 / Math.sqrt(Math.max(four, 1e-30));
        [x, y, z, w] = [(m01 + m10) * inv, four * inv, (m12 + m21) * inv, (m20 - m02) * inv];
      }
    } else {
      const sum10 = m11 + m00;
      const opm22 = 1 + m22;
      if (sum10 <= 0) {
        const four = opm22 - sum10;
        const inv = 0.5 / Math.sqrt(Math.max(four, 1e-30));
        [x, y, z, w] = [(m02 + m20) * inv, (m12 + m21) * inv, four * inv, (m01 - m10) * inv];
      } else {
        const four = opm22 + sum10;
        const inv = 0.5 / Math.sqrt(Math.max(four, 1e-30));
        [x, y, z, w] = [(m12 - m21) * inv, (m20 - m02) * inv, (m01 - m10) * inv, four * inv];
      }
    }

    const s = w < 0 ? -1 : 1;
    return SplatMath.normalizeQuat({ x: x * s, y: y * s, z: z * s, w: w * s }, out);
  }
}
