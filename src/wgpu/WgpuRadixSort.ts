import type { IndirectStorageBufferAttribute, WebGPURenderer } from "three/webgpu";
import type { SortKeyBits } from "../core/sort";
import { getGpuCaps } from "../gpu/createRenderer";
import { TSL, type TslNode } from "../gpu/tsl";
import { WgpuBuffer } from "./WgpuBuffer";
import { WgpuCompute, WgpuComputeBatch, requireWebGPU, type DispatchSize } from "./WgpuCompute";
import { SCAN_WORKGROUP, scanTier, threadRank, workgroupExclusiveScan, type ScanTier } from "./workgroupScan";

const { If, Loop, atomicAdd, atomicLoad, atomicStore, max, min, select, uint, uniform, workgroupArray, workgroupBarrier } = TSL;

export type RadixKeysPerThread = 8 | 16;

const RADIX_BITS = 8;
const BINS = 1 << RADIX_BITS;
const MAX_PASSES = 4;
// Bits of the packed local-sort word holding the position in the block
// (BLOCK <= 4096); the digit sits above them
const PACK_SHIFT = 12;
// Digit of padding past `count` in the last block: sorts after every element
const PAD_DIGIT = BINS - 1;

function scatterWorkgroupBytes(block: number) {
  return block * 4 + 3 * BINS * 4;
}

// Count and blocks of one sort as TSL nodes: uniforms, or reads of a
// count buffer the GPU wrote
interface SortCounts {
  count: TslNode;
  numBlocks: TslNode;
  // A uniform at least numBlocks: loops holding barriers need a uniform
  // trip count
  loopBlocks: TslNode;
}

interface Kernels {
  histogram: WgpuCompute[];
  scanBlocks: WgpuCompute;
  scatter: WgpuCompute[];
  dispose(): void;
}

// GPU LSD radix sort of uint32 keys with uint32 values (WebGPU backend
// only). Stable, so ties keep their input order and the result equals the
// CPU sortKeys. 2, 3 or 4 passes of 8-bit digits; each pass is reduce then
// scan, 3 dispatches, with no forward-progress assumptions:
//   histogram  (one workgroup per block): per-block digit counts
//   scanBlocks (one workgroup per digit): exclusive scan of that digit's
//              block counts, digit totals out
//   scatter    (one workgroup per block): exclusive scan of the digit totals
//              (redundant per workgroup, saving a dispatch), a stable local
//              sort of (digit, position) words in workgroup memory, then
//              dst = binOffset + blockOffset + rank
// One kernel per pass with the shift built in, so a whole sort is one
// WgpuComputeBatch: one compute pass, queued synchronously.
export class WgpuRadixSort {
  readonly renderer: WebGPURenderer;
  readonly tier: ScanTier;
  // Keys per thread and per block (256 threads)
  readonly keysPerThread: RadixKeysPerThread;
  readonly blockSize: number;
  // The caller's buffers, sorted in place
  readonly keys: WgpuBuffer<"uint32">;
  readonly values: WgpuBuffer<"uint32">;

  private keysB: WgpuBuffer<"uint32">;
  private valuesB: WgpuBuffer<"uint32">;
  // blockHistograms[digit * numBlocks + block]: per-block digit counts, then
  // each block's exclusive offset within its digit
  private blockHistograms: WgpuBuffer<"uint32">;
  private digitTotals: WgpuBuffer<"uint32">;
  private count = uniform(0, "uint");
  private numBlocks = uniform(0, "uint");
  // The keys' capacity and its blocks, bounds of an indirect sort
  private capacity = uniform(0, "uint");
  private maxBlocks = uniform(0, "uint");
  private direct?: Kernels;
  private indirect?: Kernels & { countBuffer: WgpuBuffer<"uint32">; args: WgpuCompute; argsBuffer: WgpuBuffer<"uint32"> };

  // keysPerThread 8 (default) or 16: 16 needs about 19 KB of workgroup
  // storage and sorted 10-25% slower on an Apple M3 (fewer workgroups in
  // flight)
  constructor({ renderer, keys, values, tier = "auto", keysPerThread = 8 }: {
    renderer: WebGPURenderer;
    keys: WgpuBuffer<"uint32">;
    values: WgpuBuffer<"uint32">;
    tier?: ScanTier | "auto";
    keysPerThread?: RadixKeysPerThread;
  }) {
    requireWebGPU(renderer, "WgpuRadixSort");
    this.renderer = renderer;
    this.tier = scanTier(renderer, tier);
    const limit = getGpuCaps(renderer).maxWorkgroupStorage;
    this.keysPerThread = keysPerThread;
    this.blockSize = SCAN_WORKGROUP * this.keysPerThread;
    if (scatterWorkgroupBytes(this.blockSize) > limit) {
      throw new Error(`WgpuRadixSort: ${this.keysPerThread} keys per thread need ${scatterWorkgroupBytes(this.blockSize)} bytes of workgroup memory (limit ${limit})`);
    }

    this.keys = keys;
    this.values = values;
    const buffer = (count: number, label: string) => new WgpuBuffer({ renderer, format: "uint32", count, label });
    this.keysB = buffer(keys.capacity, "radix_sortKeysB");
    this.valuesB = buffer(values.capacity, "radix_sortValuesB");
    this.blockHistograms = buffer(BINS * this.blocksFor(keys.capacity), "radix_sortBlockHistograms");
    this.digitTotals = buffer(BINS, "radix_sortDigitTotals");
  }

  // Grow the scratch buffers to the keys' and values' capacity
  ensureCapacity() {
    this.keysB.ensureCapacity(this.keys.capacity);
    this.valuesB.ensureCapacity(this.values.capacity);
    this.blockHistograms.ensureCapacity(BINS * this.blocksFor(this.keys.capacity));
  }

  // Sort the first `count` keys and values in place (ascending, stable);
  // keys must be below 2^bits
  sort(count: number, { bits = 32 }: { bits?: SortKeyBits } = {}) {
    if (count <= 0) {
      return;
    }
    this.ensureCapacity();
    const numBlocks = this.blocksFor(count);
    this.count.value = count;
    this.numBlocks.value = numBlocks;
    this.direct ??= this.makeKernels({ count: this.count, numBlocks: this.numBlocks, loopBlocks: this.numBlocks });
    this.run(this.direct, bits, [numBlocks]);
  }

  // Sort the first countBuffer[0] keys and values (at most the capacity),
  // with every dispatch sized on the GPU: nothing is read back
  sortIndirect(countBuffer: WgpuBuffer<"uint32">, { bits = 32 }: { bits?: SortKeyBits } = {}) {
    this.ensureCapacity();
    this.capacity.value = this.keys.capacity;
    this.maxBlocks.value = this.blocksFor(this.keys.capacity);
    if (this.indirect?.countBuffer !== countBuffer) {
      this.indirect?.dispose();
      this.indirect = this.makeIndirectKernels(countBuffer);
    }
    this.run(this.indirect, bits, this.indirect.argsBuffer.attribute as IndirectStorageBufferAttribute, this.indirect.args);
  }

  dispose() {
    this.direct?.dispose();
    this.indirect?.dispose();
    [this.keysB, this.valuesB, this.blockHistograms, this.digitTotals].forEach((buffer) => buffer.dispose());
  }

  private run(kernels: Kernels, bits: SortKeyBits, blocks: DispatchSize, args?: WgpuCompute) {
    if (bits !== 16 && bits !== 24 && bits !== 32) {
      throw new Error(`WgpuRadixSort: bits must be 16, 24 or 32 (got ${bits})`);
    }
    const passes = bits / RADIX_BITS;
    const batch = new WgpuComputeBatch(this.renderer);
    if (args) {
      batch.add(args, [1]);
    }
    for (let pass = 0; pass < passes; pass += 1) {
      batch.add(kernels.histogram[pass], blocks).add(kernels.scanBlocks, [BINS]).add(kernels.scatter[pass], blocks);
    }
    batch.submit();

    // An odd number of passes leaves the result in the B buffers: trade
    // them for the caller's (no copy; the kernels follow the nodes)
    if (passes % 2 === 1) {
      this.keys.swap(this.keysB);
      this.values.swap(this.valuesB);
    }
  }

  private blocksFor(count: number) {
    return Math.max(1, Math.ceil(count / this.blockSize));
  }

  private makeKernels(counts: SortCounts): Kernels {
    const { keys, values, keysB, valuesB } = this;
    const histogram: WgpuCompute[] = [];
    const scatter: WgpuCompute[] = [];
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const forward = pass % 2 === 0;
      const shift = pass * RADIX_BITS;
      histogram.push(this.makeHistogram(counts, shift, forward ? keys : keysB));
      scatter.push(forward ? this.makeScatter(counts, shift, keys, values, keysB, valuesB) : this.makeScatter(counts, shift, keysB, valuesB, keys, values));
    }
    const scanBlocks = this.makeScanBlocks(counts);
    return {
      histogram, scanBlocks, scatter,
      dispose: () => [...histogram, ...scatter, scanBlocks].forEach((kernel) => kernel.dispose()),
    };
  }

  private makeIndirectKernels(countBuffer: WgpuBuffer<"uint32">) {
    const count = min(countBuffer.element(uint(0)), this.capacity);
    const numBlocks = max(count.add(uint(this.blockSize - 1)).div(uint(this.blockSize)), uint(1));
    const kernels = this.makeKernels({ count, numBlocks, loopBlocks: this.maxBlocks });
    const argsBuffer = new WgpuBuffer({ renderer: this.renderer, format: "uint32", count: 3, indirect: true, label: "radix_sortIndirectArgs" });
    const args = new WgpuCompute({
      label: "radix_sortIndirectArgs",
      workgroupSize: [1],
      body: () => {
        argsBuffer.element(uint(0)).assign(numBlocks);
        argsBuffer.element(uint(1)).assign(uint(1));
        argsBuffer.element(uint(2)).assign(uint(1));
      },
    });
    return {
      ...kernels, countBuffer, args, argsBuffer,
      dispose: () => {
        kernels.dispose();
        args.dispose();
        argsBuffer.dispose();
      },
    };
  }

  private makeHistogram({ count, numBlocks }: SortCounts, shift: number, keys: WgpuBuffer<"uint32">) {
    const { tier, keysPerThread, blockSize, blockHistograms } = this;
    return new WgpuCompute({
      label: `radix_sortHistogram_${shift}`,
      workgroupSize: [SCAN_WORKGROUP],
      body: ({ localId, workgroupId }) => {
        const rank = threadRank(tier, localId);
        const block = workgroupId.x;
        const counts = workgroupArray("uint", BINS).setAtomic(true);
        atomicStore(counts.element(rank), uint(0));
        workgroupBarrier();

        const base = block.mul(uint(blockSize)).add(rank.mul(uint(keysPerThread))).toVar();
        for (let j = 0; j < keysPerThread; j += 1) {
          const i = base.add(uint(j));
          If(i.lessThan(count), () => {
            atomicAdd(counts.element(keys.element(i).shiftRight(uint(shift)).bitAnd(uint(BINS - 1))), uint(1));
          });
        }
        workgroupBarrier();
        blockHistograms.element(rank.mul(numBlocks).add(block)).assign(atomicLoad(counts.element(rank)));
      },
    });
  }

  // One workgroup per digit: exclusive scan over that digit's block counts
  // in chunks of 256 with a carry; the digit total to digitTotals[digit]
  private makeScanBlocks({ numBlocks, loopBlocks }: SortCounts) {
    const { tier, blockHistograms, digitTotals } = this;
    return new WgpuCompute({
      label: "radix_sortScanBlocks",
      workgroupSize: [SCAN_WORKGROUP],
      body: ({ localId, workgroupId }) => {
        const rank = threadRank(tier, localId);
        const digit = workgroupId.x;
        const scratch = workgroupArray("uint", SCAN_WORKGROUP);
        const carry = uint(0).toVar();
        const rowBase = digit.mul(numBlocks).toVar();
        const blocks = numBlocks.toVar();

        Loop({ start: uint(0), end: loopBlocks, type: "uint", condition: "<", update: SCAN_WORKGROUP }, ({ i }: { i: TslNode }) => {
          const index = i.add(rank).toVar();
          const inRange = index.lessThan(blocks).toVar();
          const value = select(inRange, blockHistograms.element(rowBase.add(index)), uint(0)).toVar();
          const { exclusive, total } = workgroupExclusiveScan(tier, scratch, rank, value);
          If(inRange, () => {
            blockHistograms.element(rowBase.add(index)).assign(carry.add(exclusive));
          });
          carry.addAssign(total);
        });

        If(rank.equal(uint(0)), () => {
          digitTotals.element(digit).assign(carry);
        });
      },
    });
  }

  // One workgroup per block: scan the digit totals into bin offsets, sort
  // the block's (digit, position) words by digit in workgroup memory (8
  // stable one-bit splits), rank = position - first position of the digit,
  // then gather each element from the source block and scatter it to
  // binOffset[d] + blockOffset[d][block] + rank
  private makeScatter({ count, numBlocks }: SortCounts, shift: number, srcKeys: WgpuBuffer<"uint32">, srcValues: WgpuBuffer<"uint32">, dstKeys: WgpuBuffer<"uint32">, dstValues: WgpuBuffer<"uint32">) {
    const { tier, keysPerThread, blockSize, blockHistograms, digitTotals } = this;
    const posMask = (1 << PACK_SHIFT) - 1;
    return new WgpuCompute({
      label: `radix_sortScatter_${shift}`,
      workgroupSize: [SCAN_WORKGROUP],
      body: ({ localId, workgroupId }) => {
        const rank = threadRank(tier, localId);
        const block = workgroupId.x;
        const packedWords = workgroupArray("uint", blockSize);
        const scratch = workgroupArray("uint", SCAN_WORKGROUP);
        const digitStart = workgroupArray("uint", BINS);
        const binOffsets = workgroupArray("uint", BINS);
        const n = count.toVar();

        // `rank` is a bijection onto the digits and the scan runs in rank
        // order, so the result is indexed by digit
        const { exclusive: binOffset } = workgroupExclusiveScan(tier, scratch, rank, digitTotals.element(rank).toVar());
        binOffsets.element(rank).assign(binOffset);

        const blockBase = block.mul(uint(blockSize)).toVar();
        const blockCount = select(n.sub(blockBase).lessThan(uint(blockSize)), n.sub(blockBase), uint(blockSize)).toVar();
        const threadBase = rank.mul(uint(keysPerThread)).toVar();

        // keysPerThread consecutive elements per thread as packed
        // (digit << PACK_SHIFT | position) words; padding sorts last
        for (let j = 0; j < keysPerThread; j += 1) {
          const p = threadBase.add(uint(j)).toVar();
          const i = blockBase.add(p);
          const digit = select(i.lessThan(n), srcKeys.element(i).shiftRight(uint(shift)).bitAnd(uint(BINS - 1)), uint(PAD_DIGIT));
          packedWords.element(p).assign(digit.shiftLeft(uint(PACK_SHIFT)).bitOr(p));
        }

        // Stable one-bit splits over the digit's bits: zeros first
        for (let bit = 0; bit < RADIX_BITS; bit += 1) {
          workgroupBarrier();
          const words: TslNode[] = [];
          const bits: TslNode[] = [];
          const ones = uint(0).toVar();
          for (let j = 0; j < keysPerThread; j += 1) {
            words.push(packedWords.element(threadBase.add(uint(j))).toVar());
            bits.push(words[j].shiftRight(uint(PACK_SHIFT + bit)).bitAnd(uint(1)).toVar());
            ones.addAssign(bits[j]);
          }
          const { exclusive: onesBefore, total: totalOnes } = workgroupExclusiveScan(tier, scratch, rank, ones);
          const totalZeros = uint(blockSize).sub(totalOnes).toVar();
          const onesSoFar = onesBefore.toVar();
          for (let j = 0; j < keysPerThread; j += 1) {
            const p = threadBase.add(uint(j));
            const dst = select(bits[j].equal(uint(1)), totalZeros.add(onesSoFar), p.sub(onesSoFar)).toVar();
            packedWords.element(dst).assign(words[j]);
            onesSoFar.addAssign(bits[j]);
          }
        }
        workgroupBarrier();

        // First position of each digit
        for (let j = 0; j < keysPerThread; j += 1) {
          const p = threadBase.add(uint(j));
          const digit = packedWords.element(p).shiftRight(uint(PACK_SHIFT)).toVar();
          const previous = select(p.equal(uint(0)), digit.add(uint(1)), packedWords.element(p.sub(uint(1))).shiftRight(uint(PACK_SHIFT)));
          If(digit.notEqual(previous), () => {
            digitStart.element(digit).assign(p);
          });
        }
        workgroupBarrier();

        // The real elements occupy [0, blockCount) after the local sort
        for (let j = 0; j < keysPerThread; j += 1) {
          const p = threadBase.add(uint(j));
          If(p.lessThan(blockCount), () => {
            const word = packedWords.element(p).toVar();
            const digit = word.shiftRight(uint(PACK_SHIFT)).toVar();
            const src = blockBase.add(word.bitAnd(uint(posMask))).toVar();
            const dst = binOffsets.element(digit).add(blockHistograms.element(digit.mul(numBlocks).add(block))).add(p.sub(digitStart.element(digit))).toVar();
            dstKeys.element(dst).assign(srcKeys.element(src));
            dstValues.element(dst).assign(srcValues.element(src));
          });
        }
      },
    });
  }
}
