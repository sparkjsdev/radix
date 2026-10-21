import * as THREE from "three";
import { GpuSplatMath } from "../gpu/math.tsl";
import { SplatGenerator } from "../gpu/splatGenerator";
import { GpuSplats, type CovSplatNode, type SplatNode } from "../gpu/splats.tsl";
import { TSL, type TslNode } from "../gpu/tsl";
import type { SplatForm } from "./projection.tsl";
import { SplatCamera } from "./splatCamera";

const { If, cross, dot, float, length, normalize, select, transpose, uint, uniform, vec3, vec4 } = TSL;

/** Where a modifier runs: head space for "view", or the frame of a matrix read every render. */
export type ModifierSpace = "view" | "world" | "object" | THREE.Matrix4;

// uniform is 1, with quat and scale set, when matrix is a rotation times a uniform scale
export interface TransformNodes {
  matrix: TslNode;
  quat: TslNode;
  scale: TslNode;
  uniform: TslNode;
}

const transformNodes = (): TransformNodes => ({
  matrix: uniform(new THREE.Matrix4()),
  quat: uniform(new THREE.Vector4(0, 0, 0, 1)),
  scale: uniform(1),
  uniform: uniform(1, "uint"),
});

// Object to head space as a, or a to the modifier's space and b on to head space
export const transforms = { a: transformNodes(), b: transformNodes() };

// With G = M^T M and s2 = trace(G) / 3: G - s2 I within tolerance x s2, and
// det(M) > 0, since a mirror has no rotation quaternion
export function isUniformScale(m: THREE.Matrix4, tolerance = 1e-6) {
  const e = m.elements;
  const cols = [[e[0], e[1], e[2]], [e[4], e[5], e[6]], [e[8], e[9], e[10]]];
  const d = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const s2 = (d(cols[0], cols[0]) + d(cols[1], cols[1]) + d(cols[2], cols[2])) / 3;
  if (!(s2 > 0)) {
    return false;
  }
  for (let i = 0; i < 3; i += 1) {
    for (let j = i; j < 3; j += 1) {
      if (Math.abs(d(cols[i], cols[j]) - (i === j ? s2 : 0)) > tolerance * s2) {
        return false;
      }
    }
  }
  return m.determinant() > 0;
}

function setTransform(t: TransformNodes, m: THREE.Matrix4) {
  (t.matrix.value as THREE.Matrix4).copy(m);
  const uniformScale = isUniformScale(m);
  t.uniform.value = uniformScale ? 1 : 0;
  if (uniformScale) {
    m.decompose(scratch.position, scratch.quaternion, scratch.scale);
    const q = scratch.quaternion;
    (t.quat.value as THREE.Vector4).set(q.x, q.y, q.z, q.w);
    t.scale.value = Math.cbrt(Math.abs(m.determinant()));
  }
}

// Splits object to head around the modifier's space, in float64
export function setTransforms(object: THREE.Matrix4, space: ModifierSpace | undefined) {
  const head = SplatCamera.head;
  const { a, b } = scratch;
  if (space === undefined || space === "view") {
    a.multiplyMatrices(head, object);
    b.identity();
  } else if (space === "object") {
    a.identity();
    b.multiplyMatrices(head, object);
  } else if (space === "world") {
    a.copy(object);
    b.copy(head);
  } else {
    a.copy(space).invert().multiply(object);
    b.multiplyMatrices(head, space);
  }
  setTransform(transforms.a, a);
  setTransform(transforms.b, b);
  // The head's inverse is made once per camera
  if (space === undefined) {
    SplatGenerator.setContext(object, head);
    return;
  }
  if (!scratch.head.equals(head)) {
    scratch.head.copy(head);
    scratch.headToWorld.copy(head).invert();
  }
  SplatGenerator.setContext(object, head, { toWorld: scratch.spaceToWorld.multiplyMatrices(scratch.headToWorld, b), toHead: b });
}

const scratch = {
  a: new THREE.Matrix4(),
  b: new THREE.Matrix4(),
  spaceToWorld: new THREE.Matrix4(),
  head: new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  headToWorld: new THREE.Matrix4(),
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  scale: new THREE.Vector3(),
};

export function transformCov(c: CovSplatNode, t: TransformNodes): CovSplatNode {
  const out = GpuSplats.CovSplat().toVar();
  const M = GpuSplatMath.mat3FromMat4(t.matrix).toVar();
  const cov = M.mul(GpuSplatMath.covMatrix(c.get("xxyyzz"), c.get("xyxzyz"))).mul(transpose(M)).toVar();
  out.get("center").assign(t.matrix.mul(vec4(c.get("center"), 1.0)).xyz);
  out.get("xxyyzz").assign(vec3(cov.element(0).x, cov.element(1).y, cov.element(2).z));
  out.get("xyxzyz").assign(vec3(cov.element(0).y, cov.element(0).z, cov.element(1).z));
  out.get("rgb").assign(c.get("rgb"));
  out.get("opacity").assign(c.get("opacity"));
  out.get("index").assign(c.get("index"));

  // Normals by the inverse transpose: the cofactor matrix, signed by det(M)
  const c0 = M.element(0).toVar();
  const c1 = M.element(1).toVar();
  const c2 = M.element(2).toVar();
  const n = c.get("normal").toVar();
  const cofactor = cross(c1, c2).mul(n.x).add(cross(c2, c0).mul(n.y)).add(cross(c0, c1).mul(n.z)).toVar();
  const signed = cofactor.mul(select(dot(c0, cross(c1, c2)).lessThan(0.0), float(-1.0), float(1.0))).toVar();
  out.get("normal").assign(select(length(signed).greaterThan(0.0), normalize(signed), vec3(0.0)));
  return out;
}

function transformUniform(s: SplatNode, t: TransformNodes): SplatNode {
  const out = GpuSplats.Splat().toVar();
  out.get("center").assign(t.matrix.mul(vec4(s.get("center"), 1.0)).xyz);
  out.get("quaternion").assign(GpuSplatMath.quatMul(t.quat, normalize(s.get("quaternion"))));
  out.get("scales").assign(s.get("scales").mul(t.scale));
  out.get("rgb").assign(s.get("rgb"));
  out.get("opacity").assign(s.get("opacity"));
  out.get("index").assign(s.get("index"));
  return out;
}

export function transformSplat(s: SplatNode, t: TransformNodes): SplatNode {
  const out = GpuSplats.Splat().toVar();
  If(t.uniform.equal(uint(1)), () => {
    out.assign(transformUniform(s, t));
  }).Else(() => {
    out.assign(GpuSplats.fromCov(transformCov(GpuSplats.toCov(s), t)));
  });
  return out;
}

// A 3DGS splat wanted next as a covariance converts first, exact for any matrix
export function transformForm(node: SplatNode | CovSplatNode, form: SplatForm, t: TransformNodes, next?: SplatForm): { node: SplatNode | CovSplatNode; form: SplatForm } {
  if (form === "cov") {
    return { node: transformCov(node as CovSplatNode, t), form: "cov" };
  }
  if (next === "cov") {
    return { node: transformCov(GpuSplats.toCov(node as SplatNode), t), form: "cov" };
  }
  return { node: transformSplat(node as SplatNode, t), form: "splat" };
}

export function convertForm(node: SplatNode | CovSplatNode, from: SplatForm, to: SplatForm): SplatNode | CovSplatNode {
  if (from === to) {
    return node;
  }
  return to === "cov" ? GpuSplats.toCov(node as SplatNode) : GpuSplats.fromCov(node as CovSplatNode);
}
