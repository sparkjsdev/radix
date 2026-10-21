import * as THREE from "three";
import { Splats, type BundleLike } from "../core/splats";
import type { GpuArrays } from "../gpu/GpuArrays";
import { SplatGenerator, type AnySplatGenerator, type StoredSplats } from "../gpu/splatGenerator";
import type { SplatObjectParams } from "./splatParams";

/** Splats of a generator placed in the world, one entry of a collection. */
export interface SplatObject<Data = unknown> {
  readonly generator: SplatGenerator<Data>;
  /** What generator.bind gets before each of the object's dispatches. */
  readonly data?: Data;
  readonly count: number;
  /**
   * The object's world transform, or a function returning it, read every render.
   *
   * @default the identity
   */
  matrixWorld?: THREE.Matrix4 | (() => THREE.Matrix4);
  /** Object params over the view's and the renderer's, read every render. */
  params?: Partial<SplatObjectParams>;
  /**
   * Called once no renderer uses this object any more, to free or pool what it
   * owns. Where data is shared, share one object, so this runs once.
   */
  release?: () => void;
}

/** A splat object of any data. */
export type AnySplatObject = Omit<SplatObject, "generator" | "data"> & { readonly generator: AnySplatGenerator; readonly data?: unknown };

/** An object of a collection, at its offset in the projected splats. */
export interface MappedObject {
  readonly object: AnySplatObject;
  /** The index of the object's first splat in the projected splats. */
  readonly offset: number;
}

const IDENTITY = new THREE.Matrix4();
const LOCKED = ["generator", "data", "count"] as const;

/**
 * An immutable, ordered list of the objects a renderer draws. A change in which
 * objects it holds or in their counts needs a new collection.
 */
export class SplatCollection {
  static readonly EMPTY = new SplatCollection([]);

  readonly objects: readonly MappedObject[];
  /** The number of splats in all objects. */
  readonly count: number;

  /**
   * Makes a collection, locking generator, data and count on each object.
   *
   * @param objects The objects, in drawing order.
   */
  constructor(objects: readonly AnySplatObject[]) {
    let offset = 0;
    this.objects = Object.freeze(objects.map((object) => {
      for (const key of LOCKED) {
        Object.defineProperty(object, key, { value: object[key], writable: false, configurable: false, enumerable: true });
      }
      const mapped = Object.freeze({ object, offset });
      offset += object.count;
      return mapped;
    }));
    this.count = offset;
  }

  /**
   * Checks an object's data against its generator's type.
   *
   * @return The object, unchanged.
   */
  static object<Data>(object: SplatObject<Data>): SplatObject<Data> {
    return object;
  }

  /**
   * Makes an object for splat arrays, drawn with their spherical harmonics.
   *
   * @param [options] The object's other fields, and its spherical harmonics.
   * @param [options.count=arrays.count] The number of splats.
   * @param [options.sh=4] The highest spherical-harmonics degree drawn, 0 to 4,
   *   or false for none.
   * @param [options.shPalette] The arrays of an SH palette.
   */
  static arrays(arrays: GpuArrays, { sh, shPalette, ...object }: Partial<Omit<SplatObject, "generator" | "data">> & {
    sh?: number | false;
    shPalette?: GpuArrays;
  } = {}): SplatObject<StoredSplats> {
    if (!Splats.findBundle(arrays.bundles as Record<string, BundleLike>)) {
      throw new Error("SplatCollection.arrays: no splat bundle in these arrays");
    }
    const generator = SplatGenerator.forArrays(arrays, { sh, shPalette });
    return { count: arrays.count, ...object, generator, data: { splats: arrays, shPalette } };
  }

  /**
   * Returns an object's world transform for this render.
   *
   * @return Its world transform, or the identity.
   */
  static matrixWorldOf(object: AnySplatObject): THREE.Matrix4 {
    return (typeof object.matrixWorld === "function" ? object.matrixWorld() : object.matrixWorld) ?? IDENTITY;
  }
}
