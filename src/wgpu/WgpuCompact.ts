import type { WebGPURenderer } from "three/webgpu";
import { TSL, type TslNode } from "../gpu/tsl";
import { WgpuBuffer } from "./WgpuBuffer";
import { WgpuCompute, WgpuComputeBatch, requireWebGPU } from "./WgpuCompute";
import { SCAN_WORKGROUP, scanTier, threadRank, workgroupExclusiveScan, type ScanTier } from "./workgroupScan";

const { If, Loop, select, uint, uniform, workgroupArray } = TSL;

const KEYS_PER_THREAD = 8;
const BLOCK = SCAN_WORKGROUP * KEYS_PER_THREAD;

/**
 * Stream compaction of key(i) over the first n indices, in input order, on the
 * WebGPU backend only.
 */
export class WgpuCompact {
  readonly renderer: WebGPURenderer;
  readonly tier: ScanTier;
  /** The keys that are not invalid, at the front in input order. */
  readonly keys: WgpuBuffer<"uint32">;
  /** The index of each key in keys. */
  readonly values: WgpuBuffer<"uint32">;
  /** Element 0 holds the count that the latest compact wrote. */
  readonly count: WgpuBuffer<"uint32">;
  /**
   * The key to drop, a uint uniform.
   *
   * @default 0xffffffff
   */
  readonly invalid = uniform(0xffffffff, "uint");

  private blockOffsets: WgpuBuffer<"uint32">;
  private n = uniform(0, "uint");
  private numBlocks = uniform(0, "uint");
  private kernels: WgpuCompute[];

  /**
   * Builds the kernels.
   *
   * @param options.key The key of an index, in TSL.
   * @param [options.tier="auto"] The scan tier, where "auto" picks "subgroup"
   *   if the device has subgroups.
   */
  constructor({ renderer, key, tier = "auto" }: { renderer: WebGPURenderer; key: (index: TslNode) => TslNode; tier?: ScanTier | "auto" }) {
    requireWebGPU(renderer, "WgpuCompact");
    this.renderer = renderer;
    this.tier = scanTier(renderer, tier);
    const buffer = (label: string) => new WgpuBuffer({ renderer, format: "uint32", count: 1, label });
    this.keys = buffer("radix_compactKeys");
    this.values = buffer("radix_compactValues");
    this.count = buffer("radix_compactCount");
    this.blockOffsets = buffer("radix_compactBlockOffsets");

    const { n, numBlocks, blockOffsets, count, keys, values, invalid } = this;
    const tierOf = this.tier;
    const valid = (i: TslNode) => i.lessThan(n).and(key(i).notEqual(invalid));
    const threadCount = (base: TslNode) => {
      const sum = uint(0).toVar();
      for (let j = 0; j < KEYS_PER_THREAD; j += 1) {
        sum.addAssign(select(valid(base.add(uint(j))), uint(1), uint(0)));
      }
      return sum;
    };
    const threadBase = (workgroupId: TslNode, rank: TslNode) =>
      workgroupId.x.mul(uint(BLOCK)).add(rank.mul(uint(KEYS_PER_THREAD))).toVar();

    const blockCounts = new WgpuCompute({
      label: "radix_compactBlockCounts",
      workgroupSize: [SCAN_WORKGROUP],
      body: ({ localId, workgroupId }) => {
        const rank = threadRank(tierOf, localId);
        const scratch = workgroupArray("uint", SCAN_WORKGROUP);
        const { total } = workgroupExclusiveScan(tierOf, scratch, rank, threadCount(threadBase(workgroupId, rank)).toVar());
        If(rank.equal(uint(0)), () => {
          blockOffsets.element(workgroupId.x).assign(total);
        });
      },
    });

    const scan = new WgpuCompute({
      label: "radix_compactScan",
      workgroupSize: [SCAN_WORKGROUP],
      body: ({ localId }) => {
        const rank = threadRank(tierOf, localId);
        const scratch = workgroupArray("uint", SCAN_WORKGROUP);
        const carry = uint(0).toVar();
        Loop({ start: uint(0), end: numBlocks, type: "uint", condition: "<", update: SCAN_WORKGROUP }, ({ i }: { i: TslNode }) => {
          const index = i.add(rank).toVar();
          const inRange = index.lessThan(numBlocks).toVar();
          const value = select(inRange, blockOffsets.element(index), uint(0)).toVar();
          const { exclusive, total } = workgroupExclusiveScan(tierOf, scratch, rank, value);
          If(inRange, () => {
            blockOffsets.element(index).assign(carry.add(exclusive));
          });
          carry.addAssign(total);
        });
        If(rank.equal(uint(0)), () => {
          count.element(uint(0)).assign(carry);
        });
      },
    });

    const scatter = new WgpuCompute({
      label: "radix_compactScatter",
      workgroupSize: [SCAN_WORKGROUP],
      body: ({ localId, workgroupId }) => {
        const rank = threadRank(tierOf, localId);
        const scratch = workgroupArray("uint", SCAN_WORKGROUP);
        const base = threadBase(workgroupId, rank);
        const { exclusive } = workgroupExclusiveScan(tierOf, scratch, rank, threadCount(base).toVar());
        const at = blockOffsets.element(workgroupId.x).add(exclusive).toVar();
        for (let j = 0; j < KEYS_PER_THREAD; j += 1) {
          const i = base.add(uint(j)).toVar();
          const k = key(i).toVar();
          If(i.lessThan(n).and(k.notEqual(invalid)), () => {
            keys.element(at).assign(k);
            values.element(at).assign(i);
            at.addAssign(uint(1));
          });
        }
      },
    });

    this.kernels = [blockCounts, scan, scatter];
  }

  /** Compacts the first n indices. */
  compact(n: number) {
    const blocks = Math.max(1, Math.ceil(n / BLOCK));
    this.keys.ensureCapacity(n);
    this.values.ensureCapacity(n);
    this.blockOffsets.ensureCapacity(blocks);
    this.n.value = n;
    this.numBlocks.value = blocks;

    const [blockCounts, scan, scatter] = this.kernels;
    new WgpuComputeBatch(this.renderer).add(blockCounts, [blocks]).add(scan, [1]).add(scatter, [blocks]).submit();
  }

  dispose() {
    this.kernels.forEach((kernel) => kernel.dispose());
    [this.keys, this.values, this.count, this.blockOffsets].forEach((buffer) => buffer.dispose());
  }
}
