import type { IndirectStorageBufferAttribute, WebGPURenderer } from "three/webgpu";
import { type TslNode } from "../gpu/tsl";
import { scanTier, threadRank, workgroupExclusiveScan } from "./workgroupScan";
export interface ComputeIds {
    globalId: TslNode;
    localId: TslNode;
    workgroupId: TslNode;
    numWorkgroups: TslNode;
    index: TslNode;
}
export type DispatchSize = number | [number, number?, number?] | IndirectStorageBufferAttribute;
export declare function requireWebGPU(renderer: WebGPURenderer, what: string): void;
export declare class WgpuCompute {
    static readonly SCAN_WORKGROUP = 256;
    static readonly scanTier: typeof scanTier;
    static readonly threadRank: typeof threadRank;
    static readonly workgroupExclusiveScan: typeof workgroupExclusiveScan;
    readonly workgroupSize: [number, number, number];
    private computeNode;
    constructor({ workgroupSize, body, label }: {
        workgroupSize?: [number] | [number, number] | [number, number, number];
        body: (ids: ComputeIds) => void;
        label?: string;
    });
    dispatch(renderer: WebGPURenderer, size: DispatchSize): void;
    prepare(size: DispatchSize): TslNode;
    dispose(): void;
}
export declare class WgpuComputeBatch {
    readonly renderer: WebGPURenderer;
    private queue;
    constructor(renderer: WebGPURenderer);
    add(kernel: WgpuCompute, size: DispatchSize): this;
    submit({ split }?: {
        split?: boolean;
    }): void;
}
