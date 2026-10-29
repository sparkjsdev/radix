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

// Splats per instance of the draw, as the sorter's draw arguments count
const QUADS = WgpuSplatSorter.QUADS_PER_INSTANCE;

// The quads of QUADS splats, the only buffer the draw has (no vertex
// attributes), shared by every renderer; indexed, so shared corners are
// shaded once
const QUAD_INDEX = new THREE.BufferAttribute(quadIndices(QUADS), 1);
QUAD_INDEX.name = "radix_splatQuadIndex";

// Views made by renders past which a renderer warns (an app making cameras
// anew each frame would make a view each)
const MANY_VIEWS = 32;

export interface SplatRendererOptions {
  renderer: WebGPURenderer;
  collection?: SplatCollection;
  method?: ProjectionMethod;
  sortBits?: SortKeyBits;
  params?: Partial<SplatViewParams>;
  objectParams?: Partial<SplatObjectParams>;
  modifier?: SplatModifier;
  covModifier?: CovSplatModifier;
  modifierSpace?: ModifierSpace;
  sortMode?: "gpu" | "cpu";
  autoSort?: AutoSort | false;
  sortWorker?: WorkerPool | WorkerLease;
  viewKey?: (camera: THREE.Camera) => unknown;
  onInvalidate?: (view?: SplatView) => void;
}

// A method's words for some eyes and a key per splat: what a renderer
// projects its collection into, sorts and draws
interface Projected {
  projection: SplatProjection;
  eyes: number;
  arrays: GpuArrays<ProjectedSchema>;
}

// What a renderer leaves behind if it is garbage-collected undisposed
interface RendererToken {
  ref: WeakRef<SplatRenderer>;
}

let sharedSortPool: WorkerPool | undefined;

// Draws a collection of splats: add it to the scene and render as usual,
// from any camera. It holds the settings every viewpoint shares (the
// collection, the method and params every splat drawn together shares,
// per-object param defaults, a modifier run on every splat in
// modifierSpace, the sort); views (viewFor(key)) set some of them over it
// for one viewpoint.
//
// Each render, onBeforeRender projects the collection (every object, one
// dispatch each) for the render's camera (two eyes for an XR ArrayCamera)
// into this renderer's projected splats, or prepare(camera) does it before
// the render; then it orders them: sortMode "gpu" (WebGPU's default) with
// a WgpuSplatSorter in the same frame (drawn indirectly, nothing read
// back), "cpu" (the WebGL2 fallback) with the applied order of the
// render's view, drawing the collection it was sorted for (nothing until
// one is applied). The view drawn: `view` when set, else the one of
// viewKey(camera) (default the camera itself), made for each key in cpu
// mode; in gpu mode no view is needed. Two renderers in one render each
// keep their own projected splats and sorter, since a frame's compute runs
// before its draws.
//
// An object's release runs once no renderer's live collection holds that
// object: live are its collection, its views' and, in cpu mode, the
// collections of their applied orders and of sorts in flight or landed and
// still appliable. Dispose renderers: one garbage-collected undisposed is
// warned about.
export class SplatRenderer extends THREE.Mesh<THREE.InstancedBufferGeometry, NodeMaterial> {
  // Every undisposed renderer, and the objects with a release that have
  // been live in one and not released yet
  private static readonly renderers = new Set<WeakRef<SplatRenderer>>();
  private static readonly watched = new Set<AnySplatObject>();
  private static readonly lost = new FinalizationRegistry<RendererToken>((token) => {
    console.warn("SplatRenderer: a renderer was garbage-collected without dispose(); its objects are released now");
    SplatRenderer.renderers.delete(token.ref);
    SplatRenderer.sweep();
  });

  // Workers of the shared sort pool: read when the pool is made, at the
  // first CPU sort of any renderer, so set it before then
  static sortWorkers = 4;

  // The pool every renderer's CPU sorts share (all their views; renderers
  // with a sortWorker use that instead), so parallel sorts stay bounded and
  // never queue behind file loads in WorkerPool.default. Made on first use,
  // its workers as sorts need them; it lives with the page.
  static get sortPool(): WorkerPool {
    return (sharedSortPool ??= new WorkerPool({ size: SplatRenderer.sortWorkers }));
  }

  readonly renderer: WebGPURenderer;
  method: ProjectionMethod;
  sortBits: SortKeyBits;
  readonly params: SplatViewParams;
  readonly objectParams: SplatObjectParams;
  modifier?: SplatModifier;
  covModifier?: CovSplatModifier;
  modifierSpace: ModifierSpace;
  autoSort: AutoSort | false;
  // Where CPU sorts run: by default SplatRenderer.sortPool, shared by every
  // renderer; a given pool or lease is the app's
  sortWorker?: WorkerPool | WorkerLease;
  // The key of the view a render from `camera` draws when `view` is unset:
  // the camera itself by default. Map cameras an app makes anew (a clone
  // per frame, say) to keys of its own, so they share views instead of
  // each making one in cpu mode.
  viewKey: (camera: THREE.Camera) => unknown;
  // Something this renderer did (an autoSort order applied) or was asked
  // to do (requestSort) needs a render to show: of `view`, or of every
  // viewpoint when undefined. For on-demand rendering.
  onInvalidate?: (view?: SplatView) => void;
  // The view every render draws; unset: the one of viewKey(camera)
  view?: SplatView;
  // Runs the "project" and "sort" steps (a GpuProfiler's phase, say)
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
  // What the material draws: the projected arrays (by their reader) and the
  // order source
  private drawState!: { for: Projected; projected: GpuArrayReader; sorter?: WgpuSplatSorter };

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

    // Three lists the material before onBeforeRender, so there is one from
    // the start, drawing real (empty) projected arrays
    this.projected = this.makeProjected(method, 1);
    this.buildMaterial(undefined);
  }

  // What every viewpoint draws unless its view sets its own collection
  get collection(): SplatCollection {
    return this._collection;
  }

  set collection(collection: SplatCollection) {
    this._collection = collection;
    this.updateLive();
  }

  // "gpu": the GPU sort every render (WebGPU); "cpu": each view's applied
  // order of a CPU sort. Switching to gpu drops the orders.
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

  // The views made so far, by key
  get views(): ReadonlyMap<unknown, SplatView> {
    return this._views;
  }

  // The view of `key` (a camera, or any value for a viewpoint of the
  // app's), made on first use; `options` are set on it
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

  // Sort every view again at its next render (view.requestSort), and call
  // onInvalidate for all of them
  requestSort() {
    this._views.forEach((view) => view.wantSort());
    this.onInvalidate?.();
  }

  // The GPU sort's visible count of the latest render (a readback)
  async readSortedCount(): Promise<number> {
    return this.sorter && !this.disposed ? this.sorter.readCount() : 0;
  }

  // A disposed renderer still in the scene draws nothing (projecting would
  // make GPU resources again)
  onBeforeRender(_renderer: unknown, _scene: THREE.Scene, camera: THREE.Camera) {
    if (this.disposed) {
      this.geometry.instanceCount = 0;
      return;
    }
    if (this.renderer.info.render.calls === this.preparedAt + 1) {
      // Projected already, for this render: the draw's uniforms are its
      SplatCamera.set(this.renderer, camera);
      SplatParams.setView(this.settingsOf(this.viewOf(camera)).params);
      this.encodeLinear.value = outputIsLinear(this.renderer) ? 1 : 0;
      return;
    }
    this.update(camera);
  }

  // Project and sort for `camera` now, outside a render (WebGL2 timer
  // queries do not nest); the next render draws that instead of projecting
  // again
  prepare(camera: THREE.Camera) {
    if (this.disposed) {
      this.geometry.instanceCount = 0;
      return;
    }
    this.update(camera);
    this.preparedAt = this.renderer.info.render.calls;
  }

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

  // Release the watched objects no renderer's live collection holds any
  // longer, after the bookkeeping, so a release may change renderers and
  // views
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

  // The view a render from `camera` draws: `view`, else the one of its
  // view key (made in cpu mode, where each viewpoint needs its own order)
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

    // Point the draw at the projection and the order
    if (this.drawState.for !== this.projected || this.drawState.sorter !== sorter) {
      this.buildMaterial(sorter);
    }
    this.drawState.projected.bind(arrays, "projected");
    this.encodeLinear.value = outputIsLinear(this.renderer) ? 1 : 0;

    // Three skips a draw with no instances even when the indirect
    // arguments hold the actual count
    this.geometry.setIndirect(sorter ? (sorter.indirect.attribute as IndirectStorageBufferAttribute) : (null as never));
    this.geometry.instanceCount = Math.ceil(visible / QUADS);
  }

  private makeProjected(method: ProjectionMethod, eyes: number): Projected {
    const projection = SplatProjection.get(method);
    const arrays = new GpuArrays({ renderer: this.renderer, bundles: projection.outputs(eyes), capacity: 1, storage: isWebGPUBackend(this.renderer) });
    return { projection, eyes, arrays };
  }

  // The one material, built (or rebuilt in place) for the projected
  // arrays and the order source
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

// `base` with the fields `top` sets on top
function over<T extends object>(base: T, top: Partial<T>): T {
  const out = { ...base };
  for (const key of Object.keys(top) as (keyof T)[]) {
    if (top[key] !== undefined) {
      out[key] = top[key] as T[keyof T];
    }
  }
  return out;
}
