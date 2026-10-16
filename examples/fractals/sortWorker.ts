// Orders a table's samples for transitions (a module worker, no imports).
// In: a code per sample, x | y << 10 | z << 20 (10 bits each over the
// display ball), or 0xffffffff for a sample that draws nothing, and how to
// pair: "hilbert" (along a 3D Hilbert curve, so neighbors stay neighbors),
// "layers" (by height), "radial" (by distance from the center), "spiral"
// (by angle around the vertical) or "random". Out: the sample indices in
// that order, visible ones first, and how many are visible.

export type Pairing = "hilbert" | "layers" | "radial" | "spiral" | "random";

export interface SortRequest {
  codes: Uint32Array;
  pairing: Pairing;
  id: number;
}

export interface SortResult {
  order: Uint32Array;
  visible: number;
  id: number;
}

const BITS = 10;
const HIDDEN = 0xffffffff;

// Skilling's transpose of 3 axes of BITS bits into a Hilbert index
function hilbert(x: number, y: number, z: number) {
  for (let q = 1 << (BITS - 1); q > 1; q >>= 1) {
    const p = q - 1;
    if (x & q) {
      x ^= p;
    }
    if (y & q) {
      x ^= p;
    } else {
      const t = (x ^ y) & p;
      x ^= t;
      y ^= t;
    }
    if (z & q) {
      x ^= p;
    } else {
      const t = (x ^ z) & p;
      x ^= t;
      z ^= t;
    }
  }
  y ^= x;
  z ^= y;
  let t = 0;
  for (let q = 1 << (BITS - 1); q > 1; q >>= 1) {
    if (z & q) {
      t ^= q - 1;
    }
  }
  x ^= t;
  y ^= t;
  z ^= t;
  let h = 0;
  for (let b = BITS - 1; b >= 0; b -= 1) {
    h = (h << 3) | (((x >> b) & 1) << 2) | (((y >> b) & 1) << 1) | ((z >> b) & 1);
  }
  return h >>> 0;
}

function hash(v: number) {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

function keyOf(code: number, index: number, pairing: Pairing) {
  const x = code & 1023;
  const y = (code >>> 10) & 1023;
  const z = (code >>> 20) & 1023;
  if (pairing === "hilbert") {
    return hilbert(x, y, z);
  }
  if (pairing === "layers") {
    return ((y << 20) | (x << 10) | z) >>> 0;
  }
  const dx = x - 512;
  const dz = z - 512;
  const angle = Math.floor(((Math.atan2(dz, dx) / Math.PI + 1) / 2) * 1023.99);
  if (pairing === "radial") {
    const r = Math.min(1023, Math.floor(Math.sqrt(dx * dx + (y - 512) * (y - 512) + dz * dz) * 1.15));
    return ((r << 20) | (angle << 10) | y) >>> 0;
  }
  if (pairing === "spiral") {
    return ((angle << 20) | (y << 10) | Math.min(1023, Math.floor(Math.sqrt(dx * dx + dz * dz) * 1.4))) >>> 0;
  }
  return hash(index) >>> 2;
}

// LSD radix sort of (key, value) pairs, 11 bits a pass
function sortPairs(keys: Uint32Array<ArrayBuffer>, values: Uint32Array<ArrayBuffer>) {
  const n = keys.length;
  let k0 = keys;
  let v0 = values;
  let k1 = new Uint32Array(n);
  let v1 = new Uint32Array(n);
  const counts = new Uint32Array(2048);
  for (let shift = 0; shift < 32; shift += 11) {
    counts.fill(0);
    for (let i = 0; i < n; i += 1) {
      counts[(k0[i] >>> shift) & 2047] += 1;
    }
    let sum = 0;
    for (let b = 0; b < 2048; b += 1) {
      const c = counts[b];
      counts[b] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i += 1) {
      const slot = counts[(k0[i] >>> shift) & 2047]++;
      k1[slot] = k0[i];
      v1[slot] = v0[i];
    }
    [k0, k1] = [k1, k0];
    [v0, v1] = [v1, v0];
  }
  return v0;
}

addEventListener("message", (event: MessageEvent<SortRequest>) => {
  const { codes, pairing, id } = event.data;
  const n = codes.length;
  const keys = new Uint32Array(n);
  const values = new Uint32Array(n);
  let visible = 0;
  for (let i = 0; i < n; i += 1) {
    const code = codes[i];
    keys[i] = code === HIDDEN ? HIDDEN : keyOf(code, i, pairing);
    values[i] = i;
    visible += code === HIDDEN ? 0 : 1;
  }
  const order = sortPairs(keys, values);
  const result: SortResult = { order, visible, id };
  (self as unknown as Worker).postMessage(result, [order.buffer]);
});
