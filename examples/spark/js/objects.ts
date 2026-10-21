// Splat objects with SplatMesh-like handles on Radix's collections, for the larger ports
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import {
  ArrayData, SplatCollection, SplatGenerator, SplatRenderer, TSL,
  type AnySplatGenerator, type AnySplatObject, type GpuArrays, type SplatModifier, type SplatObjectParams, type SplatRendererOptions, type StoredSplats,
} from "@sparkjsdev/radix";
import { fileOf, loadSplatFile, type LoadOptions, type LoadedFile } from "./files.js";
import { SplatPicker } from "./raycast.js";

const { uniform } = TSL;

interface FadeData extends StoredSplats {
  opacity: number;
  tint: THREE.Vector3;
}

// Multiplies in the object's opacity and tint, which Radix has no object param for
function fadeGenerator(base: SplatGenerator<StoredSplats>): SplatGenerator<FadeData> {
  const opacity = uniform(1);
  const tint = uniform(new THREE.Vector3(1, 1, 1));
  return {
    generateSplat(index, context) {
      const out = base.generateSplat!(index, context).toVar();
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

// One per base generator, which forArrays shares between arrays of one kind
const shared = new WeakMap<object, SplatGenerator<FadeData>>();
function sharedFade(base: SplatGenerator<StoredSplats>) {
  if (!shared.has(base)) {
    shared.set(base, fadeGenerator(base));
  }
  return shared.get(base)!;
}

const pickers = new WeakMap<ArrayData, SplatPicker>();

// A picker's centers may be edited in place; after forgetPicker the next call
// reads the table again
export function pickerOf(data: ArrayData) {
  if (!pickers.has(data)) {
    pickers.set(data, new SplatPicker(data));
  }
  return pickers.get(data)!;
}

export function forgetPicker(data: ArrayData) {
  pickers.delete(data);
}

const inverse = new THREE.Matrix4();
const linear = new THREE.Matrix3();
const origin = new THREE.Vector3();
const dir = new THREE.Vector3();

export function raycastSplats(raycaster: THREE.Raycaster, data: ArrayData, matrixWorld: THREE.Matrix4) {
  inverse.copy(matrixWorld).invert();
  origin.copy(raycaster.ray.origin).applyMatrix4(inverse);
  dir.copy(raycaster.ray.direction).applyMatrix3(linear.setFromMatrix4(inverse));
  // An affine map keeps the ray's parameter: t is the world distance
  const hit = pickerOf(data).intersect(origin, dir, raycaster.near, raycaster.far);
  return hit && { distance: hit.t, point: raycaster.ray.at(hit.t, new THREE.Vector3()), index: hit.index };
}

export interface SplatModelOptions {
  // A LoadedFile's fields; data enables raycast()
  arrays?: GpuArrays;
  data?: ArrayData;
  indices?: GpuArrays;
  shPalette?: GpuArrays;
  modifiers?: SplatModifier[];
  opacity?: number;
  // Or a generator of its own: a count of splats and a payload of its objects' data
  generator?: AnySplatGenerator;
  count?: number;
  payload?: unknown;
  // Runs once no renderer draws the object any more
  release?: () => void;
}

export type StoredModel = SplatModel & { data: ArrayData; arrays: GpuArrays };


export class SplatModel extends THREE.Object3D {
  readonly isSplatModel = true;
  arrays?: GpuArrays;
  data?: ArrayData;
  splatObject: AnySplatObject & { matrixWorld: THREE.Matrix4 };
  private tint = new THREE.Color(1, 1, 1);

  constructor({ arrays, data, indices, shPalette, modifiers, opacity = 1, generator, count, payload, release }: SplatModelOptions = {}) {
    super();
    this.arrays = arrays;
    this.data = data;
    if (arrays) {
      const base = SplatGenerator.forArrays(arrays, { remap: indices ? "indices" : undefined, modifiers, shPalette });
      generator ??= modifiers ? fadeGenerator(base) : sharedFade(base);
      const fade: FadeData = { splats: arrays, indices, shPalette, opacity, tint: new THREE.Vector3(1, 1, 1) };
      payload = fade;
      count ??= indices ? indices.count : arrays.count;
    }
    this.splatObject = { generator: generator!, data: payload, count: count!, matrixWorld: this.matrixWorld, release };
  }

  private get fade() {
    return this.splatObject.data as FadeData | undefined;
  }

  get opacity() {
    return this.fade?.opacity ?? 1;
  }

  set opacity(value) {
    if (this.fade) {
      this.fade.opacity = value;
    }
  }

  // Spark's SplatMesh.recolor
  get recolor(): THREE.Color {
    return this.tint;
  }

  set recolor(color: THREE.Color) {
    this.tint.copy(color);
    this.fade?.tint.set(color.r, color.g, color.b);
  }

  get params(): Partial<SplatObjectParams> {
    return (this.splatObject.params ??= {});
  }

  raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
    const hit = this.data && raycastSplats(raycaster, this.data, this.matrixWorld);
    if (hit) {
      intersects.push({ ...hit, object: this });
    }
  }
}

// Visible and in a scene, which keeps its matrixWorld current
function shown(object: THREE.Object3D) {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (!node.visible) {
      return false;
    }
    if ((node as THREE.Scene).isScene) {
      return true;
    }
  }
  return false;
}

export type SplatSetOptions = Partial<Omit<SplatRendererOptions, "renderer">> & {
  renderer: WebGPURenderer;
  scene: THREE.Scene;
  // The splats move by uniforms, so the CPU sort sorts every render
  animate?: boolean;
};

export class SplatSet {
  renderer: SplatRenderer;
  models: SplatModel[] = [];
  private gpu: WebGPURenderer;
  private scene: THREE.Scene;
  private shownKey = "";

  constructor({ renderer, scene, animate = false, ...options }: SplatSetOptions) {
    this.gpu = renderer;
    this.scene = scene;
    const splatRenderer = new SplatRenderer({ renderer, ...options });
    this.renderer = splatRenderer;
    // Its geometry has no positions for THREE.Raycaster to test
    splatRenderer.raycast = () => {};
    scene.add(splatRenderer);

    // Before it projects, the collection follows the models shown
    const project = splatRenderer.onBeforeRender.bind(splatRenderer);
    splatRenderer.onBeforeRender = (...args: Parameters<SplatRenderer["onBeforeRender"]>) => {
      this.update();
      if (animate && splatRenderer.sortMode === "cpu") {
        splatRenderer.requestSort();
      }
      project(...args);
    };
  }

  async load(url: string, { layout, encoding, onProgress, sh, ...options }: LoadOptions & Omit<SplatModelOptions, keyof LoadedFile> = {}) {
    return this.of(await loadSplatFile(this.gpu, url, { layout, encoding, onProgress, sh }), options);
  }

  // Models of one loaded file share its upload
  of(file: LoadedFile | ArrayData, options: Omit<SplatModelOptions, keyof LoadedFile> = {}): StoredModel {
    const loaded = file instanceof ArrayData ? fileOf(this.gpu, file) : file;
    const model = new SplatModel({ ...loaded, ...options }) as StoredModel;
    this.add(model);
    return model;
  }

  add(...models: SplatModel[]) {
    for (const model of models) {
      if (!model.parent) {
        this.scene.add(model);
      }
      if (!this.models.includes(model)) {
        this.models.push(model);
      }
    }
  }

  remove(...models: SplatModel[]) {
    this.models = this.models.filter((model) => !models.includes(model));
  }

  // Collections are immutable, so a new one when the shown models change
  update() {
    const visible = this.models.filter(shown);
    const key = visible.map((model) => model.id).join(",");
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.renderer.collection = new SplatCollection(visible.map((model) => model.splatObject));
    }
  }
}
