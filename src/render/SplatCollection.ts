import * as THREE from "three";
import { Splats, type BundleLike } from "../core/splats";
import type { GpuArrays } from "../gpu/GpuArrays";
import { SplatGenerator, type AnySplatGenerator, type StoredSplats } from "../gpu/splatGenerator";
import type { SplatObjectParams } from "./splatParams";

// One object of a collection: `count` splats of a generator, placed in the
// world by `matrixWorld`. A collection locks generator, data and count on
// the object itself; matrixWorld, params and release can still be reassigned.
export interface SplatObject<Data = unknown> {
  readonly generator: SplatGenerator<Data>;
  // What generator.bind gets before the object's dispatch ({ splats,
  // indices? } for fromSplats); nothing is bound when undefined
  readonly data?: Data;
  readonly count: number;
  // The object's world transform (object to world), read every render: a
  // matrix (an Object3D's matrixWorld, say) or a function returning one;
  // default the identity. Rotations times a uniform scale take the cheap
  // path; any other matrix goes through covariances.
  matrixWorld?: THREE.Matrix4 | (() => THREE.Matrix4);
  // Over the view's and renderer's objectParams, read every render
  params?: Partial<SplatObjectParams>;
  // Runs once this object is in no live collection of any SplatRenderer
  // (none draws it, sorts it or may still apply an order for it): free or
  // pool what the object owns. Use one object wherever it is shared.
  release?: () => void;
}

// An object of any data
export type AnySplatObject = Omit<SplatObject, "generator" | "data"> & { readonly generator: AnySplatGenerator; readonly data?: unknown };

// An object of a collection, at its offset in the projected splats
export interface MappedObject {
  readonly object: AnySplatObject;
  readonly offset: number;
}

const IDENTITY = new THREE.Matrix4();
const LOCKED = ["generator", "data", "count"] as const;

// Which splats to draw: an immutable, ordered collection of objects
// (generator, data and count locked; matrixWorld and params stay live). Its
// identity is its version: change which objects it holds or how many
// splats, and make a new collection. The order of objects matters:
// projected splat i of the collection is splat i - offset of the object
// holding it, which is what a CPU sort's order indexes.
export class SplatCollection {
  static readonly EMPTY = new SplatCollection([]);

  readonly objects: readonly MappedObject[];
  // Splats in all
  readonly count: number;

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

  // An object whose data is checked against its generator's
  static object<Data>(object: SplatObject<Data>): SplatObject<Data> {
    return object;
  }

  // An object for splat arrays (all of them unless `count` says
  // otherwise), drawn with the spherical harmonics they hold (per splat, or
  // through `shPalette`; `sh` caps the degree, 0 or false: none): one shared
  // generator per kind (SplatGenerator.forArrays), so arrays of the same
  // kind run one program
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

  // An object's world transform this render, or the identity
  static matrixWorldOf(object: AnySplatObject): THREE.Matrix4 {
    return (typeof object.matrixWorld === "function" ? object.matrixWorld() : object.matrixWorld) ?? IDENTITY;
  }
}
