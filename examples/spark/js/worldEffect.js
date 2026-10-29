// Spark's per-mesh world modifiers (each mesh with its own uniforms, such as
// its index in a sequence) on Radix, whose renderer has one modifier for
// every object: one generator wraps fromSplats, and its bind (run before
// each object's dispatch) sets the object's index and world matrices, so
// `effect(splat, objectIndex)` sees world-space centers and scales and
// returns the changed splat. Rotations stay in object space (the effects
// here only move and scale splats). Objects' spherical harmonics are added
// first, in object space, seen from the generator context's view origin: a
// GpuShReader held by the generator, reading whatever SH each file has.
import * as THREE from "three";
import { GpuShReader, SplatGenerator, TSL,                                                                } from "@sparkjsdev/radix";
import { SplatModel } from "./objects.js";

const { uniform, vec4 } = TSL;

// An object's data: { splats, index, model, ... } (the effect's own values
// ride along)
                                
                    
                
                        
                           
 

export function worldEffectGenerator(
  effect                                                       ,
  { layout = "extSplats", perObject }                                                                      = {},
)                                {
  const base = SplatGenerator.fromSplats({ layout });
  // Degree 3 ext reads files with less SH, or none (their bands cost nothing)
  const sh = new GpuShReader({ codec: "ext", degree: 3 });
  const objectIndex = uniform(0, "int");
  const toWorld = uniform(new THREE.Matrix4());
  const toObject = uniform(new THREE.Matrix4());
  // The matrix's mean scale (scales of non-uniformly scaled objects are approximate)
  const scale = uniform(1);
  return {
    generateSplat(index, context = SplatGenerator.context) {
      const splat = sh.apply(base.generateSplat (index, context), index, context.viewOrigin).toVar();
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

// A SplatModel drawing `arrays` through such a generator, as object `index`
// (extra joins its payload: the effect's own values)
export function effectModel(generator                               , arrays           , index        , extra                          = {}) {
  const payload = { splats: arrays, index, ...extra }                 ;
  const model = new SplatModel({ generator, count: arrays.count, payload });
  payload.model = model;
  return model;
}


//# sourceURL=examples/spark/js/worldEffect.ts