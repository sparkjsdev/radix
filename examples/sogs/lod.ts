/*!
 * The PlayCanvas engine, https://github.com/playcanvas/engine
 *
 * MIT License
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
// Level selection after PlayCanvas's GSplatOctreeInstance and GSplatBudgetBalancer (engine 2.23)

interface RawNode {
  bound: { min: number[]; max: number[] };
  children?: RawNode[];
  lods?: Record<string, { file: number; offset: number; count: number }>;
}

interface RawLodMeta {
  lodLevels: number;
  filenames: string[];
  environment?: string | null;
  tree: RawNode;
  counts?: number[];
}

export interface SogLodTree {
  url: string;
  levels: number;
  // Absolute meta.json URLs, and the level each one holds
  files: string[];
  fileLevel: Int8Array;
  environment?: string;
  leaves: number;
  // Per leaf: min xyz, max xyz
  bounds: Float32Array;
  // Per leaf and level (leaf * levels + level): the range, file -1 for none
  file: Int32Array;
  offset: Uint32Array;
  count: Uint32Array;
  min: [number, number, number];
  max: [number, number, number];
  // Splats of all leaves per level, and what the file says they are
  levelTotals: number[];
  counts?: number[];
}

// "target": detail rises until the budget is used; "limit": the distances
// decide and the budget only lowers detail
export type BudgetMode = "target" | "limit";

export interface LodSettings {
  baseDistance: number;
  multiplier: number;
  rangeMin: number;
  rangeMax: number;
  behindPenalty: number;
  // Splats selected (0: none; target: the finest everywhere, limit: the
  // distances alone)
  splatBudget: number;
  budgetMode: BudgetMode;
  // Levels coarser than the selected one a leaf may show while that one loads,
  // the finest resident one first
  underfillLimit: number;
  // Most splats of loaded files kept on the GPU
  residentBudget: number;
  // Re-select after the camera moves this far in object units, or turns this
  // many degrees, which only matters through behindPenalty
  updateDistance: number;
  updateAngle: number;
  freeze: boolean;
  colorLevels: boolean;
}

// After PlayCanvas's streaming examples, but the budget only caps, since a filled
// budget is often more than the GPU keeps at frame rate while flying
export function defaultLodSettings(cpuSort: boolean): LodSettings {
  return {
    baseDistance: 5, multiplier: 3, rangeMin: 0, rangeMax: 7, behindPenalty: 2,
    splatBudget: cpuSort ? 2_000_000 : 4_000_000, budgetMode: "limit", underfillLimit: 5, residentBudget: 16_000_000,
    updateDistance: 0.5, updateAngle: 90, freeze: false, colorLevels: false,
  };
}

// Against PlayCanvas's reference 45 degree vertical field of view, by the
// narrower half angle, since wider views see leaves smaller
export function fovScale(fov: number, aspect: number): number {
  const tanHalfV = Math.tan((fov * Math.PI) / 360);
  const tanHalfH = tanHalfV * (aspect > 0 && Number.isFinite(aspect) ? aspect : 1);
  return Math.min(tanHalfV, tanHalfH) / Math.tan(Math.PI / 8);
}

export function isLodMeta(json: unknown): boolean {
  const meta = json as RawLodMeta;
  return typeof meta === "object" && meta !== null && typeof meta.lodLevels === "number" && Array.isArray(meta.filenames) && typeof meta.tree === "object";
}

export function parseLod(json: unknown, url: string): SogLodTree {
  if (!isLodMeta(json)) {
    throw new Error("Not a SOG lod-meta.json");
  }
  const meta = json as RawLodMeta;
  const levels = meta.lodLevels;
  const raw: RawNode[] = [];
  const stack = [meta.tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
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
  const levelTotals = new Array<number>(levels).fill(0);
  raw.forEach((node, leaf) => {
    bounds.set(node.bound.min, leaf * 6);
    bounds.set(node.bound.max, leaf * 6 + 3);
    for (const [key, range] of Object.entries(node.lods!)) {
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
    min: meta.tree.bound.min as [number, number, number],
    max: meta.tree.bound.max as [number, number, number],
    levelTotals,
    counts: meta.counts,
  };
}

// The level the leaf has nearest the one asked for, coarser first; -1 if none
export function availableLevel(tree: SogLodTree, leaf: number, level: number): number {
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

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

// Band b is level rangeMin + b snapped to one the leaf has, so a leaf missing a
// level repeats a neighbor and that band step changes nothing
export interface LevelChains {
  rangeMin: number;
  span: number;
  // Per leaf and band (leaf * span + b); level -1: the leaf has none
  level: Int8Array;
  count: Float64Array;
  // Splats of all leaves at the finest and the coarsest band
  finest: number;
  coarsest: number;
}

const chainCache = new WeakMap<SogLodTree, LevelChains>();

export function levelChains(tree: SogLodTree, rangeMin: number, rangeMax: number): LevelChains {
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

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

// The budget fit's axis: ln s over [-48, 48] in BINS bins, the bin that runs
// out of budget split again into BINS sub-bins. s = 1 is the edge of bin
// BINS / 2, so limit mode keeps the configured distances exactly.
const BINS = 1024;
const LOG_MIN = -48;
const BIN_SCALE = BINS / 96;
const UNIT_BIN = BINS / 2;
const histogram = new Float64Array(BINS);
let logDistances = new Float64Array(0);

const binOf = (x: number) => Math.min(BINS - 1, Math.max(0, Math.floor(x)));

// Writes each leaf's level and distance into the two arrays, with the eye
// and a unit forward in the tree's space, and returns the splats selected.
//
// A leaf at distance d is at band 1 + floor(log_m(d / (s * base))), clamped to
// the range: finer than band L + 1 exactly when ln s > ln(d / base) - L ln m,
// with L counted from rangeMin. All those switch points lie on one ln s axis,
// so a histogram of the splats each one adds, summed from the coarsest end,
// finds the largest s within the budget. Stopping at the first sub-bin that
// does not fit keeps a leaf's level from depending on leaves farther along the
// axis, so small camera moves do not flip levels on and off.
export function selectLevels(tree: SogLodTree, eye: Vec3Like, forward: Vec3Like, s: LodSettings, out: Int8Array, d: Float32Array, fov = 1): number {
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
    // Cosine toward the box's nearest point: 0 side-on, -1 straight behind
    if (penalty > 0 && distance > 0.01) {
      const facing = (dx * forward.x + dy * forward.y + dz * forward.z) / distance;
      if (facing < 0) {
        distance *= 1 - facing * penalty;
      }
    }
    distance *= fov;
    d[leaf] = distance;
    // ln(distance / base) on the bin axis
    logDistances[leaf] = (Math.log(Math.max(distance, 1e-6)) - logBase - LOG_MIN) * BIN_SCALE;
  }
  const switchAt = (leaf: number, b: number) => logDistances[leaf] - (rangeMin + b - 1) * step;

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
      const accumulate = (bin: number) => {
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
