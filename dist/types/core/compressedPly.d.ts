import type { ArrayData } from "./ArrayData";
import { type Progress } from "./progress";
declare function writeCompressedPly(data: ArrayData, { sort, sh, progress }?: {
    sort?: boolean;
    sh?: boolean;
    progress?: Progress;
}): Uint8Array<ArrayBuffer>;
export declare class CompressedPlyFile {
    static readonly read: <L extends import("./splats").SplatLayout = "extSplats">(input: import("./compress").BytesInput, { progress, sh, ...target }?: import("./splats").SplatReadOptions<L>) => Promise<import("./splats").LoadedSplats<L>>;
    static readonly write: typeof writeCompressedPly;
}
export {};
