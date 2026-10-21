import * as TSLStrict from "three/tsl";
import { TextureLayout } from "../core/layout";

const TEXTURE_WIDTH = TextureLayout.WIDTH;

/** A TSL node, typed any since @types/three's per-type nodes would need casts everywhere. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TslNode = any;

/** three/tsl with node types loosened to TslNode. */
export const TSL: Record<keyof typeof TSLStrict, TslNode> = TSLStrict;

// x = t & 1023, y = (t >> 10) & yMask, layer = t >> (10 + yBits), as in core/layout.ts
export function texelCoord(texel: TslNode, yBits: TslNode, yMask: TslNode) {
  const row = texel.shiftRight(TSL.uint(Math.log2(TEXTURE_WIDTH))).toVar();
  return { x: texel.bitAnd(TSL.uint(TEXTURE_WIDTH - 1)), y: row.bitAnd(yMask), layer: row.shiftRight(yBits) };
}
