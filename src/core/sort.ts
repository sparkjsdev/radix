import { defineBundle } from "./bundles";
import { TextureLayout } from "./layout";

/** The width of a sort key, in bits. */
export type SortKeyBits = 16 | 24 | 32;

const FLOAT_BITS_INFINITY = 0x7f800000;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

const histogramLo = new Uint32Array(65536);
const histogramHi = new Uint32Array(65536);
let scratchIndex = new Uint32Array(0);
let scratchDigit = new Uint16Array(0);

/** Back-to-front sort keys of splat distances, as the GPU computes them, and their CPU sort. */
export class SortKeys {
  /** The lowest float bits 16-bit keys cover, a distance of 2^-32. */
  static readonly KEY16_LO = 95 << 23;
  /** The highest float bits 16-bit keys cover, just below a distance of 2^32. */
  static readonly KEY16_HI = (159 << 23) - 1;

  /** The bundle projections write sort keys to, read back as a little-endian Uint32Array. */
  static readonly KEYS = defineBundle({ key: "unorm8x4" }, { serialize: false });

  /** Returns the key of splats that are not drawn, all ones. */
  static invalid(bits: SortKeyBits) {
    return 2 ** bits - 1;
  }

  /** Returns the largest valid key. */
  static validMax(bits: SortKeyBits) {
    return 0xff * 2 ** (bits - 8) - 1;
  }

  /**
   * Computes the key of a distance.
   *
   * @param distance The distance, from 0 up. Non-finite distances give the
   *   invalid key.
   */
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
    // q grows with distance, so ascending keys run back to front. Invalid keys
    // alone use the top 8-bit digit.
    return Math.min((mask ^ q) >>> 0, SortKeys.validMax(bits));
  }

  /**
   * Sorts keys stably in ascending order, with invalid keys last.
   *
   * @param [options.ordering=new Uint32Array(TextureLayout.alignCapacity(count))] The array
   *   the indices are written to.
   * @return The ordering, and visible, the number of valid keys.
   */
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

// Written out per key width, since constant shifts and masks are faster

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

// 11 + 13 bits sorts faster than 12 + 12
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
