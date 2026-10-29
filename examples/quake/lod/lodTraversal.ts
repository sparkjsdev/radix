// LoD selection over Radix LoD trees (Splats.LOD_TREE beside ext splats),
// with no imports, so module workers can load it. A selection is the frontier of
// tree nodes whose weighted size is within sizeLimit, or that are leaves.
//
// Node arrays hold NODE_STRIDE uint32 per node: center xyz (float32 bits),
// child count | float16(ln size) << 16, first child. A node's size is
// 2 * mean scale * the LoD opacity expansion. Its
// weighted size seen from `origin` looking along `facing` (unit, both in the
// tree's frame) is size * max(cos, minDot) / distance, cos the angle between
// facing and the node: foveation makes nodes off the view axis up to
// 1 / minDot coarser (minDot 1: distance only).
export const NODE_STRIDE = 5;

export type Vec3 = readonly [number, number, number];

// Half floats: native Float16Array where it exists, else a truncating JS path
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const Float16 = (globalThis as { Float16Array?: new (length: number) => { [index: number]: number; buffer: ArrayBuffer } }).Float16Array;
const f16 = Float16 ? new Float16(1) : undefined;
const u16 = new Uint16Array(f16?.buffer ?? new ArrayBuffer(2));

function toHalf(f: number): number {
  if (f16) {
    f16[0] = f;
    return u16[0];
  }
  f32[0] = f;
  const bits = u32[0];
  const sign = ((bits >> 31) & 1) << 15;
  const exp = (bits >> 23) & 0xff;
  const frac = bits & 0x7fffff;
  if (exp === 0xff) {
    return sign | (frac !== 0 ? 0x7fff : 0x7c00);
  }
  const e = exp - 127 + 15;
  if (e >= 0x1f) {
    return sign | 0x7c00;
  }
  if (e <= 0) {
    return e < -10 ? sign : sign | ((frac | 0x800000) >> (1 - e + 13));
  }
  return sign | (e << 10) | (frac >> 13);
}

function fromHalf(h: number): number {
  if (f16) {
    u16[0] = h;
    return f16[0];
  }
  const sign = (h >> 15) & 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  let bits: number;
  if (exp === 0) {
    if (frac === 0) {
      bits = sign << 31;
    } else {
      let mant = frac;
      let e = -14;
      while ((mant & 0x400) === 0) {
        mant <<= 1;
        e -= 1;
      }
      bits = (sign << 31) | ((e + 127) << 23) | ((mant & 0x3ff) << 13);
    }
  } else if (exp === 0x1f) {
    bits = (sign << 31) | (frac === 0 ? 0x7f800000 : 0x7fc00000);
  } else {
    bits = (sign << 31) | ((exp - 15 + 127) << 23) | (frac << 13);
  }
  u32[0] = bits;
  return f32[0];
}

// Linear extent of a splat with LoD opacity (stored 1..2 for merged nodes)
// relative to an opaque one, against the reference sqrt(8) std devs
const LOD_REFERENCE_STD_DEV = Math.sqrt(8);

function lodSize(scaleX: number, scaleY: number, scaleZ: number, opacity: number) {
  const expansion = opacity <= 1 ? 1 : 1 + (0.7 * (Math.min(opacity * 4 - 3, 5) - 1)) / LOD_REFERENCE_STD_DEV;
  return 2 * expansion * ((scaleX + scaleY + scaleZ) / 3);
}

// The node array of `count` splats from Radix's ext words (extA, extB:
// uint32x4) and tree (node: uint32x2, child count and first child)
export function buildNodes(extA: Uint32Array, extB: Uint32Array, tree: Uint32Array, count: number): Uint32Array<ArrayBuffer> {
  const nodes = new Uint32Array(count * NODE_STRIDE);
  for (let i = 0; i < count; i += 1) {
    const i4 = i * 4;
    const i5 = i * NODE_STRIDE;
    nodes[i5] = extA[i4];
    nodes[i5 + 1] = extA[i4 + 1];
    nodes[i5 + 2] = extA[i4 + 2];
    const size = lodSize(
      Math.exp(fromHalf(extB[i4 + 1] & 0xffff)),
      Math.exp(fromHalf(extB[i4 + 1] >>> 16)),
      Math.exp(fromHalf(extB[i4 + 2] & 0xffff)),
      (extA[i4 + 3] >>> 24) / 128,
    );
    nodes[i5 + 3] = ((tree[i * 2] & 0xffff) | (toHalf(Math.log(size)) << 16)) >>> 0;
    nodes[i5 + 4] = tree[i * 2 + 1];
  }
  return nodes;
}

// A growable list of node indices
export class IndexList {
  data: Uint32Array<ArrayBuffer>;
  count = 0;

  constructor(capacity = 1024) {
    this.data = new Uint32Array(capacity);
  }

  push(index: number) {
    if (this.count === this.data.length) {
      const grown = new Uint32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.count++] = index;
  }
}

export interface SelectOptions {
  origin: Vec3;
  facing: Vec3;
  minDot: number;
  sizeLimit: number;
}

let stack = new Uint32Array(1024);

// The selection of one tree, appended to `out` (traverseLodData); returns
// the nodes whose size was considered (the root and every expanded node's
// children)
export function selectLod(nodes: Uint32Array, { origin, facing, minDot, sizeLimit }: SelectOptions, out: IndexList): number {
  const f = new Float32Array(nodes.buffer, nodes.byteOffset, nodes.length);
  const [ox, oy, oz] = origin;
  const [fx, fy, fz] = facing;
  const dotFloor = Math.max(minDot, 0);
  const dotFloor2 = dotFloor * dotFloor;
  const limit2 = sizeLimit * sizeLimit;

  let top = 0;
  let visited = 1;
  let start = 0;
  let end = 1;
  while (true) {
    for (let index = start; index < end; index += 1) {
      const offset = index * NODE_STRIDE;
      const packed = nodes[offset + 3];
      let selected = (packed & 0xffff) === 0;
      if (!selected) {
        const x = f[offset] - ox;
        const y = f[offset + 1] - oy;
        const z = f[offset + 2] - oz;
        const d2 = Math.max(x * x + y * y + z * z, 1.0e-12);
        const dot = fx * x + fy * y + fz * z;
        const size = Math.exp(fromHalf(packed >>> 16));
        if (dot <= 0 || dot * dot <= dotFloor2 * d2) {
          const weighted = size * dotFloor;
          selected = weighted * weighted <= limit2 * d2;
        } else {
          selected = size * dot <= sizeLimit * d2;
        }
      }
      if (selected) {
        out.push(index);
      } else {
        if (top === stack.length) {
          const grown = new Uint32Array(stack.length * 2);
          grown.set(stack);
          stack = grown;
        }
        stack[top++] = index;
      }
    }
    if (top === 0) {
      break;
    }
    const offset = stack[--top] * NODE_STRIDE;
    start = nodes[offset + 4];
    end = start + (nodes[offset + 3] & 0xffff);
    visited += end - start;
  }
  return visited;
}

// size * max(cos, minDot) / distance, the measure selectLod compares, or -1
// when the node is within sizeLimit (decided by selectLod's own test, so a
// budget that is not reached selects exactly what selectLod does)
function weightedSize(nodes: Uint32Array, f: Float32Array, index: number, origin: Vec3, facing: Vec3, dotFloor: number, sizeLimit: number) {
  const offset = index * NODE_STRIDE;
  const x = f[offset] - origin[0];
  const y = f[offset + 1] - origin[1];
  const z = f[offset + 2] - origin[2];
  const d2 = Math.max(x * x + y * y + z * z, 1.0e-12);
  const dot = facing[0] * x + facing[1] * y + facing[2] * z;
  const size = Math.exp(fromHalf(nodes[offset + 3] >>> 16));
  const floored = dot <= 0 || dot * dot <= dotFloor * dotFloor * d2;
  const weighted = size * dotFloor;
  const within = floored ? weighted * weighted <= sizeLimit * sizeLimit * d2 : size * dot <= sizeLimit * d2;
  if (within) {
    return -1;
  }
  const d = Math.sqrt(d2);
  return (size * (floored ? dotFloor : dot / d)) / d;
}

export interface BudgetTree {
  nodes: Uint32Array;
  origin: Vec3;
  facing: Vec3;
}

// Nodes waiting to be refined, by weighted size in buckets of an eighth of
// an octave above sizeLimit (largest bucket first, last in first out
// within one): constant time per node, where a heap's log time made
// budgeted selections several times slower than unbudgeted ones
const BUCKETS_PER_OCTAVE = 8;
const BUCKETS = 64 * BUCKETS_PER_OCTAVE;

class BucketQueue {
  // (tree, node) pairs per bucket
  private entries: Uint32Array[] = [];
  private counts = new Uint32Array(BUCKETS);
  top = -1;
  size = 0;

  clear() {
    this.counts.fill(0);
    this.top = -1;
    this.size = 0;
  }

  push(bucket: number, tree: number, node: number) {
    let entries = this.entries[bucket];
    const n = this.counts[bucket];
    if (!entries || 2 * n + 2 > entries.length) {
      const grown = new Uint32Array(Math.max(64, 4 * n + 4));
      if (entries) {
        grown.set(entries.subarray(0, 2 * n));
      }
      entries = this.entries[bucket] = grown;
    }
    entries[2 * n] = tree;
    entries[2 * n + 1] = node;
    this.counts[bucket] = n + 1;
    this.size += 1;
    this.top = Math.max(this.top, bucket);
  }

  // The entry at the top: [tree, node] in `out`; size must be > 0
  peek(out: Uint32Array) {
    while (this.counts[this.top] === 0) {
      this.top -= 1;
    }
    const at = 2 * (this.counts[this.top] - 1);
    out[0] = this.entries[this.top][at];
    out[1] = this.entries[this.top][at + 1];
  }

  // Removes the entry peek() gave
  pop() {
    this.counts[this.top] -= 1;
    this.size -= 1;
  }

  // Every entry left, as (tree, node)
  forEach(visit: (tree: number, node: number) => void) {
    for (let bucket = 0; bucket <= this.top; bucket += 1) {
      const entries = this.entries[bucket];
      for (let i = 0; i < this.counts[bucket]; i += 1) {
        visit(entries[2 * i], entries[2 * i + 1]);
      }
    }
  }
}

const queue = new BucketQueue();
const pair = new Uint32Array(2);

// One selection over several trees under a shared splat budget: nodes are
// refined largest weighted size first (to an eighth of an octave), until
// every node is within sizeLimit (then each tree's selection is exactly
// selectLod's) or refining the next one would take the total past
// `budget`. Appends to outs[i] for tree i and returns the nodes considered.
export function selectLodBudget(trees: readonly BudgetTree[], { minDot, sizeLimit, budget }: { minDot: number; sizeLimit: number; budget: number }, outs: IndexList[]): number {
  const dotFloor = Math.max(minDot, 0);
  const floats = trees.map(({ nodes }) => new Float32Array(nodes.buffer, nodes.byteOffset, nodes.length));
  queue.clear();
  let total = 0;
  let visited = 0;

  const consider = (t: number, index: number) => {
    const { nodes, origin, facing } = trees[t];
    visited += 1;
    total += 1;
    if ((nodes[index * NODE_STRIDE + 3] & 0xffff) === 0) {
      outs[t].push(index);
      return;
    }
    const key = weightedSize(nodes, floats[t], index, origin, facing, dotFloor, sizeLimit);
    if (key < 0) {
      outs[t].push(index);
    } else {
      const bucket = Math.floor(Math.log2(key / sizeLimit) * BUCKETS_PER_OCTAVE);
      queue.push(Math.max(0, Math.min(BUCKETS - 1, bucket)), t, index);
    }
  };

  trees.forEach((_, t) => consider(t, 0));
  while (queue.size > 0) {
    queue.peek(pair);
    const [t, index] = pair;
    const nodes = trees[t].nodes;
    const children = nodes[index * NODE_STRIDE + 3] & 0xffff;
    if (total - 1 + children > budget) {
      break;
    }
    queue.pop();
    total -= 1;
    const start = nodes[index * NODE_STRIDE + 4];
    for (let child = start; child < start + children; child += 1) {
      consider(t, child);
    }
  }
  queue.forEach((t, index) => outs[t].push(index));
  return visited;
}
