// Math.round is floor(x + 0.5). Near a rounding boundary f32 math can leave a
// code one step off the CPU's f64 result.
import { TSL, type TslNode } from "./tsl";

const {
  Fn, If, abs, acos, ceil, clamp, cos, float, floor, int, length, log2, max, min, normalize, packHalf2x16, select, sin, uint,
  uintBitsToFloat, unpackHalf2x16, vec2, vec3, vec4,
} = TSL;

const PI = Math.PI;

// Math.round for x >= 0
export const roundHalfUp = (x: TslNode) => floor(x.add(0.5));

const encodeExtRgb = Fn(([rgb]: [TslNode]) => {
  const absRgb = abs(rgb).toVar();
  const maxAbs = max(absRgb.x, max(absRgb.y, absRgb.z)).toVar();
  const base = clamp(int(select(maxAbs.greaterThan(0.0), ceil(log2(maxAbs)), float(0.0))).add(int(15)), int(0), int(31)).toVar();
  // 255 * 2^(15 - base) from float bits, exact so halfway magnitudes round up
  // as on the CPU
  const scale = uintBitsToFloat(uint(int(142).sub(base)).shiftLeft(uint(23))).mul(255.0).toVar();
  const magnitude = (v: TslNode) => uint(min(roundHalfUp(v.mul(scale)), 255.0));

  const signs = select(rgb.x.lessThan(0.0), uint(1), uint(0))
    .bitOr(select(rgb.y.lessThan(0.0), uint(2), uint(0)))
    .bitOr(select(rgb.z.lessThan(0.0), uint(4), uint(0)));
  return magnitude(absRgb.x).bitOr(magnitude(absRgb.y).shiftLeft(uint(8))).bitOr(magnitude(absRgb.z).shiftLeft(uint(16)))
    .bitOr(uint(base).shiftLeft(uint(3)).bitOr(signs).shiftLeft(uint(24)));
});

const decodeExtRgb = Fn(([encoded]: [TslNode]) => {
  // 2^(e - 15) from float bits, exact and cheaper than exp2
  const unit = uintBitsToFloat(encoded.shiftRight(uint(27)).add(uint(112)).shiftLeft(uint(23))).div(255.0).toVar();
  const channel = (shift: number, signBit: number) => {
    const value = float(encoded.shiftRight(uint(shift)).bitAnd(uint(0xff))).mul(unit);
    return select(encoded.bitAnd(uint(signBit)).notEqual(uint(0)), value.negate(), value);
  };
  return vec3(channel(0, 0x1000000), channel(8, 0x2000000), channel(16, 0x4000000));
});

const octDecoders = new Map<number, TslNode>();
const octEncoders = new Map<number, TslNode>();

// Unit direction of code (u | v << bits), zero for code 0
function octDecoder(bits: number) {
  let decode = octDecoders.get(bits);
  if (!decode) {
    const maxCode = 2 ** bits - 1;
    decode = Fn(([c]: [TslNode]) => {
      const x = float(c.bitAnd(uint(maxCode))).div(maxCode).mul(2.0).sub(1.0).toVar();
      const y = float(c.shiftRight(uint(bits)).bitAnd(uint(maxCode))).div(maxCode).mul(2.0).sub(1.0).toVar();
      const z = float(1.0).sub(abs(x)).sub(abs(y)).toVar();
      const t = max(z.negate(), 0.0).toVar();
      x.addAssign(select(x.greaterThanEqual(0.0), t.negate(), t));
      y.addAssign(select(y.greaterThanEqual(0.0), t.negate(), t));
      return select(c.equal(uint(0)), vec3(0.0), normalize(vec3(x, y, z)));
    });
    octDecoders.set(bits, decode);
  }
  return decode;
}

// Code 0 means no vector, so a direction rounding to it gets all ones, also -Z
function octEncoder(bits: number) {
  let encode = octEncoders.get(bits);
  if (!encode) {
    const maxCode = 2 ** bits - 1;
    const allOnes = (maxCode | (maxCode << bits)) >>> 0;
    encode = Fn(([dir]: [TslNode]) => {
      const result = uint(0).toVar();
      const l1 = abs(dir.x).add(abs(dir.y)).add(abs(dir.z)).toVar();
      If(l1.greaterThan(0.0), () => {
        const p = dir.xy.div(l1).toVar();
        If(dir.z.lessThan(0.0), () => {
          const px = p.x.toVar();
          p.x.assign(float(1.0).sub(abs(p.y)).mul(select(px.greaterThanEqual(0.0), float(1.0), float(-1.0))));
          p.y.assign(float(1.0).sub(abs(px)).mul(select(p.y.greaterThanEqual(0.0), float(1.0), float(-1.0))));
        });
        const uw = p.mul(0.5).add(0.5).mul(maxCode).toVar();
        const code = uint(roundHalfUp(uw.x)).bitOr(uint(roundHalfUp(uw.y)).shiftLeft(uint(bits))).toVar();
        result.assign(select(code.equal(uint(0)), uint(allOnes), code));
      });
      return result;
    });
    octEncoders.set(bits, encode);
  }
  return encode;
}

function encodeQuatOct(q: TslNode, axisBits: number, angleBits: number): TslNode {
  const angleMax = 2 ** angleBits - 1;
  const result = uint(0).toVar();
  const len = length(q).toVar();
  If(len.greaterThan(0.0), () => {
    const s = select(q.w.lessThan(0.0), float(-1.0), float(1.0)).div(len).toVar();
    const angle = acos(min(q.w.mul(s), 1.0)).mul(2.0);
    const angleCode = uint(roundHalfUp(angle.div(PI).mul(angleMax)));
    result.assign(octEncoder(axisBits)(q.xyz.mul(s)).bitOr(angleCode.shiftLeft(uint(2 * axisBits))));
  });
  return result;
}

function decodeQuatOct(code: TslNode, axisBits: number, angleBits: number): TslNode {
  const angleMax = 2 ** angleBits - 1;
  const axis = octDecoder(axisBits)(code.bitAnd(uint(2 ** (2 * axisBits) - 1)));
  const half = float(code.shiftRight(uint(2 * axisBits)).bitAnd(uint(angleMax))).div(angleMax).mul(PI / 2).toVar();
  return vec4(axis.mul(sin(half)), cos(half));
}

/** The TSL twin of Encoding, with the same bit layouts. */
export class GpuEncoding {
  /** Encodes a float as half-float bits in the low 16 bits. */
  static encodeHalf(f: TslNode): TslNode {
    return packHalf2x16(vec2(f, 0.0)).bitAnd(uint(0xffff));
  }

  /** Encodes two half floats in a uint, x in the low 16 bits and y in the high. */
  static encodeHalf2(v: TslNode): TslNode {
    return packHalf2x16(v);
  }

  /** Decodes two half floats, x from the low 16 bits and y from the high. */
  static decodeHalf2(word: TslNode): TslNode {
    return unpackHalf2x16(word);
  }

  /** Decodes the half float in the low 16 bits. */
  static decodeHalf(h: TslNode): TslNode {
    return unpackHalf2x16(h.bitAnd(uint(0xffff))).x;
  }

  /** Encodes a value from 0 to 1 as a byte, clamping it. */
  static encodeUnorm8(v: TslNode): TslNode {
    return uint(roundHalfUp(clamp(v, 0.0, 1.0).mul(255.0)));
  }

  /** Encodes an opacity as a byte where 128 is 1, up to 255 / 128. */
  static encodeLodOpacity(opacity: TslNode): TslNode {
    return uint(clamp(roundHalfUp(max(opacity, 0.0).mul(128.0)), 0.0, 255.0));
  }

  /** Decodes an opacity byte where 128 is 1. */
  static decodeLodOpacity(byte: TslNode): TslNode {
    return float(byte).div(128.0);
  }

  /** Encodes RGB as 8-bit magnitudes, 3 sign bits and a 5-bit shared exponent. */
  static readonly encodeExtRgb: (rgb: TslNode) => TslNode = encodeExtRgb;
  /** Decodes RGB from 8-bit magnitudes, 3 sign bits and a 5-bit shared exponent. */
  static readonly decodeExtRgb: (encoded: TslNode) => TslNode = decodeExtRgb;

  /**
   * Encodes a direction as an octahedral code.
   *
   * @param bits Bits per axis, a number the shader is specialized to.
   * @return The code, 0 for a zero vector.
   */
  static encodeOct(v: TslNode, bits: number): TslNode {
    return octEncoder(bits)(v);
  }

  /**
   * Decodes an octahedral code.
   *
   * @param bits Bits per axis.
   * @return The unit direction, zero for code 0.
   */
  static decodeOct(code: TslNode, bits: number): TslNode {
    return octDecoder(bits)(code);
  }

  /**
   * Encodes a quaternion as an octahedral axis in the low 2 * axisBits bits and
   * an angle from 0 to pi above, with w >= 0.
   *
   * @return The code, 0 for a zero quaternion.
   */
  static readonly encodeQuatOct = encodeQuatOct;
  /** Decodes a quaternion from an octahedral axis and an angle. */
  static readonly decodeQuatOct = decodeQuatOct;

  /** Encodes a direction in 12 + 12 bits. */
  static encodeOct24(v: TslNode): TslNode {
    return octEncoder(12)(v);
  }

  /** Decodes a direction from 12 + 12 bits. */
  static decodeOct24(code: TslNode): TslNode {
    return octDecoder(12)(code);
  }

  /** Encodes a quaternion as a 10 + 10 bit axis and a 12-bit angle. */
  static encodeQuatOct32(q: TslNode): TslNode {
    return encodeQuatOct(q, 10, 12);
  }

  /** Decodes a quaternion from a 10 + 10 bit axis and a 12-bit angle. */
  static decodeQuatOct32(code: TslNode): TslNode {
    return decodeQuatOct(code, 10, 12);
  }

  /** Encodes a quaternion as an 8 + 8 bit axis and an 8-bit angle. */
  static encodeQuatOct24(q: TslNode): TslNode {
    return encodeQuatOct(q, 8, 8);
  }

  /** Decodes a quaternion from an 8 + 8 bit axis and an 8-bit angle. */
  static decodeQuatOct24(code: TslNode): TslNode {
    return decodeQuatOct(code, 8, 8);
  }
}
