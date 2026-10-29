import type { Schema } from "../core/bundles";
import type { GpuArrays } from "../gpu/GpuArrays";
import { type ArrayWriter, type WriteItem, type WriterOutput, type WriterOutputs } from "../gpu/GpuArrayWriter";
import { type TslNode } from "../gpu/tsl";
import { WgpuCompute } from "./WgpuCompute";
export declare class WgpuArrayWriter<O extends Schema = Schema> implements ArrayWriter<O, true> {
    static readonly MAX_CHANNELS = 4;
    readonly outputs: O;
    readonly packing: number;
    readonly channels: WriterOutput[];
    readonly storage = true;
    readonly run: typeof runComputeWriters;
    readonly kernel: WgpuCompute;
    private stores;
    private range;
    constructor({ outputs, write, workgroupSize, label }: {
        outputs: O;
        write: (index: TslNode, out: WriterOutputs<O>) => void;
        workgroupSize?: number;
        label?: string;
    });
    prepare(arrays: GpuArrays<Schema, true>, start: number, end: number, first: number): void;
    dispose(): void;
}
export declare function runComputeWriters(arrays: GpuArrays, items: WriteItem[]): void;
