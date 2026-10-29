import { ArrayData } from "./ArrayData";
import { type BytesInput } from "./compress";
import { type Progress } from "./progress";
import { ShPalette } from "./sh";
import { type LoadedSplats, type SplatLayout, type SplatReadOptions } from "./splats";
export declare const RAD_MAGIC = 809779538;
export declare const RAD_CHUNK_MAGIC = 1128546642;
declare function readRad<L extends SplatLayout = "extSplats">(input: BytesInput, { progress, sh, ...target }?: SplatReadOptions<L>): Promise<LoadedSplats<L>>;
export declare class RadFile {
    static readonly read: typeof readRad;
    static readonly write: typeof writeRad;
}
declare function writeRad(data: ArrayData, { chunkSize, sh, radSh, shPalette, progress }?: {
    chunkSize?: number;
    sh?: boolean;
    radSh?: "s8" | "f16" | "f32";
    shPalette?: ShPalette;
    progress?: Progress;
}): Promise<Uint8Array<ArrayBuffer>>;
export {};
