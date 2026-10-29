export declare class Zstd {
    static decompress(bytes: Uint8Array, size: number, { native }?: {
        native?: boolean;
    }): Promise<Uint8Array<ArrayBuffer>>;
    static compress(bytes: Uint8Array, { native, level }?: {
        native?: boolean;
        level?: number;
    }): Promise<Uint8Array<ArrayBuffer>>;
}
