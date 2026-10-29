// Drawing SOG splats with their spherical harmonics: each splat's label
// (bundle shLabel, beside the splats) picks an entry of the file's palette
// (an ext ShPalette's table), through Radix's built-in SH
// (SplatGenerator.fromSplats with a palette; the color is seen from each
// view's origin in the object's space). One generator per (layout, codec,
// degree, remap) serves every object of that kind; an object's degree is
// objectParams.maxShDegree, so changing it compiles nothing. bind() points it
// at an object's arrays, ranges, palette and tint before the object's
// dispatch.
import * as THREE from "three";
import {
  GpuArrayReader, Sh, SplatGenerator, TSL, defineBundle,
  type AnySplatObject, type GpuArrays, type ShCodecName, type ShDegree, type SplatLayout, type StoredSplats, type TslNode,
} from "@sparkjsdev/radix";

const { If, Loop, uint, uniform } = TSL;

// An object drawing ranges of a file's splats: one row per range, x the
// object's first index in it (rows in increasing x, the first 0), y the
// range's first stored splat
export const RANGES_BUNDLE = defineBundle({ range: "uint32x2" });
// Ranges a table may hold: 2^RANGE_STEPS
const RANGE_STEPS = 12;
export const MAX_RANGES = 1 << RANGE_STEPS;

// The stored splat of object index `index`: a binary search for the last
// range starting at or before it (a reader of RANGES_BUNDLE)
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

// What a SOG generator binds per object
export interface SogData {
  // Splats, with bundle shLabel when the file has SH
  splats: GpuArrays;
  // Remap "ranges": the ranges of stored splats this object draws
  ranges?: GpuArrays;
  // The SH palette (an ShPalette's table on the GPU)
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

// The shared generator of objects of `layout`, with a palette of `sh`
// (none: base colors), whole or through a table of ranges
export function sogGenerator({ layout = "extSplats", sh, remap = false }: { layout?: SplatLayout; sh?: { codec: ShCodecName; degree: ShDegree }; remap?: boolean } = {}) {
  const key = `${layout}|${sh ? `${sh.codec}|${sh.degree}` : ""}|${remap}`;
  if (!generators.has(key)) {
    generators.set(key, makeGenerator(layout, sh, remap));
  }
  return generators.get(key)!;
}

// A SOG file on the GPU
export interface SogArrays {
  arrays: GpuArrays;
  // An ShPalette's table on the GPU (bundle shPalette)
  palette?: GpuArrays;
  degree: number;
  layout: SplatLayout;
}

// The codec and degree of a file's palette
export function paletteOf(file: SogArrays): { codec: ShCodecName; degree: ShDegree } | undefined {
  const meta = file.palette?.bundle("shPalette").meta;
  return meta && { codec: Sh.codec(meta.codec as string).name, degree: meta.degree as ShDegree };
}

// A splat object drawing `file` (all of it, or the `count` splats of a
// RANGES_BUNDLE table `ranges`) through SH degree min(degree, the file's),
// placed by `matrixWorld`
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
