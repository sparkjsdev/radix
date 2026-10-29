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

// A draw order for a collection (SplatView.sort): `ordering` lists the
// first `visible` of its splats back to front; `version` counts the view's
// sorts, in the order they started
export interface SplatOrder {
  readonly collection: SplatCollection;
  readonly version: number;
  readonly ordering: Uint32Array<ArrayBuffer>;
  readonly visible: number;
  // Wall ms of the keys (GPU pass and readback) and of the worker sort
  readonly keysMs: number;
  readonly sortMs: number;
}

// When autoSort re-sorts: the camera moved more than `distance` (world
// units) or, when a sortGuard is set, turned more than `angle` (radians)
// or changed its lens since the last sort started; any change of the
// collection or of an object's world transform also re-sorts, and so does
// view.requestSort()
export interface AutoSort {
  distance: number;
  angle: number;
}

// What a view sets over its renderer's settings (SplatRenderer.viewFor);
// a modifier of null draws without the renderer's
export interface SplatViewOptions {
  collection?: SplatCollection;
  params?: Partial<SplatViewParams>;
  objectParams?: Partial<SplatObjectParams>;
  modifier?: SplatModifier | null;
  covModifier?: CovSplatModifier | null;
  modifierSpace?: ModifierSpace;
  sortBits?: SortKeyBits;
  autoSort?: AutoSort | false;
}

// The settings a view resolves to: its own over its renderer's
export interface ViewSettings extends ProjectSettings {
  collection: SplatCollection;
  autoSort: AutoSort | false;
}

// One viewpoint of a SplatRenderer (renderer.viewFor(key), keyed by a
// camera or any value): settings over the renderer's, unset ones following
// it, and on the CPU-sort path the order being drawn. In sortMode "gpu"
// nothing here depends on the camera, so a renderer needs views only to
// draw some viewpoint differently. In "cpu" (the WebGL2 fallback) the
// renderer draws `order`, made by sort(camera) (keys on the GPU, read back
// and sorted on a worker) and shown with apply(order): until a newer order
// lands it keeps drawing the collection that order was sorted for, so every
// camera gets a view of its own (the renderer makes one per view key it
// renders). An order can be applied until one of a later sort lands or is
// applied; switching the renderer to "gpu" drops them all. autoSort does
// that loop: one sort in flight, re-sorted when the camera or the
// collection changed or a sort was requested, each order applied as it
// lands.
export class SplatView {
  readonly splats: SplatRenderer;
  readonly key: unknown;
  // Over the renderer's, field by field
  params: Partial<SplatViewParams> = {};
  objectParams: Partial<SplatObjectParams> = {};
  // Unset: the renderer's
  modifier?: SplatModifier | null;
  covModifier?: CovSplatModifier | null;
  modifierSpace?: ModifierSpace;
  sortBits?: SortKeyBits;
  autoSort?: AutoSort | false;

  private _collection?: SplatCollection;
  private _order?: SplatOrder;
  // The applied order's indices (ArrayData.INDICES)
  private orderArrays?: GpuArrays;
  private sorts = 0;
  // In cpu mode, collections of sorts in flight and of the newest landed
  // order not yet applied (`landed`), by version
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

  // The collection this view draws instead of its renderer's
  get collection(): SplatCollection | undefined {
    return this._collection;
  }

  set collection(collection: SplatCollection | undefined) {
    this._collection = collection;
    this.splats.updateLive();
  }

  // The applied order (cpu mode draws its collection)
  get order(): SplatOrder | undefined {
    return this._order;
  }

  // Sort again at the next render, for changes autoSort can't see (a
  // generator's splats moved, a uniform of it changed), also with autoSort
  // off. With a sort in flight, the next one starts when it finishes, since
  // its sort keys may predate the change. Calls the renderer's onInvalidate
  // unless a sort in flight will.
  requestSort() {
    this.wantSort();
    if (!this.autoSorting) {
      this.splats.onInvalidate?.(this);
    }
  }

  // Sort this view's collection (as of this call) from `camera`: its keys
  // are computed on the GPU now, then read back and sorted on a worker. In
  // gpu mode only with the renderer's sortWorker, and its orders cannot be
  // applied.
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

  // Draw `order` from now on (cpu mode); whether it was applied. Not once
  // an order of a later sort has landed or been applied, nor in gpu mode.
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

  // Free the view's arrays and take it off its renderer (its orders no
  // longer hold their objects)
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

  // An order of version `version` landed: older landed ones can no longer
  // be applied, nor this one if a later one landed or was applied
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

// A camera's lens: its first eye's projection
function lensOf(camera: THREE.Camera): THREE.Matrix4 {
  const array = camera as THREE.ArrayCamera;
  return (array.isArrayCamera && array.cameras.length > 0 ? array.cameras[0] : camera).projectionMatrix;
}

const scratch = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3() };
