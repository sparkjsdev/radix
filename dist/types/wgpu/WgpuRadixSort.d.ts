import type { WebGPURenderer } from "three/webgpu";
import type { SortKeyBits } from "../core/sort";
import { WgpuBuffer } from "./WgpuBuffer";
import { type ScanTier } from "./workgroupScan";
export type RadixKeysPerThread = 8 | 16;
export declare class WgpuRadixSort {
    readonly renderer: WebGPURenderer;
    readonly tier: ScanTier;
    readonly keysPerThread: RadixKeysPerThread;
    readonly blockSize: number;
    readonly keys: WgpuBuffer<"uint32">;
    readonly values: WgpuBuffer<"uint32">;
    private keysB;
    private valuesB;
    private blockHistograms;
    private digitTotals;
    private count;
    private numBlocks;
    private capacity;
    private maxBlocks;
    private direct?;
    private indirect?;
    constructor({ renderer, keys, values, tier, keysPerThread }: {
        renderer: WebGPURenderer;
        keys: WgpuBuffer<"uint32">;
        values: WgpuBuffer<"uint32">;
        tier?: ScanTier | "auto";
        keysPerThread?: RadixKeysPerThread;
    });
    ensureCapacity(): void;
    sort(count: number, { bits }?: {
        bits?: SortKeyBits;
    }): void;
    sortIndirect(countBuffer: WgpuBuffer<"uint32">, { bits }?: {
        bits?: SortKeyBits;
    }): void;
    dispose(): void;
    private run;
    private blocksFor;
    private makeKernels;
    private makeIndirectKernels;
    private makeHistogram;
    private makeScanBlocks;
    private makeScatter;
}
