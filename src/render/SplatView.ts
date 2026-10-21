import * as THREE from "three";
import { ArrayData } from "../core/ArrayData";
import { SortKeys, type SortKeyBits } from "../core/sort";
import { isWebGPUBackend } from "../gpu/backend";
import { GpuArrays } from "../gpu/GpuArrays";
import type { CovSplatModifier, SplatModifier } from "../gpu/splatGenerator";
import { SplatCamera } from "./splatCamera";
import { SplatCollection } from "./SplatCollection";
import type { SplatObjectParams, SplatViewParams } from "./splatParams";
import { projectCollection, readSortKeys, type ProjectSettings } from "./SplatProjector";
import type { SplatRenderer } from "./SplatRenderer";
import type { ModifierSpace } from "./splatTransform.tsl";

/** A draw order of a collection, made by SplatView.sort. */
export interface SplatOrder {
  /** The collection it was sorted for. */
  readonly collection: SplatCollection;
  /** Counts the view's sorts, in the order they started. */
  readonly version: number;
  /** Splat indices back to front. */
  readonly ordering: Uint32Array<ArrayBuffer>;
  /** How many of the indices are drawn. */
  readonly visible: number;
  /** The key pass and readback, in wall milliseconds. */
  readonly keysMs: number;
  /** The worker sort, in wall milliseconds. */
  readonly sortMs: number;
}

/**
 * How far the camera may move or turn since the last sort before autoSort
 * re-sorts. A new collection, a moved object or a requested sort re-sorts too.
 */
export interface AutoSort {
  /** The movement, in world units. */
  distance: number;
  /** The turn, in radians, checked only with a sortGuard set. */
  angle: number;
}

/** The settings SplatRenderer.viewFor sets on a view. */
export interface SplatViewOptions {
  /** What the view draws instead of the renderer's collection. */
  collection?: SplatCollection;
  params?: Partial<SplatViewParams>;
  objectParams?: Partial<SplatObjectParams>;
  /** A modifier over the renderer's, or null for none. */
  modifier?: SplatModifier | null;
  /** A covariance modifier over the renderer's, or null for none. */
  covModifier?: CovSplatModifier | null;
  modifierSpace?: ModifierSpace;
  /** The sort key width, in bits. */
  sortBits?: SortKeyBits;
  /** When the CPU sort re-sorts, or false for only on request. */
  autoSort?: AutoSort | false;
}

export interface ViewSettings extends ProjectSettings {
  collection: SplatCollection;
  autoSort: AutoSort | false;
}

/**
 * One viewpoint of a SplatRenderer, whose unset settings follow the renderer's.
 * With the CPU sort it draws its applied order, from sort and apply or from
 * autoSort.
 */
export class SplatView {
  /** The renderer this view belongs to. */
  readonly splats: SplatRenderer;
  readonly key: unknown;
  params: Partial<SplatViewParams> = {};
  objectParams: Partial<SplatObjectParams> = {};
  /** A modifier over the renderer's, or null for none. */
  modifier?: SplatModifier | null;
  /** A covariance modifier over the renderer's, or null for none. */
  covModifier?: CovSplatModifier | null;
  modifierSpace?: ModifierSpace;
  /** The sort key width in bits, over the renderer's. */
  sortBits?: SortKeyBits;
  /** When the CPU sort re-sorts, over the renderer's, or false for only on request. */
  autoSort?: AutoSort | false;

  private _collection?: SplatCollection;
  private _order?: SplatOrder;
  private orderArrays?: GpuArrays;
  private sorts = 0;
  // cpu mode: collections of sorts in flight and of the newest unapplied order, by version
  private pending = new Map<number, SplatCollection>();
  private landed = 0;
  private keyArrays: GpuArrays[] = [];
  private disposed = false;
  private autoSorting = false;
  private sortRequested = false;
  private sortedFrom?: {
    collection: SplatCollection; bits: SortKeyBits; position: THREE.Vector3; quaternion: THREE.Quaternion; projection: number[]; matrices: number[][];
  };

  /** @internal Made by SplatRenderer.viewFor */
  constructor(splats: SplatRenderer, key: unknown) {
    this.splats = splats;
    this.key = key;
  }

  /** What this view draws instead of the renderer's collection. */
  get collection(): SplatCollection | undefined {
    return this._collection;
  }

  set collection(collection: SplatCollection | undefined) {
    this._collection = collection;
    this.splats.updateLive();
  }

  /** The applied order, whose collection is drawn. */
  get order(): SplatOrder | undefined {
    return this._order;
  }

  /** Sorts again at the next render, for changes autoSort can't see. */
  requestSort() {
    this.wantSort();
    if (!this.autoSorting) {
      this.splats.onInvalidate?.(this);
    }
  }

  /**
   * Sorts the view's collection from a camera, on a worker. In gpu mode it needs
   * the renderer's sortWorker.
   */
  async sort(camera: THREE.Camera): Promise<SplatOrder> {
    this.checkDisposed();
    if (this.splats.sortMode === "gpu" && !this.splats.sortWorker) {
      throw new Error("SplatView.sort: a CPU sort needs sortMode \"cpu\" or a sortWorker");
    }
    const settings = this.splats.settingsOf(this);
    const { collection, sortBits: bits } = settings;
    const version = (this.sorts += 1);
    if (this.splats.sortMode === "cpu") {
      this.pending.set(version, collection);
      this.splats.updateLive();
    }
    try {
      let ordering = new Uint32Array(0);
      let visible = 0;
      const timing = { keysMs: 0, sortMs: 0 };
      if (collection.count > 0) {
        const renderer = this.splats.renderer;
        const keys = this.keyArrays.pop() ?? new GpuArrays({ renderer, bundles: { sortKeys: SortKeys.KEYS }, storage: isWebGPUBackend(renderer) });
        const start = performance.now();
        let read: Uint32Array<ArrayBuffer>;
        try {
          SplatCamera.set(renderer, camera);
          projectCollection({ renderer, settings, collection, arrays: keys, pass: "keys" });
          this.checkDisposed();
          read = await readSortKeys(keys, collection.count);
        } finally {
          if (this.disposed) {
            keys.dispose();
          } else {
            this.keyArrays.push(keys);
          }
        }
        this.checkDisposed();
        const sorting = performance.now();
        ({ ordering, visible } = await this.splats.sortKeys(read, bits));
        this.checkDisposed();
        timing.keysMs = sorting - start;
        timing.sortMs = performance.now() - sorting;
      }
      this.land(version);
      return { collection, version, ordering, visible, ...timing };
    } catch (error) {
      if (this.pending.delete(version)) {
        this.splats.updateLive();
      }
      throw error;
    }
  }

  /**
   * Draws an order from now on, in cpu mode.
   *
   * @param order An order from this view's sort.
   * @return Whether it was applied, false once a later sort's order landed or was
   *   applied.
   */
  apply(order: SplatOrder): boolean {
    if (this.disposed || this.splats.sortMode !== "cpu" || !this.pending.has(order.version)) {
      return false;
    }
    const data = new ArrayData({ count: order.visible }).addBundle("indices", ArrayData.INDICES, { data: { index: order.ordering } });
    this.orderArrays ??= new GpuArrays({ renderer: this.splats.renderer, bundles: { indices: ArrayData.INDICES }, capacity: 1 });
    this.orderArrays.upload(data);
    this._order = order;
    for (const version of [...this.pending.keys()]) {
      if (version <= order.version) {
        this.pending.delete(version);
      }
    }
    this.landed = this.landed > order.version ? this.landed : 0;
    this.splats.updateLive();
    return true;
  }

  /** Frees the view and takes it off its renderer. */
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.orderArrays?.dispose();
    this.keyArrays.forEach((keys) => keys.dispose());
    this.keyArrays = [];
    this._order = undefined;
    this.pending.clear();
    this.splats.forget(this);
  }

  /**
   * @internal SplatRenderer's, before a render in cpu mode, after
   * autoSort's step: the applied order's collection, with its indices
   */
  drawn(camera: THREE.Camera): { collection: SplatCollection; arrays: GpuArrays; visible: number } | undefined {
    this.autoSortStep(camera);
    return this._order && this.orderArrays && { collection: this._order.collection, arrays: this.orderArrays, visible: this._order.visible };
  }

  /** @internal The collections this view holds live: its own, and in cpu mode its orders' */
  collections(): SplatCollection[] {
    const collections = this._collection ? [this._collection] : [];
    if (this._order) {
      collections.push(this._order.collection);
    }
    this.pending.forEach((collection) => collections.push(collection));
    return collections;
  }

  /** @internal requestSort without onInvalidate (cpu mode only) */
  wantSort() {
    if (this.splats.sortMode === "cpu") {
      this.sortRequested = true;
    }
  }

  /** @internal The renderer switched to gpu: the orders go */
  dropOrders() {
    this._order = undefined;
    this.pending.clear();
    this.landed = 0;
    this.sortRequested = false;
  }

  // Older landed orders, or this one after a later one, can no longer be applied
  private land(version: number) {
    if (!this.pending.has(version)) {
      return;
    }
    if (version < this.landed || (this._order && version <= this._order.version)) {
      this.pending.delete(version);
    } else {
      this.pending.delete(this.landed);
      this.landed = version;
    }
    this.splats.updateLive();
  }

  private checkDisposed() {
    if (this.disposed) {
      throw new Error("SplatView.sort: the view is disposed");
    }
  }

  private autoSortStep(camera: THREE.Camera) {
    if (this.autoSorting) {
      return;
    }
    const settings = this.splats.settingsOf(this);
    if (settings.collection.count === 0 || !(this.sortRequested || (settings.autoSort && this.needsSort(camera, settings, settings.autoSort)))) {
      return;
    }
    this.sortRequested = false;
    camera.updateMatrixWorld();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    camera.matrixWorld.decompose(position, quaternion, new THREE.Vector3());
    this.sortedFrom = {
      collection: settings.collection, bits: settings.sortBits, position, quaternion,
      projection: [...lensOf(camera).elements], matrices: matrices(settings.collection),
    };
    this.autoSorting = true;
    this.sort(camera)
      .then((order) => {
        this.autoSorting = false;
        if (this.apply(order)) {
          this.splats.onInvalidate?.(this);
        }
      })
      .catch((error: unknown) => {
        this.autoSorting = false;
        if (!this.disposed) {
          console.error("SplatView autoSort:", error);
        }
      });
  }

  private needsSort(camera: THREE.Camera, { collection, sortBits, objectParams }: ViewSettings, auto: AutoSort) {
    const from = this.sortedFrom;
    if (!this._order || !from || from.collection !== collection || from.bits !== sortBits) {
      return true;
    }
    camera.updateMatrixWorld();
    const position = scratch.position;
    const quaternion = scratch.quaternion;
    camera.matrixWorld.decompose(position, quaternion, scratch.scale);
    if (position.distanceTo(from.position) > auto.distance) {
      return true;
    }
    const guarded = objectParams.sortGuard > 0 || collection.objects.some(({ object }) => (object.params?.sortGuard ?? 0) > 0);
    if (guarded && (quaternion.angleTo(from.quaternion) > auto.angle || lensOf(camera).elements.some((value, k) => value !== from.projection[k]))) {
      return true;
    }
    return collection.objects.some(({ object }, i) => SplatCollection.matrixWorldOf(object).elements.some((value, k) => value !== from.matrices[i][k]));
  }
}

function matrices(collection: SplatCollection) {
  return collection.objects.map(({ object }) => [...SplatCollection.matrixWorldOf(object).elements]);
}

function lensOf(camera: THREE.Camera): THREE.Matrix4 {
  const array = camera as THREE.ArrayCamera;
  return (array.isArrayCamera && array.cameras.length > 0 ? array.cameras[0] : camera).projectionMatrix;
}

const scratch = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3() };
