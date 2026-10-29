// Collision meshes of LCC scenes and their BVHs, for the debug overlay and
// walk mode. Both versions store a triangle mesh per chunk of the scene and
// a BVH over its triangles, in the same 32-byte nodes, depth-first with the
// left child right after its parent (LCC2Whitepaper btree_spec.md v1.0, and
// the LCC whitepaper's collision section): 6 float32 box (min xyz, max xyz),
// then for an inner node the right child's offset in 4-byte units (u32) and
// its split axis, for a leaf its first triangle (u32), triangle count (u16)
// and 0xFFFF. Faces are stored in BVH order, so a leaf's triangles are a run.
//   LCC v1 collision.lci (layout read from XGRIDS' files, as the whitepaper
//   only shows it in images): "coll", u32 version (2), u32 headerLen, 6 f32
//   box, f32 cellLengthX, f32 cellLengthY, u32 meshCount, then per mesh
//   (40 bytes) u32 cell x, u32 cell y, u64 offset, u64 bytes, u32 vertices,
//   u32 faces, u64 BVH bytes; at offset: vertices (3 f32), faces (3 u32),
//   then the BVH: 16 reserved bytes (zeros) and its nodes.
//   LCC2: each node with data.mesh and data.bvh names a binary PLY mesh
//   (vertex x y z, face list) and its .btree (the nodes, no header).
// Everything stays in the file's frame. Plain code with no imports, shared
// by the workers, the page and the Node checks.

export const BVH_NODE_BYTES = 32;
const LEAF = 0xffff;
const LCI_MAGIC = 0x6c6c6f63; // "coll"
const LCI_HEADER = 48;
const LCI_MESH = 40;
const LCI_BVH_PREFIX = 16;

                                 
             
                                         
                    
                         
                     
                
 

                          
            
            
                 
                
                   
                
                   
 

                            
                  
                    
                
                      
                      
                    
 

const viewOf = (bytes            ) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
// A copy in a buffer of its own (Node's Buffer.slice would share its pool)
const copyOf = (bytes            , length = bytes.byteLength) => {
  const out = new Uint8Array(length);
  out.set(bytes.subarray(0, length));
  return out;
};

// The header's length from its first 12 bytes
export function lciHeaderLength(bytes            )         {
  const view = viewOf(bytes);
  if (bytes.byteLength < 12 || view.getUint32(0, true) !== LCI_MAGIC) {
    throw new Error("Not a collision.lci file (no \"coll\")");
  }
  return view.getUint32(8, true);
}

export function readLciHeader(bytes            )            {
  const headerLen = lciHeaderLength(bytes);
  if (bytes.byteLength < headerLen || headerLen < LCI_HEADER) {
    throw new Error(`collision.lci header: ${bytes.byteLength} of ${headerLen} bytes`);
  }
  const view = viewOf(bytes);
  const count = view.getUint32(44, true);
  if (LCI_HEADER + count * LCI_MESH > headerLen) {
    throw new Error(`collision.lci: ${count} meshes do not fit a ${headerLen}-byte header`);
  }
  const meshes            = [];
  for (let i = 0; i < count; i += 1) {
    const at = LCI_HEADER + i * LCI_MESH;
    meshes.push({
      x: view.getUint32(at, true),
      y: view.getUint32(at + 4, true),
      offset: Number(view.getBigUint64(at + 8, true)),
      bytes: Number(view.getBigUint64(at + 16, true)),
      vertices: view.getUint32(at + 24, true),
      faces: view.getUint32(at + 28, true),
      bvhBytes: Number(view.getBigUint64(at + 32, true)),
    });
  }
  return {
    version: view.getUint32(4, true),
    headerLen,
    box: Array.from({ length: 6 }, (_, k) => view.getFloat32(12 + k * 4, true)),
    cellLengthX: view.getFloat32(36, true),
    cellLengthY: view.getFloat32(40, true),
    meshes,
  };
}

// The chunk of one mesh from its `mesh.bytes` bytes at `mesh.offset`
export function readLciMesh(bytes            , mesh         , id = `${mesh.x}_${mesh.y}`)                 {
  const vertexBytes = mesh.vertices * 12;
  const faceBytes = mesh.faces * 12;
  if (bytes.byteLength < vertexBytes + faceBytes + mesh.bvhBytes) {
    throw new Error(`collision.lci mesh ${id}: ${bytes.byteLength} bytes, ${vertexBytes + faceBytes + mesh.bvhBytes} expected`);
  }
  const copy = copyOf(bytes, vertexBytes + faceBytes + mesh.bvhBytes);
  const vertices = new Float32Array(copy.buffer, 0, mesh.vertices * 3);
  const faces = new Uint32Array(copy.buffer, vertexBytes, mesh.faces * 3);
  const bvh = new DataView(copy.buffer, vertexBytes + faceBytes + LCI_BVH_PREFIX, mesh.bvhBytes - LCI_BVH_PREFIX);
  return chunkOf(id, vertices, faces, bvh);
}

const PLY_TYPES                                                                   = {
  char: [1, (v, a) => v.getInt8(a)], int8: [1, (v, a) => v.getInt8(a)],
  uchar: [1, (v, a) => v.getUint8(a)], uint8: [1, (v, a) => v.getUint8(a)],
  short: [2, (v, a) => v.getInt16(a, true)], int16: [2, (v, a) => v.getInt16(a, true)],
  ushort: [2, (v, a) => v.getUint16(a, true)], uint16: [2, (v, a) => v.getUint16(a, true)],
  int: [4, (v, a) => v.getInt32(a, true)], int32: [4, (v, a) => v.getInt32(a, true)],
  uint: [4, (v, a) => v.getUint32(a, true)], uint32: [4, (v, a) => v.getUint32(a, true)],
  float: [4, (v, a) => v.getFloat32(a, true)], float32: [4, (v, a) => v.getFloat32(a, true)],
  double: [8, (v, a) => v.getFloat64(a, true)], float64: [8, (v, a) => v.getFloat64(a, true)],
};

                      
               
                
                                                              
 

// A binary little-endian PLY triangle mesh: vertex x y z among any other
// properties, faces as a list (triangles)
export function readMeshPly(bytes            )                                                 {
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 16384)));
  const end = head.indexOf("end_header");
  if (!head.startsWith("ply") || end < 0) {
    throw new Error("Not a PLY file");
  }
  if (!/format\s+binary_little_endian/.test(head)) {
    throw new Error("Collision PLY: only binary_little_endian is read");
  }
  const elements               = [];
  for (const line of head.slice(0, end).split(/\r?\n/)) {
    const words = line.trim().split(/\s+/);
    if (words[0] === "element") {
      elements.push({ name: words[1], count: Number(words[2]), properties: [] });
    } else if (words[0] === "property" && elements.length > 0) {
      const props = elements[elements.length - 1].properties;
      props.push(words[1] === "list" ? { name: words[4], type: words[3], list: words[2] } : { name: words[2], type: words[1] });
    }
  }
  const view = viewOf(bytes);
  let at = head.indexOf("\n", end) + 1;
  let vertices = new Float32Array(0);
  let faces = new Uint32Array(0);
  for (const element of elements) {
    if (element.name === "vertex") {
      vertices = new Float32Array(element.count * 3);
      const axes = ["x", "y", "z"].map((name) => element.properties.findIndex((p) => p.name === name));
      for (let i = 0; i < element.count; i += 1) {
        element.properties.forEach((p, k) => {
          const [size, read] = PLY_TYPES[p.type];
          const axis = axes.indexOf(k);
          if (axis >= 0) {
            vertices[i * 3 + axis] = read(view, at);
          }
          at += size;
        });
      }
    } else if (element.name === "face") {
      faces = new Uint32Array(element.count * 3);
      for (let i = 0; i < element.count; i += 1) {
        for (const p of element.properties) {
          if (p.list) {
            const [countSize, readCount] = PLY_TYPES[p.list];
            const [size, read] = PLY_TYPES[p.type];
            const n = readCount(view, at);
            at += countSize;
            if (n !== 3) {
              throw new Error(`Collision PLY: face ${i} has ${n} vertices (triangles only)`);
            }
            for (let k = 0; k < 3; k += 1) {
              faces[i * 3 + k] = read(view, at);
              at += size;
            }
          } else {
            at += PLY_TYPES[p.type][0];
          }
        }
      }
    } else {
      // Fixed-size elements are skipped; lists elsewhere are not expected
      at += element.count * element.properties.reduce((sum, p) => sum + PLY_TYPES[p.type][0], 0);
    }
  }
  return { vertices, faces };
}

// A chunk from its mesh and its BVH's nodes (the box from the root)
export function chunkOf(id        , vertices              , faces             , bvh          )                 {
  const box = new Float32Array(6);
  if (bvh.byteLength >= BVH_NODE_BYTES) {
    for (let k = 0; k < 6; k += 1) {
      box[k] = bvh.getFloat32(k * 4, true);
    }
  }
  return { id, box, vertices, faces, bvh };
}

// An LCC2 node's mesh .ply and .btree bytes as a chunk
export function readLcc2Collision(id        , ply            , btree            )                 {
  const { vertices, faces } = readMeshPly(ply);
  return chunkOf(id, vertices, faces, new DataView(copyOf(btree).buffer));
}

// --- BVH nodes ---

export const isLeaf = (bvh          , at        ) => bvh.getUint16(at + 30, true) === LEAF;
// A leaf's first triangle and count; an inner node's right child (bytes) and axis
export const leafFirst = (bvh          , at        ) => bvh.getUint32(at + 24, true);
export const leafCount = (bvh          , at        ) => bvh.getUint16(at + 28, true);
export const rightChild = (bvh          , at        ) => bvh.getUint32(at + 24, true) * 4;
export const splitAxis = (bvh          , at        ) => bvh.getUint16(at + 28, true);

// btree_spec.md's validation checklist and more: sizes, offsets, leaf
// counts and axes, every node visited once, children's boxes inside their
// parent's, leaf runs tiling the faces exactly once, face indices in range;
// the problems found (empty: valid)
export function checkBvh(chunk                )           {
  const { bvh, faces, vertices } = chunk;
  const problems           = [];
  const size = bvh.byteLength;
  if (size === 0 || size % BVH_NODE_BYTES !== 0) {
    return [`${size} bytes is not a whole number of 32-byte nodes`];
  }
  const nodes = size / BVH_NODE_BYTES;
  const faceCount = faces.length / 3;
  const seen = new Uint8Array(nodes);
  const covered = new Uint8Array(faceCount);
  const slack = (v        ) => 1e-4 * (1 + Math.abs(v));
  const stack                                   = [{ at: 0, parent: -1 }];
  while (stack.length > 0 && problems.length < 20) {
    const { at, parent } = stack.pop() ;
    if (at % BVH_NODE_BYTES !== 0 || at >= size) {
      problems.push(`node offset ${at} out of range or unaligned`);
      continue;
    }
    if (seen[at / BVH_NODE_BYTES]++) {
      problems.push(`node ${at / BVH_NODE_BYTES} reached twice`);
      continue;
    }
    if (parent >= 0) {
      for (let k = 0; k < 3; k += 1) {
        const lo = bvh.getFloat32(at + k * 4, true);
        const hi = bvh.getFloat32(at + 12 + k * 4, true);
        if (lo < bvh.getFloat32(parent + k * 4, true) - slack(lo) || hi > bvh.getFloat32(parent + 12 + k * 4, true) + slack(hi)) {
          problems.push(`node ${at / BVH_NODE_BYTES}'s box is outside its parent's`);
          break;
        }
      }
    }
    if (isLeaf(bvh, at)) {
      const first = leafFirst(bvh, at);
      const count = leafCount(bvh, at);
      if (count === 0 || first + count > faceCount) {
        problems.push(`leaf ${at / BVH_NODE_BYTES}: triangles ${first}..${first + count} of ${faceCount}`);
        continue;
      }
      for (let f = first; f < first + count; f += 1) {
        covered[f] += 1;
      }
    } else {
      const right = rightChild(bvh, at);
      const axis = splitAxis(bvh, at);
      if (axis > 2) {
        problems.push(`node ${at / BVH_NODE_BYTES}: split axis ${axis}`);
      }
      if (right <= at || right >= size) {
        problems.push(`node ${at / BVH_NODE_BYTES}: right child at ${right} of ${size}`);
        continue;
      }
      stack.push({ at: right, parent: at }, { at: at + BVH_NODE_BYTES, parent: at });
    }
  }
  const visited = seen.reduce((sum, s) => sum + (s > 0 ? 1 : 0), 0);
  if (visited !== nodes) {
    problems.push(`${visited} of ${nodes} nodes visited`);
  }
  const uncovered = covered.reduce((sum, c) => sum + (c !== 1 ? 1 : 0), 0);
  if (uncovered > 0) {
    problems.push(`${uncovered} of ${faceCount} triangles not in exactly one leaf`);
  }
  const vertexCount = vertices.length / 3;
  if (faces.some((v) => v >= vertexCount)) {
    problems.push(`face indices past the ${vertexCount} vertices`);
  }
  return problems;
}

// --- Queries (the file's frame) ---

                       
            
            
            
 

                         
            
                                                         
               
               
 

function rayBox(bvh          , at        , o      , inv      , maxT        ) {
  let t0 = 0;
  let t1 = maxT;
  const origin = [o.x, o.y, o.z];
  const invDir = [inv.x, inv.y, inv.z];
  for (let k = 0; k < 3; k += 1) {
    const a = (bvh.getFloat32(at + k * 4, true) - origin[k]) * invDir[k];
    const b = (bvh.getFloat32(at + 12 + k * 4, true) - origin[k]) * invDir[k];
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) {
      return false;
    }
  }
  return true;
}

// The nearest hit of the ray o + t d (t in [0, maxT]) on the chunk, or undefined
export function raycast(chunk                , o      , d      , maxT        , best         )                     {
  const { bvh, faces, vertices } = chunk;
  if (bvh.byteLength < BVH_NODE_BYTES) {
    return best;
  }
  const inv = { x: 1 / d.x, y: 1 / d.y, z: 1 / d.z };
  let hit = best;
  let limit = best ? Math.min(best.t, maxT) : maxT;
  const stack = [0];
  while (stack.length > 0) {
    const at = stack.pop() ;
    if (!rayBox(bvh, at, o, inv, limit)) {
      continue;
    }
    if (!isLeaf(bvh, at)) {
      stack.push(rightChild(bvh, at), at + BVH_NODE_BYTES);
      continue;
    }
    const first = leafFirst(bvh, at);
    const end = first + leafCount(bvh, at);
    for (let f = first; f < end; f += 1) {
      const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
      const e1x = vertices[b] - vertices[a], e1y = vertices[b + 1] - vertices[a + 1], e1z = vertices[b + 2] - vertices[a + 2];
      const e2x = vertices[c] - vertices[a], e2y = vertices[c + 1] - vertices[a + 1], e2z = vertices[c + 2] - vertices[a + 2];
      const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) {
        continue;
      }
      const invDet = 1 / det;
      const tx = o.x - vertices[a], ty = o.y - vertices[a + 1], tz = o.z - vertices[a + 2];
      const u = (tx * px + ty * py + tz * pz) * invDet;
      if (u < 0 || u > 1) {
        continue;
      }
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (d.x * qx + d.y * qy + d.z * qz) * invDet;
      if (v < 0 || u + v > 1) {
        continue;
      }
      const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
      if (t >= 0 && t <= limit) {
        let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const length = Math.hypot(nx, ny, nz) || 1;
        const sign = nx * d.x + ny * d.y + nz * d.z > 0 ? -1 : 1;
        nx *= sign / length;
        ny *= sign / length;
        nz *= sign / length;
        hit = { t, face: f, normal: { x: nx, y: ny, z: nz } };
        limit = t;
      }
    }
  }
  return hit;
}

// The closest point of triangle abc to p into `out` (Ericson, Real-Time
// Collision Detection 5.1.5)
export function closestOnTriangle(p      , a      , b      , c      , out      )       {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  const set = (x        , y        , z        ) => {
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  };
  if (d1 <= 0 && d2 <= 0) {
    return set(a.x, a.y, a.z);
  }
  const bpx = p.x - b.x, bpy = p.y - b.y, bpz = p.z - b.z;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    return set(b.x, b.y, b.z);
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return set(a.x + v * abx, a.y + v * aby, a.z + v * abz);
  }
  const cpx = p.x - c.x, cpy = p.y - c.y, cpz = p.z - c.z;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    return set(c.x, c.y, c.z);
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return set(a.x + w * acx, a.y + w * acy, a.z + w * acz);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(b.x + w * (c.x - b.x), b.y + w * (c.y - b.y), b.z + w * (c.z - b.z));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return set(a.x + abx * v + acx * w, a.y + aby * v + acy * w, a.z + abz * v + acz * w);
}

const corner = (vertices              , i        , out      ) => {
  out.x = vertices[i * 3];
  out.y = vertices[i * 3 + 1];
  out.z = vertices[i * 3 + 2];
  return out;
};

// Every triangle whose closest point to `center` is within `radius`: visit
// gets the triangle and that point (reused: copy it)
export function sphereTriangles(chunk                , center      , radius        , visit                                     ) {
  const { bvh, faces, vertices } = chunk;
  if (bvh.byteLength < BVH_NODE_BYTES) {
    return;
  }
  const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 }, c = { x: 0, y: 0, z: 0 }, point = { x: 0, y: 0, z: 0 };
  const r2 = radius * radius;
  const origin = [center.x, center.y, center.z];
  const stack = [0];
  while (stack.length > 0) {
    const at = stack.pop() ;
    let d2 = 0;
    for (let k = 0; k < 3; k += 1) {
      const lo = bvh.getFloat32(at + k * 4, true);
      const hi = bvh.getFloat32(at + 12 + k * 4, true);
      const e = origin[k] < lo ? lo - origin[k] : origin[k] > hi ? origin[k] - hi : 0;
      d2 += e * e;
    }
    if (d2 > r2) {
      continue;
    }
    if (!isLeaf(bvh, at)) {
      stack.push(rightChild(bvh, at), at + BVH_NODE_BYTES);
      continue;
    }
    const first = leafFirst(bvh, at);
    const end = first + leafCount(bvh, at);
    for (let f = first; f < end; f += 1) {
      closestOnTriangle(center, corner(vertices, faces[f * 3], a), corner(vertices, faces[f * 3 + 1], b), corner(vertices, faces[f * 3 + 2], c), point);
      const dx = point.x - center.x, dy = point.y - center.y, dz = point.z - center.z;
      if (dx * dx + dy * dy + dz * dz <= r2) {
        visit(f, point);
      }
    }
  }
}

// Queries over every loaded chunk whose box they reach
export class CollisionSet {
           chunks = new Map                        ();

  get triangles() {
    let sum = 0;
    for (const chunk of this.chunks.values()) {
      sum += chunk.faces.length / 3;
    }
    return sum;
  }

  raycast(o      , d      , maxT        )                     {
    let best                    ;
    for (const chunk of this.chunks.values()) {
      best = raycast(chunk, o, d, maxT, best);
    }
    return best;
  }

  sphere(center      , radius        , visit                                                            ) {
    for (const chunk of this.chunks.values()) {
      const b = chunk.box;
      if (center.x < b[0] - radius || center.y < b[1] - radius || center.z < b[2] - radius || center.x > b[3] + radius || center.y > b[4] + radius || center.z > b[5] + radius) {
        continue;
      }
      sphereTriangles(chunk, center, radius, (face, point) => visit(point, chunk, face));
    }
  }
}


//# sourceURL=examples/lcc/collision.ts