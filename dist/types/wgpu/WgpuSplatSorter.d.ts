import type { WebGPURenderer } from "three/webgpu";
import { type SortKeyBits } from "../core/sort";
import type { GpuArrays } from "../gpu/GpuArrays";
import { type TslNode } from "../gpu/tsl";
import { WgpuBuffer } from "./WgpuBuffer";
export declare class WgpuSplatSorter {
    static readonly QUADS_PER_INSTANCE = 1024;
    readonly renderer: WebGPURenderer;
    readonly values: WgpuBuffer<"uint32">;
    readonly count: TslNode;
    readonly indirect: WgpuBuffer<"uint32">;
    private keys;
    private compact;
    private radix;
    private args;
    constructor(renderer: WebGPURenderer);
    sort(projected: GpuArrays, count: number, bits: SortKeyBits): void;
    readCount(): Promise<number>;
    dispose(): void;
}
