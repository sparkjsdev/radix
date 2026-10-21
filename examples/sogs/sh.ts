/*!
 * The PlayCanvas engine, https://github.com/playcanvas/engine
 *
 * Copyright (c) 2011-2026 PlayCanvas Ltd.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
// Splat objects of SOG files, each splat's label picking its SH from the file's palette
import * as THREE from "three";
import {
  GpuArrayReader, Sh, SplatGenerator, TSL, defineBundle,
  type AnySplatObject, type GpuArrays, type ShCodecName, type ShDegree, type SplatLayout, type StoredSplats, type TslNode,
} from "@sparkjsdev/radix";

const { If, Loop, uint, uniform } = TSL;

// One row per range: x the object's first index in it, increasing from 0, y the
// range's first stored splat
export const RANGES_BUNDLE = defineBundle({ range: "uint32x2" });
// Binary search steps, so a table holds at most 2^RANGE_STEPS ranges
const RANGE_STEPS = 12;
export const MAX_RANGES = 1 << RANGE_STEPS;

// The stored splat of an object index, in the last range starting at or before it
export function rangeLookup(ranges: GpuArrayReader, index: TslNode): TslNode {
  const base = uint(0).toVar();
  const n = ranges.count.toVar();
  Loop(RANGE_STEPS, () => {
    If(n.greaterThan(uint(1)), () => {
      const half = n.shiftRight(uint(1)).toVar();
      If(ranges.fetch("range", base.add(half)).x.lessThanEqual(index), () => {
        base.addAssign(half);
      });
      n.subAssign(half);
    });
  });
  const range = ranges.load("range", base).toVar();
  return range.y.add(index.sub(range.x));
}

export interface SogData {
  // Splats, with bundle shLabel when the file has SH
  splats: GpuArrays;
  // A RANGES_BUNDLE table of the stored splats this object draws
  ranges?: GpuArrays;
  // An ShPalette's table on the GPU
  palette?: GpuArrays;
  // Color multiplier, read at every bind (default white)
  tint?: THREE.Color;
}

const WHITE = new THREE.Color(1, 1, 1);

function makeGenerator(layout: SplatLayout, sh: { codec: ShCodecName; degree: ShDegree } | undefined, remap: boolean): SplatGenerator<SogData> {
  const ranges = remap ? new GpuArrayReader(RANGES_BUNDLE) : undefined;
  const base = SplatGenerator.fromSplats({
    layout, remap: ranges ? (i) => rangeLookup(ranges, i) : undefined, sh: sh && { ...sh, palette: true },
  });
  const tint = uniform(new THREE.Color(1, 1, 1));
  const tinted = (splat: TslNode) => {
    const out = splat.toVar();
    out.get("rgb").assign(out.get("rgb").mul(tint));
    return out;
  };
  return {
    generateSplat: (index, context) => tinted(base.generateSplat!(index, context)),
    generateCovSplat: (index, context) => tinted(base.generateCovSplat!(index, context)),
    bind(data, context) {
      const stored: StoredSplats = { splats: data.splats, shPalette: data.palette };
      base.bind!(stored, context);
      ranges?.bind(data.ranges, "ranges");
      tint.value.copy(data.tint ?? WHITE);
    },
  };
}

const generators = new Map<string, SplatGenerator<SogData>>();

// Shared by every object of the same layout, palette (none: base colors) and remap
export function sogGenerator({ layout = "extSplats", sh, remap = false }: { layout?: SplatLayout; sh?: { codec: ShCodecName; degree: ShDegree }; remap?: boolean } = {}) {
  const key = `${layout}|${sh ? `${sh.codec}|${sh.degree}` : ""}|${remap}`;
  if (!generators.has(key)) {
    generators.set(key, makeGenerator(layout, sh, remap));
  }
  return generators.get(key)!;
}

export interface SogArrays {
  arrays: GpuArrays;
  // An ShPalette's table on the GPU (bundle shPalette)
  palette?: GpuArrays;
  degree: number;
  layout: SplatLayout;
}

export function paletteOf(file: SogArrays): { codec: ShCodecName; degree: ShDegree } | undefined {
  const meta = file.palette?.bundle("shPalette").meta;
  return meta && { codec: Sh.codec(meta.codec as string).name, degree: meta.degree as ShDegree };
}

// Draws through SH degree min(degree, the file's), set as a param so changing it compiles nothing
export function sogObject(file: SogArrays, { degree = 3, matrixWorld, ranges, count, tint, release }: {
  degree?: number;
  matrixWorld?: THREE.Matrix4;
  ranges?: GpuArrays;
  count?: number;
  tint?: THREE.Color;
  release?: () => void;
} = {}): AnySplatObject {
  const sh = paletteOf(file);
  const data: SogData = { splats: file.arrays, ranges, palette: file.palette, tint };
  return {
    generator: sogGenerator({ layout: file.layout, sh, remap: ranges !== undefined }),
    data,
    count: count ?? file.arrays.count,
    matrixWorld,
    params: { maxShDegree: Math.min(degree, sh?.degree ?? 0) },
    release,
  };
}
