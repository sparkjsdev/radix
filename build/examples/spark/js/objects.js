// Splat objects with SplatMesh-like handles, on Radix's collections, for
// the larger ports (the simple ones use SplatCollection directly):
//   SplatModel  an Object3D placing a loaded file (or a generator) in the
//               scene: its matrixWorld is the splat object's; opacity
//               and recolor (a tint) per object, set in the generator's bind
//               (Radix has no per-object opacity or tint param); raycast()
//               so THREE.Raycaster can hit it (raycast.ts)
//   SplatSet    one SplatRenderer drawing a set of models in one sort; before
//               each render its collection follows the models shown (a
//               collection is immutable)
import * as THREE from "three";
                                                   
import {
  ArrayData, SplatCollection, SplatGenerator, SplatRenderer, TSL,
                                                                                                                                                        
} from "@sparkjsdev/radix";
import { fileOf, loadSplatFile,                                   } from "./files.js";
import { SplatPicker } from "./raycast.js";

const { uniform } = TSL;

// The data a fade generator binds per object
                                         
                  
                      
 

// `base` (a stored-splat generator, its SH included), then the object's
// `opacity` and `tint` multiplied in
function fadeGenerator(base                              )                           {
  const opacity = uniform(1);
  const tint = uniform(new THREE.Vector3(1, 1, 1));
  return {
    generateSplat(index, context) {
      const out = base.generateSplat (index, context).toVar();
      out.get("opacity").assign(out.get("opacity").mul(opacity));
      out.get("rgb").assign(out.get("rgb").mul(tint));
      return out;
    },
    bind(data, context) {
      base.bind?.(data, context);
      opacity.value = data.opacity;
      tint.value.copy(data.tint);
    },
  };
}

// Fade generators without modifiers, one per shared base generator (arrays
// of the same kind)
const shared = new WeakMap                                  ();
function sharedFade(base                              ) {
  if (!shared.has(base)) {
    shared.set(base, fadeGenerator(base));
  }
  return shared.get(base) ;
}

// One picker per loaded table, shared by the models drawing it
const pickers = new WeakMap                        ();

// The picker of a table (its centers can be edited in place); forgetPicker
// after editing the table wholesale
export function pickerOf(data           ) {
  if (!pickers.has(data)) {
    pickers.set(data, new SplatPicker(data));
  }
  return pickers.get(data) ;
}

export function forgetPicker(data           ) {
  pickers.delete(data);
}

const inverse = new THREE.Matrix4();
const linear = new THREE.Matrix3();
const origin = new THREE.Vector3();
const dir = new THREE.Vector3();

// The nearest splat of a table placed by `matrixWorld` along the raycaster's ray
// (a CPU test, raycast.ts): { distance, point, index }, or undefined
export function raycastSplats(raycaster                 , data           , matrixWorld               ) {
  inverse.copy(matrixWorld).invert();
  origin.copy(raycaster.ray.origin).applyMatrix4(inverse);
  dir.copy(raycaster.ray.direction).applyMatrix3(linear.setFromMatrix4(inverse));
  // An affine map keeps the ray's parameter: t is the world distance
  const hit = pickerOf(data).intersect(origin, dir, raycaster.near, raycaster.far);
  return hit && { distance: hit.t, point: raycaster.ray.at(hit.t, new THREE.Vector3()), index: hit.index };
}

                                    
                                                                          
                                                                             
                                                   
                     
                   
                      
                        
                              
                   
                                                                           
                                
                 
                    
                                                    
                       
 

// A model drawing a loaded table (SplatSet.load / of)
                                                                              


export class SplatModel extends THREE.Object3D {
           isSplatModel = true;
  arrays            ;
  data            ;
  splatObject                                                 ;
          tint = new THREE.Color(1, 1, 1);

  constructor({ arrays, data, indices, shPalette, modifiers, opacity = 1, generator, count, payload, release }                    = {}) {
    super();
    this.arrays = arrays;
    this.data = data;
    if (arrays) {
      const base = SplatGenerator.forArrays(arrays, { remap: indices ? "indices" : undefined, modifiers, shPalette });
      generator ??= modifiers ? fadeGenerator(base) : sharedFade(base);
      const fade           = { splats: arrays, indices, shPalette, opacity, tint: new THREE.Vector3(1, 1, 1) };
      payload = fade;
      count ??= indices ? indices.count : arrays.count;
    }
    this.splatObject = { generator: generator , data: payload, count: count , matrixWorld: this.matrixWorld, release };
  }

          get fade() {
    return this.splatObject.data                        ;
  }

  get opacity() {
    return this.fade?.opacity ?? 1;
  }

  set opacity(value) {
    if (this.fade) {
      this.fade.opacity = value;
    }
  }

  // A color multiplying every splat's (Spark's SplatMesh.recolor)
  get recolor()              {
    return this.tint;
  }

  set recolor(color             ) {
    this.tint.copy(color);
    this.fade?.tint.set(color.r, color.g, color.b);
  }

  // Object params of this object (blurAmount, focalDistance, ...)
  get params()                             {
    return (this.splatObject.params ??= {});
  }

  // THREE.Raycaster support: the nearest splat along the ray
  raycast(raycaster                 , intersects                      ) {
    const hit = this.data && raycastSplats(raycaster, this.data, this.matrixWorld);
    if (hit) {
      intersects.push({ ...hit, object: this });
    }
  }
}

// Whether a model is visible and in a scene (its matrixWorld kept current)
function shown(object                ) {
  for (let node                        = object; node; node = node.parent) {
    if (!node.visible) {
      return false;
    }
    if ((node               ).isScene) {
      return true;
    }
  }
  return false;
}

                                                                                 
                           
                     
                                                                         
                             
                    
  

// One SplatRenderer (added to the scene) drawing a set of models
export class SplatSet {
  renderer               ;
  models               = [];
          gpu                ;
          scene             ;
          shownKey = "";

  constructor({ renderer, scene, animate = false, ...options }                 ) {
    this.gpu = renderer;
    this.scene = scene;
    const splatRenderer = new SplatRenderer({ renderer, ...options });
    this.renderer = splatRenderer;
    // Its geometry has no positions for THREE.Raycaster to test
    splatRenderer.raycast = () => {};
    scene.add(splatRenderer);

    // Before it projects: the collection of the models shown now
    const project = splatRenderer.onBeforeRender.bind(splatRenderer);
    splatRenderer.onBeforeRender = (...args                                             ) => {
      this.update();
      if (animate && splatRenderer.sortMode === "cpu") {
        splatRenderer.requestSort();
      }
      project(...args);
    };
  }

  // A model of a splat file, added to the set
  async load(url        , { layout, encoding, onProgress, sh, ...options }                                                          = {}) {
    return this.of(await loadSplatFile(this.gpu, url, { layout, encoding, onProgress, sh }), options);
  }

  // A model of a loaded file (or a table, uploaded here), added to the set;
  // models of one file share its upload
  of(file                        , options                                            = {})              {
    const loaded = file instanceof ArrayData ? fileOf(this.gpu, file) : file;
    const model = new SplatModel({ ...loaded, ...options })               ;
    this.add(model);
    return model;
  }

  // Models without a parent go into the scene
  add(...models              ) {
    for (const model of models) {
      if (!model.parent) {
        this.scene.add(model);
      }
      if (!this.models.includes(model)) {
        this.models.push(model);
      }
    }
  }

  remove(...models              ) {
    this.models = this.models.filter((model) => !models.includes(model));
  }

  // A new collection when the shown models changed
  update() {
    const visible = this.models.filter(shown);
    const key = visible.map((model) => model.id).join(",");
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.renderer.collection = new SplatCollection(visible.map((model) => model.splatObject));
    }
  }
}


//# sourceURL=examples/spark/js/objects.ts