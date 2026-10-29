import type { TypedArray } from "./formats";
export type BytesInput = Uint8Array<ArrayBuffer> | ArrayBuffer | ReadableStream<Uint8Array>;
export declare function pipe(data: Uint8Array<ArrayBuffer>, transform: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>>;
export declare class ByteReader {
    position: number;
    private chunks;
    private head;
    private offset;
    private buffered;
    private reader?;
    private done;
    private label;
    constructor(input: BytesInput, label?: string);
    private fill;
    private take;
    private drop;
    read(n: number): Promise<Uint8Array<ArrayBuffer>>;
    peek(n: number): Promise<Uint8Array<ArrayBuffer>>;
    skip(n: number): Promise<void>;
    rest(): Promise<Uint8Array<ArrayBuffer>>;
    atEnd(): Promise<boolean>;
    stream(): ReadableStream<Uint8Array<ArrayBuffer>>;
    cancel(): void;
}
export declare class Compression {
    static gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
    static gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
    static readBytes(input: BytesInput): Promise<Uint8Array<ArrayBuffer>>;
    static compressTransposed(values: TypedArray, elementBytes: number): Promise<Uint8Array<ArrayBuffer>>;
    static decompressTransposed(bytes: Uint8Array<ArrayBuffer>, elementBytes: number): Promise<Uint8Array<ArrayBuffer>>;
}
