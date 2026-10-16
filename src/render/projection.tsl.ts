// What the four projection methods (projections.tsl.ts) share: a splat
// prepared once, its center in one view, culls, 2D bounds, the MIP filter,
// the codecs of the projected words, and the draw's ray evaluation.
import { SplatCamera } from "./splatCamera";
import type { SplatParamNodes } from "./splatParams";
import { GpuSplatMath } from "../gpu/math.tsl";
import type { CovSplatNode, SplatNode } from "../gpu/splats.tsl";
import { TSL, type TslNode } from "../gpu/tsl";

const { quatConj, quatMul, quatRotate } = GpuSplatMath;

const {
  Fn, If, abs, all, any, atan, bool, ceil, clamp, cos, cross, dot, exp, exp2, float, floatBitsToUint, floor, length, log2, max, min, mix, normalize,
  pow, select, sin, sqrt, transpose, uint, uintBitsToFloat, uvec2, vec2, vec3, vec4,
} = TSL;

const E = Math.E;
// Range of the 16-bit fixed NDC codes
export const NDC_RANGE = 2.0;
// log2 range of the pixel scales
const LOG_SCALE_MIN = -4.0;
const LOG_SCALE_MAX = 12.0;

// --- The splat, before any view ---

// The splat form a projection reads: "splat" (scales and rotation) or
// "cov" (a covariance)
export type SplatForm = "splat" | "cov";
export type SplatNodeOf<F extends SplatForm> = F extends "cov" ? CovSplatNode : SplatNode;

export interface PreparedSplat<F extends SplatForm = SplatForm> {
  form: F;
  // A var of the splat, grown by the LoD inflation
  splat: SplatNodeOf<F>;
  // Opacity after the LoD stretch (0..5), and the std dev cutoff it implies
  opacity: TslNode;
  stdDev: TslNode;
}

// LoD opacities above 1 stretch to 1..5; with lodInflate the splat grows
// instead (Spark's sparkProjectSplat preamble)
export function prepareSplat<F extends SplatForm>(source: SplatNodeOf<F>, form: F, params: SplatParamNodes): PreparedSplat<F> {
  const splat = (source as TslNode).toVar();
  const opacity = splat.get("opacity").toVar();
  const inflate = float(1.0).toVar();

  If(opacity.greaterThan(1.0), () => {
    opacity.assign(min(opacity.mul(4.0).sub(3.0), 5.0));
    If(params.lodInflate, () => {
      inflate.assign(pow(exp(opacity.mul(opacity).sub(1.0).div(E)), 1.0 / 3.0));
      opacity.assign(1.0);
    });
  });

  if (form === "cov") {
    splat.get("xxyyzz").mulAssign(inflate.mul(inflate));
    splat.get("xyxzyz").mulAssign(inflate.mul(inflate));
  } else {
    splat.get("scales").mulAssign(inflate);
  }

  const stdDev = select(opacity.greaterThan(1.0), params.maxStdDev.add(opacity.sub(1.0).mul(0.7)), params.maxStdDev).toVar();
  return { form, splat, opacity, stdDev };
}

export function cullInvisible({ form, splat, opacity }: PreparedSplat, params: SplatParamNodes): TslNode {
  const degenerate = all((splat as TslNode).get(form === "cov" ? "xxyyzz" : "scales").equal(vec3(0.0)));
  return opacity.lessThanEqual(0.0).or(opacity.lessThan(params.minAlpha)).or(degenerate);
}

// Opacity as stored: LoD opacities squashed back to 1..2
export const storedOpacity = (opacity: TslNode) => select(opacity.greaterThan(1.0), opacity.add(3.0).mul(0.25), opacity);

// --- One view ---

// A view to project in: head space (where splats arrive) to the view and
// its rotation (none for the head itself), plus the eye's lens
export interface ViewFrame {
  matrix?: TslNode;
  quat?: TslNode;
  projection: TslNode;
  isOrtho: TslNode;
  renderSize: TslNode;
  ndcZMin: TslNode;
}

export function eyeFrame(v: number | TslNode): ViewFrame {
  const eye = SplatCamera.eye(v);
  return {
    matrix: eye.fromHead, quat: eye.fromHeadQuat,
    projection: eye.projection, isOrtho: eye.isOrtho, renderSize: eye.renderSize, ndcZMin: eye.ndcZMin,
  };
}

// The head with the first eye's lens (exactly that eye in mono)
export function headFrame(): ViewFrame {
  return { ...eyeFrame(0), matrix: undefined, quat: undefined };
}

// A head-space rotation `q` seen from the frame
export const frameQuat = (frame: ViewFrame, q: TslNode) => (frame.quat ? quatMul(frame.quat, normalize(q)) : normalize(q));

export interface SplatInView {
  frame: ViewFrame;
  center: TslNode;
  clip: TslNode;
  ndc: TslNode;
  // The anti-aliasing blur, widened by depth of field
  blur: TslNode;
}

export function splatInView(s: PreparedSplat, frame: ViewFrame, params: SplatParamNodes): SplatInView {
  const splatCenter = (s.splat as TslNode).get("center");
  const center = (frame.matrix ? frame.matrix.mul(vec4(splatCenter, 1.0)).xyz : splatCenter).toVar();
  const clip = frame.projection.mul(vec4(center, 1.0)).toVar();

  // Depth of field: widen the blur to the circle of confusion (pixel area units)
  const blur = params.blurAmount.toVar();
  If(params.focalDistance.greaterThan(0.0).and(params.apertureTan.greaterThan(0.0)).and(center.z.lessThan(0.0)), () => {
    const depth = center.z.negate().toVar();
    const cocView = abs(depth.sub(params.focalDistance)).mul(params.apertureTan);
    const focalPixels = frame.renderSize.y.mul(0.5).mul(frame.projection.element(1).y);
    const cocPixels = select(frame.isOrtho, cocView.mul(focalPixels), cocView.mul(focalPixels).div(depth)).toVar();
    blur.assign(clamp(cocPixels.mul(cocPixels), blur, params.maxPixelRadius.mul(params.maxPixelRadius)));
  });

  const ndc = select(clip.w.greaterThan(0.0), clip.xy.div(clip.w), vec2(0.0)).toVar();
  return { frame, center, clip, ndc, blur };
}

// Center behind the camera or outside the near / far planes
export function cullDepth({ center, clip, frame }: SplatInView): TslNode {
  return center.z.greaterThanEqual(0.0).or(clip.z.lessThan(frame.ndcZMin.mul(clip.w))).or(clip.z.greaterThanEqual(clip.w));
}

// Center more than clipXY (at most the fixed NDC range) outside the frustum
export function cullClipXY({ clip }: SplatInView, params: SplatParamNodes): TslNode {
  const limit = min(params.clipXY, NDC_RANGE).mul(clip.w).toVar();
  return abs(clip.x).greaterThan(limit).or(abs(clip.y).greaterThan(limit));
}

// Whether a splat may show in the head's view widened by `guard` (NDC
// beyond the edges, plus the splat's own reach): keys of the others are
// dropped for the CPU sort, whose order lags the camera
export function inSortGuard({ form, splat }: PreparedSplat, head: SplatInView, guard: TslNode, params: SplatParamNodes): TslNode {
  const s = splat as TslNode;
  const extent = form === "cov" ? sqrt(max(max(s.get("xxyyzz").x, s.get("xxyyzz").y), s.get("xxyyzz").z)) : max(max(s.get("scales").x, s.get("scales").y), s.get("scales").z);
  const radius = extent.mul(params.maxStdDev).toVar();
  const { center, clip, frame } = head;
  const w = max(clip.w, 1e-6).toVar();
  const reach = vec2(frame.projection.element(0).x, frame.projection.element(1).y).mul(radius).div(w);
  const inside = all(abs(clip.xy.div(w)).sub(reach).lessThanEqual(vec2(guard.add(1.0))));
  const near = center.z.negate().lessThanEqual(radius);
  return center.z.lessThan(radius).and(inside.or(near));
}

// M Sigma M^T with M = mat3(view)
export function viewCov(s: PreparedSplat<"cov">, frame: ViewFrame): TslNode {
  const cov = GpuSplatMath.covMatrix(s.splat.get("xxyyzz"), s.splat.get("xyxzyz"));
  if (!frame.matrix) {
    return cov;
  }
  const M = GpuSplatMath.mat3FromMat4(frame.matrix).toVar();
  return M.mul(cov).mul(transpose(M));
}

// View-space rotation and scales; flat splats keep a sliver of thickness so
// rays can evaluate them
export function viewBasis(s: PreparedSplat<"splat">, frame: ViewFrame): { quat: TslNode; scales: TslNode } {
  const quat = frameQuat(frame, s.splat.get("quaternion")).toVar();
  const scales = s.splat.get("scales").toVar();
  scales.assign(max(scales, vec3(max(scales.x, max(scales.y, scales.z)).mul(1e-4))));
  return { quat, scales };
}

// |Sigma| * (l^T Sigma^-1 l) for diagonal Sigma = diag(s2), finite for zero scales
const detTimesMahalanobis = (l2: TslNode, s2: TslNode) =>
  l2.x.mul(s2.y).mul(s2.z).add(l2.y.mul(s2.x).mul(s2.z)).add(l2.z.mul(s2.x).mul(s2.y));

// MIP anti-aliasing for ray evaluation (vkraygs Sec. 5): inflate the 3D
// covariance by the pixel footprint, compensating the opacity. Mutates the
// scales and opacity vars.
export function mipInflate(v: SplatInView, quat: TslNode, scales: TslNode, opacity: TslNode, params: SplatParamNodes) {
  const local = quatRotate(quatConj(quat), v.center).toVar();
  const l2 = local.mul(local).toVar();
  const pixel = float(2.0).div(v.frame.renderSize.y.mul(v.frame.projection.element(1).y)).toVar();
  const footprint = pixel.mul(pixel).mul(select(v.frame.isOrtho, float(1.0), dot(v.center, v.center))).toVar();

  const s2 = scales.mul(scales).add(params.preBlurAmount.mul(footprint)).toVar();
  const s2Blur = s2.add(v.blur.mul(footprint)).toVar();
  const num = detTimesMahalanobis(l2, s2).toVar();
  const den = detTimesMahalanobis(l2, s2Blur).toVar();

  opacity.mulAssign(select(den.greaterThan(0.0), sqrt(max(num.div(den), 0.0)), float(1.0)));
  scales.assign(sqrt(s2Blur));
}

// c^2 = mu^T Sigma^-1 mu of a view-space center for the basis (quat, scales)
export const mahalanobis2 = (center: TslNode, quat: TslNode, scales: TslNode) => {
  const local = quatRotate(quatConj(quat), center).div(scales);
  return dot(local, local);
};

// --- 2D bounds (pixel half extents along an angle, centered at ndc) ---

export interface Bound {
  ndc: TslNode;
  angle: TslNode;
  scales: TslNode;
}

export const makeBound = (): Bound => ({ ndc: vec2(0.0).toVar(), angle: float(0.0).toVar(), scales: vec2(0.0).toVar() });

// Unit eigenvector of the symmetric 2x2 (a b; b d) for eigenvalue eig
export const eigenvector2 = Fn(([a, b, d, eig]: [TslNode, TslNode, TslNode, TslNode]) => {
  const v = select(abs(a.sub(eig)).greaterThanEqual(abs(d.sub(eig))), vec2(b, eig.sub(a)), vec2(eig.sub(d), b)).toVar();
  const len = length(v).toVar();
  return select(len.greaterThan(0.0), v.div(len), vec2(1.0, 0.0));
});

// Oriented bound of a pixel-space covariance (a b; b d): half extents
// stdDev * sqrt(eigenvalue), clamped; false if too small to draw
export function boundFromCov(a: TslNode, b: TslNode, d: TslNode, stdDev: TslNode, params: SplatParamNodes, bound: Bound): TslNode {
  const det = a.mul(d).sub(b.mul(b));
  const half = a.sub(d).mul(0.5).toVar();
  const eigen1 = a.add(d).mul(0.5).add(sqrt(half.mul(half).add(b.mul(b)))).toVar();
  const eigen2 = select(eigen1.greaterThan(0.0), max(det.div(eigen1), 0.0), float(0.0));

  const scale1 = min(params.maxPixelRadius, stdDev.mul(sqrt(max(eigen1, 0.0)))).toVar();
  const scale2 = min(params.maxPixelRadius, stdDev.mul(sqrt(eigen2))).toVar();
  const ok = scale1.greaterThanEqual(params.minPixelRadius).or(scale2.greaterThanEqual(params.minPixelRadius)).toVar();

  If(ok, () => {
    const axis = eigenvector2(a, b, d, eigen1).toVar();
    const angle = atan(axis.y, axis.x).toVar();
    bound.angle.assign(select(angle.lessThan(0.0), angle.add(Math.PI), angle));
    bound.scales.assign(vec2(scale1, scale2));
  });
  return ok;
}

// When no outline can be computed (camera inside, extent behind it): the screen
export function screenBound(frame: ViewFrame, params: SplatParamNodes, bound: Bound) {
  bound.ndc.assign(vec2(0.0));
  bound.angle.assign(0.0);
  bound.scales.assign(vec2(min(params.maxPixelRadius, length(frame.renderSize).mul(0.5))));
}

// Intersect the bound's pixel box with the screen; false if off screen
export function clipBoundToScreen(renderSize: TslNode, bound: Bound): TslNode {
  const halfSize = renderSize.mul(0.5).toVar();
  const c = cos(bound.angle).mul(bound.scales).toVar();
  const s = sin(bound.angle).mul(bound.scales).toVar();
  const extent = vec2(length(vec2(c.x, s.y)), length(vec2(s.x, c.y))).toVar();

  const center = bound.ndc.mul(halfSize).toVar();
  const lo = center.sub(extent).toVar();
  const hi = center.add(extent).toVar();
  const ok = bool(true).toVar();

  If(all(lo.greaterThanEqual(halfSize.negate())).and(all(hi.lessThanEqual(halfSize))).not(), () => {
    lo.assign(max(lo, halfSize.negate()));
    hi.assign(min(hi, halfSize));
    If(any(lo.greaterThanEqual(hi)), () => {
      ok.assign(false);
    }).Else(() => {
      bound.ndc.assign(lo.add(hi).mul(0.5).div(halfSize));
      bound.angle.assign(0.0);
      bound.scales.assign(hi.sub(lo).mul(0.5));
    });
  });
  return ok;
}

// --- Word codecs (all uint32) ---

const encodeFixed16 = (value: TslNode) => uint(clamp(floor(value.add(NDC_RANGE).div(2 * NDC_RANGE).mul(65535.0).add(0.5)), 0.0, 65535.0));
const decodeFixed16 = (code: TslNode) => float(code).div(65535.0).mul(2 * NDC_RANGE).sub(NDC_RANGE);

export const encodeNdc = (ndc: TslNode) => encodeFixed16(ndc.x).bitOr(encodeFixed16(ndc.y).shiftLeft(uint(16)));
export const decodeNdc = (word: TslNode) => vec2(decodeFixed16(word.bitAnd(uint(0xffff))), decodeFixed16(word.shiftRight(uint(16))));

// Positive depth (-viewZ) in 20 bits: its float32 bits above 2^-14, so 5
// exponent bits (2^-14 to 2^18) and 15 mantissa bits, rounded
const DEPTH_LO = 113 << 23;
export const encodeDepth20 = (viewZ: TslNode) => {
  const f = clamp(floatBitsToUint(viewZ.negate()), uint(DEPTH_LO), uint((145 << 23) - 1));
  return min(f.sub(uint(DEPTH_LO)).add(uint(128)).shiftRight(uint(8)), uint(0xfffff));
};
export const decodeDepth20 = (code: TslNode) => uintBitsToFloat(code.shiftLeft(uint(8)).add(uint(DEPTH_LO))).negate();

// A 2D bound's angle on [0, pi) in 12 bits (an ellipse at pi is the one at 0)
export const encodeAngle12 = (angle: TslNode) => uint(floor(angle.div(Math.PI).mul(4096.0).add(0.5))).bitAnd(uint(0xfff));
export const decodeAngle12 = (code: TslNode) => float(code).div(4096.0).mul(Math.PI);

// log2 pixel scale on [LOG_SCALE_MIN, LOG_SCALE_MAX] in `bits`; `outward`
// rounds up (bounds that must cover the splat), else to nearest. Code 0 is
// never written, so a zero word can mark a culled bound.
export function encodeLogScale(scale: TslNode, bits: number, outward = false) {
  const top = 2 ** bits - 2;
  const normalized = clamp(log2(max(scale, 1e-20)), LOG_SCALE_MIN, LOG_SCALE_MAX).sub(LOG_SCALE_MIN).div(LOG_SCALE_MAX - LOG_SCALE_MIN).mul(top);
  return uint(clamp(outward ? ceil(normalized) : floor(normalized.add(0.5)), 0.0, top)).add(uint(1));
}

export function decodeLogScale(code: TslNode, bits: number) {
  return exp2(float(code.sub(uint(1))).div(2 ** bits - 2).mul(LOG_SCALE_MAX - LOG_SCALE_MIN).add(LOG_SCALE_MIN));
}

// Visible splats keep a nonzero byte (zero marks a culled view)
export const encodeOpacity = (opacity: TslNode) => max(uint(floor(clamp(opacity.mul(128.0), 0.0, 255.0).add(0.5))), uint(1));
export const decodeOpacity = (byte: TslNode) => float(byte).div(128.0);

// The head-centered center: an octahedral direction of 20 + 20 bits, rounded,
// and the float32 distance. Words: the direction's top 16 + 16 bits, the
// distance, and its low 4 + 4 bits in bits 24-31, for the method to OR into
// its last head word (whose top byte is free).
export function encodeCenter(center: TslNode): [TslNode, TslNode, TslNode] {
  const distance = length(center).toVar();

  const p = center.xy.div(max(abs(center.x).add(abs(center.y)).add(abs(center.z)), 1e-30)).toVar();
  const signs = vec2(select(p.x.greaterThanEqual(0.0), float(1.0), float(-1.0)), select(p.y.greaterThanEqual(0.0), float(1.0), float(-1.0)));
  If(center.z.lessThan(0.0), () => {
    p.assign(vec2(float(1.0).sub(abs(p.y)), float(1.0).sub(abs(p.x))).mul(signs));
  });

  const q = uvec2(floor(p.mul(0.5).add(0.5).mul(0xfffff).add(0.5))).toVar();
  const dir = q.x.shiftRight(uint(4)).bitOr(q.y.shiftRight(uint(4)).shiftLeft(uint(16)));
  // y << 28 keeps only its low 4 bits
  const low = q.x.bitAnd(uint(15)).shiftLeft(uint(24)).bitOr(q.y.shiftLeft(uint(28)));
  return [dir, floatBitsToUint(distance), low];
}

// The center from its first two words and the last head word. Every code
// is a direction here (GpuEncoding.decodeOct reserves 0 for none).
export const decodeCenter = Fn(([dir, distance, last]: [TslNode, TslNode, TslNode]) => {
  const qx = dir.bitAnd(uint(0xffff)).shiftLeft(uint(4)).bitOr(last.shiftRight(uint(24)).bitAnd(uint(15)));
  const qy = dir.shiftRight(uint(16)).shiftLeft(uint(4)).bitOr(last.shiftRight(uint(28)));
  const x = float(qx).div(0xfffff).mul(2.0).sub(1.0).toVar();
  const y = float(qy).div(0xfffff).mul(2.0).sub(1.0).toVar();
  const z = float(1.0).sub(abs(x)).sub(abs(y)).toVar();

  const t = max(z.negate(), 0.0).toVar();
  x.addAssign(select(x.greaterThanEqual(0.0), t.negate(), t));
  y.addAssign(select(y.greaterThanEqual(0.0), t.negate(), t));

  return normalize(vec3(x, y, z)).mul(uintBitsToFloat(distance));
});

// A 2D bound in 2 words: NDC as 2x16 fixed; a 10-bit angle and 2x11-bit
// log2 scales, rounded outward (the angle's half step folded into the
// scales). Zero second word: culled.
const ANGLE_STEPS = 1024;
export function encodeBound(bound: Bound): [TslNode, TslNode] {
  const angleCode = uint(floor(bound.angle.div(Math.PI).mul(ANGLE_STEPS).add(0.5))).bitAnd(uint(ANGLE_STEPS - 1));

  const slack = max(bound.scales.x, bound.scales.y).mul(Math.sin(Math.PI / ANGLE_STEPS / 2) * 1.001).toVar();
  const scales = bound.scales.add(slack).toVar();

  return [encodeNdc(bound.ndc), angleCode.bitOr(encodeLogScale(scales.x, 11, true).shiftLeft(uint(10))).bitOr(encodeLogScale(scales.y, 11, true).shiftLeft(uint(21)))];
}

export function decodeBound(w0: TslNode, w1: TslNode): Bound {
  return {
    ndc: decodeNdc(w0),
    angle: float(w1.bitAnd(uint(ANGLE_STEPS - 1))).div(ANGLE_STEPS).mul(Math.PI),
    scales: vec2(decodeLogScale(w1.shiftRight(uint(10)).bitAnd(uint(0x7ff)), 11), decodeLogScale(w1.shiftRight(uint(21)), 11)),
  };
}

// --- The draw ---

// What a method's density reads, interpolated from its vertex step
export interface SplatVaryings {
  uv: TslNode;
  // The ray in the splat's whitened frame: its direction, and its origin
  // crossed with the direction
  localDir: TslNode;
  localCross: TslNode;
  c2: TslNode;
}

export const clipW = (viewZ: TslNode, projection: TslNode) => projection.element(2).w.mul(viewZ).add(projection.element(3).w);
export const clipZ = (viewZ: TslNode, projection: TslNode) => projection.element(2).z.mul(viewZ).add(projection.element(3).z);

// View-space point at a known view depth under an NDC position
export const unproject = Fn(([ndc, viewZ, projection]: [TslNode, TslNode, TslNode]) => {
  const w = clipW(viewZ, projection).toVar();
  return vec3(
    ndc.x.mul(w).sub(projection.element(2).x.mul(viewZ)).sub(projection.element(3).x).div(projection.element(0).x),
    ndc.y.mul(w).sub(projection.element(2).y.mul(viewZ)).sub(projection.element(3).y).div(projection.element(1).y),
    viewZ,
  );
});

// A quad corner over a 2D bound at the depth of `center` (view space)
export function boundCorner(bound: Bound, center: TslNode, corner: TslNode, projection: TslNode, renderSize: TslNode, out: TslNode) {
  const axis1 = vec2(cos(bound.angle), sin(bound.angle)).toVar();
  const axis2 = vec2(axis1.y, axis1.x.negate());
  const pixelOffset = corner.x.mul(axis1).mul(bound.scales.x).add(corner.y.mul(axis2).mul(bound.scales.y));
  const ndc = bound.ndc.add(vec2(2.0).div(renderSize).mul(pixelOffset)).toVar();

  const w = clipW(center.z, projection).toVar();
  out.get("position").assign(vec4(ndc.mul(w), clipZ(center.z, projection), w));
  return ndc;
}

// Quad around the 2D bound, evaluating the 3D Gaussian (view-space center,
// rotation and scales) along each pixel ray in its whitened frame: both are
// affine in the quad's view-space position, so interpolation is exact.
// `shrink` scales the corner when the bound is fully on screen (a clipped
// bound is a box not centered on the ellipse).
export function rayVertex(bound: Bound, center: TslNode, quat: TslNode, scales: TslNode, cornerIn: TslNode, shrink: TslNode, projection: TslNode, isOrtho: TslNode, renderSize: TslNode, out: TslNode) {
  const axis1 = vec2(cos(bound.angle), sin(bound.angle)).toVar();
  const axis2 = vec2(axis1.y, axis1.x.negate()).toVar();
  const halfSize = renderSize.mul(0.5).toVar();
  const extent = vec2(length(vec2(axis1.x.mul(bound.scales.x), axis2.x.mul(bound.scales.y))), length(vec2(axis1.y.mul(bound.scales.x), axis2.y.mul(bound.scales.y)))).toVar();
  const onScreen = all(abs(bound.ndc.mul(halfSize)).add(extent).lessThan(halfSize));

  const corner = select(onScreen, cornerIn.mul(shrink), cornerIn).toVar();
  const ndc = boundCorner(bound, center, corner, projection, renderSize, out);

  const viewPos = unproject(ndc, center.z, projection).toVar();
  const origin = select(isOrtho, vec3(viewPos.xy, 0.0), vec3(0.0)).toVar();
  const dir = select(isOrtho, vec3(0.0, 0.0, -1.0), viewPos).toVar();

  const conj = quatConj(quat).toVar();
  const localOrigin = quatRotate(conj, origin.sub(center)).div(scales).toVar();
  const localDir = quatRotate(conj, dir).div(scales).toVar();
  out.get("localDir").assign(localDir);
  out.get("localCross").assign(cross(localOrigin, localDir));
}

// Squared Mahalanobis distance of the ray's closest approach (max response):
// |o x d|^2 / |d|^2. The equal |o|^2 - (o.d)^2 / |d|^2 cancels in float32
// once |o| (distance / splat size) is in the thousands: a splat 2500 sizes
// away gets steps of 0.5 in a falloff spanning 0 to 8.
export function rayDensity(v: SplatVaryings): TslNode {
  const dd = dot(v.localDir, v.localDir).toVar();
  return select(dd.lessThanEqual(0.0), float(1e30), dot(v.localCross, v.localCross).div(max(dd, 1e-30)));
}

// Fragment alpha from the density and the vertex opacity (Spark's falloff
// shaping for LoD opacities above 1)
export function fragmentAlpha(z2: TslNode, opacity: TslNode, falloff: TslNode): TslNode {
  const alpha = opacity.toVar();
  const g = exp(z2.mul(-0.5)).toVar();

  If(alpha.lessThanEqual(1.0), () => {
    alpha.assign(mix(alpha, alpha.mul(g), falloff));
  }).Else(() => {
    const a = exp(alpha.mul(alpha).sub(1.0).div(E));
    alpha.assign(mix(1.0, float(1.0).sub(pow(float(1.0).sub(g), a)), falloff));
  });
  return alpha;
}