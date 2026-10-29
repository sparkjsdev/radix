import { ArrayData, type ArrayBundle } from "./ArrayData";
import { type BundleDef } from "./bundles";
import type { BundleLike } from "./splats";
export type ShDegree = 1 | 2 | 3 | 4;
export type ShCodecName = "ext" | "packed";
export type ShTarget = ShCodecName | false;
export interface ShCodec {
    readonly name: ShCodecName;
    words(degree: ShDegree): number;
    channels(degree: ShDegree): string[];
    encode(coeffs: ArrayLike<number>, degree: ShDegree, out: Uint32Array, at: number): void;
    decode(words: Uint32Array, at: number, degree: ShDegree, out: Float32Array): Float32Array;
}
export interface FoundSh {
    name: string;
    codec: ShCodecName;
    degree: ShDegree;
}
export declare function encodeShScale(max: number): number;
export declare function decodeShScale(code: number): number;
export declare class Sh {
    static readonly COEFFICIENTS: readonly [0, 3, 8, 15, 24];
    static readonly MAX_DEGREE = 4;
    static readonly VALUES: number;
    static readonly LABEL: BundleDef<{
        readonly label: "uint16";
    }>;
    static codec(name: string): ShCodec;
    static texels(codec: ShCodecName, degree: ShDegree): number;
    static degreeOf(coefficients: number): ShDegree | undefined;
    static bundleName(codec: ShCodecName): string;
    static bundle(codec: ShCodecName, degree: ShDegree): BundleDef;
    static add(data: ArrayData, codec: ShCodecName, degree: ShDegree): ArrayBundle;
    static find(bundles: Record<string, BundleLike & {
        meta?: Record<string, unknown>;
    }>): FoundSh | undefined;
    static prepare(data: ArrayData, degree: number, target?: ShTarget): ((i: number, coeffs: ArrayLike<number>) => void) | undefined;
    static encoder(data: ArrayData, found?: FoundSh | undefined): (i: number, coeffs: ArrayLike<number>) => void;
    static decoder(data: ArrayData, found?: FoundSh | undefined): (i: number, out: Float32Array) => Float32Array;
    static convert(data: ArrayData, codec: ShCodecName, { degree }?: {
        degree?: ShDegree;
    }): ArrayData;
    static evaluate(coeffs: ArrayLike<number>, dir: {
        x: number;
        y: number;
        z: number;
    }, degree: number, out?: number[]): number[];
    static basis<T extends Float64Array | Float32Array | number[] = Float64Array>(dir: {
        x: number;
        y: number;
        z: number;
    }, out?: T): T;
}
declare const PALETTE: BundleDef<{
    readonly shEntries: "uint32x4";
}>;
export declare class ShPalette {
    static readonly BUNDLE: BundleDef<{
        readonly shEntries: "uint32x4";
    }>;
    readonly data: ArrayData<{
        shPalette: typeof PALETTE;
    }>;
    constructor(data: ArrayData);
    static strideOf(codec: ShCodecName, degree: ShDegree): number;
    static create({ codec, degree, size, stride }: {
        codec: ShCodecName;
        degree: ShDegree;
        size: number;
        stride?: number;
    }): ShPalette;
    get meta(): Record<string, unknown>;
    get codec(): ShCodecName;
    get degree(): ShDegree;
    get size(): number;
    get stride(): number;
    private get words();
    set(n: number, coeffs: ArrayLike<number>): void;
    get(n: number, out?: Float32Array): Float32Array;
    convert(codec: ShCodecName, { stride }?: {
        stride?: number;
    }): ShPalette;
    expand(data: ArrayData, labels: ArrayLike<number>, codec?: ShCodecName): ArrayData<import("./bundles").Schema>;
    expanded(data: ArrayData, codec?: ShCodecName): ArrayData;
}
export {};
