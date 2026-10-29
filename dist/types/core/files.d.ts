import type { ArrayData } from "./ArrayData";
import type { CoordinateSystem } from "./axes";
import { type Progress } from "./progress";
import { type ShPalette, type ShTarget } from "./sh";
import { type LoadedSplats, type SplatLayout, type SplatReadOptions } from "./splats";
export type SplatFormat = "ply" | "compressed-ply" | "spz" | "rad" | "rdx";
export type SplatRequestInit = Omit<RequestInit, "signal" | "body" | "window" | "method">;
export type SplatLoadOptions<L extends SplatLayout = "extSplats"> = SplatReadOptions<L> & {
    name?: string;
};
export interface SplatWriteOptions {
    pbr?: boolean;
    compatibility?: boolean;
    sort?: boolean;
    version?: 2 | 3 | 4;
    coordinateSystem?: CoordinateSystem;
    zstdLevel?: number;
    lod?: boolean;
    fractionalBits?: number;
    antialiased?: boolean;
    chunkSize?: number;
    sh?: boolean;
    radSh?: "s8" | "f16" | "f32";
    shPalette?: ShPalette;
}
export declare class SplatFiles {
    static detectFormat(bytes: Uint8Array, name?: string): SplatFormat;
    static decode<L extends SplatLayout = "extSplats">(bytes: Uint8Array<ArrayBuffer>, { name, progress, layout, encoding, sh, coordinateSystem, }?: SplatLoadOptions<L>): Promise<LoadedSplats<L>>;
    static withSh<D>(data: D, sh: ShTarget | undefined): D;
    static encode(data: ArrayData, format: SplatFormat, options?: SplatWriteOptions & {
        progress?: Progress;
    }): Promise<Uint8Array<ArrayBuffer>>;
    static fetch<L extends SplatLayout = "extSplats">(url: string, { init, progress, ...target }?: SplatReadOptions<L> & {
        init?: RequestInit;
    }): Promise<LoadedSplats<L>>;
}
