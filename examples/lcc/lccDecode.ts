// LCC records into Radix's ext splats, after the LCC whitepaper and
// PlayCanvas splat-transform's reader. The Radix core module is passed in
// (the decode workers load radix-core.module.js by URL, the Node checks
// import the sources), so this file imports types only.
// data.bin, 32 bytes per splat as 8 uint32 words:
//   0-2  center, float32 xyz
//   3    r, g, b, opacity bytes (base color and linear opacity, / 255)
//   4    scale x u16 | scale y u16 << 16    (mix(scaleMin, scaleMax, u / 65535))
//   5    scale z u16 | rotation low 16 << 16
//   6    rotation high 16 | normal x u16 << 16
//   7    normal y u16 | normal z u16 << 16
// The rotation word is three 10-bit components of the quaternion (xyzw)
// without its largest, which is positive, then that component's index.
// shcoef.bin, 16 words per splat: word k < 15 is SH coefficient k + 1 as
// r 11 | g 10 << 11 | b 11 << 21 bits over [shMin, shMax] per channel,
// decoded (decodeLccSh) into Radix's extSh.
// environment.bin holds data.bin records, each followed by its 16 SH words
// in Quality files (96 bytes per splat), quantized over the env* ranges.
import type * as Core from "@sparkjsdev/radix/core";
import type { LccRanges } from "./LccScene.js";

const SQRT2 = Math.SQRT2;
const RSQRT2 = Math.SQRT1_2;

// The SH coefficients of splat i (45 values, 3DGS order) from its 16 words
// at words[i * 16], over the block's [shMin, shMax]
function lccShInto(words: Uint32Array, i: number, { shMin, shMax }: Pick<LccRanges, "shMin" | "shMax">, out: Float32Array) {
  const [r0, g0, b0] = shMin;
  const dr = shMax[0] - r0;
  const dg = shMax[1] - g0;
  const db = shMax[2] - b0;
  for (let k = 0; k < 15; k += 1) {
    const word = words[i * 16 + k];
    out[k * 3] = r0 + dr * ((word & 2047) / 2047);
    out[k * 3 + 1] = g0 + dg * (((word >>> 11) & 1023) / 1023);
    out[k * 3 + 2] = b0 + db * (((word >>> 21) & 2047) / 2047);
  }
}

const shWordsOf = (sh: Uint8Array, count: number) => {
  if (sh.byteLength < count * 64) {
    throw new Error(`Block SH too short: ${sh.byteLength} bytes for ${count} splats`);
  }
  const aligned = sh.byteOffset % 4 === 0 ? sh : sh.slice();
  return new Uint32Array(aligned.buffer, aligned.byteOffset, count * 16);
};

// A block's SH as floats, count * 45 (the exact values, for the checks)
export function decodeLccSh(sh: Uint8Array, count: number, ranges: Pick<LccRanges, "shMin" | "shMax">): Float32Array {
  const words = shWordsOf(sh, count);
  const out = new Float32Array(count * 45);
  const coeffs = new Float32Array(45);
  for (let i = 0; i < count; i += 1) {
    lccShInto(words, i, ranges, coeffs);
    out.set(coeffs, i * 45);
  }
  return out;
}

// The splats of one block as ext splats (bundle extSplats) and, with
// `sh`, their SH (bundle extSh)
export function decodeBlock(core: typeof Core, data: Uint8Array, sh: Uint8Array | undefined, count: number, ranges: LccRanges, normalRange?: { min: number[]; max: number[] }) {
  if (data.byteLength < count * 32) {
    throw new Error(`Block data too short: ${data.byteLength} bytes for ${count} splats`);
  }
  const aligned = data.byteOffset % 4 === 0 ? data : data.slice();
  const words = new Uint32Array(aligned.buffer, aligned.byteOffset, count * 8);
  const floats = new Float32Array(aligned.buffer, aligned.byteOffset, count * 8);

  const out = core.Splats.make(count);
  const encode = core.Splats.encoder(out.bundles.extSplats);
  const s = core.Splats.makeExtSplat();
  const [sx0, sy0, sz0] = ranges.scaleMin;
  const sdx = ranges.scaleMax[0] - sx0;
  const sdy = ranges.scaleMax[1] - sy0;
  const sdz = ranges.scaleMax[2] - sz0;
  const nMin = normalRange?.min ?? [0, 0, 0];
  const nMax = normalRange?.max ?? [0, 0, 0];
  const hasNormals = nMin.some((v, k) => v !== 0 || nMax[k] !== 0);

  for (let i = 0; i < count; i += 1) {
    const w = i * 8;
    s.center.x = floats[w];
    s.center.y = floats[w + 1];
    s.center.z = floats[w + 2];

    const color = words[w + 3];
    s.rgb.r = (color & 255) / 255;
    s.rgb.g = ((color >>> 8) & 255) / 255;
    s.rgb.b = ((color >>> 16) & 255) / 255;
    s.opacity = (color >>> 24) / 255;

    const w4 = words[w + 4];
    const w5 = words[w + 5];
    const w6 = words[w + 6];
    s.scales.x = sx0 + sdx * ((w4 & 0xffff) / 65535);
    s.scales.y = sy0 + sdy * ((w4 >>> 16) / 65535);
    s.scales.z = sz0 + sdz * ((w5 & 0xffff) / 65535);

    const rotation = ((w5 >>> 16) | (w6 << 16)) >>> 0;
    const a = (rotation & 1023) / 1023 * SQRT2 - RSQRT2;
    const b = ((rotation >>> 10) & 1023) / 1023 * SQRT2 - RSQRT2;
    const c = ((rotation >>> 20) & 1023) / 1023 * SQRT2 - RSQRT2;
    const d = Math.sqrt(1 - Math.min(1, a * a + b * b + c * c));
    const q = s.quaternion;
    switch (rotation >>> 30) {
      case 0: q.x = d; q.y = a; q.z = b; q.w = c; break;
      case 1: q.x = a; q.y = d; q.z = b; q.w = c; break;
      case 2: q.x = a; q.y = b; q.z = d; q.w = c; break;
      default: q.x = a; q.y = b; q.z = c; q.w = d;
    }

    if (hasNormals) {
      const w7 = words[w + 7];
      const nx = nMin[0] + (nMax[0] - nMin[0]) * ((w6 >>> 16) / 65535);
      const ny = nMin[1] + (nMax[1] - nMin[1]) * ((w7 & 0xffff) / 65535);
      const nz = nMin[2] + (nMax[2] - nMin[2]) * ((w7 >>> 16) / 65535);
      const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
      s.normal.x = length > 0 ? nx / length : 0;
      s.normal.y = length > 0 ? ny / length : 0;
      s.normal.z = length > 0 ? nz / length : 0;
    }
    encode(i, s);
  }

  if (sh) {
    const shWords = shWordsOf(sh, count);
    const encodeSh = core.Sh.prepare(out as unknown as Core.ArrayData, 3)!;
    const coeffs = new Float32Array(core.Sh.VALUES);
    for (let i = 0; i < count; i += 1) {
      lccShInto(shWords, i, ranges, coeffs);
      encodeSh(i, coeffs);
    }
  }
  return out;
}

// environment.bin as decodeBlock's inputs: its records, and with `sh` the
// SH bytes split from them
export function splitEnvironment(bytes: Uint8Array, sh: boolean): { count: number; data: Uint8Array; sh?: Uint8Array } {
  if (!sh) {
    return { count: Math.floor(bytes.byteLength / 32), data: bytes };
  }
  const count = Math.floor(bytes.byteLength / 96);
  const data = new Uint8Array(count * 32);
  const shBytes = new Uint8Array(count * 64);
  for (let i = 0; i < count; i += 1) {
    data.set(bytes.subarray(i * 96, i * 96 + 32), i * 32);
    shBytes.set(bytes.subarray(i * 96 + 32, i * 96 + 96), i * 64);
  }
  return { count, data, sh: shBytes };
}
