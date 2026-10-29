import { StorageBufferAttribute, type WebGPURenderer } from "three/webgpu";
import { type ArrayFormat, type ArrayOf } from "../core/formats";
import { type TslNode } from "../gpu/tsl";
export declare class WgpuBuffer<F extends ArrayFormat = ArrayFormat> {
    readonly renderer: WebGPURenderer;
    readonly format: F;
    readonly atomic: boolean;
    readonly indirect: boolean;
    attribute: StorageBufferAttribute;
    node: TslNode;
    capacity: number;
    constructor({ renderer, format, count, atomic, indirect, label }: {
        renderer: WebGPURenderer;
        format: F;
        count: number;
        atomic?: boolean;
        indirect?: boolean;
        label?: string;
    });
    get components(): number;
    get byteLength(): number;
    element(index: TslNode): TslNode;
    gpuBuffer(): GPUBuffer;
    setCapacity(count: number, { keep }?: {
        keep?: boolean;
    }): boolean;
    ensureCapacity(count: number, options?: {
        keep?: boolean;
    }): boolean;
    swap(other: WgpuBuffer<F>): void;
    upload(data: ArrayOf<F>, offset?: number): void;
    clear(offset?: number, count?: number): void;
    copyFrom(src: WgpuBuffer<F>, { srcStart, dstStart, count }?: {
        srcStart?: number;
        dstStart?: number;
        count?: number;
    }): void;
    read(offset?: number, count?: number): Promise<ArrayOf<F>>;
    dispose(): void;
    private checkSize;
    private makeAttribute;
    private copyBuffer;
    private backend;
}
