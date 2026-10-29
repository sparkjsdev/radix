import type { Quat, Rgb, Vec3 } from "./math";

const floatViews = new WeakMap<Uint32Array, Float32Array<ArrayBuffer>>();

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const Float16 = (globalThis as { Float16Array?: new (length: number) => { [index: number]: number; buffer: ArrayBuffer } }).Float16Array;
const f16 = Float16 ? new Float16(1) : undefined;
const u16 = f16 ? new Uint16Array(f16.buffer) : undefined;

interface OctCodec {
  encode(v: Vec3): number;
  decode(code: number, out: Vec3): Vec3;
}

interface QuatCodec {
  encode(q: Quat): number;
  decode(code: number, out: Quat): Quat;
}

// Octahedral direction, `bits` per axis: u | v << bits. The direction is
// folded onto the octahedron and each coordinate rounded. Code 0 means "no
// vector": a direction rounding to 0 (-Z) gets the all-ones code instead,
// which decodes to the same direction.
function makeOctCodec(bits: number): OctCodec {
  if (bits < 1 || bits > 16) {
    throw new Error(`Octahedral codes take 1 to 16 bits per axis, not ${bits}`);
  }
  const max = 2 ** bits - 1;
  const allOnes = (max | (max << bits)) >>> 0;

  return {
    encode(v) {
      const l1 = Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z);
      if (!(l1 > 0)) {
        return 0;
      }
      let px = v.x / l1;
      let py = v.y / l1;
      if (v.z < 0) {
        const ax = Math.abs(px);
        px = (1 - Math.abs(py)) * (px >= 0 ? 1 : -1);
        py = (1 - ax) * (py >= 0 ? 1 : -1);
      }
      const code = (Math.round((px * 0.5 + 0.5) * max) | (Math.round((py * 0.5 + 0.5) * max) << bits)) >>> 0;
      return code === 0 ? allOnes : code;
    },

    decode(code, out) {
      if (code === 0) {
        out.x = 0;
        out.y = 0;
        out.z = 0;
        return out;
      }
      let x = ((code & max) / max) * 2 - 1;
      let y = (((code >>> bits) & max) / max) * 2 - 1;
      const z = 1 - Math.abs(x) - Math.abs(y);
      const t = Math.max(-z, 0);
      x += x >= 0 ? -t : t;
      y += y >= 0 ? -t : t;

      const length = Math.sqrt(x * x + y * y + z * z);
      out.x = x / length;
      out.y = y / length;
      out.z = z / length;
      return out;
    },
  };
}

// Axis (octahedral, 2 * axisBits) in the low bits, angle 0..pi above, for
// the quaternion with w >= 0; a zero quaternion encodes as the identity (0).
// At most 32 bits, so the code unpacks with shifts and masks.
function makeQuatCodec(axisBits: number, angleBits: number): QuatCodec {
  const axisCodeBits = 2 * axisBits;
  if (axisCodeBits + angleBits > 32) {
    throw new Error(`Quaternion codes hold at most 32 bits, not ${axisCodeBits + angleBits}`);
  }
  const oct = makeOctCodec(axisBits);
  const axisMask = 2 ** axisCodeBits - 1;
  const angleMax = 2 ** angleBits - 1;
  const axis: Vec3 = { x: 0, y: 0, z: 0 };

  return {
    encode(q) {
      // Not Math.hypot: it guards against overflow and is several times slower
      const length = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
      if (!(length > 0)) {
        return 0;
      }
      const s = (q.w < 0 ? -1 : 1) / length;
      axis.x = q.x * s;
      axis.y = q.y * s;
      axis.z = q.z * s;
      const angle = 2 * Math.acos(Math.min(1, q.w * s));
      const angleCode = Math.round((angle / Math.PI) * angleMax);
      return (oct.encode(axis) | (angleCode << axisCodeBits)) >>> 0;
    },

    decode(code, out) {
      oct.decode(code & axisMask, out);
      const angle = (((code >>> axisCodeBits) & angleMax) / angleMax) * Math.PI;
      const s = Math.sin(angle / 2);
      out.x *= s;
      out.y *= s;
      out.z *= s;
      out.w = Math.cos(angle / 2);
      return out;
    },
  };
}

const octCodecs = new Map<number, OctCodec>();
const quatCodecs = new Map<string, QuatCodec>();

function octCodec(bits: number) {
  let codec = octCodecs.get(bits);
  if (!codec) {
    codec = makeOctCodec(bits);
    octCodecs.set(bits, codec);
  }
  return codec;
}

function quatCodec(axisBits: number, angleBits: number) {
  const key = `${axisBits}:${angleBits}`;
  let codec = quatCodecs.get(key);
  if (!codec) {
    codec = makeQuatCodec(axisBits, angleBits);
    quatCodecs.set(key, codec);
  }
  return codec;
}

const oct24 = octCodec(12);
const quatOct32 = quatCodec(10, 12);
const quatOct24 = quatCodec(8, 8);

// Scalar and vector packers of the splat codecs (GpuEncoding is the TSL
// twin). Fixed-size codecs name the total bits of the code: Oct24 is a 12 +
// 12 bit octahedral direction, QuatOct32 a 10 + 10 bit octahedral axis and a
// 12-bit angle, QuatOct24 8 + 8 and 8.
export class Encoding {
  // The same memory as floats, cached per array
  static floatView(u32: Uint32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
    let view = floatViews.get(u32);
    if (!view) {
      view = new Float32Array(u32.buffer, u32.byteOffset, u32.length);
      floatViews.set(u32, view);
    }
    return view;
  }

  // Half-float bits of f, rounded to nearest even (like the GPU's packHalf2x16)
  static encodeHalf(f: number): number {
    if (f16 && u16) {
      f16[0] = f;
      return u16[0];
    }

    f32[0] = f;
    const bits = u32[0];
    const sign = (bits >>> 16) & 0x8000;
    const exponent = (bits >>> 23) & 0xff;
    const mantissa = bits & 0x7fffff;
    if (exponent === 0xff) {
      return sign | 0x7c00 | (mantissa ? 0x200 : 0);
    }

    const e = exponent - 127 + 15;
    if (e >= 0x1f) {
      return sign | 0x7c00;
    }
    if (e <= 0) {
      // Subnormal: multiples of 2^-24, ties to even
      const m = Math.abs(f32[0]) * 2 ** 24;
      let rounded = Math.floor(m);
      const fraction = m - rounded;
      if (fraction > 0.5 || (fraction === 0.5 && (rounded & 1))) {
        rounded += 1;
      }
      return sign | rounded;
    }

    const half = sign | (e << 10) | (mantissa >> 13);
    const rest = mantissa & 0x1fff;
    return rest > 0x1000 || (rest === 0x1000 && (half & 1)) ? half + 1 : half;
  }

  static decodeHalf(h: number): number {
    const sign = h & 0x8000 ? -1 : 1;
    const exponent = (h >> 10) & 0x1f;
    const mantissa = h & 0x3ff;
    if (exponent === 0) {
      return sign * mantissa * 2 ** -24;
    }
    if (exponent === 0x1f) {
      return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    }
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
  }

  static encodeUnorm8(v: number) {
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  }

  // 128 = 1.0; merged LoD nodes can exceed 1, up to 255 / 128
  static encodeLodOpacity(opacity: number) {
    return Math.max(0, Math.min(255, Math.round(opacity * 128)));
  }

  static decodeLodOpacity(byte: number) {
    return byte / 128;
  }

  // 8-bit magnitudes, 3 sign bits and a 5-bit shared exponent, so colors may
  // exceed 1 or be negative
  static encodeExtRgb({ r, g, b }: Rgb): number {
    const maxAbs = Math.max(Math.abs(r), Math.abs(g), Math.abs(b));
    const base = Math.max(0, Math.min(31, (maxAbs > 0 ? Math.ceil(Math.log2(maxAbs)) : 0) + 15));
    // Magnitudes are |v| / (2^e / 255), as |v| * (255 * 2^-e): exact, so a
    // value halfway between two steps rounds up here and on the GPU alike
    const scale = 255 * 2 ** (15 - base);
    const mr = Math.min(255, Math.round(Math.abs(r) * scale));
    const mg = Math.min(255, Math.round(Math.abs(g) * scale));
    const mb = Math.min(255, Math.round(Math.abs(b) * scale));

    const signs = (r < 0 ? 1 : 0) | (g < 0 ? 2 : 0) | (b < 0 ? 4 : 0);
    return (mr | (mg << 8) | (mb << 16) | (((base << 3) | signs) << 24)) >>> 0;
  }

  static decodeExtRgb(encoded: number, out: Rgb): Rgb {
    const unit = 2 ** (((encoded >>> 27) & 0x1f) - 15) / 255;
    out.r = (encoded & 0xff) * unit * (encoded & 0x1000000 ? -1 : 1);
    out.g = ((encoded >>> 8) & 0xff) * unit * (encoded & 0x2000000 ? -1 : 1);
    out.b = ((encoded >>> 16) & 0xff) * unit * (encoded & 0x4000000 ? -1 : 1);
    return out;
  }

  // Octahedral direction with `bits` per axis (1 to 16)
  static encodeOct(v: Vec3, bits: number): number {
    return octCodec(bits).encode(v);
  }

  static decodeOct(code: number, bits: number, out: Vec3): Vec3 {
    return octCodec(bits).decode(code, out);
  }

  // Octahedral axis with `axisBits` per axis plus an `angleBits` angle (at
  // most 32 bits in all)
  static encodeQuatOct(q: Quat, axisBits: number, angleBits: number): number {
    return quatCodec(axisBits, angleBits).encode(q);
  }

  static decodeQuatOct(code: number, axisBits: number, angleBits: number, out: Quat): Quat {
    return quatCodec(axisBits, angleBits).decode(code, out);
  }

  static readonly encodeOct24: (v: Vec3) => number = oct24.encode;
  static readonly decodeOct24: (code: number, out: Vec3) => Vec3 = oct24.decode;
  static readonly encodeQuatOct32: (q: Quat) => number = quatOct32.encode;
  static readonly decodeQuatOct32: (code: number, out: Quat) => Quat = quatOct32.decode;
  static readonly encodeQuatOct24: (q: Quat) => number = quatOct24.encode;
  static readonly decodeQuatOct24: (code: number, out: Quat) => Quat = quatOct24.decode;
}
