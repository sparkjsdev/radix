import type { WebGPURenderer } from "three/webgpu";
import { getGpuCaps } from "../gpu/createRenderer";
import { TSL, type TslNode } from "../gpu/tsl";

const { If, Loop, invocationSubgroupIndex, select, subgroupAdd, subgroupExclusiveAdd, subgroupIndex, subgroupSize, uint, workgroupBarrier } = TSL;

export const SCAN_WORKGROUP = 256;

/**
 * "portable" scans in workgroup memory and "subgroup" with subgroup operations,
 * with equal results.
 */
export type ScanTier = "portable" | "subgroup";

export function scanTier(renderer: WebGPURenderer, tier: ScanTier | "auto" = "auto"): ScanTier {
  const subgroups = getGpuCaps(renderer).subgroups;
  if (tier === "subgroup" && !subgroups) {
    throw new Error("Subgroups are not supported on this device");
  }
  return tier === "auto" ? (subgroups ? "subgroup" : "portable") : tier;
}

// WGSL does not promise that subgroup order matches local ids
export function threadRank(tier: ScanTier, localId: TslNode): TslNode {
  return tier === "subgroup" ? subgroupIndex.mul(subgroupSize).add(invocationSubgroupIndex).toVar() : localId.x.toVar();
}

// scratch is a 256-entry workgroup array, reusable after the call
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

  // Hillis-Steele inclusive scan
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
