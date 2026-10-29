// Streaming a SOG LoD scene into one SplatRenderer's collection. Files load
// on demand and are decoded on the GPU (gpuDecode.ts). Each leaf shows the
// finest resident level from its selected one to underfillLimit levels
// coarser, else the level it showed before, else the nearest resident one
// (coarser first), so a switch never leaves a hole. Loads go by tier, then
// coarsest level first, then nearest (after PlayCanvas's
// GSplatOctreeInstance): every leaf's coarsest level (so the whole scene
// shows at once), leaves showing nothing, the level a leaf should show
// (the selected one, or with underfill the coarsest in its window), then
// one level finer toward the selected one: the view fills coarse first and
// refines a level at a time. The collection has one object per resident file that leaves
// show, drawing a small table of those leaves' ranges (sh.ts rangeLookup:
// a binary search per splat, so a new selection uploads a few KB, where
// per-splat index lists would upload MBs), rebuilt only when they change;
// plus the environment, whole. One file lands per update. Files past the
// resident budget that nothing shows or wants are evicted, least recently
// used first, and freed once no live collection holds them (Resident).
import * as THREE from "three";
                                                   
import { ArrayData, GpuArrays, SplatCollection,                     } from "@sparkjsdev/radix";
import { closePrepared, prepareSogGpu, uploadSogGpu,                  } from "./gpuDecode.js";
import { availableLevel, fovScale, selectLevels,                                   } from "./lod.js";
import { Resident } from "./resident.js";
import { MAX_RANGES, RANGES_BUNDLE, sogObject,                } from "./sh.js";
import { fetchBytes, urlSource } from "./sog.js";

const MAX_LOADS = 4;
const MIN_SELECT_MS = 100;
const MAX_POOLED = 64;

// Load tiers, the higher first
const PREFETCH = 0;
const SWITCH = 1;
const VISIBLE = 2;
const BASE = 3;
export const TIERS = ["prefetch", "switch", "visible", "base"]         ;

                   
              
                        
                
                                                    
                  
                      
                 
                   
                    
                                                                           
               
                          
 

                           
                     
                   
                
                              
                        
                        
                         
                  
                 
                  
                 
                                                    
                   
                                                                        
                                                
                
                     
                 
                                                          
                    
 

export class SogLodStream {
           tree            ;
           settings             ;
           stats          ;
  collection = SplatCollection.EMPTY;
  // While set, update() does nothing (checks read a steady state)
  paused = false;
                   renderer                ;
                   camera              ;
                   matrixWorld               ;
                   files           ;
                   environment          ;
                   desired           ;
                   shown           ;
                   distance              ;
  // Every leaf's coarsest level's file: loaded first, never evicted
                   base = new Set        ();
                   pool              = [];
  // Downloaded files waiting for their upload
                   ready                                             = [];
          degree        ;
          loads = 0;
          selectedAt = -Infinity;
          dirty = true;
          changed = true;
          disposed = false;
                   eye = new THREE.Vector3();
                   forward = new THREE.Vector3();
                   lastEye = new THREE.Vector3(Infinity, 0, 0);
                   lastForward = new THREE.Vector3();
                   toObject = new THREE.Matrix4();

  constructor({ renderer, tree, camera, matrixWorld, settings, degree }   
                             
                     
                         
                               
                          
                   
   ) {
    this.renderer = renderer;
    this.tree = tree;
    this.camera = camera;
    this.matrixWorld = matrixWorld;
    this.settings = settings;
    this.degree = degree;
    const file = (url        , level        )          => ({ url, level, state: "idle", splats: 0, lastUsed: 0, tint: new THREE.Color(1, 1, 1) });
    this.files = tree.files.map((url, i) => file(url, tree.fileLevel[i]));
    this.environment = tree.environment ? file(tree.environment, -1) : undefined;
    this.desired = new Int8Array(tree.leaves).fill(-1);
    this.shown = new Int8Array(tree.leaves).fill(-1);
    this.distance = new Float32Array(tree.leaves);
    for (let leaf = 0; leaf < tree.leaves; leaf += 1) {
      this.base.add(tree.file[leaf * tree.levels + availableLevel(tree, leaf, tree.levels - 1)]);
    }
    this.stats = {
      selections: 0, selected: 0, shown: 0, shownLevels: new Array        (tree.levels).fill(0),
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

  setDegree(degree        ) {
    if (degree !== this.degree) {
      this.degree = degree;
      this.changed = true;
    }
  }

  // Re-select if the camera moved, settings changed or a file landed, load
  // what is wanted and rebuild the objects that changed; whether the
  // collection is new
  update(now = performance.now())          {
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
      const perspective = this.camera                           ;
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

  // What each file's object draws (checks): the file, its level, the
  // leaves whose ranges it draws, its range table and splats, the leaves'
  // levels, and which levels are resident
  inspect() {
    const objects = this.files.flatMap((file, f) => {
      const data = file.object?.data                                      ;
      const leaves = file.key?.split("|")[1]?.split(",").map(Number) ?? [];
      return file.object ? [{ file: f, level: file.level, leaves, ranges: data?.ranges, count: file.object.count, gpu: file.gpu  }] : [];
    });
    return { objects, shown: this.shown, desired: this.desired, resident: (leaf        , level        ) => this.resident(leaf, level) };
  }

  dispose() {
    this.disposed = true;
    for (const file of [...this.files, ...(this.environment ? [this.environment] : [])]) {
      file.resident?.drop();
    }
    this.ready.forEach(({ prepared }) => closePrepared(prepared));
    this.pool.forEach((list) => list.dispose());
  }

  // The level a leaf should show (it requests it): its selected level, or
  // with underfill the finest resident one in its window, else the
  // coarsest it has there
          target(leaf        )         {
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

  // Start loads by tier, then coarsest level first, then nearest leaf (the
  // environment first of all); the files wanted
          request(now        )              {
    const { tree, distance } = this;
    // Per file: [tier, level, distance], the most urgent of its leaves
    const priority = new Map                                  ();
    const want = (f        , tier        , d        ) => {
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

  // Download a file and decode its images off the main thread; update()
  // then uploads it (one file per update, so landings spread over frames)
          async load(file         ) {
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
          land() {
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

          returnTable(table           ) {
    if (this.disposed || this.pool.length >= MAX_POOLED) {
      table.dispose();
    } else {
      this.pool.push(table);
    }
  }

          resident(leaf        , level        ) {
    const f = level >= 0 && level < this.tree.levels ? this.tree.file[leaf * this.tree.levels + level] : -1;
    return f >= 0 && this.files[f].state === "resident";
  }

  // The shown level of every leaf, then one object per file shown
          show(now        ) {
    const { tree, desired, shown, stats } = this;
    const ranges = new Map                  ();
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
    const objects                   = [];
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

  // The file's object for `key`, made anew when the key changed
          objectOf(file         , key        , leaves                      )                 {
    if (file.key === key && file.object) {
      return file.object;
    }
    const gpu = file.gpu ;
    const release = file.resident .hold();
    let ranges                       ;
    let count = gpu.arrays.count;
    if (leaves) {
      const start = performance.now();
      const table = this.rangesOf(leaves, file.level);
      count = table.meta.count          ;
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

  // The ranges of `leaves` at `level` (all in one file) as a RANGES_BUNDLE
  // table: sorted by offset, touching ranges merged; meta.count the splats
          rangesOf(leaves          , level        )            {
    const { tree } = this;
    const spans = leaves.map((leaf) => leaf * tree.levels + level).sort((a, b) => tree.offset[a] - tree.offset[b]);
    const rows           = [];
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
          evict(wanted             ) {
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
      file.resident .drop();
      file.resident = undefined;
      this.stats.evicted += 1;
    }
    this.stats.residentSplats = splats;
    this.stats.residentFiles = all.filter((file) => file.state === "resident").length;
  }

          applyTints() {
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


//# sourceURL=examples/sogs/lodStream.ts