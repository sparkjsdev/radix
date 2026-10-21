// Bit layouts are documented in core/splats.ts
import { Splats, type PackedEncoding } from "../core/splats";
import { GpuEncoding, roundHalfUp } from "./encoding.tsl";
import { GpuSplatMath } from "./math.tsl";
import { generatorContext, type AnySplatGenerator, type SplatGeneratorContext } from "./splatGenerator";
import { TSL, type TslNode } from "./tsl";

const { Fn, clamp, exp, float, floatBitsToUint, log, max, min, normalize, select, sign, sqrt, struct, uint, uintBitsToFloat, uvec4, vec3, vec4, abs } = TSL;

declare const structBrand: unique symbol;
/** A struct node of known fields, branded so one kind cannot stand in for another. */
export interface StructNode<Fields extends string, Brand extends string> {
  readonly [structBrand]: Brand;
  get(field: Fields): TslNode;
  toVar(name?: string): StructNode<Fields, Brand>;
  /** Assigns the whole struct, on a var. */
  assign(value: StructNode<Fields, Brand>): unknown;
}

/** A splat's 3DGS fields, plus the uint index in what made it, 0 when unset. */
export type SplatNode = StructNode<"center" | "scales" | "quaternion" | "rgb" | "opacity" | "index", "Splat">;
/** A splat in covariance form, with diagonal (xx, yy, zz) and off-diagonal (xy, xz, yz). */
export type CovSplatNode = StructNode<"center" | "xxyyzz" | "xyxzyz" | "rgb" | "opacity" | "normal" | "index", "CovSplat">;
/** The PBR fields of a splat. */
export type PbrNode = StructNode<"normal" | "roughness" | "metallic", "Pbr">;

const SplatStruct = struct({
  center: "vec3",
  scales: "vec3",
  quaternion: "vec4",
  rgb: "vec3",
  opacity: "float",
  index: "uint",
}, "Splat");

const PbrStruct = struct({
  normal: "vec3",
  roughness: "float",
  metallic: "float",
}, "SplatPbr");

const CovSplatStruct = struct({
  center: "vec3",
  xxyyzz: "vec3",
  xyxzyz: "vec3",
  rgb: "vec3",
  opacity: "float",
  normal: "vec3",
  index: "uint",
}, "CovSplat");

// The two uint32x4 words of an ext or cov splat
const EncodedSplat = struct({ a: "uvec4", b: "uvec4" }, "EncodedSplat");

const lnHalf = (v: TslNode) => GpuEncoding.encodeHalf(log(v));
const expHalf = (h: TslNode) => exp(GpuEncoding.decodeHalf(h));

const decodeExt = Fn(([a, b]: [TslNode, TslNode]) => {
  const s = SplatStruct().toVar();
  s.get("center").assign(uintBitsToFloat(a.xyz));
  s.get("opacity").assign(GpuEncoding.decodeLodOpacity(a.w.shiftRight(uint(24))));
  s.get("rgb").assign(GpuEncoding.decodeExtRgb(b.x));
  s.get("scales").assign(vec3(expHalf(b.y), expHalf(b.y.shiftRight(uint(16))), expHalf(b.z)));
  s.get("quaternion").assign(GpuEncoding.decodeQuatOct32(b.w));
  return s;
});

const decodeExtPbr = Fn(([a, b]: [TslNode, TslNode]) => {
  const p = PbrStruct().toVar();
  p.get("normal").assign(GpuEncoding.decodeOct24(a.w.bitAnd(uint(0xffffff))));
  p.get("roughness").assign(float(b.z.shiftRight(uint(16)).bitAnd(uint(0xff))).div(255.0));
  p.get("metallic").assign(float(b.z.shiftRight(uint(24))).div(255.0));
  return p;
});

const encodeExt = Fn(([s, p]: [TslNode, TslNode]) => {
  const scales = s.get("scales").toVar();
  const a = uvec4(
    floatBitsToUint(s.get("center")),
    GpuEncoding.encodeOct24(p.get("normal")).bitOr(GpuEncoding.encodeLodOpacity(s.get("opacity")).shiftLeft(uint(24))),
  );
  const b = uvec4(
    GpuEncoding.encodeExtRgb(s.get("rgb")),
    lnHalf(scales.x).bitOr(lnHalf(scales.y).shiftLeft(uint(16))),
    lnHalf(scales.z).bitOr(GpuEncoding.encodeUnorm8(p.get("roughness")).shiftLeft(uint(16))).bitOr(GpuEncoding.encodeUnorm8(p.get("metallic")).shiftLeft(uint(24))),
    GpuEncoding.encodeQuatOct32(s.get("quaternion")),
  );
  return EncodedSplat(a, b);
});

const encodeCorrelation = Fn(([value, a, b]: [TslNode, TslNode, TslNode]) => {
  const c = clamp(value.div(sqrt(a.mul(b))), -1.0, 1.0).toVar();
  return select(c.equal(0.0), float(0.0), sign(c).mul(clamp(log(abs(c)), -100.0, -1e-7)));
});

const decodeCorrelation = (encoded: TslNode) => select(encoded.equal(0.0), float(0.0), sign(encoded).negate().mul(exp(abs(encoded).negate())));

const decodeCov = Fn(([a, b]: [TslNode, TslNode]) => {
  const c = CovSplatStruct().toVar();
  c.get("center").assign(uintBitsToFloat(a.xyz));
  c.get("normal").assign(GpuEncoding.decodeOct24(a.w.bitAnd(uint(0xffffff))));
  c.get("opacity").assign(GpuEncoding.decodeLodOpacity(a.w.shiftRight(uint(24))));
  c.get("rgb").assign(GpuEncoding.decodeExtRgb(b.x));

  const d = vec3(expHalf(b.y), expHalf(b.y.shiftRight(uint(16))), expHalf(b.z)).toVar();
  c.get("xxyyzz").assign(d);
  const correlations = vec3(
    decodeCorrelation(GpuEncoding.decodeHalf(b.z.shiftRight(uint(16)))),
    decodeCorrelation(GpuEncoding.decodeHalf(b.w)),
    decodeCorrelation(GpuEncoding.decodeHalf(b.w.shiftRight(uint(16)))),
  );
  c.get("xyxzyz").assign(correlations.mul(sqrt(vec3(d.x.mul(d.y), d.x.mul(d.z), d.y.mul(d.z)))));
  return c;
});

const encodeCov = Fn(([c]: [TslNode]) => {
  const d = c.get("xxyyzz").toVar();
  const o = c.get("xyxzyz").toVar();
  const a = uvec4(
    floatBitsToUint(c.get("center")),
    GpuEncoding.encodeOct24(c.get("normal")).bitOr(GpuEncoding.encodeLodOpacity(c.get("opacity")).shiftLeft(uint(24))),
  );
  const b = uvec4(
    GpuEncoding.encodeExtRgb(c.get("rgb")),
    lnHalf(d.x).bitOr(lnHalf(d.y).shiftLeft(uint(16))),
    lnHalf(d.z).bitOr(GpuEncoding.encodeHalf(encodeCorrelation(o.x, d.x, d.y)).shiftLeft(uint(16))),
    GpuEncoding.encodeHalf(encodeCorrelation(o.y, d.x, d.z)).bitOr(GpuEncoding.encodeHalf(encodeCorrelation(o.z, d.y, d.z)).shiftLeft(uint(16))),
  );
  return EncodedSplat(a, b);
});

// encoding is vec4(rgbMin, rgbMax, lnScaleMin, lnScaleMax)
const decodePacked = Fn(([p, encoding]: [TslNode, TslNode]) => {
  const s = SplatStruct().toVar();
  const byte = (word: TslNode, shift: number) => float(word.shiftRight(uint(shift)).bitAnd(uint(0xff)));
  const color = (v: TslNode) => encoding.x.add(v.div(255.0).mul(encoding.y.sub(encoding.x)));
  s.get("rgb").assign(vec3(color(byte(p.x, 0)), color(byte(p.x, 8)), color(byte(p.x, 16))));
  s.get("opacity").assign(byte(p.x, 24).div(255.0));
  s.get("center").assign(vec3(GpuEncoding.decodeHalf(p.y), GpuEncoding.decodeHalf(p.y.shiftRight(uint(16))), GpuEncoding.decodeHalf(p.z)));

  const step = encoding.w.sub(encoding.z).div(254.0).toVar();
  const scale = (code: TslNode) => select(code.equal(0.0), float(0.0), exp(encoding.z.add(code.sub(1.0).mul(step))));
  s.get("scales").assign(vec3(scale(byte(p.w, 0)), scale(byte(p.w, 8)), scale(byte(p.w, 16))));
  s.get("quaternion").assign(GpuEncoding.decodeQuatOct24(p.z.shiftRight(uint(16)).bitOr(p.w.shiftRight(uint(24)).shiftLeft(uint(16)))));
  return s;
});

const encodePacked = Fn(([s, encoding]: [TslNode, TslNode]) => {
  const rgb = s.get("rgb").sub(encoding.x).div(encoding.y.sub(encoding.x)).toVar();
  const x = GpuEncoding.encodeUnorm8(rgb.x).bitOr(GpuEncoding.encodeUnorm8(rgb.y).shiftLeft(uint(8))).bitOr(GpuEncoding.encodeUnorm8(rgb.z).shiftLeft(uint(16)))
    .bitOr(GpuEncoding.encodeUnorm8(s.get("opacity")).shiftLeft(uint(24)));

  const step = encoding.w.sub(encoding.z).div(254.0).toVar();
  const scale = (v: TslNode) => select(v.lessThanEqual(0.0), uint(0), uint(clamp(roundHalfUp(log(v).sub(encoding.z).div(step)).add(1.0), 1.0, 255.0)));
  const scales = s.get("scales").toVar();
  const center = s.get("center").toVar();
  const quat = GpuEncoding.encodeQuatOct24(s.get("quaternion")).toVar();
  return uvec4(
    x,
    GpuEncoding.encodeHalf(center.x).bitOr(GpuEncoding.encodeHalf(center.y).shiftLeft(uint(16))),
    GpuEncoding.encodeHalf(center.z).bitOr(quat.bitAnd(uint(0xffff)).shiftLeft(uint(16))),
    scale(scales.x).bitOr(scale(scales.y).shiftLeft(uint(8))).bitOr(scale(scales.z).shiftLeft(uint(16))).bitOr(quat.shiftRight(uint(16)).shiftLeft(uint(24))),
  );
});

const toCov = Fn(([s]: [TslNode]) => {
  const c = CovSplatStruct().toVar();
  c.get("center").assign(s.get("center"));
  c.get("rgb").assign(s.get("rgb"));
  c.get("opacity").assign(s.get("opacity"));
  c.get("normal").assign(vec3(0.0));
  c.get("index").assign(s.get("index"));
  const cov = GpuSplatMath.covFromScaleQuat(s.get("scales"), s.get("quaternion")).toVar();
  c.get("xxyyzz").assign(vec3(cov.element(0).x, cov.element(1).y, cov.element(2).z));
  c.get("xyxzyz").assign(vec3(cov.element(0).y, cov.element(0).z, cov.element(1).z));
  return c;
});

const fromCov = Fn(([c]: [TslNode]) => {
  const s = SplatStruct().toVar();
  s.get("center").assign(c.get("center"));
  s.get("rgb").assign(c.get("rgb"));
  s.get("opacity").assign(c.get("opacity"));
  s.get("index").assign(c.get("index"));
  const eigens = GpuSplatMath.symEigens(c.get("xxyyzz"), c.get("xyxzyz")).toVar();
  s.get("scales").assign(sqrt(max(eigens.get("values"), vec3(0.0))));
  s.get("quaternion").assign(GpuSplatMath.basisToQuat(eigens.get("basis")));
  return s;
});

// A plain encoding as a vec4, a node as is
const encodingVec4 = (encoding: PackedEncoding | TslNode): TslNode =>
  (encoding as TslNode).isNode ? encoding : vec4(encoding.rgbMin, encoding.rgbMax, encoding.lnScaleMin, encoding.lnScaleMax);

/** The TSL twin of the Splats codecs, plus 3DGS and covariance conversions. */
export class GpuSplats {
  /**
   * Builds a splat struct. Missing fields are zero.
   *
   * @param fields The center, scales, quaternion, rgb, opacity and index.
   */
  static readonly Splat: (...fields: TslNode[]) => SplatNode = SplatStruct;
  /**
   * Builds a covariance splat struct. Missing fields are zero.
   *
   * @param fields The center, xxyyzz, xyxzyz, rgb, opacity, normal and index.
   */
  static readonly CovSplat: (...fields: TslNode[]) => CovSplatNode = CovSplatStruct;
  /**
   * Builds a PBR struct. Missing fields are zero.
   *
   * @param fields The normal, roughness and metallic.
   */
  static readonly Pbr: (...fields: TslNode[]) => PbrNode = PbrStruct;

  /**
   * Decodes an ext splat.
   *
   * @param a The extA word.
   * @param b The extB word.
   */
  static decodeExt(a: TslNode, b: TslNode): SplatNode {
    return decodeExt(a, b);
  }

  /**
   * Decodes an ext splat's PBR fields.
   *
   * @param a The extA word.
   * @param b The extB word.
   */
  static decodeExtPbr(a: TslNode, b: TslNode): PbrNode {
    return decodeExtPbr(a, b);
  }

  /**
   * Encodes an ext splat.
   *
   * @return A struct of words a and b.
   */
  static encodeExt(s: SplatNode, p: PbrNode): TslNode {
    return encodeExt(s, p);
  }

  /**
   * Decodes a cov splat.
   *
   * @param a The covA word.
   * @param b The covB word.
   */
  static decodeCov(a: TslNode, b: TslNode): CovSplatNode {
    return decodeCov(a, b);
  }

  /**
   * Encodes a cov splat.
   *
   * @return A struct of words a and b.
   */
  static encodeCov(c: CovSplatNode): TslNode {
    return encodeCov(c);
  }

  /**
   * Decodes a packed splat.
   *
   * @param [encoding=Splats.DEFAULT_PACKED_ENCODING] A PackedEncoding or a vec4
   *   node.
   */
  static decodePacked(p: TslNode, encoding: PackedEncoding | TslNode = Splats.DEFAULT_PACKED_ENCODING): SplatNode {
    return decodePacked(p, encodingVec4(encoding));
  }

  /**
   * Encodes a packed splat.
   *
   * @param [encoding=Splats.DEFAULT_PACKED_ENCODING] A PackedEncoding or a vec4
   *   node.
   */
  static encodePacked(s: SplatNode, encoding: PackedEncoding | TslNode = Splats.DEFAULT_PACKED_ENCODING): TslNode {
    return encodePacked(s, encodingVec4(encoding));
  }

  /**
   * Writes an ext splat to a writer's outputs.
   *
   * @param [pbr] Its PBR fields, by default no normal, roughness 0 and metallic
   *   0.
   */
  static storeExt(out: { extA: TslNode; extB: TslNode }, s: SplatNode, pbr?: PbrNode) {
    const encoded = encodeExt(s, pbr ?? PbrStruct(vec3(0.0), float(0.0), float(0.0))).toVar();
    out.extA.assign(encoded.get("a"));
    out.extB.assign(encoded.get("b"));
  }

  /** Writes a cov splat to a writer's outputs. */
  static storeCov(out: { covA: TslNode; covB: TslNode }, c: CovSplatNode) {
    const encoded = encodeCov(c).toVar();
    out.covA.assign(encoded.get("a"));
    out.covB.assign(encoded.get("b"));
  }

  /**
   * Writes a packed splat to a writer's output.
   *
   * @param [encoding=Splats.DEFAULT_PACKED_ENCODING] A PackedEncoding or a vec4
   *   node.
   */
  static storePacked(out: { packed: TslNode }, s: SplatNode, encoding: PackedEncoding | TslNode = Splats.DEFAULT_PACKED_ENCODING) {
    out.packed.assign(encodePacked(s, encodingVec4(encoding)));
  }

  /** Converts a splat to covariance form, with a zero normal. */
  static toCov(s: SplatNode): CovSplatNode {
    return toCov(s);
  }

  /** Converts a cov splat to 3DGS form by a Jacobi eigen decomposition. */
  static fromCov(c: CovSplatNode): SplatNode {
    return fromCov(c);
  }

  /**
   * Generates a splat in 3DGS form, converting when the generator has only
   * covariances.
   *
   * @param [context=SplatGenerator.context] The generator context.
   */
  static splatOf(generator: AnySplatGenerator, index: TslNode, context: SplatGeneratorContext = generatorContext.nodes): SplatNode {
    return generator.generateSplat ? generator.generateSplat(index, context) : GpuSplats.fromCov(generator.generateCovSplat!(index, context));
  }

  /**
   * Generates a splat in covariance form, converting when the generator has
   * only 3DGS splats.
   *
   * @param [context=SplatGenerator.context] The generator context.
   */
  static covSplatOf(generator: AnySplatGenerator, index: TslNode, context: SplatGeneratorContext = generatorContext.nodes): CovSplatNode {
    return generator.generateCovSplat ? generator.generateCovSplat(index, context) : GpuSplats.toCov(generator.generateSplat!(index, context));
  }

  /**
   * Sets a splat struct's index field.
   *
   * @return A var of the struct.
   */
  static withIndex<N extends SplatNode | CovSplatNode>(node: N, index: TslNode): N {
    const v = (node as SplatNode).toVar();
    v.get("index").assign(uint(index));
    return v as N;
  }

  /**
   * The rotated axis of a splat's smallest scale, a flat splat's normal.
   *
   * @return The unit normal.
   */
  static normalOf(s: SplatNode): TslNode {
    const scales = s.get("scales").toVar();
    const axis = select(scales.x.lessThanEqual(min(scales.y, scales.z)), vec3(1.0, 0.0, 0.0), select(scales.y.lessThanEqual(scales.z), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0)));
    return GpuSplatMath.quatRotate(normalize(s.get("quaternion")), axis);
  }
}
