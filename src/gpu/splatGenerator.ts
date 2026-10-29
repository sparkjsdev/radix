import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { ArrayData } from "../core/ArrayData";
import type { ShCodecName, ShDegree } from "../core/sh";
import { Splats, type BundleLike, type SplatLayout } from "../core/splats";
import { GpuArrayReader } from "./GpuArrayReader";
import { GpuArrays } from "./GpuArrays";
import { GpuShReader } from "./sh.tsl";
import { GpuSplatReader } from "./splatAccess";
import type { CovSplatNode, SplatNode } from "./splats.tsl";
import { TSL, type TslNode } from "./tsl";

const { uniform } = TSL;

// What Radix knows about the object being projected and the viewpoint, in
// one space: for a generator its splats' own (object) space, for a modifier
// the modifier's space. TSL nodes (uniforms set before each object's
// dispatch); more members may join later.
export interface SplatGeneratorContext {
  // The head (camera, or the eye pair's center) position
  viewOrigin: TslNode;
  // The head's viewing direction, unit
  viewForward: TslNode;
  // This space to head space and back (mat4)
  objectToHead: TslNode;
  headToObject: TslNode;
  // This space to world space (mat4)
  objectToWorld: TslNode;
}

// The same values for bind, as three.js objects (read them in bind; they
// change for the next object)
export interface SplatBindContext {
  viewOrigin: THREE.Vector3;
  viewForward: THREE.Vector3;
  objectToHead: THREE.Matrix4;
  headToObject: THREE.Matrix4;
  objectToWorld: THREE.Matrix4;
}

// Makes splat `index` in TSL: a program built once, whose inputs are slots
// (readers, uniforms) that bind(data, context) points at before each
// dispatch. It gives the forms it has; the pipeline converts to the other
// when it needs it (splat to cov is cheap, cov to splat an eigen
// decomposition). Generators set the index field. `context` tells it about
// the object and the viewpoint (SplatGeneratorContext; the projection
// always passes it, a wrapping generator may leave it out: it defaults to
// SplatGenerator.context). `Data` is what the data of its splat objects is
// (StoredSplats for fromSplats).
export type SplatGenerator<Data = unknown> =
  | {
    generateSplat(index: TslNode, context?: SplatGeneratorContext): SplatNode;
    generateCovSplat?(index: TslNode, context?: SplatGeneratorContext): CovSplatNode;
    bind?: (data: Data, context?: SplatBindContext) => void;
  }
  | {
    generateSplat?(index: TslNode, context?: SplatGeneratorContext): SplatNode;
    generateCovSplat(index: TslNode, context?: SplatGeneratorContext): CovSplatNode;
    bind?: (data: Data, context?: SplatBindContext) => void;
  };

// A generator of any data
export type AnySplatGenerator = SplatGenerator<never>;

// TSL functions of a splat in either form (fromSplats steps, a renderer's
// or view's modifier); `context` is in the modifier's space
export type SplatModifier = (splat: SplatNode, context?: SplatGeneratorContext) => SplatNode;
export type CovSplatModifier = (cov: CovSplatNode, context?: SplatGeneratorContext) => CovSplatNode;

// The data of a fromSplats generator's splat objects: the splat arrays, an
// index list (SplatGenerator.indices) with remap "indices", and the SH
// palette with sh palette mode
export interface StoredSplats {
  splats: GpuArrays;
  indices?: GpuArrays;
  shPalette?: GpuArrays;
}

// Spherical harmonics a fromSplats generator adds: a codec and degree, per
// splat (the codec's bundle in the splat arrays) or through a palette
// (bundle shLabel and StoredSplats.shPalette)
export interface SplatShOptions {
  codec: ShCodecName;
  degree: ShDegree;
  palette?: boolean;
}

// One set of context uniforms and their values
function makeContext() {
  const values: SplatBindContext = {
    viewOrigin: new THREE.Vector3(),
    viewForward: new THREE.Vector3(0, 0, -1),
    objectToHead: new THREE.Matrix4(),
    headToObject: new THREE.Matrix4(),
    objectToWorld: new THREE.Matrix4(),
  };
  const nodes: SplatGeneratorContext = {
    viewOrigin: uniform(values.viewOrigin),
    viewForward: uniform(values.viewForward),
    objectToHead: uniform(values.objectToHead),
    headToObject: uniform(values.headToObject),
    objectToWorld: uniform(values.objectToWorld),
  };
  // From this space's matrices to world and to head
  const set = (toWorld: THREE.Matrix4, toHead: THREE.Matrix4) => {
    values.objectToWorld.copy(toWorld);
    values.objectToHead.copy(toHead);
    values.headToObject.copy(toHead).invert();
    values.viewOrigin.setFromMatrixPosition(values.headToObject);
    values.viewForward.set(0, 0, -1).transformDirection(values.headToObject);
  };
  return { nodes, values, set };
}

// The generator's context (object space) and the modifier's (its space):
// render/ sets both before each object's dispatch (gpu/ cannot import it)
export const generatorContext = makeContext();
export const modifierContext = makeContext();

// Generators from templates (SplatGenerator is also the type)
export const SplatGenerator = {
  // The context nodes generators get, for code outside a generator call
  // (modifiers of fromSplats, tests)
  context: generatorContext.nodes,

  // A generator of stored splats of `layout`: splat i is the arrays' splat
  // remap(i) (entry i of an index list with "indices", or any TSL function
  // of the index; default i itself), its SH color added with `sh` (seen
  // from context.viewOrigin; GpuShReader), then each of `modifiers` in
  // turn. Its data is { splats, indices?, shPalette? }. Make it once: every
  // file of the layout and every index list then runs one program.
  fromSplats({ layout = "extSplats", remap, modifiers = [], sh }: {
    layout?: SplatLayout;
    remap?: "indices" | ((index: TslNode) => TslNode);
    modifiers?: SplatModifier[];
    sh?: SplatShOptions;
  } = {}): SplatGenerator<StoredSplats> {
    const reader = GpuSplatReader.for(layout);
    const list = remap === "indices" ? new GpuArrayReader(ArrayData.INDICES) : undefined;
    const shReader = sh ? new GpuShReader(sh) : undefined;
    const at = (i: TslNode) => (list ? list.load("index", i) : typeof remap === "function" ? remap(i) : i);
    const bind = ({ splats, indices, shPalette }: StoredSplats) => {
      reader.bind(splats);
      shReader?.bind(splats, shPalette);
      if (list) {
        if (!indices) {
          throw new Error("SplatGenerator.fromSplats: remap \"indices\" needs { splats, indices } as data");
        }
        list.bind(indices, "indices");
      }
    };
    const withSh = <N extends SplatNode | CovSplatNode>(load: (i: TslNode) => N) => (i: TslNode, context = generatorContext.nodes): N => {
      if (!shReader) {
        return load(at(i));
      }
      const stored = at(i).toVar();
      return shReader.apply(load(stored), stored, context.viewOrigin);
    };
    const loadSplat = withSh((i) => reader.loadSplat(i));
    if (modifiers.length === 0) {
      return { generateSplat: loadSplat, generateCovSplat: withSh((i) => reader.loadCovSplat(i)), bind };
    }
    return {
      generateSplat: (i, context = generatorContext.nodes) => modifiers.reduce((splat, modifier) => modifier(splat, context), loadSplat(i, context)),
      bind,
    };
  },

  // The generator for `arrays` (and `shPalette`): fromSplats of their splat
  // layout, with the SH they hold (per splat, or a palette with shPalette),
  // shared by every set of arrays of the same kind. `sh` caps the degree (0
  // or false: none); modifiers make a generator of its own.
  forArrays(arrays: GpuArrays, { remap, modifiers, sh, shPalette }: {
    remap?: "indices";
    modifiers?: SplatModifier[];
    sh?: number | false;
    shPalette?: GpuArrays;
  } = {}): SplatGenerator<StoredSplats> {
    const layout = Splats.findBundle(arrays.bundles as Record<string, BundleLike>)?.layout;
    if (!layout) {
      throw new Error("SplatGenerator.forArrays: no splat bundle in these arrays");
    }
    const found = sh === false || sh === 0 ? undefined : GpuShReader.find(arrays, shPalette);
    const shOptions = found && { codec: found.codec, degree: Math.min(sh || 4, found.degree) as ShDegree, palette: found.palette };
    if (modifiers) {
      return SplatGenerator.fromSplats({ layout, remap, modifiers, sh: shOptions });
    }
    const key = `${layout}|${remap ?? ""}|${shOptions ? `${shOptions.codec}|${shOptions.degree}|${shOptions.palette}` : ""}`;
    let generator = shared.get(key);
    if (!generator) {
      generator = SplatGenerator.fromSplats({ layout, remap, sh: shOptions });
      shared.set(key, generator);
    }
    return generator;
  },

  // An index list as GpuArrays (bundle "indices" of ArrayData.INDICES),
  // uploaded into `into` when given (its count becomes the list's)
  indices(renderer: WebGPURenderer, list: ArrayLike<number>, into?: GpuArrays): GpuArrays {
    const data = new ArrayData({ count: list.length }).addBundle("indices", ArrayData.INDICES);
    data.bundles.indices.channels.index.data.set(list);
    const arrays = into ?? new GpuArrays({ renderer, bundles: { indices: ArrayData.INDICES } });
    arrays.upload(data);
    return arrays;
  },

  // Sets the generator's context for an object placed by `objectToWorld`,
  // seen from `worldToHead`, and with `space` (a modifier's space: its
  // matrices to world and head) the modifier's (render/ calls this before
  // each object's dispatch)
  setContext(objectToWorld: THREE.Matrix4, worldToHead: THREE.Matrix4, space?: { toWorld: THREE.Matrix4; toHead: THREE.Matrix4 }) {
    generatorContext.set(objectToWorld, scratch.multiplyMatrices(worldToHead, objectToWorld));
    if (space) {
      modifierContext.set(space.toWorld, space.toHead);
    }
  },
};

const shared = new Map<string, SplatGenerator<StoredSplats>>();
const scratch = new THREE.Matrix4();
