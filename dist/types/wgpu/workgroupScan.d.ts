import type { WebGPURenderer } from "three/webgpu";
import { type TslNode } from "../gpu/tsl";
export declare const SCAN_WORKGROUP = 256;
export type ScanTier = "portable" | "subgroup";
export declare function scanTier(renderer: WebGPURenderer, tier?: ScanTier | "auto"): ScanTier;
export declare function threadRank(tier: ScanTier, localId: TslNode): TslNode;
export declare function workgroupExclusiveScan(tier: ScanTier, scratch: TslNode, rank: TslNode, value: TslNode): {
    exclusive: any;
    total: any;
};
