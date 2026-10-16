// TSL twin of core/math.ts (SplatMath): quaternions, rotation matrices and
// covariances of splats in shaders
import { TSL, type TslNode } from "./tsl";

const { Break, Fn, If, Loop, abs, atan, cos, cross, dot, float, int, inverseSqrt, mat3, max, normalize, select, sin, struct, transpose, vec3, vec4 } = TSL;

const Eigens = struct({ values: "vec3", basis: "mat3" }, "SplatEigens");

const at = (m: TslNode, col: TslNode | number, row: TslNode | number) => m.element(col).element(row);

// Rotate v by the unit quaternion q
const quatRotate = Fn(([q, v]: [TslNode, TslNode]) => {
  const t = cross(q.xyz, v).mul(2.0).toVar();
  return v.add(q.w.mul(t)).add(cross(q.xyz, t));
});

// q1 applied after q2
const quatMul = Fn(([q1, q2]: [TslNode, TslNode]) => vec4(
  q1.w.mul(q2.x).add(q1.x.mul(q2.w)).add(q1.y.mul(q2.z)).sub(q1.z.mul(q2.y)),
  q1.w.mul(q2.y).sub(q1.x.mul(q2.z)).add(q1.y.mul(q2.w)).add(q1.z.mul(q2.x)),
  q1.w.mul(q2.z).add(q1.x.mul(q2.y)).sub(q1.y.mul(q2.x)).add(q1.z.mul(q2.w)),
  q1.w.mul(q2.w).sub(q1.x.mul(q2.x)).sub(q1.y.mul(q2.y)).sub(q1.z.mul(q2.z)),
));

// Columns: R(q) * diag(s)
const scaleQuatMatrix = Fn(([s, q]: [TslNode, TslNode]) => {
  return mat3(
    vec3(
      s.x.mul(float(1.0).sub(float(2.0).mul(q.y.mul(q.y).add(q.z.mul(q.z))))),
      s.x.mul(float(2.0).mul(q.x.mul(q.y).add(q.w.mul(q.z)))),
      s.x.mul(float(2.0).mul(q.x.mul(q.z).sub(q.w.mul(q.y)))),
    ),
    vec3(
      s.y.mul(float(2.0).mul(q.x.mul(q.y).sub(q.w.mul(q.z)))),
      s.y.mul(float(1.0).sub(float(2.0).mul(q.x.mul(q.x).add(q.z.mul(q.z))))),
      s.y.mul(float(2.0).mul(q.y.mul(q.z).add(q.w.mul(q.x)))),
    ),
    vec3(
      s.z.mul(float(2.0).mul(q.x.mul(q.z).add(q.w.mul(q.y)))),
      s.z.mul(float(2.0).mul(q.y.mul(q.z).sub(q.w.mul(q.x)))),
      s.z.mul(float(1.0).sub(float(2.0).mul(q.x.mul(q.x).add(q.y.mul(q.y))))),
    ),
  );
});

// Eigenvalues (descending) and eigenvectors (columns, right-handed) of the
// symmetric matrix (xx, yy, zz | xy, xz, yz), by Jacobi rotations
const symEigens = Fn(([xxyyzz, xyxzyz]: [TslNode, TslNode]) => {
  const eps = float(1e-6).mul(abs(xxyyzz.x).add(abs(xxyyzz.y)).add(abs(xxyyzz.z))).toVar();
  const a = mat3(vec3(xxyyzz.x, xyxzyz.x, xyxzyz.y), vec3(xyxzyz.x, xxyyzz.y, xyxzyz.z), vec3(xyxzyz.y, xyxzyz.z, xxyyzz.z)).toVar();
  const v = mat3(vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0)).toVar();

  Loop(16, () => {
    const p = int(0).toVar();
    const q = int(1).toVar();
    const maxValue = abs(at(a, 0, 1)).toVar();
    If(abs(at(a, 0, 2)).greaterThan(maxValue), () => {
      maxValue.assign(abs(at(a, 0, 2)));
      q.assign(2);
    });
    If(abs(at(a, 1, 2)).greaterThan(maxValue), () => {
      maxValue.assign(abs(at(a, 1, 2)));
      p.assign(1);
      q.assign(2);
    });
    If(maxValue.lessThanEqual(eps), () => {
      Break();
    });

    const phi = atan(at(a, p, q).mul(2.0), at(a, q, q).sub(at(a, p, p))).mul(0.5);
    const c = cos(phi).toVar();
    const s = sin(phi).toVar();
    const rotate = (m: TslNode, first: (r: TslNode) => TslNode, second: (r: TslNode) => TslNode) => {
      Loop({ start: int(0), end: int(3), name: "r" }, ({ r }: { r: TslNode }) => {
        const x = first(r).toVar();
        const y = second(r).toVar();
        first(r).assign(c.mul(x).sub(s.mul(y)));
        second(r).assign(s.mul(x).add(c.mul(y)));
      });
    };
    rotate(a, (r) => at(a, r, p), (r) => at(a, r, q));
    rotate(a, (r) => at(a, p, r), (r) => at(a, q, r));
    at(a, p, q).assign(0.0);
    at(a, q, p).assign(0.0);
    rotate(v, (r) => at(v, r, p), (r) => at(v, r, q));
  });

  const l0 = at(a, 0, 0).toVar();
  const l1 = at(a, 1, 1).toVar();
  const l2 = at(a, 2, 2).toVar();
  const v0 = normalize(vec3(at(v, 0, 0), at(v, 1, 0), at(v, 2, 0))).toVar();
  const v1 = normalize(vec3(at(v, 0, 1), at(v, 1, 1), at(v, 2, 1))).toVar();
  const v2 = normalize(vec3(at(v, 0, 2), at(v, 1, 2), at(v, 2, 2))).toVar();

  const swap = (la: TslNode, lb: TslNode, va: TslNode, vb: TslNode) => {
    If(la.lessThan(lb), () => {
      const l = la.toVar();
      la.assign(lb);
      lb.assign(l);
      const w = va.toVar();
      va.assign(vb);
      vb.assign(w);
    });
  };
  swap(l0, l1, v0, v1);
  swap(l0, l2, v0, v2);
  swap(l1, l2, v1, v2);

  If(dot(cross(v0, v1), v2).lessThan(0.0), () => {
    v2.assign(v2.negate());
  });
  return Eigens(vec3(l0, l1, l2), mat3(v0, v1, v2));
});

// Quaternion (w >= 0) of an orthonormal basis (columns), after glam's
// Quat::from_rotation_axes (SplatMath.basisToQuat)
const basisToQuat = Fn(([basis]: [TslNode]) => {
  const x = basis.element(0).toVar();
  const y = basis.element(1).toVar();
  const z = basis.element(2).toVar();
  const q = vec4(0.0).toVar();

  const set = (four: TslNode, make: (inv: TslNode) => TslNode) => {
    const inv = inverseSqrt(max(four, 1e-30)).mul(0.5).toVar();
    q.assign(make(inv));
  };
  If(z.z.lessThanEqual(0.0), () => {
    const dif10 = y.y.sub(x.x).toVar();
    const omm22 = float(1.0).sub(z.z).toVar();
    If(dif10.lessThanEqual(0.0), () => {
      const four = omm22.sub(dif10).toVar();
      set(four, (inv) => vec4(four.mul(inv), x.y.add(y.x).mul(inv), x.z.add(z.x).mul(inv), y.z.sub(z.y).mul(inv)));
    }).Else(() => {
      const four = omm22.add(dif10).toVar();
      set(four, (inv) => vec4(x.y.add(y.x).mul(inv), four.mul(inv), y.z.add(z.y).mul(inv), z.x.sub(x.z).mul(inv)));
    });
  }).Else(() => {
    const sum10 = y.y.add(x.x).toVar();
    const opm22 = float(1.0).add(z.z).toVar();
    If(sum10.lessThanEqual(0.0), () => {
      const four = opm22.sub(sum10).toVar();
      set(four, (inv) => vec4(x.z.add(z.x).mul(inv), y.z.add(z.y).mul(inv), four.mul(inv), x.y.sub(y.x).mul(inv)));
    }).Else(() => {
      const four = opm22.add(sum10).toVar();
      set(four, (inv) => vec4(y.z.sub(z.y).mul(inv), z.x.sub(x.z).mul(inv), x.y.sub(y.x).mul(inv), four.mul(inv)));
    });
  });

  q.assign(normalize(q));
  return select(q.w.lessThan(0.0), q.negate(), q);
});

export class GpuSplatMath {
  // Rotate v by the unit quaternion q
  static readonly quatRotate: (q: TslNode, v: TslNode) => TslNode = quatRotate;
  // q1 applied after q2
  static readonly quatMul: (q1: TslNode, q2: TslNode) => TslNode = quatMul;

  static quatConj(q: TslNode): TslNode {
    return vec4(q.xyz.negate(), q.w);
  }

  // Upper-left 3x3 of a mat4 (WGSL has no mat3x3(mat4x4) constructor)
  static mat3FromMat4(m: TslNode): TslNode {
    return mat3(m.element(0).xyz, m.element(1).xyz, m.element(2).xyz);
  }

  // R(q) * diag(s), as columns
  static readonly scaleQuatMatrix: (scales: TslNode, quat: TslNode) => TslNode = scaleQuatMatrix;

  // Sigma = M M^T with M = R(q) diag(scales), as a mat3 (q normalized here)
  static covFromScaleQuat(scales: TslNode, quat: TslNode): TslNode {
    const m = scaleQuatMatrix(scales, normalize(quat)).toVar();
    return m.mul(transpose(m));
  }

  // The symmetric matrix of a covariance's diagonal (xx, yy, zz) and
  // off-diagonal (xy, xz, yz)
  static covMatrix(xxyyzz: TslNode, xyxzyz: TslNode): TslNode {
    const d = xxyyzz.toVar();
    const o = xyxzyz.toVar();
    return mat3(vec3(d.x, o.x, o.y), vec3(o.x, d.y, o.z), vec3(o.y, o.z, d.z));
  }

  // Eigenvalues (descending, .get("values")) and eigenvectors (columns,
  // right-handed, .get("basis")) of a symmetric matrix
  static readonly symEigens: (xxyyzz: TslNode, xyxzyz: TslNode) => TslNode = symEigens;

  // Quaternion (w >= 0) of an orthonormal basis (columns)
  static readonly basisToQuat: (basis: TslNode) => TslNode = basisToQuat;
}
