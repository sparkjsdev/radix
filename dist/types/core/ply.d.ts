import { ArrayData } from "./ArrayData";
import { type BytesInput } from "./compress";
import { type Progress } from "./progress";
import { type LoadedSplats, type SplatLayout, type SplatReadOptions } from "./splats";
export declare const SH_C0 = 0.28209479177387814;
export declare const COMPRESSED_CHUNK_SIZE = 256;
export declare const COMPRESSED_CHUNK_PROPERTIES: string[];
export declare const COMPRESSED_VERTEX_PROPERTIES: string[];
declare function readPly<L extends SplatLayout = "extSplats">(input: BytesInput, { progress, sh, ...target }?: SplatReadOptions<L>): Promise<LoadedSplats<L>>;
export declare function decodeCompressedSh(byte: number): number;
export declare function encodeCompressedSh(value: number): number;
declare function writePly(data: ArrayData, { pbr, compatibility, sh, progress }?: {
    pbr?: boolean;
    compatibility?: boolean;
    sh?: boolean;
    progress?: Progress;
}): Uint8Array<ArrayBuffer>;
export declare class PlyFile {
    static readonly read: typeof readPly;
    static readonly write: typeof writePly;
}
export {};
