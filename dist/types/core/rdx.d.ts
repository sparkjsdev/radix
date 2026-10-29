import { ArrayData } from "./ArrayData";
import { type BundleDef } from "./bundles";
import type { Progress } from "./progress";
export declare const RDX_MAGIC = 1213744210;
export interface RdxHeader {
    version: number;
    count: number;
    chunkSize: number;
    meta: Record<string, unknown>;
    bundles: Record<string, {
        def: BundleDef;
        meta: Record<string, unknown>;
    }>;
    chunks: number[];
}
declare function encodeRdxChunks(data: ArrayData, { chunkSize, progress }?: {
    chunkSize?: number;
    progress?: Progress;
}): Promise<{
    header: Uint8Array<ArrayBuffer>;
    chunks: Uint8Array<ArrayBuffer>[];
}>;
declare function rdxChunkName(headerName: string, chunk: number): string;
declare function encodeRdxFiles(data: ArrayData, headerName: string, options?: {
    chunkSize?: number;
    progress?: Progress;
}): Promise<Record<string, Uint8Array<ArrayBuffer>>>;
declare function encodeRdx(data: ArrayData, options?: {
    chunkSize?: number;
    progress?: Progress;
}): Promise<Uint8Array<ArrayBuffer>>;
declare function decodeRdxHeader(bytes: Uint8Array<ArrayBuffer>): {
    header: RdxHeader;
    byteLength: number;
};
declare function rdxData(header: RdxHeader): ArrayData;
declare function decodeRdxChunk(header: RdxHeader, bytes: Uint8Array<ArrayBuffer>, into: ArrayData): Promise<void>;
declare function decodeRdx(bytes: Uint8Array<ArrayBuffer>, { progress }?: {
    progress?: Progress;
}): Promise<ArrayData>;
export interface RdxReader {
    header: RdxHeader;
    readChunk(chunk: number, into: ArrayData): Promise<void>;
}
declare function openRdx(readRange: (start: number, end: number) => Promise<Uint8Array<ArrayBuffer>>): Promise<RdxReader>;
declare function loadRdx(url: string, { chunked, init }?: {
    chunked?: boolean;
    init?: RequestInit;
}): Promise<RdxReader>;
export declare class RdxFile {
    static readonly CHUNK_SIZE = 65536;
    static readonly encode: typeof encodeRdx;
    static readonly decode: typeof decodeRdx;
    static readonly encodeChunks: typeof encodeRdxChunks;
    static readonly encodeFiles: typeof encodeRdxFiles;
    static readonly chunkName: typeof rdxChunkName;
    static readonly decodeHeader: typeof decodeRdxHeader;
    static readonly makeData: typeof rdxData;
    static readonly decodeChunk: typeof decodeRdxChunk;
    static readonly open: typeof openRdx;
    static readonly load: typeof loadRdx;
}
export {};
