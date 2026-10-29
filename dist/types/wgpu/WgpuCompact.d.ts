import type { WebGPURenderer } from "three/webgpu";
import { type TslNode } from "../gpu/tsl";
import { WgpuBuffer } from "./WgpuBuffer";
import { type ScanTier } from "./workgroupScan";
export declare class WgpuCompact {
    readonly renderer: WebGPURenderer;
    readonly tier: ScanTier;
    readonly keys: WgpuBuffer<"uint32">;
    readonly values: WgpuBuffer<"uint32">;
    readonly count: WgpuBuffer<"uint32">;
    readonly invalid: any;
    private blockOffsets;
    private n;
    private numBlocks;
    private kernels;
    constructor({ renderer, key, tier }: {
        renderer: WebGPURenderer;
        key: (index: TslNode) => TslNode;
        tier?: ScanTier | "auto";
    });
    compact(n: number): void;
    dispose(): void;
}
