// After Spark's sparkProjections
import type { EyeNodes } from "./splatCamera";
import type { SplatParamNodes } from "./splatParams";
import {
  boundFromCov, clipBoundToScreen, cullClipXY, cullDepth, cullInvisible, decodeAngle12, decodeBound, decodeCenter, decodeDepth20,
  decodeLogScale, decodeNdc, decodeOpacity, eigenvector2, encodeAngle12, encodeBound, encodeCenter, encodeDepth20, encodeLogScale,
  encodeNdc, encodeOpacity, eyeFrame, frameQuat, mahalanobis2, makeBound, mipInflate, rayDensity, rayVertex, boundCorner, screenBound, splatInView,
  storedOpacity, viewBasis, viewCov, type Bound, type PreparedSplat, type SplatForm, type SplatInView, type SplatVaryings,
} from "./projection.tsl";
import { GpuEncoding } from "../gpu/encoding.tsl";
import { GpuSplatMath } from "../gpu/math.tsl";
import { TSL, type TslNode } from "../gpu/tsl";

const { basisToQuat, quatConj, quatMul, quatRotate, scaleQuatMatrix } = GpuSplatMath;
const { decodeExtRgb, decodeHalf, decodeHalf2, decodeQuatOct32, encodeExtRgb, encodeHalf, encodeHalf2, encodeQuatOct32 } = GpuEncoding;

const {
  If, bool, cross, dot, exp, float, floatBitsToUint, inverseSqrt, length, log, mat3, mat4, max, normalize, select, sqrt,
  transpose, uint, uintBitsToFloat, vec2, vec3, vec4,
} = TSL;

/** How a renderer projects splats: "ewa" splatting, or ray evaluation in the others. */
export type ProjectionMethod = "ewa" | "3dgut" | "htgs" | "raygs";

// The splat form each method reads
export interface ProjectionInputs {
  ewa: "cov";
  "3dgut": "splat";
  htgs: "splat";
  raygs: "splat";
}

export interface ProjectContext<F extends SplatForm> {
  splat: PreparedSplat<F>;
  // With the first eye's lens
  head: SplatInView;
  eyes: number;
  params: SplatParamNodes;
}

export interface SplatLook {
  visible: TslNode;
  rgb: TslNode;
  opacity: TslNode;
}

export interface ProjectionDef<F extends SplatForm = SplatForm> {
  input: F;
  headWords: number;
  eyeWords: number;
  // What vertex() fills and density() reads
  varyings: readonly (keyof SplatVaryings)[];
  project(ctx: ProjectContext<F>): { words: TslNode[]; visible: TslNode };
  look(head: TslNode[], eye: TslNode[]): SplatLook;
  // Fills the DrawVertex var out for a corner in [-1, 1]^2
  vertex(head: TslNode[], eye: TslNode[], view: EyeNodes, corner: TslNode, boundStdDev: TslNode, cutoffStdDev: TslNode, out: TslNode): void;
  density(varyings: SplatVaryings): TslNode;
}

const zeroWords = (n: number) => Array.from({ length: n }, () => uint(0).toVar());

function assignWords(words: TslNode[], values: TslNode[]) {
  values.forEach((value, i) => words[i].assign(value));
}

const ewa: ProjectionDef<"cov"> = {
  input: "cov",
  headWords: 0,
  eyeWords: 4,
  varyings: ["uv"],

  project({ splat: s, eyes, params }) {
    const words: TslNode[] = [];
    const visible = bool(false).toVar();

    for (let v = 0; v < eyes; v += 1) {
      const eye = splatInView(s, eyeFrame(v), params);
      const out = zeroWords(4);

      // The 2D Gaussian is only valid near its center, so cull on the center
      const ok = cullInvisible(s, params).or(cullDepth(eye)).or(cullClipXY(eye, params)).not().toVar();
      If(ok, () => {
        const { frame, center } = eye;
        const cov3D = viewCov(s, frame).toVar();
        const focal = frame.renderSize.mul(0.5).mul(vec2(frame.projection.element(0).x, frame.projection.element(1).y)).toVar();

        const J = mat3(vec3(0.0), vec3(0.0), vec3(0.0)).toVar();
        If(frame.isOrtho, () => {
          J.assign(mat3(vec3(focal.x, 0.0, 0.0), vec3(0.0, focal.y, 0.0), vec3(0.0)));
        }).Else(() => {
          const invZ = float(1.0).div(center.z).toVar();
          const J1 = focal.mul(invZ).toVar();
          const J2 = J1.mul(center.xy).negate().mul(invZ).toVar();
          J.assign(mat3(vec3(J1.x, 0.0, J2.x), vec3(0.0, J1.y, J2.y), vec3(0.0)));
        });

        const cov2D = transpose(J).mul(cov3D).mul(J).toVar();
        const a = cov2D.element(0).x.add(params.preBlurAmount).toVar();
        const d = cov2D.element(1).y.add(params.preBlurAmount).toVar();
        const b = cov2D.element(0).y.toVar();

        // Convolve with the anti-aliasing blur, compensating the opacity
        const detOrig = a.mul(d).sub(b.mul(b)).toVar();
        a.addAssign(eye.blur);
        d.addAssign(eye.blur);
        const opacity = s.opacity.mul(sqrt(max(0.0, detOrig.div(a.mul(d).sub(b.mul(b)))))).toVar();

        const contribution = opacity.mul(2 * Math.PI).mul(sqrt(max(0.0, a.mul(d).sub(b.mul(b)))));
        const bound = makeBound();
        ok.assign(opacity.greaterThanEqual(params.minAlpha).and(contribution.greaterThanEqual(params.minContribution)).and(boundFromCov(a, b, d, s.stdDev, params, bound)));
        If(ok, () => {
          assignWords(out, [
            encodeNdc(eye.ndc),
            encodeDepth20(center.z).bitOr(encodeAngle12(bound.angle).shiftLeft(uint(20))),
            encodeExtRgb(s.splat.get("rgb")),
            encodeOpacity(storedOpacity(opacity)).bitOr(encodeLogScale(bound.scales.x, 12).shiftLeft(uint(8))).bitOr(encodeLogScale(bound.scales.y, 12).shiftLeft(uint(20))),
          ]);
          visible.assign(true);
        });
      });

      words.push(...out);
    }
    return { words, visible };
  },

  look: (_head, eye) => {
    const byte = eye[3].bitAnd(uint(0xff));
    return { visible: byte.notEqual(uint(0)), rgb: decodeExtRgb(eye[2]), opacity: decodeOpacity(byte) };
  },

  vertex(_head, eye, view, corner, boundStdDev, cutoffStdDev, out) {
    const bound: Bound = {
      ndc: decodeNdc(eye[0]),
      angle: decodeAngle12(eye[1].shiftRight(uint(20))),
      scales: vec2(decodeLogScale(eye[3].shiftRight(uint(8)).bitAnd(uint(0xfff)), 12), decodeLogScale(eye[3].shiftRight(uint(20)), 12)),
    };

    // The bound is centered on the splat, so shrink the quad to the cutoff
    boundCorner(bound, vec3(0.0, 0.0, decodeDepth20(eye[1].bitAnd(uint(0xfffff)))), corner.mul(cutoffStdDev.div(boundStdDev)), view.projection, view.renderSize, out);
    out.get("uv").assign(corner.mul(cutoffStdDev));
  },

  density: (v) => dot(v.uv, v.uv),
};

// MIP-inflated once, in head space
function headBasis({ splat: s, head, params }: ProjectContext<"splat">) {
  const ok = cullInvisible(s, params).not().toVar();
  const opacity = s.opacity.toVar();
  const { quat, scales } = viewBasis(s, head.frame);
  mipInflate(head, quat, scales, opacity, params);
  ok.assign(ok.and(opacity.greaterThanEqual(params.minAlpha)));
  return { ok, opacity, quat, scales };
}

// Unscented transform of the 7 sigma points
function gutBound(eye: SplatInView, quat: TslNode, scales: TslNode, stdDev: TslNode, params: SplatParamNodes, bound: Bound): TslNode {
  const ok = bool(true).toVar();
  const basis = scaleQuatMatrix(scales.mul(Math.sqrt(3)), quat).toVar();
  const c = eye.center;
  const points = [c, c.add(basis.element(0)), c.sub(basis.element(0)), c.add(basis.element(1)), c.sub(basis.element(1)), c.add(basis.element(2)), c.sub(basis.element(2))];

  const halfSize = eye.frame.renderSize.mul(0.5).toVar();
  const inFront = bool(true).toVar();
  const pixels = points.map((point) => {
    const clip = eye.frame.projection.mul(vec4(point, 1.0)).toVar();
    inFront.assign(inFront.and(clip.w.greaterThan(0.0)));
    return clip.xy.div(clip.w).mul(halfSize).toVar();
  });

  If(inFront.not(), () => {
    screenBound(eye.frame, params, bound);
  }).Else(() => {
    const mean = vec2(0.0).toVar();
    for (let i = 1; i < 7; i += 1) {
      mean.addAssign(pixels[i].mul(1 / 6));
    }

    const d0 = pixels[0].sub(mean).toVar();
    const a = d0.x.mul(d0.x).mul(2.0).toVar();
    const b = d0.x.mul(d0.y).mul(2.0).toVar();
    const d = d0.y.mul(d0.y).mul(2.0).toVar();
    for (let i = 1; i < 7; i += 1) {
      const di = pixels[i].sub(mean).toVar();
      a.addAssign(di.x.mul(di.x).mul(1 / 6));
      b.addAssign(di.x.mul(di.y).mul(1 / 6));
      d.addAssign(di.y.mul(di.y).mul(1 / 6));
    }

    ok.assign(boundFromCov(a, b, d, stdDev, params, bound));
    bound.ndc.assign(mean.div(halfSize));
  });
  return ok;
}

// Exact dual-quadric outline of the stdDev-ellipsoid
function htgsBound(eye: SplatInView, quat: TslNode, scales: TslNode, stdDev: TslNode, params: SplatParamNodes, bound: Bound): TslNode {
  const ok = bool(true).toVar();
  const basis = scaleQuatMatrix(scales.mul(stdDev), quat).toVar();
  const T = eye.frame.projection.mul(mat4(vec4(basis.element(0), 0.0), vec4(basis.element(1), 0.0), vec4(basis.element(2), 0.0), vec4(eye.center, 1.0))).toVar();
  const xs = vec3(T.element(0).x, T.element(1).x, T.element(2).x).toVar();
  const ys = vec3(T.element(0).y, T.element(1).y, T.element(2).y).toVar();
  const ws = vec3(T.element(0).w, T.element(1).w, T.element(2).w).toVar();
  const c3 = T.element(3).toVar();
  const qww = dot(ws, ws).sub(c3.w.mul(c3.w)).toVar();

  // An ellipse only if the camera is outside the ellipsoid
  const valid = qww.lessThan(0.0).and(c3.w.greaterThan(0.0)).toVar();
  const center = vec2(0.0).toVar();
  const a = float(0.0).toVar();
  const b = float(0.0).toVar();
  const d = float(0.0).toVar();
  If(valid, () => {
    const u = xs.mul(c3.w).sub(ws.mul(c3.x)).toVar();
    const v = ys.mul(c3.w).sub(ws.mul(c3.y)).toVar();
    const sww = dot(ws, ws).toVar();
    const xw = dot(xs, ws).toVar();
    const yw = dot(ys, ws).toVar();
    const invC2 = float(1.0).div(qww.mul(qww)).toVar();
    const halfSize = eye.frame.renderSize.mul(0.5).toVar();

    a.assign(dot(u, u).sub(sww.mul(dot(xs, xs)).sub(xw.mul(xw))).mul(invC2).mul(halfSize.x).mul(halfSize.x));
    b.assign(dot(u, v).sub(sww.mul(dot(xs, ys)).sub(xw.mul(yw))).mul(invC2).mul(halfSize.x).mul(halfSize.y));
    d.assign(dot(v, v).sub(sww.mul(dot(ys, ys)).sub(yw.mul(yw))).mul(invC2).mul(halfSize.y).mul(halfSize.y));
    center.assign(eye.ndc.add(vec2(dot(ws, u), dot(ws, v)).div(c3.w.mul(qww))));
    valid.assign(a.greaterThan(0.0).and(d.greaterThan(0.0)).and(a.mul(d).sub(b.mul(b)).greaterThan(0.0)));
  });

  If(valid.not(), () => {
    screenBound(eye.frame, params, bound);
  }).Else(() => {
    ok.assign(boundFromCov(a, b, d, float(1.0), params, bound));
    bound.ndc.assign(center);
  });
  return ok;
}

type BoundOf = typeof gutBound;

// 3dgut and htgs: a 2D bound per eye, then max-response ray evaluation
function rayProjection(boundOf: BoundOf, shrinkToCutoff: boolean): ProjectionDef<"splat"> {
  return {
    input: "splat",
    headWords: 6,
    eyeWords: 2,
    varyings: ["localDir", "localCross"],

    project(ctx) {
      const { splat: s, eyes, params } = ctx;
      const { ok, opacity, quat, scales } = headBasis(ctx);
      const head = zeroWords(6);
      const words: TslNode[] = [];
      const visible = bool(false).toVar();

      for (let v = 0; v < eyes; v += 1) {
        const eye = splatInView(s, eyeFrame(v), params);
        const out = zeroWords(2);

        If(ok.and(cullDepth(eye).not()), () => {
          const bound = makeBound();
          const eyeQuat = frameQuat(eye.frame, s.splat.get("quaternion"));
          If(boundOf(eye, eyeQuat, scales, s.stdDev, params, bound).and(clipBoundToScreen(eye.frame.renderSize, bound)), () => {
            assignWords(out, encodeBound(bound));
            visible.assign(true);
          });
        });

        words.push(...out);
      }

      If(ok, () => {
        const [dir, distance, low] = encodeCenter(ctx.head.center);
        assignWords(head, [
          dir,
          distance,
          encodeExtRgb(s.splat.get("rgb")),
          encodeQuatOct32(quat),
          encodeHalf2(log(scales.xy)),
          encodeHalf(log(scales.z)).bitOr(encodeOpacity(storedOpacity(opacity)).shiftLeft(uint(16))).bitOr(low),
        ]);
      });
      return { words: [...head, ...words], visible };
    },

    look: (head, eye) => ({
      visible: eye[1].notEqual(uint(0)),
      rgb: decodeExtRgb(head[2]),
      opacity: decodeOpacity(head[5].shiftRight(uint(16)).bitAnd(uint(0xff))),
    }),

    vertex(head, eye, view, corner, boundStdDev, cutoffStdDev, out) {
      const center = view.fromHead.mul(vec4(decodeCenter(head[0], head[1], head[5]), 1.0)).xyz.toVar();
      const quat = quatMul(view.fromHeadQuat, decodeQuatOct32(head[3])).toVar();
      const scales = exp(vec3(decodeHalf2(head[4]), decodeHalf(head[5]))).toVar();

      // The 3dgut bound is centered on the splat, so it shrinks to the cutoff.
      // The htgs outline's center drifts with the std dev under perspective.
      const shrink = shrinkToCutoff ? cutoffStdDev.div(boundStdDev) : float(1.0);
      rayVertex(decodeBound(eye[0], eye[1]), center, quat, scales, corner, shrink, view.projection, view.isOrtho, view.renderSize, out);
      out.get("uv").assign(corner.mul(boundStdDev));
    },

    density: rayDensity,
  };
}

// Every corner in front of the camera and outside the same edge
function quadOffScreen(projection: TslNode, mu: TslNode, axis0: TslNode, axis1: TslNode): TslNode {
  const c = projection.mul(vec4(mu, 1.0)).toVar();
  const a0 = projection.mul(vec4(axis0, 0.0)).toVar();
  const a1 = projection.mul(vec4(axis1, 0.0)).toVar();

  const inFront = bool(true).toVar();
  const outside = [bool(true).toVar(), bool(true).toVar(), bool(true).toVar(), bool(true).toVar()];
  for (let i = 0; i < 4; i += 1) {
    const clip = c.add((i & 1) === 0 ? a0.negate() : a0).add((i & 2) === 0 ? a1.negate() : a1).toVar();
    inFront.assign(inFront.and(clip.w.greaterThan(0.0)));
    outside[0].assign(outside[0].and(clip.x.lessThan(clip.w.negate())));
    outside[1].assign(outside[1].and(clip.x.greaterThan(clip.w)));
    outside[2].assign(outside[2].and(clip.y.lessThan(clip.w.negate())));
    outside[3].assign(outside[3].and(clip.y.greaterThan(clip.w)));
  }
  return inFront.and(outside[0].or(outside[1]).or(outside[2]).or(outside[3]));
}

// ok is false when the camera is inside the splat or the quad is off screen
function raygsFrame(eye: SplatInView, quat: TslNode, scales: TslNode, stdDev: TslNode) {
  const ok = bool(true).toVar();
  const kappa = stdDev.mul(stdDev).toVar();
  const c2 = mahalanobis2(eye.center, quat, scales).toVar();
  const muHat = vec3(0.0).toVar();
  If(eye.frame.isOrtho, () => {
    // Parallel rays: whiten the view direction instead of the center
    muHat.assign(normalize(quatRotate(quatConj(quat), vec3(0.0, 0.0, -1.0)).div(scales)));
    c2.assign(1e18);
  }).Else(() => {
    // Skip the splat when the camera is inside its support, paper Sec. 3.2
    ok.assign(c2.greaterThan(kappa.mul(1.0001)));
    muHat.assign(quatRotate(quatConj(quat), eye.center).div(scales).mul(inverseSqrt(c2)));
  });

  // Orthonormal basis of the plane orthogonal to mu_hat (Householder)
  const t = muHat.add(vec3(0.0, 0.0, select(muHat.z.greaterThanEqual(0.0), float(1.0), float(-1.0)))).toVar();
  const invDen = float(2.0).div(dot(t, t)).toVar();
  const q0 = quatRotate(quat, scales.mul(t.mul(t.x.mul(invDen)).sub(vec3(1.0, 0.0, 0.0)))).toVar();
  const q1 = quatRotate(quat, scales.mul(t.mul(t.y.mul(invDen)).sub(vec3(0.0, 1.0, 0.0)))).toVar();

  // Major eigenvector of Q^T Q, and u0 rotated 90 degrees from it
  const bxx = dot(q0, q0).toVar();
  const bxy = dot(q0, q1).toVar();
  const byy = dot(q1, q1).toVar();
  const diff = bxx.sub(byy);
  const eig1 = bxx.add(byy).mul(0.5).add(sqrt(max(0.0, diff.mul(diff).mul(0.25).add(bxy.mul(bxy))))).toVar();
  const u1 = eigenvector2(bxx, bxy, byy, eig1).toVar();
  const u0 = vec2(u1.y.negate(), u1.x).toVar();

  const axis0 = q0.mul(u0.x).add(q1.mul(u0.y)).toVar();
  const axis1 = q0.mul(u1.x).add(q1.mul(u1.y)).toVar();
  const lengths = vec2(length(axis0), length(axis1)).toVar();
  ok.assign(ok.and(lengths.x.greaterThan(0.0)).and(lengths.y.greaterThan(0.0)));

  const zScale = stdDev.mul(inverseSqrt(max(float(1.0).sub(kappa.div(c2)), 1e-4))).toVar();
  ok.assign(ok.and(quadOffScreen(eye.frame.projection, eye.center, axis0.mul(zScale), axis1.mul(zScale)).not()));

  const n0 = axis0.div(lengths.x).toVar();
  const n1 = axis1.div(lengths.y).toVar();
  return { ok, quat: basisToQuat(mat3(n0, n1, cross(n0, n1))), lengths, c2 };
}

// A tilted 3D quad with interpolated ray evaluation
const raygs: ProjectionDef<"splat"> = {
  input: "splat",
  headWords: 4,
  eyeWords: 3,
  varyings: ["uv", "c2"],

  project(ctx) {
    const { splat: s, eyes, params } = ctx;
    const { ok, opacity, scales } = headBasis(ctx);
    const head = zeroWords(4);
    const words: TslNode[] = [];
    const visible = bool(false).toVar();

    for (let v = 0; v < eyes; v += 1) {
      const eye = splatInView(s, eyeFrame(v), params);
      const out = zeroWords(3);

      If(ok.and(cullDepth(eye).not()), () => {
        const eyeQuat = frameQuat(eye.frame, s.splat.get("quaternion"));
        const frame = raygsFrame(eye, eyeQuat, scales, s.stdDev);
        If(frame.ok, () => {
          assignWords(out, [encodeQuatOct32(frame.quat), floatBitsToUint(frame.c2), encodeHalf2(log(frame.lengths))]);
          visible.assign(true);
        });
      });

      words.push(...out);
    }

    If(ok, () => {
      const [dir, distance, low] = encodeCenter(ctx.head.center);
      assignWords(head, [dir, distance, encodeExtRgb(s.splat.get("rgb")), encodeOpacity(storedOpacity(opacity)).bitOr(low)]);
    });
    return { words: [...head, ...words], visible };
  },

  look: (head, eye) => ({
    visible: eye[1].notEqual(uint(0)),
    rgb: decodeExtRgb(head[2]),
    opacity: decodeOpacity(head[3].bitAnd(uint(0xff))),
  }),

  // z = (sqrt(kappa) / b) * corner with b = sqrt(1 - kappa / c^2). The quad is
  // built around the center, so the tighter cutoff applies directly.
  vertex(head, eye, view, corner, _boundStdDev, cutoffStdDev, out) {
    const center = view.fromHead.mul(vec4(decodeCenter(head[0], head[1], head[3]), 1.0)).xyz.toVar();
    const quat = decodeQuatOct32(eye[0]).toVar();
    const c2 = uintBitsToFloat(eye[1]).toVar();
    const lengths = exp(decodeHalf2(eye[2])).toVar();

    const kappa = cutoffStdDev.mul(cutoffStdDev);
    const z = corner.mul(cutoffStdDev.mul(inverseSqrt(max(float(1.0).sub(kappa.div(c2)), 1e-4)))).toVar();
    const offset = quatRotate(quat, vec3(lengths.x.mul(z.x), lengths.y.mul(z.y), 0.0));

    // The center's NDC depth with the corner's true w keeps interpolation
    // perspective-correct while avoiding near-plane clipping
    const centerClip = view.projection.mul(vec4(center, 1.0)).toVar();
    const clip = centerClip.add(view.projection.mul(vec4(offset, 0.0))).toVar();
    out.get("position").assign(vec4(clip.xy, centerClip.z.div(centerClip.w).mul(clip.w), clip.w));
    out.get("uv").assign(z);
    out.get("c2").assign(c2);
  },

  // D = 1 / (1/c^2 + 1/|z|^2)
  density(v) {
    const zz = dot(v.uv, v.uv).toVar();
    return zz.mul(v.c2).div(v.c2.add(zz));
  },
};

export const PROJECTIONS: { [M in ProjectionMethod]: ProjectionDef<ProjectionInputs[M]> } = {
  ewa,
  "3dgut": rayProjection(gutBound, true),
  htgs: rayProjection(htgsBound, false),
  raygs,
};
