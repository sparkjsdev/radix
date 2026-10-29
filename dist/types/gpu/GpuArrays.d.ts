import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { ArrayData } from "../core/ArrayData";
import type { BundleDef, Schema } from "../core/bundles";
import { type ArrayFormat } from "../core/formats";
import { TextureLayout } from "../core/layout";
import type { ArrayWriter, WriteRange, WriterOutput } from "./GpuArrayWriter";
export interface GpuChannel {
    format: ArrayFormat;
    texelFormat: ArrayFormat;
    texture: THREE.DataArrayTexture;
    storage: boolean;
}
export interface GpuBundle<D extends BundleDef = BundleDef> {
    def: D;
    layout: TextureLayout;
    channels: {
        [K in keyof D["channels"]]: GpuChannel;
    };
    meta: Record<string, unknown>;
}
export type GpuBundles<S extends Schema> = {
    [K in keyof S]: GpuBundle<S[K]>;
};
export type WriterFor<Storage extends boolean> = [Storage] extends [true] ? ArrayWriter : ArrayWriter<Schema, false>;
export declare function makeArrayTexture(name: string, format: ArrayFormat, layout: TextureLayout, internalFormat?: string): THREE.DataArrayTexture;
export declare class GpuArrays<S extends Schema = Schema, Storage extends boolean = boolean> {
    readonly renderer: WebGPURenderer;
    readonly schema: S;
    readonly storage: Storage;
    count: number;
    capacity: number;
    version: number;
    bundles: GpuBundles<S>;
    private targets;
    constructor({ renderer, bundles, capacity, storage }: {
        renderer: WebGPURenderer;
        bundles: S;
        capacity?: number;
        storage?: Storage;
    });
    static supports(def: BundleDef): boolean;
    static fromData<S extends Schema, Storage extends boolean = false>(renderer: WebGPURenderer, data: ArrayData<S>, { bundles, storage }?: {
        bundles?: string[];
        storage?: Storage;
    }): GpuArrays<S, Storage>;
    upload(data: ArrayData, { bundles, srcStart, dstStart, count }?: {
        bundles?: string[];
        srcStart?: number;
        dstStart?: number;
        count?: number;
    }): void;
    read({ bundles, start, count, into }?: {
        bundles?: string[];
        start?: number;
        count?: number;
        into?: ArrayData;
    }): Promise<ArrayData>;
    copyFrom(src: GpuArrays, { bundles, srcStart, dstStart, count }?: {
        bundles?: string[];
        srcStart?: number;
        dstStart?: number;
        count?: number;
    }): void;
    setCapacity(capacity: number): boolean;
    ensureCapacity(capacity: number): boolean;
    hasStorage(): this is GpuArrays<S, true>;
    write(writer: WriterFor<Storage>, range: WriteRange): void;
    writeBatch(items: (WriteRange & {
        writer: WriterFor<Storage>;
    })[]): void;
    swap(other: GpuArrays<S, Storage>): void;
    renderTarget(outputs: WriterOutput[]): THREE.RenderTarget;
    bundle(name: string): GpuBundle;
    dispose(): void;
    private allocate;
    private releaseTextures;
    private get anyBundles();
}
