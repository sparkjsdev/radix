// TSL twin of SortKeys.compute (core/sort.ts), with the width a uniform
// (16, 24 or 32), so switching it rebuilds no shader. Keys travel as 4
// bytes of an RGBA8 texel: written as byte / 255 (exact), read with
// round(v * 255).
import { SortKeys } from "../core/sort";
import { TSL, type TslNode } from "./tsl";

const { clamp, floatBitsToUint, floor, max, min, select, uint, uvec4, vec4 } = TSL;

export class GpuSortKeys {
  // The invalid key of a width: all ones
  static invalid(bits: TslNode): TslNode {
    return select(bits.equal(uint(32)), uint(0xffffffff), uint(1).shiftLeft(bits).sub(uint(1)));
  }

  // Key of a distance >= 0; non-finite distances give the invalid key
  static compute(distance: TslNode, bits: TslNode): TslNode {
    const mask = GpuSortKeys.invalid(bits).toVar();
    const validMax = uint(0xff).shiftLeft(bits.sub(uint(8))).sub(uint(1));
    const f = floatBitsToUint(max(distance, 0.0)).toVar();

    const q16 = clamp(f, uint(SortKeys.KEY16_LO), uint(SortKeys.KEY16_HI)).sub(uint(SortKeys.KEY16_LO)).shiftRight(uint(13));
    const q = select(bits.equal(uint(32)), f, select(bits.equal(uint(24)), f.shiftRight(uint(7)), q16));

    return select(f.lessThan(uint(0x7f800000)), min(mask.bitXor(q), validMax), mask);
  }

  // A key as the RGBA8 texel of a SortKeys.KEYS channel
  static pack(key: TslNode): TslNode {
    return vec4(uvec4(key, key.shiftRight(uint(8)), key.shiftRight(uint(16)), key.shiftRight(uint(24))).bitAnd(uvec4(0xff))).div(255.0);
  }

  static unpack(rgba: TslNode): TslNode {
    const bytes = uvec4(floor(rgba.mul(255.0).add(0.5))).toVar();
    return bytes.x.bitOr(bytes.y.shiftLeft(uint(8))).bitOr(bytes.z.shiftLeft(uint(16))).bitOr(bytes.w.shiftLeft(uint(24)));
  }
}
