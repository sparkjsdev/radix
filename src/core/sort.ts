// Back-to-front sort keys of splat distances and their stable CPU radix
// sort. The GPU computes the same keys (GpuSortKeys); the CPU only sorts
// them, and WgpuRadixSort sorts them into the same order.
//
// f, the float32 bits of a distance >= 0 (sign bit 0), maps to a code q
// that grows with distance: 32-bit q = f; 24-bit q = f >>> 7 (8 exponent
// and 16 mantissa bits); 16-bit q keeps 6 exponent bits (distances
// 2^-32..2^32, clamped outside) and 10 mantissa bits. key = min(mask ^ q,
// validMax), so ascending keys run back to front. Invalid splats (culled,
// non-finite distance) get `mask`: the top 8-bit digit is reserved for
// them, so they sort last.
import { defineBundle } from "./bundles";
import { TextureLayout } from "./layout";

export type SortKeyBits = 16 | 24 | 32;

const FLOAT_BITS_INFINITY = 0x7f800000;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

const histogramLo = new Uint32Array(65536);
const histogramHi = new Uint32Array(65536);
let scratchIndex = new Uint32Array(0);
let scratchDigit = new Uint16Array(0);

export class SortKeys {
  // The float bits 16-bit keys cover (distances 2^-32..2^32)
  static readonly KEY16_LO = 95 << 23;
  static readonly KEY16_HI = (159 << 23) - 1;

  // Sort keys as projections write them: the 4 bytes of a key per RGBA8
  // texel, read back as a Uint32Array (little-endian)
  static readonly KEYS = defineBundle({ key: "unorm8x4" }, { serialize: false });

  // The invalid key of a width: all ones
  static invalid(bits: SortKeyBits) {
    return 2 ** bits - 1;
  }

  static validMax(bits: SortKeyBits) {
    return 0xff * 2 ** (bits - 8) - 1;
  }

  // Key of a distance >= 0; non-finite distances give the invalid key
  static compute(distance: number, bits: SortKeyBits): number {
    const mask = SortKeys.invalid(bits);
    f32[0] = distance;
    const f = u32[0];
    if (!(f < FLOAT_BITS_INFINITY)) {
      return mask;
    }

    const q = bits === 32 ? f
      : bits === 24 ? f >>> 7
      : (Math.min(Math.max(f, SortKeys.KEY16_LO), SortKeys.KEY16_HI) - SortKeys.KEY16_LO) >>> 13;
    return Math.min((mask ^ q) >>> 0, SortKeys.validMax(bits));
  }

  // Stable ascending sort of `count` keys into `ordering` (indices; by
  // default a whole capacity, as an ArrayData.INDICES channel holds). Invalid keys sort
  // last; `visible` counts the others. 16-bit keys take one counting pass,
  // 24-bit keys two LSD passes of 11 and 13 bits, 32-bit keys two of 16.
  static sort<O extends Uint32Array = Uint32Array<ArrayBuffer>>({ keys, count, bits, ordering = new Uint32Array(TextureLayout.alignCapacity(count)) as O }: {
    keys: Uint32Array;
    count: number;
    bits: SortKeyBits;
    ordering?: O;
  }): { ordering: O; visible: number } {
    if (ordering.length < count) {
      throw new Error(`SortKeys.sort: ordering holds ${ordering.length} of ${count} indices`);
    }
    if (scratchIndex.length < count) {
      scratchIndex = new Uint32Array(count);
      scratchDigit = new Uint16Array(count);
    }

    const visible = bits === 16 ? sort1x16(keys, count, ordering)
      : bits === 24 ? sort11x13(keys, count, ordering)
      : sort2x16(keys, count, ordering);
    return { ordering, visible };
  }
}

function prefixSum(histogram: Uint32Array, last: number) {
  let sum = 0;
  for (let d = 0; d <= last; d += 1) {
    const n = histogram[d];
    histogram[d] = sum;
    sum += n;
  }
}

// Written out per layout so each hot loop has constant shifts and masks,
// which measured 6-9% faster than one function taking the digit width

function sort1x16(keys: Uint32Array, count: number, ordering: Uint32Array) {
  const histogram = histogramLo;
  histogram.fill(0);
  for (let i = 0; i < count; i += 1) {
    histogram[keys[i] & 0xffff] += 1;
  }

  const visible = count - histogram[0xffff];
  prefixSum(histogram, 0xffff);
  for (let i = 0; i < count; i += 1) {
    ordering[histogram[keys[i] & 0xffff]++] = i;
  }
  return visible;
}

// 11 + 13 measured 10-20% faster than 12 + 12 (bench-core.ts)
function sort11x13(keys: Uint32Array, count: number, ordering: Uint32Array) {
  const lo = histogramLo;
  const hi = histogramHi;
  lo.fill(0, 0, 2048);
  hi.fill(0, 0, 8192);
  for (let i = 0; i < count; i += 1) {
    const k = keys[i];
    lo[k & 0x7ff] += 1;
    hi[k >>> 11] += 1;
  }

  const visible = count - hi[0x1fff];
  prefixSum(lo, 0x7ff);
  prefixSum(hi, 0x1fff);
  for (let i = 0; i < count; i += 1) {
    const k = keys[i];
    const pos = lo[k & 0x7ff]++;
    scratchIndex[pos] = i;
    scratchDigit[pos] = k >>> 11;
  }
  for (let j = 0; j < count; j += 1) {
    ordering[hi[scratchDigit[j]]++] = scratchIndex[j];
  }
  return visible;
}

function sort2x16(keys: Uint32Array, count: number, ordering: Uint32Array) {
  const lo = histogramLo;
  const hi = histogramHi;
  lo.fill(0);
  hi.fill(0);
  for (let i = 0; i < count; i += 1) {
    const k = keys[i];
    lo[k & 0xffff] += 1;
    hi[k >>> 16] += 1;
  }

  const visible = count - hi[0xffff];
  prefixSum(lo, 0xffff);
  prefixSum(hi, 0xffff);
  for (let i = 0; i < count; i += 1) {
    const k = keys[i];
    const pos = lo[k & 0xffff]++;
    scratchIndex[pos] = i;
    scratchDigit[pos] = k >>> 16;
  }
  for (let j = 0; j < count; j += 1) {
    ordering[hi[scratchDigit[j]]++] = scratchIndex[j];
  }
  return visible;
}
