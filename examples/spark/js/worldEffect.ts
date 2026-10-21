// Spark's per-mesh world modifiers as one generator that binds each object's index and matrices
import * as THREE from "three";
import { GpuShReader, SplatGenerator, TSL, type GpuArrays, type SplatLayout, type SplatNode, type TslNode } from "@sparkjsdev/radix";
import { SplatModel } from "./objects.js";

const { uniform, vec4 } = TSL;

// Extra fields hold the effect's own values
export interface EffectPayload {
  splats: GpuArrays;
  index: number;
  model: THREE.Object3D;
  [extra: string]: unknown;
}

export function worldEffectGenerator(
  effect: (splat: SplatNode, objectIndex: TslNode) => SplatNode,
  { layout = "extSplats", perObject }: { layout?: SplatLayout; perObject?: (data: EffectPayload) => void } = {},
): SplatGenerator<EffectPayload> {
  const base = SplatGenerator.fromSplats({ layout });
  // Degree 3 ext reads files with less SH, or none (their bands cost nothing)
  const sh = new GpuShReader({ codec: "ext", degree: 3 });
  const objectIndex = uniform(0, "int");
  const toWorld = uniform(new THREE.Matrix4());
  const toObject = uniform(new THREE.Matrix4());
  // The matrix's mean scale, approximate for non-uniform scales; rotations stay
  // in object space, as the effects here only move and scale splats
  const scale = uniform(1);
  return {
    generateSplat(index, context = SplatGenerator.context) {
      const splat = sh.apply(base.generateSplat!(index, context), index, context.viewOrigin).toVar();
      splat.get("center").assign(toWorld.mul(vec4(splat.get("center"), 1)).xyz);
      splat.get("scales").assign(splat.get("scales").mul(scale));
      const out = effect(splat, objectIndex).toVar();
      out.get("center").assign(toObject.mul(vec4(out.get("center"), 1)).xyz);
      out.get("scales").assign(out.get("scales").div(scale));
      return out;
    },
    // perObject(data) sets the effect's own per-object uniforms
    bind(data, context) {
      base.bind?.(data, context);
      sh.bind(data.splats);
      objectIndex.value = data.index;
      const matrix = data.model.matrixWorld;
      toWorld.value.copy(matrix);
      toObject.value.copy(matrix).invert();
      scale.value = Math.cbrt(Math.abs(matrix.determinant()));
      perObject?.(data);
    },
  };
}

// extra holds the effect's own values for the payload
export function effectModel(generator: SplatGenerator<EffectPayload>, arrays: GpuArrays, index: number, extra: Record<string, unknown> = {}) {
  const payload = { splats: arrays, index, ...extra } as EffectPayload;
  const model = new SplatModel({ generator, count: arrays.count, payload });
  payload.model = model;
  return model;
}
