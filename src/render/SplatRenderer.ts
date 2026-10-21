import * as THREE from "three";
import { NodeMaterial, type IndirectStorageBufferAttribute, type WebGPURenderer } from "three/webgpu";
import { ArrayData } from "../core/ArrayData";
import type { SortKeyBits } from "../core/sort";
import { isWebGPUBackend } from "../gpu/backend";
import { GpuArrayReader } from "../gpu/GpuArrayReader";
import { GpuArrays } from "../gpu/GpuArrays";
import type { CovSplatModifier, SplatModifier } from "../gpu/splatGenerator";
import { TSL } from "../gpu/tsl";
import { WgpuSplatSorter } from "../wgpu/WgpuSplatSorter";
import { sortSplatKeys } from "../worker/splatSort";
import { WorkerPool, type WorkerLease } from "../worker/WorkerPool";
import type { ProjectionMethod } from "./projections.tsl";
import { SplatCamera } from "./splatCamera";
import { SplatCollection, type AnySplatObject } from "./SplatCollection";
import { makeDrawMaterial, outputIsLinear, quadIndices, setDrawNodes, type DrawOptions } from "./splatDraw";
import { SplatParams, type SplatObjectParams, type SplatViewParams } from "./splatParams";
import { SplatProjection, type ProjectedSchema } from "./SplatProjection";
import { projectCollection } from "./SplatProjector";
import type { ModifierSpace } from "./splatTransform.tsl";
import { SplatView, type AutoSort, type SplatViewOptions, type ViewSettings } from "./SplatView";

const { uniform } = TSL;

const QUADS = WgpuSplatSorter.QUADS_PER_INSTANCE;

// The draw's only buffer, shared by all renderers, indexed so shared corners shade once
const QUAD_INDEX = new THREE.BufferAttribute(quadIndices(QUADS), 1);
QUAD_INDEX.name = "radix_splatQuadIndex";

// Renders warn past this many views, since cameras made anew each make one
const MANY_VIEWS = 32;

/** The options of a SplatRenderer, each setting the member of that name. */
export interface SplatRendererOptions {
  renderer: WebGPURenderer;
  /**
   * What every viewpoint draws unless its view sets its own.
   *
   * @default SplatCollection.EMPTY
   */
  collection?: SplatCollection;
  /**
   * The projection method.
   *
   * @default "ewa"
   */
  method?: ProjectionMethod;
  /**
   * The sort key width, in bits.
   *
   * @default 24
   */
  sortBits?: SortKeyBits;
  params?: Partial<SplatViewParams>;
  objectParams?: Partial<SplatObjectParams>;
  modifier?: SplatModifier;
  covModifier?: CovSplatModifier;
  /**
   * Where the modifiers run.
   *
   * @default "view"
   */
  modifierSpace?: ModifierSpace;
  /**
   * Whether splats are sorted on the GPU every render or on a worker per view.
   *
   * @default "gpu" on WebGPU, else "cpu"
   */
  sortMode?: "gpu" | "cpu";
  /**
   * When views re-sort on the CPU, or false for only on request.
   *
   * @default { distance: 0, angle: 0 }
   */
  autoSort?: AutoSort | false;
  /**
   * Where CPU sorts run.
   *
   * @default SplatRenderer.sortPool
   */
  sortWorker?: WorkerPool | WorkerLease;
  /**
   * The key of the view a render from a camera draws.
   *
   * @default (camera) => camera
   */
  viewKey?: (camera: THREE.Camera) => unknown;
  /** Called when an autoSort order or a requested sort needs a render. */
  onInvalidate?: (view?: SplatView) => void;
}

interface Projected {
  projection: SplatProjection;
  eyes: number;
  arrays: GpuArrays<ProjectedSchema>;
}

// Left behind when a renderer is garbage-collected undisposed
interface RendererToken {
  ref: WeakRef<SplatRenderer>;
}

let sharedSortPool: WorkerPool | undefined;

/**
 * Draws a collection of splats from any camera. Dispose it when done.
 *
 * It holds the settings every viewpoint shares, and its views set some of them
 * for one viewpoint.
 *
 * - sortMode "gpu" sorts every render on WebGPU.
 * - sortMode "cpu" draws each view's order, sorted on a worker a few frames late.
 */
export class SplatRenderer extends THREE.Mesh<THREE.InstancedBufferGeometry, NodeMaterial> {
  // Undisposed renderers, and objects with a release not yet released
  private static readonly renderers = new Set<WeakRef<SplatRenderer>>();
  private static readonly watched = new Set<AnySplatObject>();
  private static readonly lost = new FinalizationRegistry<RendererToken>((token) => {
    console.warn("SplatRenderer: a renderer was garbage-collected without dispose(); its objects are released now");
    SplatRenderer.renderers.delete(token.ref);
    SplatRenderer.sweep();
  });

  /**
   * The size of the shared sort pool, read at the first CPU sort.
   *
   * @default 4
   */
  static sortWorkers = 4;

  /** The worker pool for CPU sorts of renderers without a sortWorker. */
  static get sortPool(): WorkerPool {
    return (sharedSortPool ??= new WorkerPool({ size: SplatRenderer.sortWorkers }));
  }

  readonly renderer: WebGPURenderer;
  method: ProjectionMethod;
  /** The sort key width, in bits. */
  sortBits: SortKeyBits;
  /** View params, changed in place. */
  readonly params: SplatViewParams;
  /** Object param defaults, changed in place. */
  readonly objectParams: SplatObjectParams;
  modifier?: SplatModifier;
  covModifier?: CovSplatModifier;
  modifierSpace: ModifierSpace;
  /** When views re-sort on the CPU, or false for only on request. */
  autoSort: AutoSort | false;
  /**
   * Where CPU sorts run.
   *
   * @default SplatRenderer.sortPool
   */
  sortWorker?: WorkerPool | WorkerLease;
  /**
   * The key of the view a render from a camera draws, when view is unset. Map
   * cameras made anew to stable keys, or the CPU sort makes a view for each.
   *
   * @default (camera) => camera
   */
  viewKey: (camera: THREE.Camera) => unknown;
  /** Called when an autoSort order or a requested sort needs a render. */
  onInvalidate?: (view?: SplatView) => void;
  /** The view every render draws, when set. */
  view?: SplatView;
  /** Called around the "project" and "sort" steps of each render. */
  phase?: <T>(name: string, run: () => T) => T;

  private _collection: SplatCollection;
  private _sortMode: "gpu" | "cpu" = "gpu";
  private _views = new Map<unknown, SplatView>();
  private warnedViews = false;
  private live = new Set<SplatCollection>();
  private token: RendererToken;
  private disposed = false;
  private projected: Projected;
  private sorter?: WgpuSplatSorter;
  // renderer.info.render.calls after the latest prepare()
  private preparedAt = -1;
  private orderReader = new GpuArrayReader(ArrayData.INDICES);
  private orderCount = uniform(0, "uint");
  private encodeLinear = uniform(0);
  private drawState!: { for: Projected; projected: GpuArrayReader; sorter?: WgpuSplatSorter };

  /** Makes a renderer to add to a scene. */
  constructor({
    renderer, collection = SplatCollection.EMPTY, method = "ewa", sortBits = 24, params, objectParams, modifier, covModifier, modifierSpace = "view",
    sortMode, autoSort = { distance: 0, angle: 0 }, sortWorker, viewKey = (camera) => camera, onInvalidate,
  }: SplatRendererOptions) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(QUAD_INDEX);
    geometry.instanceCount = 0;
    super(geometry, new NodeMaterial());

    this.renderer = renderer;
    this._collection = collection;
    this.method = method;
    this.sortBits = sortBits;
    this.params = { ...SplatParams.VIEW, ...params };
    this.objectParams = { ...SplatParams.OBJECT, ...objectParams };
    this.modifier = modifier;
    this.covModifier = covModifier;
    this.modifierSpace = modifierSpace;
    this._sortMode = sortMode ?? (isWebGPUBackend(renderer) ? "gpu" : "cpu");
    this.autoSort = autoSort;
    this.sortWorker = sortWorker;
    this.viewKey = viewKey;
    this.onInvalidate = onInvalidate;
    this.frustumCulled = false;

    this.token = { ref: new WeakRef(this) };
    SplatRenderer.renderers.add(this.token.ref);
    SplatRenderer.lost.register(this, this.token, this);
    this.updateLive();

    // three lists the material before onBeforeRender, so build it now on real, empty arrays
    this.projected = this.makeProjected(method, 1);
    this.buildMaterial(undefined);
  }

  /** What every viewpoint draws unless its view sets its own. */
  get collection(): SplatCollection {
    return this._collection;
  }

  set collection(collection: SplatCollection) {
    this._collection = collection;
    this.updateLive();
  }

  /**
   * Whether splats are sorted on the GPU every render or on a worker per view.
   *
   * @default "gpu" on WebGPU, else "cpu"
   */
  get sortMode(): "gpu" | "cpu" {
    return this._sortMode;
  }

  set sortMode(mode: "gpu" | "cpu") {
    this._sortMode = mode;
    if (mode === "gpu") {
      this._views.forEach((view) => view.dropOrders());
      this.updateLive();
    }
  }

  get views(): ReadonlyMap<unknown, SplatView> {
    return this._views;
  }

  /**
   * Returns the view of a key, made on first use.
   *
   * @param key A camera, or any value.
   */
  viewFor(key: unknown, options: SplatViewOptions = {}): SplatView {
    if (this.disposed) {
      throw new Error("SplatRenderer.viewFor: the renderer is disposed");
    }
    let view = this._views.get(key);
    if (!view) {
      view = new SplatView(this, key);
      this._views.set(key, view);
    }
    const { collection, params, objectParams, ...rest } = options;
    Object.assign(view.params, params);
    Object.assign(view.objectParams, objectParams);
    Object.assign(view, rest);
    if ("collection" in options) {
      view.collection = collection;
    }
    return view;
  }

  /** Sorts every view again at its next render, and calls onInvalidate. */
  requestSort() {
    this._views.forEach((view) => view.wantSort());
    this.onInvalidate?.();
  }

  /**
   * Reads back the GPU sort's visible count of the latest render.
   *
   * @return The visible count, or 0 without a GPU sort.
   */
  async readSortedCount(): Promise<number> {
    return this.sorter && !this.disposed ? this.sorter.readCount() : 0;
  }

  /** Projects and sorts for the render's camera, called by three. */
  onBeforeRender(_renderer: unknown, _scene: THREE.Scene, camera: THREE.Camera) {
    // Projecting would make GPU resources again
    if (this.disposed) {
      this.geometry.instanceCount = 0;
      return;
    }
    if (this.renderer.info.render.calls === this.preparedAt + 1) {
      // prepare() projected this render already, so set only the draw's uniforms
      SplatCamera.set(this.renderer, camera);
      SplatParams.setView(this.settingsOf(this.viewOf(camera)).params);
      this.encodeLinear.value = outputIsLinear(this.renderer) ? 1 : 0;
      return;
    }
    this.update(camera);
  }

  /**
   * Projects and sorts now, outside a render, for the next render to draw.
   *
   * @param camera The camera of the next render.
   */
  prepare(camera: THREE.Camera) {
    if (this.disposed) {
      this.geometry.instanceCount = 0;
      return;
    }
    this.update(camera);
    this.preparedAt = this.renderer.info.render.calls;
  }

  /** Frees the renderer's GPU resources and views, and releases objects only it held. */
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    SplatRenderer.lost.unregister(this);
    [...this._views.values()].forEach((view) => view.dispose());
    this.view = undefined;
    this.live = new Set();
    SplatRenderer.renderers.delete(this.token.ref);
    SplatRenderer.sweep();
    this.projected.arrays.dispose();
    this.sorter?.dispose();
    this.sorter = undefined;
    this.material.dispose();
    // The shared index stays
    this.geometry.setIndex(null);
    this.geometry.instanceCount = 0;
    this.geometry.dispose();
    this.visible = false;
  }

  /** @internal The settings `view` draws with: its own over this renderer's */
  settingsOf(view?: SplatView): ViewSettings {
    const own: ViewSettings = {
      collection: this._collection, method: this.method, sortBits: this.sortBits, params: this.params, objectParams: this.objectParams,
      modifier: this.modifier, covModifier: this.covModifier, modifierSpace: this.modifierSpace, autoSort: this.autoSort,
    };
    if (!view) {
      return own;
    }
    return {
      collection: view.collection ?? own.collection,
      method: own.method,
      sortBits: view.sortBits ?? own.sortBits,
      params: over(own.params, view.params),
      objectParams: over(own.objectParams, view.objectParams),
      modifier: view.modifier === null ? undefined : view.modifier ?? own.modifier,
      covModifier: view.covModifier === null ? undefined : view.covModifier ?? own.covModifier,
      modifierSpace: view.modifierSpace ?? own.modifierSpace,
      autoSort: view.autoSort ?? own.autoSort,
    };
  }

  /** @internal Sort keys on the app's sortWorker, else the shared sort pool */
  async sortKeys(keys: Uint32Array<ArrayBuffer>, bits: SortKeyBits) {
    if (this.disposed) {
      throw new Error("SplatRenderer.sortKeys: the renderer is disposed");
    }
    return sortSplatKeys(keys, { bits, worker: this.sortWorker ?? SplatRenderer.sortPool });
  }

  /** @internal A view was disposed */
  forget(view: SplatView) {
    if (this._views.get(view.key) === view) {
      this._views.delete(view.key);
    }
    if (this.view === view) {
      this.view = undefined;
    }
    this.updateLive();
  }

  /** @internal The live collections changed: watch new objects, release retired ones */
  updateLive() {
    if (this.disposed) {
      return;
    }
    const next = new Set<SplatCollection>([this._collection]);
    this._views.forEach((view) => view.collections().forEach((collection) => next.add(collection)));
    const retired = [...this.live].some((collection) => !next.has(collection));
    for (const collection of next) {
      for (const { object } of this.live.has(collection) ? [] : collection.objects) {
        if (object.release) {
          SplatRenderer.watched.add(object);
        }
      }
    }
    this.live = next;
    if (retired) {
      SplatRenderer.sweep();
    }
  }

  // Runs after the bookkeeping, so a release may change renderers and views
  private static sweep() {
    if (SplatRenderer.watched.size === 0) {
      return;
    }
    const live = new Set<AnySplatObject>();
    for (const ref of SplatRenderer.renderers) {
      for (const collection of ref.deref()?.live ?? []) {
        collection.objects.forEach(({ object }) => live.add(object));
      }
    }
    const done = [...SplatRenderer.watched].filter((object) => !live.has(object));
    done.forEach((object) => SplatRenderer.watched.delete(object));
    done.forEach((object) => object.release?.());
  }

  // cpu mode makes a view per key, since each viewpoint needs its own order
  private viewOf(camera: THREE.Camera): SplatView | undefined {
    if (this.view) {
      if (this.view.splats !== this) {
        throw new Error("SplatRenderer: its view belongs to another SplatRenderer");
      }
      return this.view;
    }
    const key = this.viewKey(camera);
    const view = this._views.get(key);
    if (view || this._sortMode === "gpu") {
      return view;
    }
    if (this._views.size >= MANY_VIEWS && !this.warnedViews) {
      this.warnedViews = true;
      console.warn(`SplatRenderer: renders have made ${this._views.size} views, one per camera; for cameras made anew, set viewKey (or view)`);
    }
    return this.viewFor(key);
  }

  private update(camera: THREE.Camera) {
    const gpu = this._sortMode === "gpu";
    if (gpu && !isWebGPUBackend(this.renderer)) {
      throw new Error("SplatRenderer: sortMode \"gpu\" needs WebGPU (use \"cpu\")");
    }
    const view = this.viewOf(camera);
    const settings = this.settingsOf(view);
    const drawn = gpu ? { collection: settings.collection } : view!.drawn(camera);
    SplatCamera.set(this.renderer, camera);
    if (!drawn || drawn.collection.count === 0) {
      this.geometry.instanceCount = 0;
      return;
    }

    const phase = this.phase ?? ((_name, run) => run());
    if (this.projected.projection.method !== this.method || this.projected.eyes !== SplatCamera.eyes) {
      this.projected.arrays.dispose();
      this.projected = this.makeProjected(this.method, SplatCamera.eyes);
    }
    const arrays = this.projected.arrays;
    phase("project", () => projectCollection({ renderer: this.renderer, settings, collection: drawn.collection, arrays, pass: "full", cullKeys: gpu }));
    let sorter: WgpuSplatSorter | undefined;
    let visible = arrays.count;
    if (gpu) {
      sorter = this.sorter ??= new WgpuSplatSorter(this.renderer);
      phase("sort", () => sorter!.sort(arrays, arrays.count, settings.sortBits));
    } else {
      const order = drawn as { arrays: GpuArrays; visible: number };
      this.orderReader.bind(order.arrays, "indices");
      this.orderCount.value = order.visible;
      visible = Math.min(order.visible, arrays.count);
    }

    if (this.drawState.for !== this.projected || this.drawState.sorter !== sorter) {
      this.buildMaterial(sorter);
    }
    this.drawState.projected.bind(arrays, "projected");
    this.encodeLinear.value = outputIsLinear(this.renderer) ? 1 : 0;

    // three skips a draw with no instances, even an indirect one
    this.geometry.setIndirect(sorter ? (sorter.indirect.attribute as IndirectStorageBufferAttribute) : (null as never));
    this.geometry.instanceCount = Math.ceil(visible / QUADS);
  }

  private makeProjected(method: ProjectionMethod, eyes: number): Projected {
    const projection = SplatProjection.get(method);
    const arrays = new GpuArrays({ renderer: this.renderer, bundles: projection.outputs(eyes), capacity: 1, storage: isWebGPUBackend(this.renderer) });
    return { projection, eyes, arrays };
  }

  private buildMaterial(sorter: WgpuSplatSorter | undefined) {
    const { projection, eyes, arrays } = this.projected;
    const projected = projection.reader(eyes).bind(arrays, "projected");
    const order: DrawOptions["order"] = sorter ? (i) => sorter.values.element(i) : (i) => this.orderReader.load("index", i);
    const count = sorter ? sorter.count : this.orderCount;
    const options = { projection, eyes, projected, order, count, quads: QUADS, encodeLinear: this.encodeLinear };

    if (this.drawState) {
      setDrawNodes(this.material, options);
    } else {
      this.material.dispose();
      this.material = makeDrawMaterial(options);
    }
    this.drawState = { for: this.projected, projected, sorter };
  }
}

function over<T extends object>(base: T, top: Partial<T>): T {
  const out = { ...base };
  for (const key of Object.keys(top) as (keyof T)[]) {
    if (top[key] !== undefined) {
      out[key] = top[key] as T[keyof T];
    }
  }
  return out;
}
