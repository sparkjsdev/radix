// The worker of LodSelector.ts: it holds every object's node array
// (lodTraversal.ts) and selects them all per request, sending back only the
// lists that changed. A module worker without an import map, so it imports
// relative files only. Messages (LodRequest / LodReply):
//   main -> worker
//     { type: "add", id, nodes }                   a node array (NODE_STRIDE)
//     { type: "add", id, extA, extB, tree, count } Radix ext words + tree
//     { type: "remove", id }
//     { type: "select", seq, sizeLimit, minDot, budget, objects: [{ id,
//       origin, facing }], all? }                  in each object's frame
//   worker -> main
//     { type: "added", id, nodes, ms }             node count, build ms
//     { type: "selected", seq, ms, visited, total, counts: [id, count][],
//       lists: [{ id, indices }] }                 changed lists (all with
//                                                  `all`), indices transferred
//     { type: "error", message, seq? }
import { IndexList, NODE_STRIDE, buildNodes, selectLod, selectLodBudget,           } from "./lodTraversal.js";

                        
                                                                
                                                                                                                                              
                                  
                                                                                                                                                             

                      
                                                            
                                                                                                                                                                         
                                                     

                
                     
                       
                     
 

const trees = new Map              ();
// Membership marks for comparing lists, by generation
let marks = new Uint32Array(0);
let generation = 0;
// Whether the budget limited the last selection
let budgetBound = false;

function sameSet(a                         , b             , count        , nodes        ) {
  if (!a || a.length !== count) {
    return false;
  }
  if (marks.length < nodes) {
    marks = new Uint32Array(nodes);
    generation = 0;
  }
  generation = (generation + 1) >>> 0 || 1;
  for (let i = 0; i < count; i += 1) {
    marks[a[i]] = generation;
  }
  for (let i = 0; i < count; i += 1) {
    if (marks[b[i]] !== generation) {
      return false;
    }
  }
  return true;
}

function select(request                                         )           {
  const start = performance.now();
  const objects = request.objects.filter(({ id }) => trees.has(id));
  let outs = objects.map(() => new IndexList(4096));
  let visited = 0;
  // The plain traversal first, unless the budget bound the last selection;
  // over budget, the budgeted one
  let over = budgetBound;
  if (!over) {
    objects.forEach(({ id, origin, facing }, i) => {
      visited += selectLod(trees.get(id) .nodes, { origin, facing, minDot: request.minDot, sizeLimit: request.sizeLimit }, outs[i]);
    });
    over = outs.reduce((sum, out) => sum + out.count, 0) > request.budget;
    if (over) {
      outs = objects.map(() => new IndexList(4096));
    }
  }
  if (over) {
    const budgetTrees = objects.map(({ id, origin, facing }) => ({ nodes: trees.get(id) .nodes, origin, facing }));
    visited += selectLodBudget(budgetTrees, request, outs);
  }
  // Bound: the budgeted traversal stopped short of a node's children
  budgetBound = over && outs.reduce((sum, out) => sum + out.count, 0) > request.budget * 0.98;

  const counts                     = [];
  const lists                                                      = [];
  let total = 0;
  objects.forEach(({ id }, i) => {
    const tree = trees.get(id) ;
    const { data, count } = outs[i];
    counts.push([id, count]);
    total += count;
    if (request.all || !sameSet(tree.sent, data, count, tree.nodes.length / NODE_STRIDE)) {
      tree.sent = data.slice(0, count);
      lists.push({ id, indices: data.slice(0, count) });
    }
  });
  return { type: "selected", seq: request.seq, ms: performance.now() - start, visited, total, counts, lists };
}

function handle(request            )                                                 {
  if (request.type === "add") {
    const start = performance.now();
    const nodes = "nodes" in request ? request.nodes : buildNodes(request.extA, request.extB, request.tree, request.count);
    trees.set(request.id, { nodes });
    return { reply: { type: "added", id: request.id, nodes: nodes.length / NODE_STRIDE, ms: performance.now() - start } };
  }
  if (request.type === "remove") {
    trees.delete(request.id);
    return {};
  }
  const reply = select(request);
  return { reply, transfer: reply.type === "selected" ? reply.lists.map(({ indices }) => indices.buffer) : [] };
}

const scope = globalThis                                                                                                                                                               ;
if (scope.WorkerGlobalScope !== undefined) {
  scope.onmessage = (event                          ) => {
    try {
      const { reply, transfer = [] } = handle(event.data);
      if (reply) {
        scope.postMessage(reply, transfer);
      }
    } catch (error) {
      const reply           = { type: "error", message: error instanceof Error ? error.message : String(error), seq: event.data.type === "select" ? event.data.seq : undefined };
      scope.postMessage(reply, []);
    }
  };
}


//# sourceURL=examples/doom/lod/lodWorker.ts