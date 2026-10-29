// The generators drawing LCC blocks and chunk files: stored ext splats with a
// per-object tint ("color by level") and their spherical harmonics through
// Radix's built-in SH (SplatGenerator.fromSplats; the color is seen from
// each view's origin in the object's space, so any placement of the scene
// stays correct). LCC v1 blocks decode their SH words into Radix's extSh
// on the workers (lccDecode.ts), as LCC2's .spz / .ply chunks load theirs
// (lccChunk.ts); .sog chunks keep SOG's palette (examples/sogs/sh.ts). The
// drawn degree is objectParams.maxShDegree.
// With `remap`, an object draws row ranges of its arrays (LCC2 chunk files
// shared by several nodes): a table of examples/sogs/sh.ts's RANGES_BUNDLE,
// looked up per splat by rangeLookup.
import * as THREE from "three";
import { GpuArrayReader, SplatGenerator, TSL, type GpuArrays, type SplatGenerator as Generator, type TslNode } from "@sparkjsdev/radix";
import { RANGES_BUNDLE, rangeLookup } from "../sogs/sh.js";

const { uniform } = TSL;

// What a block's (or chunk file's) objects bind
export interface LccBlockData {
  splats: GpuArrays;
  // With remap: the RANGES_BUNDLE table of the rows drawn
  rows?: GpuArrays;
  tint: THREE.Color;
}

const generators = new Map<string, Generator<LccBlockData>>();

// The shared generator of a kind: with or without SH (extSh), whole or
// remapped
export function lccGenerator({ sh = false, remap = false }: { sh?: boolean; remap?: boolean }): Generator<LccBlockData> {
  const key = `${sh}|${remap}`;
  if (!generators.has(key)) {
    generators.set(key, makeGenerator(sh, remap));
  }
  return generators.get(key)!;
}

function makeGenerator(sh: boolean, remap: boolean): Generator<LccBlockData> {
  const rows = remap ? new GpuArrayReader(RANGES_BUNDLE) : undefined;
  const base = SplatGenerator.fromSplats({
    remap: rows ? (index) => rangeLookup(rows, index) : undefined,
    sh: sh ? { codec: "ext", degree: 3 } : undefined,
  });
  const tint = uniform(new THREE.Color(1, 1, 1));
  const tinted = (splat: TslNode) => {
    const out = splat.toVar();
    out.get("rgb").assign(out.get("rgb").mul(tint));
    return out;
  };
  return {
    generateSplat: (i, context) => tinted(base.generateSplat!(i, context)),
    generateCovSplat: (i, context) => tinted(base.generateCovSplat!(i, context)),
    bind(data, context) {
      base.bind!({ splats: data.splats }, context);
      rows?.bind(data.rows, "ranges");
      tint.value.copy(data.tint);
    },
  };
}
