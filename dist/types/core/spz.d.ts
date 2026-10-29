import { ArrayData } from "./ArrayData";
import { type CoordinateSystem } from "./axes";
import { type BytesInput } from "./compress";
import { type Progress } from "./progress";
import { type LoadedSplats, type SplatLayout, type SplatReadOptions } from "./splats";
export declare const SPZ_MAGIC = 1347635022;
export interface SpzWriteOptions {
    version?: 2 | 3 | 4;
    fractionalBits?: number;
    antialiased?: boolean;
    pbr?: boolean;
    lod?: boolean;
    sh?: boolean;
    coordinateSystem?: CoordinateSystem;
    zstdLevel?: number;
    progress?: Progress;
}
export interface SpzExtension {
    type: number;
    data: Uint8Array<ArrayBuffer>;
}
export interface SpzUnpacked {
    container: "gzip" | "ngsp";
    version: number;
    count: number;
    shDegree: number;
    fractionalBits: number;
    flags: number;
    centers: Uint8Array<ArrayBuffer>;
    alphas: Uint8Array<ArrayBuffer>;
    colors: Uint8Array<ArrayBuffer>;
    scales: Uint8Array<ArrayBuffer>;
    rotations: Uint8Array<ArrayBuffer>;
    sh?: Uint8Array<ArrayBuffer>;
    lodTree?: Uint8Array<ArrayBuffer>;
    pbr?: Uint8Array<ArrayBuffer>;
    extensions: SpzExtension[];
}
declare function unpackSpz(input: BytesInput, { sh }?: {
    sh?: boolean;
}): Promise<SpzUnpacked>;
declare function readSpz<L extends SplatLayout = "extSplats">(input: BytesInput, { progress, sh: shTarget, coordinateSystem, ...target }?: SplatReadOptions<L>): Promise<LoadedSplats<L>>;
declare function writeSpz(data: ArrayData, { version, fractionalBits, antialiased, pbr, lod, sh, coordinateSystem, zstdLevel, progress, }?: SpzWriteOptions): Promise<Uint8Array<ArrayBuffer>>;
export declare class SpzFile {
    static readonly read: typeof readSpz;
    static readonly write: typeof writeSpz;
    static readonly unpack: typeof unpackSpz;
}
export {};
