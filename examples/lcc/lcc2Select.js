// The LoD cut of an LCC2 tree (Lcc2Scene.ts) for a camera: the nodes to
// draw, covering every leaf exactly once. A node is drawn when it is a leaf
// or when its distance asks for a level at least its own; otherwise its
// children are visited. Distances are as in examples/sogs/lod.ts (after
// PlayCanvas 2.23): to the nearest point of the node's box, longer behind
// the camera (behindPenalty), scaled by the field of view (fovScale). A node
// at distance d asks for level 1 + floor(log2(d / (s * lodDistance))), as
// LCC v1's cells do (level 0 within lodDistance, one level coarser per
// doubling), with one scale s for the whole tree fitted to the splat
// budget: node n is split exactly when ln s > x(n) = ln(d / lodDistance) -
// (level - 1) ln 2, and only once its parent is, so its split point is
// e(n) = max(x(n), e(parent)). Splitting n adds its children's splats less
// its own; sorted by e, the splits are taken in order while the total fits,
// which is the histogram balancer of sogs/lod.ts made exact (trees are a few
// hundred nodes). "limit" keeps s <= 1 (the distances are the most detail
// allowed), "target" lets detail rise to fill the budget. A fixed level
// splits every node above it, nearest first under the budget. Pure code, so
// the Node check tests it.
                                                

                                     
                                                                                 
                         
                      
                        
                                  
                 
                                 
 

                           
            
            
            
 

                          
                                 
                  
                 
                 
                                                                            
                   
                                                                   
                         
                      
 

const LN2 = Math.LN2;
// A fixed level's splits sort below any distance's
const FIXED = 1e6;

// The splats a node's children hold, less its own
function splitDelta(scene           , node        ) {
  let sum = 0;
  for (let k = 0; k < scene.childCount[node]; k += 1) {
    sum += scene.count[scene.children[scene.firstChild[node] + k]];
  }
  return sum - scene.count[node];
}

export function selectCut(scene           , eye          , forward          , s                    , fov = 1, out          )          {
  const n = scene.nodes;
  const cut          = out ?? { nodes: [], splats: 0, logScale: 0, distance: new Float32Array(n), split: new Float64Array(n) };
  const { bounds, parent, level } = scene;
  const penalty = Math.max(0, s.behindPenalty - 1);
  const logBase = Math.log(Math.max(1e-6, s.lodDistance));
  const fixed = s.level !== "auto";

  // Split points, parents before children (depth-first order)
  for (let node = 0; node < n; node += 1) {
    const b = node * 6;
    const dx = Math.max(bounds[b], Math.min(eye.x, bounds[b + 3])) - eye.x;
    const dy = Math.max(bounds[b + 1], Math.min(eye.y, bounds[b + 4])) - eye.y;
    const dz = Math.max(bounds[b + 2], Math.min(eye.z, bounds[b + 5])) - eye.z;
    let distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (penalty > 0 && distance > 0.01) {
      const facing = (dx * forward.x + dy * forward.y + dz * forward.z) / distance;
      if (facing < 0) {
        distance *= 1 - facing * penalty;
      }
    }
    distance *= fov;
    cut.distance[node] = distance;
    let x        ;
    if (node === 0 || scene.isLeaf(node)) {
      // The root holds no splats (always split); leaves never split
      x = node === 0 ? -Infinity : Infinity;
    } else if (fixed) {
      x = level[node] > (s.level          ) ? Math.log(Math.max(distance, 1e-6)) - FIXED : Infinity;
    } else {
      x = Math.log(Math.max(distance, 1e-6)) - logBase - (level[node] - 1) * LN2;
    }
    cut.split[node] = parent[node] >= 0 ? Math.max(x, cut.split[parent[node]]) : x;
  }

  // The cut: limit mode starts at s = 1 (fixed levels below it), target at
  // no limit; then the budget lowers it to the first split that does not fit
  let logScale = fixed ? 0 : s.budgetMode === "limit" ? 0 : Infinity;
  const budget = s.budget > 0 ? s.budget : Infinity;
  let total = 0;
  for (let k = 0; k < scene.childCount[0]; k += 1) {
    total += scene.count[scene.children[scene.firstChild[0] + k]];
  }
  if (budget < Infinity) {
    const order           = [];
    for (let node = 1; node < n; node += 1) {
      if (cut.split[node] < logScale) {
        order.push(node);
      }
    }
    order.sort((a, b) => cut.split[a] - cut.split[b]);
    for (const node of order) {
      const delta = splitDelta(scene, node);
      if (total + delta > budget) {
        logScale = cut.split[node];
        break;
      }
      total += delta;
    }
  }
  cut.logScale = logScale;

  // The drawn nodes: those not split whose parent is
  cut.nodes.length = 0;
  cut.splats = 0;
  const stack = [0];
  while (stack.length > 0) {
    const node = stack.pop() ;
    if (node === 0 || cut.split[node] < logScale) {
      for (let k = scene.childCount[node] - 1; k >= 0; k -= 1) {
        stack.push(scene.children[scene.firstChild[node] + k]);
      }
    } else {
      cut.nodes.push(node);
      cut.splats += scene.count[node];
    }
  }
  return cut;
}

// The leaves under each drawn node, counted (checks: every leaf exactly once)
export function leafCoverage(scene           , nodes          )              {
  const covered = new Uint32Array(scene.nodes);
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop() ;
    if (scene.isLeaf(node)) {
      covered[node] += 1;
    }
    for (let k = 0; k < scene.childCount[node]; k += 1) {
      stack.push(scene.children[scene.firstChild[node] + k]);
    }
  }
  return covered;
}


//# sourceURL=examples/lcc/lcc2Select.ts