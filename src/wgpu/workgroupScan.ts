import type { WebGPURenderer } from "three/webgpu";
import { getGpuCaps } from "../gpu/createRenderer";
import { TSL, type TslNode } from "../gpu/tsl";

const { If, Loop, invocationSubgroupIndex, select, subgroupAdd, subgroupExclusiveAdd, subgroupIndex, subgroupSize, uint, workgroupBarrier } = TSL;

// Threads of the scan, sort and compaction workgroups
export const SCAN_WORKGROUP = 256;

// "portable": Hillis-Steele scans in workgroup memory (core WebGPU);
// "subgroup": subgroupExclusiveAdd / subgroupAdd where the device has them.
// Both give identical results.
export type ScanTier = "portable" | "subgroup";

export function scanTier(renderer: WebGPURenderer, tier: ScanTier | "auto" = "auto"): ScanTier {
  const subgroups = getGpuCaps(renderer).subgroups;
  if (tier === "subgroup" && !subgroups) {
    throw new Error("Subgroups are not supported on this device");
  }
  return tier === "auto" ? (subgroups ? "subgroup" : "portable") : tier;
}

// Rank of this thread in the order workgroupExclusiveScan uses. The portable
// tier scans in local id order. The subgroup tier scans subgroup by subgroup
// (subgroup id, then lane), which WGSL does not promise to match local ids;
// with a workgroup size that is a multiple of the subgroup size it is a
// bijection onto [0, 256).
export function threadRank(tier: ScanTier, localId: TslNode): TslNode {
  return tier === "subgroup" ? subgroupIndex.mul(subgroupSize).add(invocationSubgroupIndex).toVar() : localId.x.toVar();
}

// Exclusive prefix sum of one uint per thread across the 256-thread
// workgroup in threadRank order, plus the total. `scratch` is a 256-entry
// workgroup array; every thread ends past a barrier, so it can be reused.
export function workgroupExclusiveScan(tier: ScanTier, scratch: TslNode, rank: TslNode, value: TslNode) {
  if (tier === "subgroup") {
    const inTile = subgroupExclusiveAdd(value).toVar();
    const tileSum = subgroupAdd(value).toVar();
    If(invocationSubgroupIndex.equal(uint(0)), () => {
      scratch.element(subgroupIndex).assign(tileSum);
    });
    workgroupBarrier();

    const before = uint(0).toVar();
    const total = uint(0).toVar();
    Loop({ start: uint(0), end: uint(SCAN_WORKGROUP).div(subgroupSize), type: "uint", condition: "<" }, ({ i }: { i: TslNode }) => {
      const sum = scratch.element(i).toVar();
      before.addAssign(select(i.lessThan(subgroupIndex), sum, uint(0)));
      total.addAssign(sum);
    });
    workgroupBarrier();
    return { exclusive: before.add(inTile), total };
  }

  // Hillis-Steele inclusive scan, log2(256) = 8 rounds
  scratch.element(rank).assign(value);
  workgroupBarrier();
  for (let stride = 1; stride < SCAN_WORKGROUP; stride <<= 1) {
    const partner = select(rank.greaterThanEqual(uint(stride)), scratch.element(rank.sub(uint(stride))), uint(0)).toVar();
    workgroupBarrier();
    scratch.element(rank).addAssign(partner);
    workgroupBarrier();
  }
  const inclusive = scratch.element(rank).toVar();
  const total = scratch.element(uint(SCAN_WORKGROUP - 1)).toVar();
  workgroupBarrier();
  return { exclusive: inclusive.sub(value), total };
}
