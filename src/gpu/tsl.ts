import * as TSLStrict from "three/tsl";
import { TextureLayout } from "../core/layout";

const TEXTURE_WIDTH = TextureLayout.WIDTH;

// Handle to a TSL node in shader-building code. TSL infers shader types when
// the material is built; the per-type Node<"vec3"> typings in @types/three
// would force a cast on nearly every expression.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TslNode = any;

// three/tsl with export names checked but node types loosened to TslNode:
// `const { Fn, vec3, ... } = TSL;`
export const TSL: Record<keyof typeof TSLStrict, TslNode> = TSLStrict;

// Where texel `texel` (uint) sits (core/layout.ts): x = t & 1023,
// y = (t >> 10) & yMask, layer = t >> (10 + yBits)
export function texelCoord(texel: TslNode, yBits: TslNode, yMask: TslNode) {
  const row = texel.shiftRight(TSL.uint(Math.log2(TEXTURE_WIDTH))).toVar();
  return { x: texel.bitAnd(TSL.uint(TEXTURE_WIDTH - 1)), y: row.bitAnd(yMask), layer: row.shiftRight(yBits) };
}
