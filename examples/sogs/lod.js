// SOG LoD scenes (PlayCanvas's lod-meta.json, written by splat-transform):
// a tree of bounds whose leaves each name, per level (0 finest), a range
// { file, offset, count } of one of the scene's SOG files (unbundled
// meta.json folders, named <level>_<unit>, many leaves per file), plus an
// optional environment SOG drawn whole. parseLod flattens the leaves into
// typed arrays; selectLevels picks a level per leaf from the camera, after
// PlayCanvas's GSplatOctreeInstance and GSplatBudgetBalancer (engine
// 2.23): the distance to the leaf's box (longer behind the camera, scaled
// by the field of view) against thresholds s * baseDistance * multiplier^i,
// clamped to a range, with one scale s for the whole scene fitted to the
// splat budget: in "target" mode the largest s that fits (detail rises to
// fill the budget), in "limit" mode the same but at most 1 (the distances
// are the most detail allowed).

                   
                                          
                       
                                                                         
 

                      
                    
                      
                              
                
                    
 

                             
              
                 
                                                          
                  
                       
                       
                 
                               
                       
                                                                            
                   
                      
                     
                                
                                
                                                                    
                        
                    
 

// "target": detail rises until the budget is used; "limit": the distances
// decide and the budget only lowers detail
                                            

                              
                       
                     
                   
                   
                        
                                                                        
                     
                      
                         
                                                                   
                                                                   
                                                   
                         
                                                
                         
                                                                           
                                                              
                         
                      
                  
                       
 

// After PlayCanvas's streaming examples, but the budget caps rather than
// fills: a filled budget is often more than the GPU (or the CPU sort's
// sort and upload) keeps at frame rate while flying, where the distances'
// own selection is often well under it
export function defaultLodSettings(cpuSort         )              {
  return {
    baseDistance: 5, multiplier: 3, rangeMin: 0, rangeMax: 7, behindPenalty: 2,
    splatBudget: cpuSort ? 2_000_000 : 4_000_000, budgetMode: "limit", underfillLimit: 5, residentBudget: 16_000_000,
    updateDistance: 0.5, updateAngle: 90, freeze: false, colorLevels: false,
  };
}

// The distance scale of a perspective camera's field of view against
// PlayCanvas's reference 45 degrees (vertical), by the narrower of the two
// half angles: wider views see leaves smaller, so farther
export function fovScale(fov        , aspect        )         {
  const tanHalfV = Math.tan((fov * Math.PI) / 360);
  const tanHalfH = tanHalfV * (aspect > 0 && Number.isFinite(aspect) ? aspect : 1);
  return Math.min(tanHalfV, tanHalfH) / Math.tan(Math.PI / 8);
}

export function isLodMeta(json         )          {
  const meta = json              ;
  return typeof meta === "object" && meta !== null && typeof meta.lodLevels === "number" && Array.isArray(meta.filenames) && typeof meta.tree === "object";
}

export function parseLod(json         , url        )             {
  if (!isLodMeta(json)) {
    throw new Error("Not a SOG lod-meta.json");
  }
  const meta = json              ;
  const levels = meta.lodLevels;
  const raw            = [];
  const stack = [meta.tree];
  while (stack.length > 0) {
    const node = stack.pop() ;
    if (node.lods) {
      raw.push(node);
    }
    stack.push(...(node.children ?? []));
  }

  const leaves = raw.length;
  const bounds = new Float32Array(leaves * 6);
  const file = new Int32Array(leaves * levels).fill(-1);
  const offset = new Uint32Array(leaves * levels);
  const count = new Uint32Array(leaves * levels);
  const fileLevel = new Int8Array(meta.filenames.length).fill(-1);
  const levelTotals = new Array        (levels).fill(0);
  raw.forEach((node, leaf) => {
    bounds.set(node.bound.min, leaf * 6);
    bounds.set(node.bound.max, leaf * 6 + 3);
    for (const [key, range] of Object.entries(node.lods )) {
      const level = Number(key);
      if (level < 0 || level >= levels || range.count === 0) {
        continue;
      }
      const at = leaf * levels + level;
      file[at] = range.file;
      offset[at] = range.offset;
      count[at] = range.count;
      fileLevel[range.file] = level;
      levelTotals[level] += range.count;
    }
  });

  return {
    url,
    levels,
    files: meta.filenames.map((name) => new URL(name, url).href),
    fileLevel,
    environment: meta.environment ? new URL(meta.environment, url).href : undefined,
    leaves,
    bounds,
    file,
    offset,
    count,
    min: meta.tree.bound.min                            ,
    max: meta.tree.bound.max                            ,
    levelTotals,
    counts: meta.counts,
  };
}

// The level of `leaf` nearest `level` that it has, coarser first; -1 if none
export function availableLevel(tree            , leaf        , level        )         {
  const base = leaf * tree.levels;
  for (let l = level; l < tree.levels; l += 1) {
    if (tree.file[base + l] >= 0) {
      return l;
    }
  }
  for (let l = level - 1; l >= 0; l -= 1) {
    if (tree.file[base + l] >= 0) {
      return l;
    }
  }
  return -1;
}

                           
            
            
            
 

// Every leaf's levels over a level range: band b (0 finest) is level
// rangeMin + b, snapped to a level the leaf has (availableLevel), with its
// splats; a leaf missing a level repeats a neighbor, so that band step
// changes nothing
                              
                   
               
                                                                     
                   
                      
                                                             
                 
                   
 

const chainCache = new WeakMap                         ();

export function levelChains(tree            , rangeMin        , rangeMax        )              {
  const cached = chainCache.get(tree);
  if (cached && cached.rangeMin === rangeMin && cached.span === rangeMax - rangeMin + 1) {
    return cached;
  }
  const span = rangeMax - rangeMin + 1;
  const level = new Int8Array(tree.leaves * span);
  const count = new Float64Array(tree.leaves * span);
  let finest = 0;
  let coarsest = 0;
  for (let leaf = 0; leaf < tree.leaves; leaf += 1) {
    for (let b = 0; b < span; b += 1) {
      const l = availableLevel(tree, leaf, rangeMin + b);
      level[leaf * span + b] = l;
      count[leaf * span + b] = l >= 0 ? tree.count[leaf * tree.levels + l] : 0;
    }
    finest += count[leaf * span];
    coarsest += count[leaf * span + span - 1];
  }
  const chains = { rangeMin, span, level, count, finest, coarsest };
  chainCache.set(tree, chains);
  return chains;
}

                           
            
            
            
 

// The budget fit's axis: ln s over [-48, 48] in BINS bins (any scene's
// switch points fall inside; ones outside share an end bin), the bin that
// runs out of budget split again into BINS sub-bins. s = 1 falls on the
// edge of bin BINS / 2, so limit mode keeps the configured distances
// exactly.
const BINS = 1024;
const LOG_MIN = -48;
const BIN_SCALE = BINS / 96;
const UNIT_BIN = BINS / 2;
const histogram = new Float64Array(BINS);
let logDistances = new Float64Array(0);

const binOf = (x        ) => Math.min(BINS - 1, Math.max(0, Math.floor(x)));

// The level of every leaf into `out` for a camera at `eye` looking along
// unit `forward` (both in the tree's space) with field-of-view scale
// `fov` (fovScale), and its distance (longer behind the camera, scaled by
// the field of view) into `d`; returns the splats selected.
//
// A leaf at distance d is at band 1 + floor(log_m(d / (s * base))),
// clamped to the range: finer than band L + 1 exactly when
// ln s > ln(d / base) - L ln m (with L counted from rangeMin). All those
// switch points lie on one ln s axis, so a histogram of the splats each
// one adds, summed from the coarsest end, finds the largest s within the
// budget. Stopping at the first sub-bin that does not fit (not skipping
// it) keeps a leaf's level from depending on leaves farther along the
// axis, so small camera moves do not flip levels on and off.
export function selectLevels(tree            , eye          , forward          , s             , out           , d              , fov = 1)         {
  const { leaves, bounds } = tree;
  const rangeMax = Math.max(0, Math.min(s.rangeMax, tree.levels - 1));
  const rangeMin = Math.max(0, Math.min(s.rangeMin, rangeMax));
  const chains = levelChains(tree, rangeMin, rangeMax);
  const { span } = chains;
  const penalty = Math.max(0, s.behindPenalty - 1);
  const logBase = Math.log(Math.max(1e-6, s.baseDistance));
  const logMultiplier = Math.log(Math.max(1.2, s.multiplier));
  // Bins per band step
  const step = logMultiplier * BIN_SCALE;

  if (logDistances.length < leaves) {
    logDistances = new Float64Array(leaves);
  }
  for (let leaf = 0; leaf < leaves; leaf += 1) {
    const b = leaf * 6;
    const dx = Math.max(bounds[b], Math.min(eye.x, bounds[b + 3])) - eye.x;
    const dy = Math.max(bounds[b + 1], Math.min(eye.y, bounds[b + 4])) - eye.y;
    const dz = Math.max(bounds[b + 2], Math.min(eye.z, bounds[b + 5])) - eye.z;
    let distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Toward the box's nearest point: 0 side-on, 1 straight behind
    if (penalty > 0 && distance > 0.01) {
      const facing = (dx * forward.x + dy * forward.y + dz * forward.z) / distance;
      if (facing < 0) {
        distance *= 1 - facing * penalty;
      }
    }
    distance *= fov;
    d[leaf] = distance;
    // In bins: the leaf's switch point leaving band b for b - 1 is at
    // position - (rangeMin + b - 1) * step
    logDistances[leaf] = (Math.log(Math.max(distance, 1e-6)) - logBase - LOG_MIN) * BIN_SCALE;
  }
  const switchAt = (leaf        , b        ) => logDistances[leaf] - (rangeMin + b - 1) * step;

  // The cut: switch points in bins below cutBin are taken, and in cutBin
  // those in sub-bins below cutSub
  const budget = s.splatBudget > 0 ? s.splatBudget : Infinity;
  const limit = s.budgetMode === "limit";
  let cutBin = UNIT_BIN;
  let cutSub = 0;
  if (chains.coarsest >= budget) {
    cutBin = -1;
  } else if (!limit && chains.finest <= budget) {
    cutBin = BINS;
  } else {
    // Limit mode within budget at the configured distances: the cut at s = 1
    let unitTotal = 0;
    if (limit) {
      for (let leaf = 0; leaf < leaves; leaf += 1) {
        let b = span - 1;
        while (b > 0 && binOf(switchAt(leaf, b)) < UNIT_BIN) {
          b -= 1;
        }
        unitTotal += chains.count[leaf * span + b];
      }
    }
    if (!limit || unitTotal > budget) {
      const stop = limit ? UNIT_BIN : BINS;
      let total = chains.coarsest;
      const accumulate = (bin        ) => {
        histogram.fill(0);
        for (let leaf = 0; leaf < leaves; leaf += 1) {
          for (let b = 1; b < span; b += 1) {
            const delta = chains.count[leaf * span + b - 1] - chains.count[leaf * span + b];
            if (delta === 0) {
              continue;
            }
            const x = switchAt(leaf, b);
            const at = binOf(x);
            if (bin < 0) {
              histogram[at] += delta;
            } else if (at === bin) {
              histogram[binOf((x - bin) * BINS)] += delta;
            }
          }
        }
      };
      accumulate(-1);
      cutBin = 0;
      while (cutBin < stop && total + histogram[cutBin] <= budget) {
        total += histogram[cutBin];
        cutBin += 1;
      }
      if (cutBin < stop) {
        accumulate(cutBin);
        while (cutSub < BINS && total + histogram[cutSub] <= budget) {
          total += histogram[cutSub];
          cutSub += 1;
        }
      }
    }
  }

  // Each leaf steps finer while its next switch point is taken; switch
  // points rise as bands get finer, so the first one not taken ends it
  let total = 0;
  for (let leaf = 0; leaf < leaves; leaf += 1) {
    let b = span - 1;
    if (cutBin >= BINS) {
      b = 0;
    } else if (cutBin >= 0) {
      while (b > 0) {
        const x = switchAt(leaf, b);
        const bin = binOf(x);
        if (bin > cutBin || (bin === cutBin && binOf((x - cutBin) * BINS) >= cutSub)) {
          break;
        }
        b -= 1;
      }
    }
    out[leaf] = chains.level[leaf * span + b];
    total += chains.count[leaf * span + b];
  }
  return total;
}


//# sourceURL=examples/sogs/lod.ts