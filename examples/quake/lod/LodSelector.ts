// Runtime LoD for pages with many splat objects, on either backend (this
// folder and doom/lod/ are copies of each other).
// Each object's LoD tree (an ArrayData of extSplats + lodTree, or a node
// array from lodTraversal.ts buildNodes) lives in a worker (lodWorker.ts),
// which selects every object from the camera per update(camera): the nodes
// within sizeLimit (weighted by foveation, minDot), under a shared splat
// budget. Changed lists come back as index GpuArrays
// (SplatGenerator.indices, from a pool per object); the page draws each
// object's `list` through a remap "indices" generator, and splatObject()
// makes the SplatObject for a list once, with a release that puts the list
// back in the pool when no renderer holds it any longer.
//
//   const listed = SplatGenerator.fromSplats({ remap: "indices" });
//   const lod = new LodSelector({ renderer, budget: 2_000_000 });
//   const parts = files.map((data) => {
//     const splats = GpuArrays.fromData(renderer, data); // before add()
//     return { splats, lod: lod.add({ data, matrixWorld }) };
//   });
//   lod.onSelect = () => (splatRenderer.collection = new SplatCollection(parts.flatMap(({ splats, lod: part }) =>
//     lod.splatObject(part, (list) => SplatCollection.object({ generator: listed, data: { splats, indices: list.indices }, count: list.count, matrixWorld: part.matrixWorld })) ?? [])));
//   // each frame (with the CPU sort: once the last collection is drawn)
//   lod.update(camera);
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { SplatGenerator, Splats, type AnySplatObject, type ArrayData, type GpuArrays } from "@sparkjsdev/radix";
import { buildNodes } from "./lodTraversal.js";
import type { LodReply, LodRequest } from "./lodWorker.js";

// One object's selection on the GPU (ArrayData.INDICES, count = the list's)
export interface LodList {
  readonly indices: GpuArrays;
  readonly count: number;
  // Back to the pool (or disposed once the selector is): splatObject()
  // makes it the object's release
  readonly release: () => void;
}

export interface LodObjectOptions {
  // extSplats + lodTree. Their arrays are transferred to the worker (the
  // ArrayData is unusable afterwards: upload it first) unless `copy`
  data?: ArrayData;
  // Or a node array (buildNodes), transferred
  nodes?: Uint32Array<ArrayBuffer>;
  copy?: boolean;
  // Object to world, read at every update: a matrix (live) or a function
  matrixWorld?: THREE.Matrix4 | (() => THREE.Matrix4);
}

export class LodObject {
  readonly id: number;
  matrixWorld?: THREE.Matrix4 | (() => THREE.Matrix4);
  // Left out of selections while false (its list stays)
  visible = true;
  // The newest selection, from the first one that lands
  list?: LodList;
  // Nodes in its tree, once the worker has it
  nodes = 0;
  // Resolves once the worker holds its tree
  readonly ready: Promise<void>;
  /** @internal */ made?: { list: LodList; object: AnySplatObject };
  /** @internal */ pool: GpuArrays[] = [];
  /** @internal */ removed = false;
  /** @internal */ resolve!: () => void;

  constructor(id: number, matrixWorld?: THREE.Matrix4 | (() => THREE.Matrix4)) {
    this.id = id;
    this.matrixWorld = matrixWorld;
    this.ready = new Promise((resolve) => (this.resolve = resolve));
  }

  get count(): number {
    return this.list?.count ?? 0;
  }

  matrix(): THREE.Matrix4 {
    return (typeof this.matrixWorld === "function" ? this.matrixWorld() : this.matrixWorld) ?? IDENTITY;
  }
}

export interface LodSelectorOptions {
  renderer: WebGPURenderer;
  // Finest weighted size kept (size * max(cos, minDot) / distance)
  sizeLimit?: number;
  // Foveation: nodes off the view axis are up to 1 / minDot coarser; 1 is off
  minDot?: number;
  // Most splats selected over all objects (Infinity: sizeLimit alone)
  budget?: number;
  // New lists landed for `changed` (after their uploads)
  onSelect?: (changed: LodObject[]) => void;
}

export interface LodStats {
  selections: number;
  // Of the latest selection: the worker's ms, the round trip and the uploads
  workerMs: number;
  roundTripMs: number;
  uploadMs: number;
  // Nodes considered, splats selected, lists that changed
  visited: number;
  total: number;
  changed: number;
  // Index GpuArrays made so far
  listsMade: number;
}

const IDENTITY = new THREE.Matrix4();
const ORIGIN_EPSILON = 1e-4;
const ANGLE_EPSILON = 1e-4;

export class LodSelector {
  readonly renderer: WebGPURenderer;
  sizeLimit: number;
  minDot: number;
  budget: number;
  onSelect?: (changed: LodObject[]) => void;
  readonly stats: LodStats = { selections: 0, workerMs: 0, roundTripMs: 0, uploadMs: 0, visited: 0, total: 0, changed: 0, listsMade: 0 };

  private worker = new Worker(new URL("./lodWorker.js", import.meta.url), { type: "module" });
  private byId = new Map<number, LodObject>();
  private nextId = 1;
  private seq = 0;
  private inFlight?: { seq: number; sent: number; done: () => void };
  private idle?: Promise<void>;
  private used = new WeakSet<LodList>();
  private last?: { position: THREE.Vector3; quaternion: THREE.Quaternion; settings: string; matrices: number[] };
  private dirty = true;
  private disposed = false;

  constructor({ renderer, sizeLimit = 0.005, minDot = 0.2, budget = Infinity, onSelect }: LodSelectorOptions) {
    this.renderer = renderer;
    this.sizeLimit = sizeLimit;
    this.minDot = minDot;
    this.budget = budget;
    this.onSelect = onSelect;
    this.worker.onmessage = (event: MessageEvent<LodReply>) => this.receive(event.data);
    this.worker.onerror = (event) => console.error("LodSelector worker:", event.message);
  }

  // Every object added and not removed, in order
  get objects(): LodObject[] {
    return [...this.byId.values()];
  }

  // Whether a selection is in flight
  get busy(): boolean {
    return this.inFlight !== undefined;
  }

  add({ data, nodes, copy = false, matrixWorld }: LodObjectOptions): LodObject {
    const object = new LodObject(this.nextId++, matrixWorld);
    this.byId.set(object.id, object);
    if (nodes) {
      const own = copy ? nodes.slice() : nodes;
      this.post({ type: "add", id: object.id, nodes: own }, [own.buffer]);
    } else if (data) {
      const { extA, extB, tree, count } = treeArrays(data);
      const take = (array: Uint32Array<ArrayBuffer>, components: number) => (copy ? array.slice(0, count * components) : array);
      const request = { type: "add" as const, id: object.id, extA: take(extA, 4), extB: take(extB, 4), tree: take(tree, 2), count };
      this.post(request, [request.extA.buffer, request.extB.buffer, request.tree.buffer]);
    } else {
      throw new Error("LodSelector.add: give data or nodes");
    }
    this.dirty = true;
    return object;
  }

  // Stops selecting `object`; its list is released by the renderer as usual
  remove(object: LodObject) {
    if (!this.byId.delete(object.id)) {
      return;
    }
    object.removed = true;
    object.pool.forEach((indices) => indices.dispose());
    object.pool = [];
    if (object.list && !this.used.has(object.list)) {
      object.list.release();
    }
    this.post({ type: "remove", id: object.id }, []);
    this.dirty = true;
  }

  // Select again at the next update, whatever moved
  invalidate() {
    this.dirty = true;
  }

  // Starts a selection from `camera` unless one is in flight or nothing
  // changed (camera, matrices, settings, objects); whether it started
  update(camera: THREE.Camera, { force = false }: { force?: boolean } = {}): boolean {
    if (this.disposed || this.inFlight) {
      return false;
    }
    camera.updateMatrixWorld();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    camera.matrixWorld.decompose(position, quaternion, new THREE.Vector3());
    const visible = this.objects.filter((object) => object.visible);
    const matrices = visible.flatMap((object) => [object.id, ...object.matrix().elements]);
    const settings = `${this.sizeLimit} ${this.minDot} ${this.budget}`;
    const last = this.last;
    const same = last && !this.dirty && !force && last.settings === settings
      && position.distanceTo(last.position) <= ORIGIN_EPSILON && quaternion.angleTo(last.quaternion) <= ANGLE_EPSILON
      && matrices.length === last.matrices.length && matrices.every((value, i) => value === last.matrices[i]);
    if (same) {
      return false;
    }
    this.last = { position, quaternion, settings, matrices };
    this.dirty = false;

    const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
    const inverse = new THREE.Matrix4();
    const objects = visible.map((object) => {
      inverse.copy(object.matrix()).invert();
      const origin = position.clone().applyMatrix4(inverse);
      const direction = facing.clone().transformDirection(inverse);
      return { id: object.id, origin: origin.toArray(), facing: direction.toArray() };
    });

    const seq = (this.seq += 1);
    this.idle = new Promise((done) => (this.inFlight = { seq, sent: performance.now(), done }));
    this.post({ type: "select", seq, sizeLimit: this.sizeLimit, minDot: this.minDot, budget: this.budget, objects }, []);
    return true;
  }

  // Resolves once the selection in flight (if any) has landed
  async settle(): Promise<void> {
    await this.idle;
  }

  // The SplatObject of `object`'s current list: made by `make` once per
  // list and reused until a newer list lands. Its release (kept, then)
  // returns the list to the pool.
  splatObject<O extends AnySplatObject>(object: LodObject, make: (list: LodList) => O): O | undefined {
    const list = object.list;
    if (!list) {
      return undefined;
    }
    if (object.made?.list === list) {
      return object.made.object as O;
    }
    const made = make(list);
    const own = made.release;
    made.release = () => {
      own?.();
      list.release();
    };
    this.used.add(list);
    object.made = { list, object: made };
    return made;
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.worker.terminate();
    for (const object of this.byId.values()) {
      object.pool.forEach((indices) => indices.dispose());
      object.pool = [];
      if (object.list && !this.used.has(object.list)) {
        object.list.release();
      }
    }
    this.byId.clear();
    this.inFlight?.done();
    this.inFlight = undefined;
  }

  private post(request: LodRequest, transfer: ArrayBuffer[]) {
    this.worker.postMessage(request, transfer);
  }

  private receive(reply: LodReply) {
    if (this.disposed) {
      return;
    }
    if (reply.type === "added") {
      const object = this.byId.get(reply.id);
      if (object) {
        object.nodes = reply.nodes;
        object.resolve();
      }
      return;
    }
    const flight = this.inFlight;
    if (reply.type === "error") {
      console.error("LodSelector:", reply.message);
      if (flight && reply.seq === flight.seq) {
        this.inFlight = undefined;
        flight.done();
      }
      return;
    }

    const uploadStart = performance.now();
    const changed: LodObject[] = [];
    for (const { id, indices } of reply.lists) {
      const object = this.byId.get(id);
      if (!object) {
        continue;
      }
      this.stats.listsMade += object.pool.length === 0 ? 1 : 0;
      const old = object.list;
      object.list = this.makeList(object, SplatGenerator.indices(this.renderer, indices, object.pool.pop()), indices.length);
      if (old && !this.used.has(old)) {
        old.release();
      }
      changed.push(object);
    }
    const now = performance.now();
    Object.assign(this.stats, {
      selections: this.stats.selections + 1, workerMs: reply.ms, roundTripMs: flight ? now - flight.sent : 0, uploadMs: now - uploadStart,
      visited: reply.visited, total: reply.total, changed: changed.length,
    });
    if (flight && reply.seq === flight.seq) {
      this.inFlight = undefined;
    }
    if (changed.length > 0) {
      this.onSelect?.(changed);
    }
    flight?.done();
  }

  private makeList(object: LodObject, indices: GpuArrays, count: number): LodList {
    let released = false;
    return {
      indices,
      count,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        if (this.disposed || object.removed) {
          indices.dispose();
        } else {
          object.pool.push(indices);
        }
      },
    };
  }
}

function treeArrays(data: ArrayData) {
  const ext = data.bundles.extSplats;
  const tree = Splats.findLodTree(data);
  if (!ext || !Splats.isExt(ext) || !tree) {
    throw new Error("LodSelector: the data needs an extSplats bundle and a lodTree");
  }
  return { extA: ext.channels.extA.data, extB: ext.channels.extB.data, tree: tree.channels.node.data, count: data.count };
}

// The node array of an object's data (extSplats + lodTree), for add({ nodes })
// when the page builds it itself (on the main thread)
export function lodNodes(data: ArrayData): Uint32Array<ArrayBuffer> {
  const { extA, extB, tree, count } = treeArrays(data);
  return buildNodes(extA, extB, tree, count);
}
