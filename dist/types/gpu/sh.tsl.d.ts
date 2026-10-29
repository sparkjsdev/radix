import type { WebGPURenderer } from "three/webgpu";
import { ShPalette, type FoundSh, type ShCodecName, type ShDegree } from "../core/sh";
import { GpuArrays } from "./GpuArrays";
import { type TslNode } from "./tsl";
export interface GpuShCodec {
    readonly name: ShCodecName;
    decodeBand(band: ShDegree, texel: (j: number) => TslNode): TslNode[];
}
export declare class GpuSh {
    static readonly maxDegree: TslNode;
    static codec(name: ShCodecName): GpuShCodec;
    static evaluate(dir: TslNode, degree: number, coefficients: (band: ShDegree) => TslNode[], { cap, limit }?: {
        cap?: boolean;
        limit?: TslNode;
    }): TslNode;
}
export declare class GpuShReader {
    readonly codec: ShCodecName;
    readonly degree: ShDegree;
    readonly palette: boolean;
    private gpuCodec;
    private channels;
    private labels;
    private stride;
    private bound;
    constructor({ codec, degree, palette }: {
        codec: ShCodecName;
        degree: ShDegree;
        palette?: boolean;
    });
    static for(arrays: GpuArrays, { palette, degree }?: {
        palette?: GpuArrays;
        degree?: number;
    }): GpuShReader | undefined;
    static find(arrays: GpuArrays, palette?: GpuArrays): (Pick<FoundSh, "codec" | "degree"> & {
        palette: boolean;
    }) | undefined;
    bind(arrays?: GpuArrays, palette?: GpuArrays): this;
    private texels;
    private decode;
    band(index: TslNode, band: ShDegree): TslNode[];
    coefficients(index: TslNode): TslNode[];
    color(index: TslNode, origin: TslNode, center: TslNode): TslNode;
    apply(splat: TslNode, index: TslNode, origin: TslNode): TslNode;
}
export declare class GpuShPalette {
    static upload(renderer: WebGPURenderer, palette: ShPalette): GpuArrays;
    static create<Storage extends boolean = false>(renderer: WebGPURenderer, { codec, degree, size, stride, storage }: {
        codec: ShCodecName;
        degree: ShDegree;
        size: number;
        stride?: number;
        storage?: Storage;
    }): GpuArrays<{
        shPalette: typeof ShPalette.BUNDLE;
    }, Storage>;
}
