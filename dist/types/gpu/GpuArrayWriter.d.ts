import { NodeMaterial } from "three/webgpu";
import type { Schema } from "../core/bundles";
import { type ArrayFormat } from "../core/formats";
import type { GpuArrays } from "./GpuArrays";
import { type TslNode } from "./tsl";
export type WriterOutputs<O extends Schema> = {
    [B in keyof O]: {
        [C in keyof O[B]["channels"]]: TslNode;
    };
};
export interface WriteRange {
    at?: number;
    count: number;
    first?: number;
}
export interface WriterOutput {
    bundle: string;
    channel: string;
    texelFormat: ArrayFormat;
}
export interface ArrayWriter<O extends Schema = Schema, Storage extends boolean = boolean> {
    readonly outputs: O;
    readonly packing: number;
    readonly channels: WriterOutput[];
    readonly storage: Storage;
    readonly run: (arrays: GpuArrays, items: WriteItem[]) => void;
}
export interface WriteItem extends WriteRange {
    writer: ArrayWriter;
}
export declare function writerChannels(outputs: Schema): {
    channels: WriterOutput[];
    packing: number;
};
export declare function writerVars(channels: WriterOutput[]): {
    out: Record<string, Record<string, any>>;
    vars: any[];
};
export declare function writeItemTexels(arrays: GpuArrays, item: WriteItem): {
    start: number;
    end: number;
};
export declare function countWrites(arrays: GpuArrays, items: WriteItem[]): void;
export declare class GpuArrayWriter<O extends Schema = Schema> implements ArrayWriter<O, false> {
    static readonly MAX_CHANNELS = 4;
    static readonly MAX_BYTES = 64;
    readonly outputs: O;
    readonly packing: number;
    readonly channels: WriterOutput[];
    readonly material: NodeMaterial;
    readonly storage = false;
    readonly run: typeof runWriters;
    constructor({ outputs, write, label }: {
        outputs: O;
        write: (index: TslNode, out: WriterOutputs<O>) => void;
        label?: string;
    });
    dispose(): void;
}
export declare function runWriters(arrays: GpuArrays, items: WriteItem[]): void;
export declare function widen(texelFormat: ArrayFormat, value: TslNode): TslNode;
