/*!
 * The PlayCanvas engine, https://github.com/playcanvas/engine
 *
 * Copyright (c) 2011-2026 PlayCanvas Ltd.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { ArrayData, GpuArrays, SplatCollection, type AnySplatObject } from "@sparkjsdev/radix";
import { closePrepared, prepareSogGpu, uploadSogGpu, type PreparedSog } from "./gpuDecode.js";
import { availableLevel, fovScale, selectLevels, type LodSettings, type SogLodTree } from "./lod.js";
import { Resident } from "./resident.js";
import { MAX_RANGES, RANGES_BUNDLE, sogObject, type SogArrays } from "./sh.js";
import { fetchBytes, urlSource } from "./sog.js";

const MAX_LOADS = 4;
const MIN_SELECT_MS = 100;
const MAX_POOLED = 64;

// Load tiers, the higher first
const PREFETCH = 0;
const SWITCH = 1;
const VISIBLE = 2;
const BASE = 3;
export const TIERS = ["prefetch", "switch", "visible", "base"] as const;

interface LodFile {
  url: string;
  // -1: the environment
  level: number;
  state: "idle" | "loading" | "resident" | "failed";
  gpu?: SogArrays;
  resident?: Resident;
  splats: number;
  lastUsed: number;
  tint: THREE.Color;
  // The object drawing this file's shown ranges, and what it was made from
  key?: string;
  object?: AnySplatObject;
}

export interface LodStats {
  selections: number;
  selected: number;
  shown: number;
  // Leaves showing each level
  shownLevels: number[];
  residentFiles: number;
  residentSplats: number;
  loading: number;
  loaded: number;
  evicted: number;
  failed: number;
  // GPU decode of the last file (download excluded)
  decodeMs: number;
  // The last update's range tables: how many were made, the splats they
  // list and the ms building and uploading them
  lists: number;
  listSplats: number;
  listMs: number;
  // Files wanted and not resident, per tier (TIERS order)
  waiting: number[];
}

export class SogLodStream {
  readonly tree: SogLodTree;
  readonly settings: LodSettings;
  readonly stats: LodStats;
  collection = SplatCollection.EMPTY;
  // While set, update() does nothing, so checks read a steady state
  paused = false;
  private readonly renderer: WebGPURenderer;
  private readonly camera: THREE.Camera;
  private readonly matrixWorld: THREE.Matrix4;
  private readonly files: LodFile[];
  private readonly environment?: LodFile;
  private readonly desired: Int8Array;
  private readonly shown: Int8Array;
  private readonly distance: Float32Array;
  // Every leaf's coarsest level's file: loaded first, never evicted
  private readonly base = new Set<number>();
  private readonly pool: GpuArrays[] = [];
  // Downloaded files waiting for their upload
  private readonly ready: { file: LodFile; prepared: PreparedSog }[] = [];
  private degree: number;
  private loads = 0;
  private selectedAt = -Infinity;
  private dirty = true;
  private changed = true;
  private disposed = false;
  private readonly eye = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly lastEye = new THREE.Vector3(Infinity, 0, 0);
  private readonly lastForward = new THREE.Vector3();
  private readonly toObject = new THREE.Matrix4();

  constructor({ renderer, tree, camera, matrixWorld, settings, degree }: {
    renderer: WebGPURenderer;
    tree: SogLodTree;
    camera: THREE.Camera;
    matrixWorld: THREE.Matrix4;
    settings: LodSettings;
    degree: number;
  }) {
    this.renderer = renderer;
    this.tree = tree;
    this.camera = camera;
    this.matrixWorld = matrixWorld;
    this.settings = settings;
    this.degree = degree;
    const file = (url: string, level: number): LodFile => ({ url, level, state: "idle", splats: 0, lastUsed: 0, tint: new THREE.Color(1, 1, 1) });
    this.files = tree.files.map((url, i) => file(url, tree.fileLevel[i]));
    this.environment = tree.environment ? file(tree.environment, -1) : undefined;
    this.desired = new Int8Array(tree.leaves).fill(-1);
    this.shown = new Int8Array(tree.leaves).fill(-1);
    this.distance = new Float32Array(tree.leaves);
    for (let leaf = 0; leaf < tree.leaves; leaf += 1) {
      this.base.add(tree.file[leaf * tree.levels + availableLevel(tree, leaf, tree.levels - 1)]);
    }
    this.stats = {
      selections: 0, selected: 0, shown: 0, shownLevels: new Array<number>(tree.levels).fill(0),
      residentFiles: 0, residentSplats: 0, loading: 0, loaded: 0, evicted: 0, failed: 0, decodeMs: 0, lists: 0, listSplats: 0, listMs: 0,
      waiting: TIERS.map(() => 0),
    };
    this.applyTints();
  }

  // Settings changed (selection, tints): re-select at the next update
  invalidate() {
    this.dirty = true;
    this.applyTints();
  }

  setDegree(degree: number) {
    if (degree !== this.degree) {
      this.degree = degree;
      this.changed = true;
    }
  }

  // Returns whether the collection is new
  update(now = performance.now()): boolean {
    if (this.disposed || this.paused) {
      return false;
    }
    this.land();
    const s = this.settings;
    this.toObject.copy(this.matrixWorld).invert();
    this.eye.setFromMatrixPosition(this.camera.matrixWorld).applyMatrix4(this.toObject);
    this.camera.getWorldDirection(this.forward).transformDirection(this.toObject);
    const moved = this.eye.distanceTo(this.lastEye) > s.updateDistance || this.forward.angleTo(this.lastForward) > THREE.MathUtils.degToRad(s.updateAngle);
    if (!s.freeze && (moved || this.dirty) && now - this.selectedAt >= MIN_SELECT_MS) {
      this.selectedAt = now;
      this.dirty = false;
      this.lastEye.copy(this.eye);
      this.lastForward.copy(this.forward);
      const perspective = this.camera as THREE.PerspectiveCamera;
      const fov = perspective.isPerspectiveCamera ? fovScale(perspective.fov, perspective.aspect) : 1;
      this.stats.selected = selectLevels(this.tree, this.eye, this.forward, s, this.desired, this.distance, fov);
      this.stats.selections += 1;
      this.changed = true;
    }
    if (!this.changed) {
      return false;
    }
    this.changed = false;
    this.show(now);
    this.evict(this.request(now));
    return true;
  }

  // For the checks in validate.ts
  inspect() {
    const objects = this.files.flatMap((file, f) => {
      const data = file.object?.data as { ranges?: GpuArrays } | undefined;
      const leaves = file.key?.split("|")[1]?.split(",").map(Number) ?? [];
      return file.object ? [{ file: f, level: file.level, leaves, ranges: data?.ranges, count: file.object.count, gpu: file.gpu! }] : [];
    });
    return { objects, shown: this.shown, desired: this.desired, resident: (leaf: number, level: number) => this.resident(leaf, level) };
  }

  dispose() {
    this.disposed = true;
    for (const file of [...this.files, ...(this.environment ? [this.environment] : [])]) {
      file.resident?.drop();
    }
    this.ready.forEach(({ prepared }) => closePrepared(prepared));
    this.pool.forEach((list) => list.dispose());
  }

  // The selected level, or with underfill the finest resident one in its
  // window, else the coarsest it has there
  private target(leaf: number): number {
    const want = this.desired[leaf];
    const underfill = Math.max(0, Math.floor(this.settings.underfillLimit));
    if (want < 0 || underfill === 0) {
      return want;
    }
    const last = Math.min(this.tree.levels - 1, want + underfill);
    for (let level = want; level <= last; level += 1) {
      if (this.resident(leaf, level)) {
        return level;
      }
    }
    for (let level = last; level > want; level -= 1) {
      if (this.tree.file[leaf * this.tree.levels + level] >= 0) {
        return level;
      }
    }
    return want;
  }

  // Starts loads by tier, then coarsest level, then nearest leaf, after
  // PlayCanvas's GSplatOctreeInstance, and returns the files wanted
  private request(now: number): Set<number> {
    const { tree, distance } = this;
    // Per file: [tier, level, distance], the most urgent of its leaves
    const priority = new Map<number, [number, number, number]>();
    const want = (f: number, tier: number, d: number) => {
      const level = this.files[f].level;
      const current = priority.get(f);
      if (!current || tier > current[0] || (tier === current[0] && (level > current[1] || (level === current[1] && d < current[2])))) {
        priority.set(f, [tier, level, d]);
      }
    };
    for (const f of this.base) {
      want(f, BASE, -1);
    }
    for (let leaf = 0; leaf < tree.leaves; leaf += 1) {
      const target = this.target(leaf);
      if (target < 0) {
        continue;
      }
      const base = leaf * tree.levels;
      if (!this.resident(leaf, target)) {
        want(tree.file[base + target], this.shown[leaf] < 0 ? VISIBLE : SWITCH, distance[leaf]);
      }
      // One level finer toward the selected one
      for (let level = target - 1; level >= this.desired[leaf]; level -= 1) {
        if (tree.file[base + level] >= 0) {
          want(tree.file[base + level], PREFETCH, distance[leaf]);
          break;
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
    if (this.environment?.state === "idle") {
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

  // update() uploads one downloaded file per call, so uploads spread over frames
  private async load(file: LodFile) {
    file.state = "loading";
    this.loads += 1;
    this.stats.loading = this.loads;
    try {
      const metaBytes = await fetchBytes(file.url);
      const prepared = await prepareSogGpu(urlSource(file.url, JSON.parse(new TextDecoder().decode(metaBytes))));
      if (this.disposed) {
        closePrepared(prepared);
      } else {
        this.ready.push({ file, prepared });
      }
    } catch (error) {
      console.warn(`SOG LoD: ${file.url}: ${error instanceof Error ? error.message : String(error)}`);
      file.state = "failed";
      this.stats.failed += 1;
      this.changed = true;
    } finally {
      this.loads -= 1;
      this.stats.loading = this.loads + this.ready.length;
    }
  }

  // Upload the next downloaded file
  private land() {
    const job = this.ready.shift();
    if (!job) {
      return;
    }
    const start = performance.now();
    const { file } = job;
    const gpu = uploadSogGpu(this.renderer, job.prepared);
    this.stats.decodeMs = performance.now() - start;
    file.gpu = gpu;
    file.splats = gpu.arrays.count;
    file.resident = new Resident(() => {
      gpu.arrays.dispose();
      gpu.palette?.dispose();
    });
    file.state = "resident";
    this.stats.loaded += 1;
    this.stats.loading = this.loads + this.ready.length;
    this.changed = true;
  }

  private returnTable(table: GpuArrays) {
    if (this.disposed || this.pool.length >= MAX_POOLED) {
      table.dispose();
    } else {
      this.pool.push(table);
    }
  }

  private resident(leaf: number, level: number) {
    const f = level >= 0 && level < this.tree.levels ? this.tree.file[leaf * this.tree.levels + level] : -1;
    return f >= 0 && this.files[f].state === "resident";
  }

  // A leaf shows its target level if resident, else the one it showed, else
  // the nearest resident one, so a switch never leaves a hole
  private show(now: number) {
    const { tree, desired, shown, stats } = this;
    const ranges = new Map<number, number[]>();
    stats.shownLevels.fill(0);
    stats.shown = 0;
    for (let leaf = 0; leaf < tree.leaves; leaf += 1) {
      let level = -1;
      const want = desired[leaf];
      if (want >= 0) {
        const target = this.target(leaf);
        if (this.resident(leaf, target)) {
          level = target;
        } else if (this.resident(leaf, shown[leaf])) {
          level = shown[leaf];
        } else {
          for (let step = 1; step < tree.levels && level < 0; step += 1) {
            level = this.resident(leaf, want + step) ? want + step : this.resident(leaf, want - step) ? want - step : -1;
          }
        }
      }
      shown[leaf] = level;
      if (level >= 0) {
        const at = leaf * tree.levels + level;
        const list = ranges.get(tree.file[at]) ?? [];
        list.push(leaf);
        ranges.set(tree.file[at], list);
        stats.shownLevels[level] += 1;
        stats.shown += tree.count[at];
      }
    }

    stats.lists = stats.listSplats = stats.listMs = 0;
    const objects: AnySplatObject[] = [];
    const env = this.environment;
    if (env?.state === "resident") {
      objects.push(this.objectOf(env, `env|${this.degree}`, undefined));
    }
    this.files.forEach((file, f) => {
      const leaves = ranges.get(f);
      if (!leaves) {
        file.key = file.object = undefined;
        return;
      }
      file.lastUsed = now;
      objects.push(this.objectOf(file, `${this.degree}|${leaves.join(",")}`, leaves));
    });
    this.collection = objects.length > 0 ? new SplatCollection(objects) : SplatCollection.EMPTY;
  }

  private objectOf(file: LodFile, key: string, leaves: number[] | undefined): AnySplatObject {
    if (file.key === key && file.object) {
      return file.object;
    }
    const gpu = file.gpu!;
    const release = file.resident!.hold();
    let ranges: GpuArrays | undefined;
    let count = gpu.arrays.count;
    if (leaves) {
      const start = performance.now();
      const table = this.rangesOf(leaves, file.level);
      count = table.meta.count as number;
      ranges = this.pool.pop() ?? new GpuArrays({ renderer: this.renderer, bundles: { ranges: RANGES_BUNDLE } });
      ranges.upload(table);
      this.stats.lists += 1;
      this.stats.listSplats += count;
      this.stats.listMs += performance.now() - start;
    }
    const pooled = ranges;
    file.key = key;
    file.object = sogObject(gpu, {
      degree: this.degree, matrixWorld: this.matrixWorld, ranges, count, tint: file.tint,
      release: () => {
        if (pooled) {
          this.returnTable(pooled);
        }
        release();
      },
    });
    return file.object;
  }

  // The leaves' ranges, touching ones merged: a new selection uploads a small
  // table, not per-splat index lists
  private rangesOf(leaves: number[], level: number): ArrayData {
    const { tree } = this;
    const spans = leaves.map((leaf) => leaf * tree.levels + level).sort((a, b) => tree.offset[a] - tree.offset[b]);
    const rows: number[] = [];
    let total = 0;
    let end = -1;
    for (const at of spans) {
      const offset = tree.offset[at];
      if (offset !== end) {
        rows.push(total, offset);
      }
      total += tree.count[at];
      end = offset + tree.count[at];
    }
    if (rows.length / 2 > MAX_RANGES) {
      throw new Error(`SOG LoD: ${rows.length / 2} ranges in one file (at most ${MAX_RANGES})`);
    }
    const table = new ArrayData({ count: rows.length / 2, meta: { count: total } }).addBundle("ranges", RANGES_BUNDLE);
    table.bundles.ranges.channels.range.data.set(rows);
    return table;
  }

  // Past the resident budget, drop files nothing shows or wants, least
  // recently used first
  private evict(wanted: Set<number>) {
    const all = [...this.files, ...(this.environment ? [this.environment] : [])];
    let splats = all.reduce((sum, file) => sum + (file.state === "resident" ? file.splats : 0), 0);
    const candidates = this.files
      .map((file, f) => ({ file, f }))
      .filter(({ file, f }) => file.state === "resident" && !file.object && !wanted.has(f))
      .sort((a, b) => a.file.lastUsed - b.file.lastUsed);
    for (const { file } of candidates) {
      if (splats <= this.settings.residentBudget) {
        break;
      }
      splats -= file.splats;
      file.state = "idle";
      file.gpu = undefined;
      file.resident!.drop();
      file.resident = undefined;
      this.stats.evicted += 1;
    }
    this.stats.residentSplats = splats;
    this.stats.residentFiles = all.filter((file) => file.state === "resident").length;
  }

  private applyTints() {
    const levels = this.tree.levels;
    for (const file of this.files) {
      if (this.settings.colorLevels && file.level >= 0) {
        file.tint.setHSL((file.level / Math.max(1, levels)) * 0.8, 0.9, 0.6);
      } else {
        file.tint.setRGB(1, 1, 1);
      }
    }
  }
}
