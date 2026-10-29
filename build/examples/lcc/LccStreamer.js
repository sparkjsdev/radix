// Level of detail and residency for one LCC scene. Every cell of the grid
// draws one of its levels: the one its distance asks for (level
// ceil(log2(distance / lodDistance)), kept within a hysteresis band), or
// `settings.level` for all, then coarsened from the farthest cell while the
// total is over the splat budget. A cell draws its old block until the new
// one is decoded; a cell with nothing yet asks for its coarsest level first.
// Blocks are decoded by the worker pool (as many at once as it has free),
// nearest first, uploaded as GpuArrays (ext splats, plus extSh with SH) and
// cached under a GPU byte budget, least recently drawn first out. Each
// block entering the drawn set gets an object (kept while some live
// collection holds it); its release counts down the block's draws, and only
// blocks nothing draws are evicted, so their arrays go at once. The scene's
// environment.bin (background splats outside the grid) is decoded first,
// once, and drawn whole while `settings.environment` is on: outside the
// budget and never evicted.
import * as THREE from "three";
                                                   
import { GpuArrays, SplatCollection,                                                          } from "@sparkjsdev/radix";
                                                    
                                                   
                                                        

// The settings of both streamers (LCC v1's and Lcc2Streamer.ts); the page's
// bar and panel write them
                                      
                                                                   
                         
                                                                                    
                      
                                                                                  
                     
                                                                           
                        
                                                                          
                                              
                                 
                      
                 
                             
                     
                  
                        
                                                
                       
                                                               
                   
 

// Level colors for "color by level", finest first, and the environment's
export const LEVEL_COLORS = ["#ffffff", "#ff6b6b", "#ffd166", "#06d6a0", "#4cc9f0", "#9b5de5", "#f15bb5", "#8d99ae"];
export const ENVIRONMENT_COLOR = "#3a86ff";

                                 
                                                                           
                
                          
                      
                                                          
                   
                        
                  
                 
 

// A box of the scene in the file's frame, with the level drawn there (-1: none yet)
                         
                         
                         
                
 

// What the page drives: LccStreamer (LCC v1) or Lcc2Streamer (LCC2)
                            
                          
                                 
                                                           
                                                  
                                     
                                     
                                                           
                                    
                                                                        
                                  
                                                               
                    
                     
                                    
                  
 

                    
                                                                 
                  
                                                                      
                                                             
                     
                   
                
                               
                          
                                                  
                
                    
                    
 

export class LccStreamer                      {
           scene          ;
           settings                     ;
  // Called with the collection to draw whenever it changes
  onChange                                        = () => {};
  onError                            = () => {};
           stats                 = { drawn: 0, drawnPerLevel: [], environment: 0, resident: 0, residentBytes: 0, loading: 0, failed: 0 };

                   renderer                ;
                   decoders             ;
                   generator                              ;
                   matrixWorld               ;
                   blocks              ;
                   environment           ;
          environmentShown = false;
                   target            ;
                   shown            ;
                   distances              ;
                   local = new THREE.Vector3();
                   inverse = new THREE.Matrix4();
          frame = 0;
          colorByLevel = false;
          disposed = false;
          changed = true;

  constructor({ renderer, scene, decoders, generator, matrixWorld, settings }   
                             
                    
                          
                                            
                                       
                               
                                  
   ) {
    this.renderer = renderer;
    this.scene = scene;
    this.decoders = decoders;
    this.generator = generator;
    this.matrixWorld = matrixWorld;
    this.settings = settings;
    this.blocks = scene.cells.map((cell) => cell.blocks.map((block) => ({
      block, state: block.count === 0 ? "ready" : "idle", bytes: 0, draws: 0, lastDrawn: 0, tint: new THREE.Color(1, 1, 1),
    })));
    this.environment = scene.environment ? {
      block: { cell: -1, level: -1, count: 0, offset: 0, size: 0 }, state: "idle", bytes: 0, draws: 0, lastDrawn: 0, tint: new THREE.Color(1, 1, 1),
    } : undefined;
    this.target = new Int32Array(scene.cells.length).fill(scene.levels - 1);
    this.shown = new Int32Array(scene.cells.length).fill(-1);
    this.distances = new Float64Array(scene.cells.length);
    this.stats.drawnPerLevel = new Array        (scene.levels).fill(0);
  }

  // Once per frame: choose levels, start decodes, update the drawn set
  update(camera              ) {
    if (this.disposed) {
      return;
    }
    this.frame += 1;
    this.measure(camera);
    if (!this.settings.freeze) {
      this.chooseLevels();
    }
    this.request();
    this.show();
    this.evict();
    this.updateTints();
    if (this.changed) {
      this.changed = false;
      this.onChange(this.collection());
    }
  }

  // Cell distances from the camera, in the scene's own frame
          measure(camera              ) {
    this.inverse.copy(this.matrixWorld).invert();
    this.local.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this.inverse);
    const { x, y, z } = this.local;
    this.scene.cells.forEach((cell, c) => {
      const dx = Math.max(cell.min[0] - x, 0, x - cell.max[0]);
      const dy = Math.max(cell.min[1] - y, 0, y - cell.max[1]);
      const dz = Math.max(cell.min[2] - z, 0, z - cell.max[2]);
      this.distances[c] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    });
  }

          chooseLevels() {
    const { level, lodDistance, hysteresis, budget } = this.settings;
    const top = this.scene.levels - 1;
    for (let c = 0; c < this.target.length; c += 1) {
      if (level !== "auto") {
        this.target[c] = Math.max(0, Math.min(top, level));
        continue;
      }
      const t = Math.log2(Math.max(this.distances[c], 1e-6) / Math.max(lodDistance, 1e-6));
      const current = this.target[c];
      const keep = t > current - 1 - hysteresis && t <= current + hysteresis;
      this.target[c] = keep ? current : Math.max(0, Math.min(top, Math.ceil(t)));
    }

    // Over the budget: coarsen the farthest cells first
    let total = this.target.reduce((sum, t, c) => sum + this.blocks[c][t].block.count, 0);
    if (total > budget) {
      const order = Array.from(this.target.keys()).sort((a, b) => this.distances[b] - this.distances[a]);
      for (let pass = 0; pass < this.scene.levels && total > budget; pass += 1) {
        for (const c of order) {
          if (total <= budget) {
            break;
          }
          const t = this.target[c];
          if (t < top) {
            total += this.blocks[c][t + 1].block.count - this.blocks[c][t].block.count;
            this.target[c] = t + 1;
          }
        }
      }
    }
  }

  // Blocks some cell needs: its target, and its coarsest while it draws nothing
          needed() {
    const top = this.scene.levels - 1;
    const wants                                             = [];
    for (let c = 0; c < this.target.length; c += 1) {
      const cell = this.blocks[c];
      if (this.shown[c] < 0 && cell[top].state !== "ready") {
        wants.push({ resident: cell[top], priority: this.distances[c] - 1e9 });
      }
      wants.push({ resident: cell[this.target[c]], priority: this.distances[c] });
    }
    return wants;
  }

          request() {
    const wants = this.needed();
    const wanted = new Set(wants.map((want) => want.resident));

    // Decodes nobody wants any more
    for (const cell of this.blocks) {
      for (const resident of cell) {
        if (resident.state === "loading" && !wanted.has(resident)) {
          resident.controller?.abort();
        }
      }
    }

    if (this.settings.environment && this.environment?.state === "idle" && this.decoders.free > 0) {
      this.loadEnvironment(this.environment);
    }
    const queue = wants.filter((want) => want.resident.state === "idle").sort((a, b) => a.priority - b.priority);
    for (const { resident } of queue) {
      if (this.decoders.free <= 0) {
        break;
      }
      if (resident.state === "idle") {
        this.load(resident);
      }
    }
  }

          load(resident          ) {
    const controller = new AbortController();
    resident.state = "loading";
    resident.controller = controller;
    const { scene } = this;
    this.decoders.decode(scene.source, resident.block, { sh: scene.sh, ranges: scene.ranges, normal: scene.normalRange, signal: controller.signal }).then((data) => {
      resident.controller = undefined;
      if (this.disposed || controller.signal.aborted) {
        resident.state = "idle";
        return;
      }
      resident.arrays = GpuArrays.fromData(this.renderer, data);
      resident.data = this.settings.keepCpu ? data : undefined;
      resident.bytes = data.count * (scene.sh ? 96 : 32);
      resident.state = "ready";
    }, (error         ) => {
      resident.controller = undefined;
      if (error instanceof DOMException && error.name === "AbortError") {
        resident.state = "idle";
        return;
      }
      resident.state = "failed";
      this.onError(`Block ${resident.block.cell}/${resident.block.level}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

          loadEnvironment(resident          ) {
    const { scene } = this;
    resident.state = "loading";
    this.decoders.environment(scene.source, { sh: scene.sh, ranges: scene.envRanges, normal: scene.envNormalRange }).then((data) => {
      if (this.disposed) {
        resident.state = "idle";
        return;
      }
      if (!data || data.count === 0) {
        resident.state = "missing";
        return;
      }
      resident.arrays = GpuArrays.fromData(this.renderer, data);
      resident.data = this.settings.keepCpu ? data : undefined;
      resident.block.count = data.count;
      resident.bytes = data.count * (scene.sh ? 96 : 32);
      resident.state = "ready";
    }, (error         ) => {
      resident.state = "failed";
      this.onError(`environment.bin: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  // "none" (the scene has no environment.bin), "off", "loading", "failed",
  // or the splats it draws
  get environmentState() {
    const env = this.environment;
    if (!env || env.state === "missing") {
      return "none";
    }
    if (!this.settings.environment) {
      return "off";
    }
    return env.state === "ready" ? `${env.block.count} splats` : env.state === "idle" ? "loading" : env.state;
  }

  // Each cell draws its target when ready, else what it drew, else the
  // ready level nearest its target
          show() {
    for (let c = 0; c < this.target.length; c += 1) {
      const cell = this.blocks[c];
      const t = this.target[c];
      let next = this.shown[c];
      if (cell[t].state === "ready") {
        next = t;
      } else if (next < 0 || cell[next].state !== "ready") {
        next = -1;
        for (let d = 1; d < cell.length && next < 0; d += 1) {
          next = cell[t + d]?.state === "ready" ? t + d : cell[t - d]?.state === "ready" ? t - d : -1;
        }
      }
      if (next !== this.shown[c]) {
        this.shown[c] = next;
        this.changed = true;
      }
      if (next >= 0) {
        cell[next].lastDrawn = this.frame;
      }
    }
    const environmentShown = this.settings.environment && this.environment?.state === "ready";
    if (environmentShown !== this.environmentShown) {
      this.environmentShown = environmentShown;
      this.changed = true;
    }
  }

  // Least recently drawn blocks out while over the byte budget: never one a
  // cell draws or wants, nor one a live collection still holds
          evict() {
    let bytes = 0;
    const candidates             = [];
    const keep = new Set          ();
    this.blocks.forEach((cell, c) => {
      keep.add(cell[this.target[c]]);
      if (this.shown[c] >= 0) {
        keep.add(cell[this.shown[c]]);
      }
    });
    for (const cell of this.blocks) {
      for (const resident of cell) {
        if (resident.arrays) {
          bytes += resident.bytes;
          if (!keep.has(resident) && resident.draws === 0) {
            candidates.push(resident);
          }
        }
      }
    }
    candidates.sort((a, b) => a.lastDrawn - b.lastDrawn);
    for (const resident of candidates) {
      if (bytes <= this.settings.cacheBytes) {
        break;
      }
      bytes -= resident.bytes;
      resident.arrays .dispose();
      resident.arrays = undefined;
      resident.data = undefined;
      resident.state = "idle";
    }

    let resident = 0;
    let loading = 0;
    let failed = 0;
    for (const cell of this.blocks) {
      for (const r of cell) {
        resident += r.arrays ? 1 : 0;
        loading += r.state === "loading" ? 1 : 0;
        failed += r.state === "failed" ? 1 : 0;
      }
    }
    loading += this.environment?.state === "loading" ? 1 : 0;
    Object.assign(this.stats, { resident, residentBytes: bytes, loading, failed });
  }

          updateTints() {
    if (this.colorByLevel === this.settings.colorByLevel) {
      return;
    }
    this.colorByLevel = this.settings.colorByLevel;
    for (const cell of this.blocks) {
      for (const resident of cell) {
        resident.tint.set(this.colorByLevel ? LEVEL_COLORS[resident.block.level % LEVEL_COLORS.length] : "#ffffff");
      }
    }
    this.environment?.tint.set(this.colorByLevel ? ENVIRONMENT_COLOR : "#ffffff");
  }

  // The environment and every cell's drawn block as objects
          collection() {
    const objects                   = [];
    this.stats.drawnPerLevel.fill(0);
    let drawn = 0;
    const env = this.environment;
    this.stats.environment = 0;
    if (this.environmentShown && env?.arrays) {
      env.object ??= this.objectOf(env, env.arrays);
      objects.push(env.object);
      drawn += env.block.count;
      this.stats.environment = env.block.count;
    }
    this.blocks.forEach((cell, c) => {
      const level = this.shown[c];
      const resident = level >= 0 ? cell[level] : undefined;
      if (!resident?.arrays || resident.block.count === 0) {
        return;
      }
      if (!resident.object) {
        resident.object = this.objectOf(resident, resident.arrays);
      }
      objects.push(resident.object);
      drawn += resident.block.count;
      this.stats.drawnPerLevel[level] += resident.block.count;
    });
    this.stats.drawn = drawn;
    return new SplatCollection(objects);
  }

          objectOf(resident          , arrays           )                 {
    resident.draws += 1;
    const object = SplatCollection.object({
      generator: this.generator,
      data: { splats: arrays, tint: resident.tint },
      count: resident.block.count,
      matrixWorld: this.matrixWorld,
      release: () => {
        resident.draws -= 1;
        if (resident.object === object) {
          resident.object = undefined;
        }
        if (resident.draws === 0 && this.disposed && resident.arrays === arrays) {
          arrays.dispose();
          resident.arrays = undefined;
        }
      },
    });
    return object;
  }

  // Forces a new collection (after a generator or setting the objects bake in changes)
  invalidate() {
    this.changed = true;
  }

  // The CPU copies of the drawn blocks and environment (read back from the
  // GPU when not kept)
  async drawnData()                       {
    const drawn = this.shown.reduce            ((list, level, c) => (level >= 0 ? [...list, this.blocks[c][level]] : list), []);
    if (this.environmentShown && this.environment) {
      drawn.unshift(this.environment);
    }
    const out              = [];
    for (const resident of drawn) {
      if (resident.arrays && resident.block.count > 0) {
        out.push(resident.data ?? await resident.arrays.read({ bundles: ["extSplats"] }));
      }
    }
    return out;
  }

  get levels() {
    return this.scene.levels;
  }

  // SH bands are switched by the renderer's objectParams.maxShDegree, not per object
  setDegree() {}

  // Cells with the level each draws (-1: none yet)
  boxes()           {
    return this.scene.cells.map((cell, c) => ({ min: cell.min, max: cell.max, level: this.shown[c] }));
  }

  // Aborts every decode and frees every block once nothing draws it; the
  // caller sets a collection without these objects
  dispose() {
    this.disposed = true;
    for (const cell of [...this.blocks, this.environment ? [this.environment] : []]) {
      for (const resident of cell) {
        resident.controller?.abort();
        resident.data = undefined;
        if (resident.draws === 0) {
          resident.arrays?.dispose();
          resident.arrays = undefined;
        }
      }
    }
  }
}


//# sourceURL=examples/lcc/LccStreamer.ts