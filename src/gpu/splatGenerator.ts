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

/**
 * The object and viewpoint, as uniforms in the generator's or modifier's space.
 * Members may be added.
 */
export interface SplatGeneratorContext {
  /** The head's position, the camera's or the eyes' center. */
  viewOrigin: TslNode;
  /** The head's unit viewing direction. */
  viewForward: TslNode;
  /** A mat4 from this space to head space. */
  objectToHead: TslNode;
  /** A mat4 from head space to this space. */
  headToObject: TslNode;
  /** A mat4 from this space to world space. */
  objectToWorld: TslNode;
}

/**
 * SplatGeneratorContext's values for bind. They change for the next object, so
 * read them in bind.
 */
export interface SplatBindContext {
  /** The head's position, the camera's or the eyes' center. */
  viewOrigin: THREE.Vector3;
  /** The head's unit viewing direction. */
  viewForward: THREE.Vector3;
  objectToHead: THREE.Matrix4;
  headToObject: THREE.Matrix4;
  objectToWorld: THREE.Matrix4;
}

/**
 * Makes splat index in TSL, built once and bound to data before each dispatch.
 * Set the index field.
 */
export type SplatGenerator<Data = unknown> =
  | {
    /**
     * Makes a splat in 3DGS form.
     *
     * @param [context=SplatGenerator.context] What Radix knows about the object
     *   and the viewpoint.
     * @return The splat, with its index field set.
     */
    generateSplat(index: TslNode, context?: SplatGeneratorContext): SplatNode;
    /**
     * Makes a splat in covariance form.
     *
     * @param [context=SplatGenerator.context] What Radix knows about the object
     *   and the viewpoint.
     * @return The splat, with its index field set.
     */
    generateCovSplat?(index: TslNode, context?: SplatGeneratorContext): CovSplatNode;
    /** Points the program at an object's data before its dispatch. */
    bind?: (data: Data, context?: SplatBindContext) => void;
  }
  | {
    /**
     * Makes a splat in 3DGS form.
     *
     * @param [context=SplatGenerator.context] What Radix knows about the object
     *   and the viewpoint.
     * @return The splat, with its index field set.
     */
    generateSplat?(index: TslNode, context?: SplatGeneratorContext): SplatNode;
    /**
     * Makes a splat in covariance form.
     *
     * @param [context=SplatGenerator.context] What Radix knows about the object
     *   and the viewpoint.
     * @return The splat, with its index field set.
     */
    generateCovSplat(index: TslNode, context?: SplatGeneratorContext): CovSplatNode;
    /** Points the program at an object's data before its dispatch. */
    bind?: (data: Data, context?: SplatBindContext) => void;
  };

/** A generator of any data. */
export type AnySplatGenerator = SplatGenerator<never>;

/** A TSL function of a splat, with context in the modifier's space. */
export type SplatModifier = (splat: SplatNode, context?: SplatGeneratorContext) => SplatNode;
/** A SplatModifier of covariance splats. */
export type CovSplatModifier = (cov: CovSplatNode, context?: SplatGeneratorContext) => CovSplatNode;

/** The data of fromSplats objects. */
export interface StoredSplats {
  splats: GpuArrays;
  /** The index list for remap "indices". */
  indices?: GpuArrays;
  /** The palette for sh with palette. */
  shPalette?: GpuArrays;
}

/** SH for fromSplats, per splat or from a palette. */
export interface SplatShOptions {
  codec: ShCodecName;
  degree: ShDegree;
  /**
   * Whether the SH comes from a palette.
   *
   * @default false
   */
  palette?: boolean;
}

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
  const set = (toWorld: THREE.Matrix4, toHead: THREE.Matrix4) => {
    values.objectToWorld.copy(toWorld);
    values.objectToHead.copy(toHead);
    values.headToObject.copy(toHead).invert();
    values.viewOrigin.setFromMatrixPosition(values.headToObject);
    values.viewForward.set(0, 0, -1).transformDirection(values.headToObject);
  };
  return { nodes, values, set };
}

// render/ sets both before each dispatch, since gpu/ cannot import it
export const generatorContext = makeContext();
export const modifierContext = makeContext();

/** Generator templates, under the same name as the SplatGenerator type. */
export const SplatGenerator = {
  /** The generator context, for code outside a generator call. */
  context: generatorContext.nodes,

  /**
   * A generator of stored splats at remap(i). Make it once, so every object
   * shares one program.
   *
   * @param [options.layout="extSplats"] The layout of the splat arrays.
   * @param [options.remap] "indices" to read an index list, or a TSL function
   *   of the index, by default the index itself.
   * @param [options.modifiers=[]] Functions run in turn after the SH is added.
   */
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

  /**
   * fromSplats for the arrays' layout and SH, shared per kind unless modifiers
   * are given.
   *
   * @param [options.remap] "indices" to read an index list.
   * @param [options.modifiers] Functions run in turn, which make a generator of
   *   its own.
   * @param [options.sh] Caps the SH degree, 0 or false for none.
   */
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

  /**
   * An index list as GpuArrays.
   *
   * @param [into] Arrays to upload into instead of new ones.
   */
  indices(renderer: WebGPURenderer, list: ArrayLike<number>, into?: GpuArrays): GpuArrays {
    const data = new ArrayData({ count: list.length }).addBundle("indices", ArrayData.INDICES);
    data.bundles.indices.channels.index.data.set(list);
    const arrays = into ?? new GpuArrays({ renderer, bundles: { indices: ArrayData.INDICES } });
    arrays.upload(data);
    return arrays;
  },

  /**
   * Sets the context uniforms for an object's dispatch. The renderer calls it.
   *
   * @param [space] A modifier space's matrices to world and head.
   */
  setContext(objectToWorld: THREE.Matrix4, worldToHead: THREE.Matrix4, space?: { toWorld: THREE.Matrix4; toHead: THREE.Matrix4 }) {
    generatorContext.set(objectToWorld, scratch.multiplyMatrices(worldToHead, objectToWorld));
    if (space) {
      modifierContext.set(space.toWorld, space.toHead);
    }
  },
};

const shared = new Map<string, SplatGenerator<StoredSplats>>();
const scratch = new THREE.Matrix4();
