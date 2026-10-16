// A scene's collision chunks, loaded around the camera on the decode workers
// (collision.ts), after XGRIDS' Unreal plugin (CollisionLoadMaxDistance):
// chunks whose box is within `radius` of the camera load nearest first, two
// at a time, and chunks past 1.5 x radius are dropped. LCC v1 scenes read
// collision.lci's header once (a range read; a scene without one has no
// collision), then one range read per mesh; LCC2 scenes read each node's
// data.mesh .ply and data.bvh .btree. Walk mode asks for the chunks under a
// point first (ready). Everything is in the file's frame; the page turns the
// camera into it.
import type { CollisionChunk, LciMesh, Vec3 } from "./collision.js";
import { checkBvh, CollisionSet } from "./collision.js";
import type { Lcc2Scene } from "./Lcc2Scene.js";
import type { LccDecoders } from "./LccDecoders.js";
import type { LccScene } from "./LccScene.js";

const MAX_LOADS = 2;
const DROP = 1.5;

interface Entry {
  id: string;
  // min xyz, max xyz (the cell or node box until loaded, then the BVH's)
  box: Float32Array;
  state: "idle" | "loading" | "loaded" | "failed";
  load: (signal: AbortSignal) => Promise<CollisionChunk>;
  controller?: AbortController;
  waiters: (() => void)[];
}

const boxDistance = (box: Float32Array, p: Vec3) => {
  const dx = Math.max(box[0] - p.x, 0, p.x - box[3]);
  const dy = Math.max(box[1] - p.y, 0, p.y - box[4]);
  const dz = Math.max(box[2] - p.z, 0, p.z - box[5]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

export class CollisionStream {
  readonly set = new CollisionSet();
  readonly entries: Entry[];
  // Load radius in the file's units
  radius = 100;
  onChange: () => void = () => {};
  onError: (message: string) => void = () => {};
  readonly stats = { known: 0, loaded: 0, loading: 0, failed: 0, triangles: 0 };
  private loads = 0;
  private disposed = false;
  private readonly wanted = new Set<Entry>();

  private constructor(entries: Entry[]) {
    this.entries = entries;
    this.stats.known = entries.length;
  }

  // The scene's collision, or undefined when it has none
  static async open(scene: { v1?: LccScene; v2?: Lcc2Scene }, decoders: LccDecoders): Promise<CollisionStream | undefined> {
    const entries: Entry[] = [];
    if (scene.v1) {
      const source = scene.v1.source;
      const header = await decoders.lciHeader(source);
      if (!header || header.meshes.length === 0) {
        return undefined;
      }
      const [x0, y0, z0, , , z1] = header.box;
      for (const mesh of header.meshes) {
        const box = Float32Array.of(
          x0 + mesh.x * header.cellLengthX, y0 + mesh.y * header.cellLengthY, z0,
          x0 + (mesh.x + 1) * header.cellLengthX, y0 + (mesh.y + 1) * header.cellLengthY, z1,
        );
        const what: { mesh: LciMesh } = { mesh };
        entries.push({ id: `${mesh.x}_${mesh.y}`, box, state: "idle", waiters: [], load: (signal) => decoders.collision(source, what, signal) });
      }
    } else if (scene.v2) {
      const v2 = scene.v2;
      for (let node = 0; node < v2.nodes; node += 1) {
        if (v2.mesh[node] < 0) {
          continue;
        }
        const paths = (name: string) => (v2.source.kind === "files" ? [v2.path(name), name.split("/").pop()!] : [name]);
        const what = { node: v2.ids[node], ply: paths(v2.meshFiles[v2.mesh[node]]), btree: paths(v2.bvhFiles[v2.bvh[node]]) };
        entries.push({ id: v2.ids[node], box: v2.bounds.slice(node * 6, node * 6 + 6), state: "idle", waiters: [], load: (signal) => decoders.collision(v2.source, what, signal) });
      }
      if (entries.length === 0) {
        return undefined;
      }
    }
    return entries.length > 0 ? new CollisionStream(entries) : undefined;
  }

  // Once per frame with the camera in the file's frame
  update(eye: Vec3) {
    if (this.disposed) {
      return;
    }
    for (const entry of this.entries) {
      const d = boxDistance(entry.box, eye);
      if (entry.state === "loaded" && d > this.radius * DROP && !this.wanted.has(entry)) {
        this.set.chunks.delete(entry.id);
        entry.state = "idle";
        this.changed();
      }
    }
    const queue = this.entries
      .filter((entry) => entry.state === "idle" && (this.wanted.has(entry) || boxDistance(entry.box, eye) <= this.radius))
      .sort((a, b) => Number(this.wanted.has(b)) - Number(this.wanted.has(a)) || boxDistance(a.box, eye) - boxDistance(b.box, eye));
    for (const entry of queue) {
      if (this.loads >= MAX_LOADS) {
        break;
      }
      void this.load(entry);
    }
  }

  private async load(entry: Entry) {
    const controller = new AbortController();
    entry.state = "loading";
    entry.controller = controller;
    this.loads += 1;
    this.stats.loading = this.loads;
    try {
      const chunk = await entry.load(controller.signal);
      if (this.disposed) {
        return;
      }
      const problems = checkBvh(chunk);
      if (problems.length > 0) {
        throw new Error(`bad BVH: ${problems[0]}`);
      }
      entry.box = chunk.box;
      entry.state = "loaded";
      this.set.chunks.set(entry.id, chunk);
    } catch (error) {
      entry.state = "failed";
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        this.onError(`Collision ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      entry.controller = undefined;
      this.loads -= 1;
      this.stats.loading = this.loads;
      this.wanted.delete(entry);
      entry.waiters.splice(0).forEach((resolve) => resolve());
      this.changed();
    }
  }

  // The entries whose box is within `margin` of `point`
  near(point: Vec3, margin: number) {
    return this.entries.filter((entry) => boxDistance(entry.box, point) <= margin);
  }

  // Whether every chunk near `point` has loaded (or failed)
  loadedAt(point: Vec3, margin: number) {
    return this.near(point, margin).every((entry) => entry.state === "loaded" || entry.state === "failed");
  }

  // Resolves when the chunks near `point` have loaded (asking for them first)
  ready(point: Vec3, margin: number): Promise<void> {
    const waits = this.near(point, margin).filter((entry) => entry.state !== "loaded" && entry.state !== "failed").map((entry) => {
      this.wanted.add(entry);
      return new Promise<void>((resolve) => entry.waiters.push(resolve));
    });
    return Promise.all(waits).then(() => {});
  }

  private changed() {
    const loaded = this.entries.filter((entry) => entry.state === "loaded").length;
    Object.assign(this.stats, { loaded, failed: this.entries.filter((entry) => entry.state === "failed").length, triangles: this.set.triangles });
    this.onChange();
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.entries) {
      entry.controller?.abort();
      entry.waiters.splice(0).forEach((resolve) => resolve());
    }
    this.set.chunks.clear();
  }
}
