// The hosted levels (data.ts):
// <level>/scene.json and one RDX file per object (extSplats, lodTree, sector), merged by the
// exporter into static clusters, mover groups (one movable sector plane
// each) and the sky. LevelLoader fetches and decodes them on Radix's
// worker pool, one prefetched level at a time; Level puts one on the GPU,
// registers each object's tree with the LodSelector and makes the splat
// objects of its current lists (lighting.level, data bound per dispatch).
import * as THREE from "three";
                                                   
import { GpuArrays, SplatCollection, loadSplats,                                     } from "@sparkjsdev/radix";
import { fetchData } from "./data.js";
                                                                   
                                                  
import { SECTOR,                  } from "./sim/DoomSim.js";
                                              

                              
             
                                   
               
                                                                
                
                 
                                                                           
                        
                    
                                                                           
                 
                              
                  
 

                            
                  
              
                        
                    
                                                              
                         
                                       
                  
                       
                                                               
                     
                          
 

                               
              
                  
                                                    
                
 

                               
              
                 
                
 

const PARALLEL = 6;

// Fetch + decode of levels, keeping one prefetched
export class LevelLoader {
  onProgress                                   ;
          pending                                                  ;

  get pendingUrl() {
    return this.pending?.url;
  }

  prefetch(url        )                        {
    if (this.pending?.url !== url) {
      this.pending = { url, promise: this.load(url) };
    }
    return this.pending.promise;
  }

  async take(url        )                        {
    const decoded = this.prefetch(url);
    if (this.pending?.url === url) {
      this.pending = undefined;
    }
    return decoded;
  }

          async load(url        )                        {
    const file = await (await fetchData(url)).json()             ;
    if (file.version !== 3) {
      throw new Error(`${url} is not a Radix export (version ${file.version})`);
    }
    const objects                          = [];
    const queue = [...file.objects];
    let bytes = 0;
    const one = async () => {
      for (let info = queue.shift(); info; info = queue.shift()) {
        const data = await loadSplats(new URL(info.file, url).href);
        objects.push({ info, data });
        bytes += data.count * 34;
        this.onProgress?.({ url, loaded: objects.length, total: file.objects.length });
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, one));
    return { url, file, objects, bytes };
  }
}

                
                    
                    
                 
                             
                                                                       
                             
               
                   
 

export class Level {
           file           ;
           url        ;
           parts         = [];
  resident = 0;
                   lighting              ;
                   selector             ;

  constructor(decoded              , lighting              , selector             ) {
    this.file = decoded.file;
    this.url = decoded.url;
    this.lighting = lighting;
    this.selector = selector;
  }

  // Upload every object (a frame between every few million splats) and hand
  // its tree to the selector
  async upload(decoded              , renderer                , onStep                                       ) {
    let sinceFrame = 0;
    for (const [i, { info, data }] of decoded.objects.entries()) {
      const splats = GpuArrays.fromData(renderer, data, { bundles: ["extSplats", "sector"] });
      const matrixWorld = new THREE.Matrix4().fromArray(info.matrixWorld);
      this.resident += data.count;
      this.parts.push({ info, splats, matrixWorld, lod: this.selector.add({ data, matrixWorld }), live: 0, removed: false });
      onStep(i + 1, decoded.objects.length);
      sinceFrame += data.count;
      if (sinceFrame > 3_000_000) {
        sinceFrame = 0;
        await new Promise      ((done) => requestAnimationFrame(() => done()));
      }
    }
    decoded.objects.length = 0;
  }

  // The splat objects of every part's current list
  objects()                   {
    const out                   = [];
    for (const part of this.parts) {
      const object = this.selector.splatObject(part.lod, (list) => {
        part.live += 1;
        return SplatCollection.object({
          generator: this.lighting.level,
          data: { splats: part.splats, indices: list.indices, matrixWorld: part.matrixWorld },
          count: list.count,
          matrixWorld: part.matrixWorld,
          release: () => {
            part.live -= 1;
            if (part.removed && part.live === 0) {
              part.splats.dispose();
            }
          },
        });
      });
      if (object) {
        out.push(object);
      }
    }
    return out;
  }

  // Translate every mover group by how far its plane has moved from the
  // baked height (interpolated between tics)
  updateMovers(prev                         , curr                         , alpha        ) {
    for (const { info, matrixWorld } of this.parts) {
      if (info.mover === undefined || info.height === undefined) {
        continue;
      }
      const field = info.plane === "floor" ? SECTOR.FLOOR : SECTOR.CEILING;
      const at = (s                         ) => (s && info.mover  < s.sectorCount ? s.sectors[info.mover  * SECTOR.STRIDE + field] / 65536 : undefined);
      const b = at(curr);
      const a = at(prev);
      const height = b === undefined ? info.height : a === undefined || prev .sectorCount !== curr .sectorCount ? b : a + (b - a) * alpha;
      const translation = (height - info.height) / this.file.unitsPerMeter;
      if (matrixWorld.elements[13] !== info.matrixWorld[13] + translation) {
        matrixWorld.fromArray(info.matrixWorld);
        matrixWorld.elements[13] += translation;
      }
    }
  }

  dispose() {
    for (const part of this.parts) {
      part.removed = true;
      this.selector.remove(part.lod);
      if (part.live === 0) {
        part.splats.dispose();
      }
    }
  }
}


//# sourceURL=examples/doom/level.ts