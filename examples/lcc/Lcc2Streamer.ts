// Level of detail and residency for one LCC2 scene (Lcc2Scene.ts). Each
// selection is a cut through the tree (lcc2Select.ts: every leaf under
// exactly one drawn node). A cut node draws its own rows once its chunk file
// is resident; else its children if they all are (zooming out keeps the
// finer view until the coarser one lands), else its nearest resident
// ancestor, and the nodes under a drawn ancestor are dropped, so the view
// has neither holes (once the coarsest level is in) nor double coverage.
// Files load by tier, after examples/sogs/lodStream.ts: the coarsest level
// (the root's children, never evicted) and the environment first, then the
// files of cut nodes showing nothing, then the cut's other files, then the
// children of nodes about to split; within a tier coarser levels first, then
// nearer nodes. .sog files are downloaded and their images decoded off the
// main thread, then uploaded and decoded on the GPU (../sogs/gpuDecode.ts),
// one file per update; .spz / .ply files are decoded by the worker pool
// (lccChunk.ts, with their SH). Each resident file with drawn nodes is one
// object drawing those nodes' rows through a small table of ranges
// (../sogs/sh.ts RANGES_BUNDLE, rangeLookup), or the whole file when that is
// all of it. Files past the GPU byte budget that nothing draws or wants are
// evicted, least recently used first, and freed once no live collection
// holds them (../sogs/resident.ts).
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { ArrayData, GpuArrays, SplatCollection, type AnySplatObject } from "@sparkjsdev/radix";
import { closePrepared, prepareSogGpu, uploadSogGpu, type PreparedSog } from "../sogs/gpuDecode.js";
import { fovScale } from "../sogs/lod.js";
import { Resident } from "../sogs/resident.js";
import { MAX_RANGES, RANGES_BUNDLE, sogObject, type SogArrays } from "../sogs/sh.js";
import { openSogInput } from "../sogs/sog.js";
import type { Lcc2Scene } from "./Lcc2Scene.js";
import { selectCut, type Lcc2Cut } from "./lcc2Select.js";
import type { LccDecoders } from "./LccDecoders.js";
import { lccGenerator, type LccBlockData } from "./lccSh.tsl.js";
import { ENVIRONMENT_COLOR, LEVEL_COLORS, type LccBox, type LccStream, type LccStreamerSettings, type LccStreamStats } from "./LccStreamer.js";

const MAX_LOADS = 4;
const MIN_SELECT_MS = 100;
const MAX_POOLED = 64;
// Re-select after the camera moves this far (scene units) or turns this much
const UPDATE_DISTANCE = 0.05;
const UPDATE_ANGLE = THREE.MathUtils.degToRad(10);

// Load tiers, the higher first
const PREFETCH = 0;
const SWITCH = 1;
const VISIBLE = 2;
const BASE = 3;

interface ChunkFile {
  // Index in splatFiles
  index: number;
  name: string;
  // -1: the environment
  level: number;
  state: "idle" | "loading" | "resident" | "failed" | "missing";
  // A .sog on the GPU, or a .spz / .ply's arrays (with extSh)
  sog?: SogArrays;
  arrays?: GpuArrays;
  sh: boolean;
  data?: ArrayData;
  resident?: Resident;
  controller?: AbortController;
  splats: number;
  bytes: number;
  lastUsed: number;
  tint: THREE.Color;
  // The object drawing the file's drawn nodes, and what it was made from
  key?: string;
  object?: AnySplatObject;
  // The nodes it draws (export)
  drawn: number[];
}

export class Lcc2Streamer implements LccStream {
  readonly scene: Lcc2Scene;
  readonly settings: LccStreamerSettings;
  onChange: (collection: SplatCollection) => void = () => {};
  onError: (message: string) => void = () => {};
  readonly stats: LccStreamStats & { selected: number; nodes: number; waiting: number[] };
  // The last cut, and the nodes drawn (checks)
  cut?: Lcc2Cut;
  readonly drawn = new Set<number>();

  private readonly renderer: WebGPURenderer;
  private readonly decoders: LccDecoders;
  private readonly matrixWorld: THREE.Matrix4;
  private readonly files: ChunkFile[];
  private readonly environment?: ChunkFile;
  private readonly base = new Set<number>();
  private readonly ready: { file: ChunkFile; prepared?: PreparedSog; data?: ArrayData }[] = [];
  private readonly pool: GpuArrays[] = [];
  private degree = 3;
  private loads = 0;
  private selectedAt = -Infinity;
  private dirty = true;
  private changed = true;
  private disposed = false;
  private colorByLevel = false;
  private readonly eye = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly lastEye = new THREE.Vector3(Infinity, 0, 0);
  private readonly lastForward = new THREE.Vector3();
  private readonly toObject = new THREE.Matrix4();
  private camera?: THREE.Camera;
  private lastSettings = "";

  constructor({ renderer, scene, decoders, matrixWorld, settings }: {
    renderer: WebGPURenderer;
    scene: Lcc2Scene;
    decoders: LccDecoders;
    matrixWorld: THREE.Matrix4;
    settings: LccStreamerSettings;
  }) {
    this.renderer = renderer;
    this.scene = scene;
    this.decoders = decoders;
    this.matrixWorld = matrixWorld;
    this.settings = settings;
    const file = (index: number, level: number): ChunkFile => ({
      index, name: scene.splatFiles[index], level, state: "idle", sh: false, splats: 0, bytes: 0, lastUsed: 0, tint: new THREE.Color(1, 1, 1), drawn: [],
    });
    this.files = scene.splatFiles.map((_, i) => file(i, scene.fileLevel[i]));
    this.environment = scene.envFile !== undefined && scene.envFile < scene.splatFiles.length ? file(scene.envFile, -1) : undefined;
    for (let k = 0; k < scene.childCount[0]; k += 1) {
      const node = scene.children[scene.firstChild[0] + k];
      if (scene.file[node] >= 0) {
        this.base.add(scene.file[node]);
      }
    }
    this.stats = {
      drawn: 0, drawnPerLevel: new Array<number>(scene.levels).fill(0), environment: 0, resident: 0, residentBytes: 0, loading: 0, failed: 0,
      selected: 0, nodes: 0, waiting: [0, 0, 0, 0],
    };
  }

  get levels() {
    return this.scene.levels;
  }

  invalidate() {
    this.dirty = true;
    this.changed = true;
  }

  setDegree(degree: number) {
    if (degree !== this.degree) {
      this.degree = degree;
      this.changed = true;
    }
  }

  update(camera: THREE.Camera) {
    if (this.disposed) {
      return;
    }
    this.camera = camera;
    const now = performance.now();
    this.land();
    const s = this.settings;
    const key = `${s.level}|${s.lodDistance}|${s.behindPenalty}|${s.budget}|${s.budgetMode}`;
    if (key !== this.lastSettings) {
      this.lastSettings = key;
      this.dirty = true;
    }
    if (this.colorByLevel !== s.colorByLevel) {
      this.colorByLevel = s.colorByLevel;
      for (const file of [...this.files, ...(this.environment ? [this.environment] : [])]) {
        file.tint.set(!s.colorByLevel ? "#ffffff" : file.level < 0 ? ENVIRONMENT_COLOR : LEVEL_COLORS[file.level % LEVEL_COLORS.length]);
      }
    }

    this.toObject.copy(this.matrixWorld).invert();
    this.eye.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this.toObject);
    camera.getWorldDirection(this.forward).transformDirection(this.toObject);
    const moved = this.eye.distanceTo(this.lastEye) > UPDATE_DISTANCE * Math.max(s.lodDistance, 1e-3) || this.forward.angleTo(this.lastForward) > UPDATE_ANGLE;
    if (!s.freeze && (moved || this.dirty || !this.cut) && now - this.selectedAt >= MIN_SELECT_MS) {
      this.selectedAt = now;
      this.dirty = false;
      this.lastEye.copy(this.eye);
      this.lastForward.copy(this.forward);
      const perspective = camera as THREE.PerspectiveCamera;
      const fov = perspective.isPerspectiveCamera ? fovScale(perspective.fov, perspective.aspect) : 1;
      this.cut = selectCut(this.scene, this.eye, this.forward, s, fov, this.cut);
      this.stats.selected = this.cut.splats;
      this.stats.nodes = this.cut.nodes.length;
      this.changed = true;
    }
    const environmentShown = s.environment && this.environment?.state === "resident";
    if (environmentShown !== (this.environment?.object !== undefined)) {
      this.changed = true;
    }
    if (this.changed) {
      this.changed = false;
      this.show(now);
      this.onChange(this.collection(now));
    }
    this.evict(this.request(now));
  }

  private isResident(node: number) {
    const f = this.scene.file[node];
    return f >= 0 && this.files[f].state === "resident";
  }

  // The nodes to draw: each cut node, its children, or its nearest resident
  // ancestor, without nodes under another drawn node
  private show(now: number) {
    const { scene, drawn } = this;
    drawn.clear();
    for (const node of this.cut?.nodes ?? []) {
      if (this.isResident(node) || scene.file[node] < 0) {
        drawn.add(node);
        continue;
      }
      const first = scene.firstChild[node];
      const count = scene.childCount[node];
      let children = count > 0;
      for (let k = 0; k < count && children; k += 1) {
        children = this.isResident(scene.children[first + k]);
      }
      if (children) {
        for (let k = 0; k < count; k += 1) {
          drawn.add(scene.children[first + k]);
        }
        continue;
      }
      for (let up = scene.parent[node]; up > 0; up = scene.parent[up]) {
        if (this.isResident(up)) {
          drawn.add(up);
          break;
        }
      }
    }
    for (const node of [...drawn]) {
      for (let up = scene.parent[node]; up > 0; up = scene.parent[up]) {
        if (drawn.has(up)) {
          drawn.delete(node);
          break;
        }
      }
    }
    for (const file of this.files) {
      file.drawn.length = 0;
    }
    this.stats.drawnPerLevel.fill(0);
    for (const node of drawn) {
      const f = scene.file[node];
      if (f >= 0) {
        this.files[f].drawn.push(node);
        this.files[f].lastUsed = now;
        this.stats.drawnPerLevel[scene.level[node]] += scene.count[node];
      }
    }
  }

  // Start loads by tier, then coarser first, then nearest; the files wanted
  private request(now: number): Set<number> {
    const { scene } = this;
    const priority = new Map<number, [number, number, number]>();
    const want = (node: number, tier: number) => {
      const f = scene.file[node];
      if (f < 0) {
        return;
      }
      const d = this.cut?.distance[node] ?? 0;
      const level = scene.level[node];
      const current = priority.get(f);
      if (!current || tier > current[0] || (tier === current[0] && (level > current[1] || (level === current[1] && d < current[2])))) {
        priority.set(f, [tier, level, d]);
      }
    };
    for (let k = 0; k < scene.childCount[0]; k += 1) {
      want(scene.children[scene.firstChild[0] + k], BASE);
    }
    const logScale = this.cut?.logScale ?? 0;
    for (const node of this.cut?.nodes ?? []) {
      if (!this.isResident(node)) {
        let covered = false;
        for (let up = node; up > 0 && !covered; up = scene.parent[up]) {
          covered = this.drawn.has(up);
        }
        want(node, covered ? SWITCH : VISIBLE);
      }
      for (let k = 0; k < scene.childCount[node]; k += 1) {
        if (this.cut!.split[node] < logScale + Math.LN2) {
          want(scene.children[scene.firstChild[node] + k], PREFETCH);
        }
      }
    }

    this.stats.waiting.fill(0);
    for (const [f, [tier]] of priority) {
      this.files[f].lastUsed = now;
      if (this.files[f].state !== "resident") {
        this.stats.waiting[tier] += 1;
      }
    }
    // Loads nothing wants any more
    for (const file of this.files) {
      if (file.state === "loading" && !priority.has(file.index)) {
        file.controller?.abort();
      }
    }
    if (this.settings.environment && this.environment?.state === "idle" && this.loads < MAX_LOADS) {
      void this.load(this.environment);
    }
    const queue = [...priority].filter(([f]) => this.files[f].state === "idle").sort(([, a], [, b]) => b[0] - a[0] || b[1] - a[1] || a[2] - b[2]);
    for (const [f] of queue) {
      if (this.loads >= MAX_LOADS) {
        break;
      }
      void this.load(this.files[f]);
    }
    return new Set(priority.keys());
  }

  // Download and prepare a file; land() uploads it
  private async load(file: ChunkFile) {
    const controller = new AbortController();
    file.state = "loading";
    file.controller = controller;
    this.loads += 1;
    const { scene } = this;
    try {
      if (scene.splatType === ".sog") {
        const bytes = await scene.read(file.name, controller.signal);
        const input = await openSogInput(bytes, { name: file.name });
        if (input.kind !== "sog") {
          throw new Error("not a SOG file");
        }
        const prepared = await prepareSogGpu(input.source);
        if (this.disposed || controller.signal.aborted) {
          closePrepared(prepared);
          file.state = "idle";
        } else {
          this.ready.push({ file, prepared });
        }
      } else {
        const paths = scene.source.kind === "files" ? [scene.path(file.name), file.name.split("/").pop()!] : [file.name];
        const data = await this.decoders.chunk(scene.source, paths, { sh: scene.sh, signal: controller.signal });
        if (this.disposed || controller.signal.aborted) {
          file.state = "idle";
        } else {
          this.ready.push({ file, data });
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        file.state = "idle";
      } else if (file.level < 0) {
        // A missing environment is the normal "no sky" case
        file.state = "missing";
      } else {
        file.state = "failed";
        this.stats.failed += 1;
        this.onError(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      file.controller = undefined;
      this.loads -= 1;
    }
  }

  // Upload the next prepared file
  private land() {
    const job = this.ready.shift();
    if (!job) {
      return;
    }
    const { file } = job;
    if (job.prepared) {
      const sog = uploadSogGpu(this.renderer, job.prepared);
      file.sog = sog;
      file.splats = sog.arrays.count;
      file.bytes = file.splats * 34 + (sog.palette ? sog.palette.count * 16 : 0);
      file.resident = new Resident(() => {
        sog.arrays.dispose();
        sog.palette?.dispose();
      });
    } else if (job.data) {
      const arrays = GpuArrays.fromData(this.renderer, job.data);
      file.arrays = arrays;
      file.sh = job.data.meta.lccSh === true;
      file.splats = job.data.count;
      file.bytes = file.splats * (file.sh ? 96 : 32);
      file.data = this.settings.keepCpu ? job.data : undefined;
      file.resident = new Resident(() => arrays.dispose());
    }
    file.state = "resident";
    this.changed = true;
  }

  // The environment and each file's drawn nodes as objects
  private collection(now: number) {
    const objects: AnySplatObject[] = [];
    let drawn = 0;
    const env = this.environment;
    this.stats.environment = 0;
    if (env) {
      if (this.settings.environment && env.state === "resident") {
        objects.push(this.objectOf(env, `env|${this.degree}`, undefined));
        drawn += env.splats;
        this.stats.environment = env.splats;
        env.lastUsed = now;
      } else {
        env.key = env.object = undefined;
      }
    }
    for (const file of this.files) {
      if (file.drawn.length === 0 || file.state !== "resident") {
        file.key = file.object = undefined;
        continue;
      }
      file.drawn.sort((a, b) => this.scene.start[a] - this.scene.start[b]);
      objects.push(this.objectOf(file, `${this.degree}|${file.drawn.join(",")}`, file.drawn));
      drawn += file.object!.count;
    }
    this.stats.drawn = drawn;
    return objects.length > 0 ? new SplatCollection(objects) : SplatCollection.EMPTY;
  }

  // The rows of `nodes` (sorted by start) as a RANGES_BUNDLE table, touching
  // ranges merged; undefined when they are the whole file
  private rowsOf(file: ChunkFile, nodes: number[]): { table?: ArrayData; count: number } {
    const { scene } = this;
    const rows: number[] = [];
    let total = 0;
    let end = -1;
    for (const node of nodes) {
      const start = scene.start[node];
      const count = Math.min(scene.count[node], Math.max(0, file.splats - start));
      if (start !== end) {
        rows.push(total, start);
      }
      total += count;
      end = start + count;
    }
    if (rows.length === 2 && rows[1] === 0 && total === file.splats) {
      return { count: total };
    }
    if (rows.length / 2 > MAX_RANGES) {
      throw new Error(`LCC2: ${rows.length / 2} ranges in ${file.name} (at most ${MAX_RANGES})`);
    }
    const table = new ArrayData({ count: rows.length / 2 }).addBundle("ranges", RANGES_BUNDLE);
    table.bundles.ranges.channels.range.data.set(rows);
    return { table, count: total };
  }

  private objectOf(file: ChunkFile, key: string, nodes: number[] | undefined): AnySplatObject {
    if (file.key === key && file.object) {
      return file.object;
    }
    const release = file.resident!.hold();
    const { table, count } = nodes ? this.rowsOf(file, nodes) : { table: undefined, count: file.splats };
    let rows: GpuArrays | undefined;
    if (table) {
      rows = this.pool.pop() ?? new GpuArrays({ renderer: this.renderer, bundles: { ranges: RANGES_BUNDLE } });
      rows.upload(table);
    }
    const pooled = rows;
    const done = () => {
      if (pooled) {
        if (this.disposed || this.pool.length >= MAX_POOLED) {
          pooled.dispose();
        } else {
          this.pool.push(pooled);
        }
      }
      release();
    };
    file.key = key;
    if (file.sog) {
      file.object = sogObject(file.sog, { degree: this.degree, matrixWorld: this.matrixWorld, ranges: rows, count, tint: file.tint, release: done });
    } else {
      const data: LccBlockData = { splats: file.arrays!, rows, tint: file.tint };
      file.object = SplatCollection.object({
        generator: lccGenerator({ sh: file.sh, remap: rows !== undefined }), data, count, matrixWorld: this.matrixWorld,
        params: { maxShDegree: this.degree }, release: done,
      });
    }
    return file.object;
  }

  // Past the GPU byte budget, drop files nothing draws or wants (never the
  // coarsest level's), least recently used first
  private evict(wanted: Set<number>) {
    const all = [...this.files, ...(this.environment ? [this.environment] : [])];
    let bytes = all.reduce((sum, file) => sum + (file.state === "resident" ? file.bytes : 0), 0);
    const candidates = this.files
      .filter((file) => file.state === "resident" && !file.object && !wanted.has(file.index) && !this.base.has(file.index))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const file of candidates) {
      if (bytes <= this.settings.cacheBytes) {
        break;
      }
      bytes -= file.bytes;
      this.unload(file);
    }
    this.stats.residentBytes = bytes;
    this.stats.resident = all.filter((file) => file.state === "resident").length;
    this.stats.loading = this.loads + this.ready.length;
  }

  private unload(file: ChunkFile) {
    file.state = "idle";
    file.sog = file.arrays = file.data = undefined;
    file.resident?.drop();
    file.resident = undefined;
  }

  get environmentState() {
    const env = this.environment;
    if (!env || env.state === "missing") {
      return "none";
    }
    if (!this.settings.environment) {
      return "off";
    }
    return env.state === "resident" ? `${env.splats} splats` : env.state === "idle" ? "loading" : env.state;
  }

  // The drawn nodes' boxes with their levels
  boxes(): LccBox[] {
    const { bounds, level } = this.scene;
    return [...this.drawn].map((node) => ({ min: bounds.subarray(node * 6, node * 6 + 3), max: bounds.subarray(node * 6 + 3, node * 6 + 6), level: level[node] }));
  }

  // The CPU copies of the drawn rows and the environment (read back from the
  // GPU when not kept)
  async drawnData(): Promise<ArrayData[]> {
    const out: ArrayData[] = [];
    const read = async (file: ChunkFile, start: number, count: number) => {
      const arrays = file.sog?.arrays ?? file.arrays;
      if (!arrays || count === 0) {
        return;
      }
      if (file.data) {
        const part = new ArrayData({ count }).addBundle("extSplats", file.data.bundles.extSplats.def);
        part.copyFrom(file.data, { bundles: ["extSplats"], srcStart: start, count });
        out.push(part);
      } else {
        out.push(await arrays.read({ bundles: ["extSplats"], start, count }));
      }
    };
    const env = this.environment;
    if (env?.object) {
      await read(env, 0, env.splats);
    }
    for (const file of this.files) {
      if (!file.object) {
        continue;
      }
      for (const node of file.drawn) {
        await read(file, this.scene.start[node], Math.min(this.scene.count[node], file.splats - this.scene.start[node]));
      }
    }
    return out;
  }

  dispose() {
    this.disposed = true;
    for (const file of [...this.files, ...(this.environment ? [this.environment] : [])]) {
      file.controller?.abort();
      if (file.state === "resident") {
        this.unload(file);
      }
    }
    this.ready.forEach(({ prepared }) => prepared && closePrepared(prepared));
    this.ready.length = 0;
    this.pool.forEach((table) => table.dispose());
    this.pool.length = 0;
  }
}
